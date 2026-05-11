
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';

const CIPL_BOUNDARY_PROMPT = `Anda adalah ahli ekstraksi dokumen. Tugas Anda menganalisis batas halaman dokumen CIPL (001).
Jawab HANYA dengan JSON murni berikut:
{
  "page_contain_header": {"start": number, "end": number},
  "is_document_contain_summary": boolean,
  "document_summary_page": {"start": number, "end": number},
  "page_contain_invoice_data": {"start": number, "end": number},
  "page_contain_packing_list_data": {"start": number, "end": number}
}
Keterangan:
- Halaman header berisi informasi pengirim, penerima, dll (bukan sekedar tabel item).
- Summary adalah halaman rekapitulasi/total dari dokumen.
- Invoice data berisi tabel nilai harga barang.
- Packing list data berisi tabel fisik kemasan/berat.
Jika suatu bagian tidak ada, berikan null.`;

const extractPageBuffer = async (pdfDoc, startPage, endPage) => {
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const startIndex = Math.max(0, startPage - 1);
  const endIndex = Math.min(numPages - 1, endPage - 1);
  const indices = [];
  for (let i = startIndex; i <= endIndex; i++) indices.push(i);
  if (indices.length === 0) return null;
  const pages = await singlePdf.copyPages(pdfDoc, indices);
  pages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

const mergeItemsByProductNumber = (masterJson) => {
  // Peta berdasarkan invoice_number untuk mendukung multi-invoice dalam 1 dokumen
  const invoiceMap = {};

  const processItemsList = (list) => {
    if (!Array.isArray(list)) return;
    for (const wrapper of list) {
      const invNo = wrapper.invoice_number || 'UNKNOWN';
      if (!invoiceMap[invNo]) invoiceMap[invNo] = { invoiceData: { ...wrapper }, itemsMap: {} };

      if (Array.isArray(wrapper.items)) {
        for (const item of wrapper.items) {
          let matchKey = null;

          // 1. Match by prod_number explicitly
          if (item.prod_number && invoiceMap[invNo].itemsMap[item.prod_number]) {
            matchKey = item.prod_number;
          } else {
            // 2. Fuzzy match existing items (Anti-Duplikasi jika prod_number hilang di chunk tertentu)
            const existingKeys = Object.keys(invoiceMap[invNo].itemsMap);
            for (const k of existingKeys) {
              const existingItem = invoiceMap[invNo].itemsMap[k];
              
              const seqMatch = existingItem.number && item.number && String(existingItem.number).trim() === String(item.number).trim();

              const desc1 = (existingItem.description || '').trim().toLowerCase().replace(/\\s+/g, '');
              const desc2 = (item.description || '').trim().toLowerCase().replace(/\\s+/g, '');
              const descMatch = desc1 && desc2 && (desc1 === desc2 || desc1.includes(desc2) || desc2.includes(desc1));
              
              const amountMatch = existingItem.amount === item.amount;
              const prodNoConflict = existingItem.prod_number && item.prod_number && existingItem.prod_number !== item.prod_number;

              if ((seqMatch || (descMatch && amountMatch)) && !prodNoConflict) {
                 // Jika tidak ada konflik prod_number, dan (amount sama ATAU salah satu tidak punya amount)
                 if (amountMatch || existingItem.amount == null || item.amount == null || seqMatch) {
                    matchKey = k;
                    break;
                 }
              }
            }
          }

          if (!matchKey) {
            matchKey = item.prod_number || item.description || `UNKNOWN_PROD_${Math.random().toString(36).substring(2, 7)}`;
            invoiceMap[invNo].itemsMap[matchKey] = { ...item };
          } else {
            // merge data (mengisi properti null/undefined dengan nilai yang ada)
            Object.keys(item).forEach((key) => {
              if (item[key] !== null && item[key] !== undefined && item[key] !== '') {
                if (!invoiceMap[invNo].itemsMap[matchKey][key]) {
                  invoiceMap[invNo].itemsMap[matchKey][key] = item[key];
                }
              }
            });
            // Update key jika item baru ternyata punya prod_number sedangkan key lama bukan prod_number
            if (item.prod_number && matchKey !== item.prod_number) {
               invoiceMap[invNo].itemsMap[matchKey].prod_number = item.prod_number;
               invoiceMap[invNo].itemsMap[item.prod_number] = invoiceMap[invNo].itemsMap[matchKey];
               delete invoiceMap[invNo].itemsMap[matchKey];
            }
          }
        }
      }
    }
  };

  // 1 & 2. Kumpulkan semua items
  processItemsList(masterJson.invoice_list);
  processItemsList(masterJson.pl_list);

  // 3. Bangun ulang array masterJson.invoice_list dan masterJson.pl_list
  masterJson.invoice_list = [];
  masterJson.pl_list = [];

  for (const invNo of Object.keys(invoiceMap)) {
    const mergedItems = Object.values(invoiceMap[invNo].itemsMap);
    
    const invWrapper = { ...invoiceMap[invNo].invoiceData };
    invWrapper.items = JSON.parse(JSON.stringify(mergedItems));
    masterJson.invoice_list.push(invWrapper);

    const plWrapper = { ...invoiceMap[invNo].invoiceData };
    plWrapper.items = JSON.parse(JSON.stringify(mergedItems));
    masterJson.pl_list.push(plWrapper);
  }
};

export const processCiplPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, log = logger) => {
  log.info({ event: 'cipl_extraction_start' }, 'Memulai CIPL Extraction Pipeline v2.0 (Context-Aware Map-Reduce)');

  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    log.warn('Secured PDF, fallback ke One-Shot Extraction');
    const { parsedData, usageMetadata } = await callGeminiWithRetry([prompt, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }], 3, null, log);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  }

  // Custom merge function specifically for CIPL to handle array concatenation and grouping by invoice_number
  const mergeCiplChunks = (target, source) => {
    if (!source) return;
    // Pindahkan semua primitive fields
    Object.keys(source).forEach((key) => {
      if (!Array.isArray(source[key]) && typeof source[key] !== 'object') {
        if (target[key] === undefined || target[key] === null || target[key] === '') {
          target[key] = source[key];
        }
      }
    });

    // Helper untuk menyatukan list berdasarkan invoice_number
    const mergeList = (listKey) => {
      if (!Array.isArray(source[listKey])) return;
      if (!target[listKey]) target[listKey] = [];

      for (const srcItem of source[listKey]) {
        const invNo = srcItem.invoice_number || 'UNKNOWN';
        let targetItem = target[listKey].find((t) => (t.invoice_number || 'UNKNOWN') === invNo);

        if (!targetItem) {
          // Clone srcItem and make sure items is an array
          targetItem = { ...srcItem };
          targetItem.items = Array.isArray(srcItem.items) ? [...srcItem.items] : [];
          target[listKey].push(targetItem);
        } else {
          // Merge properti non-array dari wrapper
          Object.keys(srcItem).forEach((k) => {
            if (k !== 'items' && !Array.isArray(srcItem[k])) {
              if (targetItem[k] === undefined || targetItem[k] === null || targetItem[k] === '') {
                targetItem[k] = srcItem[k];
              }
            }
          });
          // Concat items (Gabungkan item baris demi baris, jangan ditimpa by index)
          if (Array.isArray(srcItem.items)) {
            if (!Array.isArray(targetItem.items)) targetItem.items = [];
            targetItem.items = targetItem.items.concat(srcItem.items);
          }
        }
      }
    };

    mergeList('invoice_list');
    mergeList('pl_list');
  };

  const processPageRange = async (start, end, useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const buffer = await extractPageBuffer(pdfDoc, start, end);
    if (!buffer) return null;
    const selectedPrompt = useFullPrompt ? prompt : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, context);
    const { parsedData, usageMetadata } = await callGeminiWithRetry([
      selectedPrompt,
      { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }
    ], 3, null, log);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;

    parseItemsCsv(parsedData, docCode);
    return parsedData;
  };

  const processPageRangeChunked = async (start, end, useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const CHUNK_SIZE = 5;
    const promises = [];
    for (let i = start; i <= end; i += CHUNK_SIZE) {
      const chunkEnd = Math.min(i + CHUNK_SIZE - 1, end);
      promises.push(processPageRange(i, chunkEnd, useFullPrompt, context));
    }
    const results = await Promise.all(promises);
    const mergedResult = {};
    for (const res of results) {
      if (res) mergeCiplChunks(mergedResult, res);
    }
    return mergedResult;
  };

  // Fase 1: Boundary Detection
  log.info({ event: 'cipl_boundary_scan' }, 'Fase 1: Scanning boundary dokumen...');
  const boundaryResponse = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [CIPL_BOUNDARY_PROMPT, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }],
    config: { responseMimeType: 'application/json', temperature: 0.1 }
  });
  const boundaryUsage = boundaryResponse.usageMetadata || {};
  tokenUsage.inputTotal += boundaryUsage.promptTokenCount || 0;
  tokenUsage.output += boundaryUsage.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(boundaryUsage);
  tokenUsage.total += boundaryUsage.totalTokenCount || 0;

  const boundaryRaw = cleanAIJson(boundaryResponse.text);
  const boundary = Array.isArray(boundaryRaw) ? boundaryRaw[0] : boundaryRaw;
  log.info({ event: 'cipl_boundary_detected', boundary }, 'Boundary terdeteksi');

  // Fase 2: Global Context Extraction (Header)
  const headerStart = 1;
  let headerEnd = boundary?.page_contain_header?.end ? Math.min(boundary.page_contain_header.end, 3) : 1;
  if (!headerEnd || headerEnd < 1) headerEnd = 1;

  log.info({ event: 'cipl_extracting_header' }, `Fase 2: Mengekstrak Global Context (Header) hal ${headerStart}-${headerEnd}`);
  const masterJson = await processPageRange(headerStart, headerEnd, true) || {};
  if (!masterJson.invoice_list) masterJson.invoice_list = [];
  if (!masterJson.pl_list) masterJson.pl_list = [];

  const globalContext = {
    buyer_name: masterJson.buyer_name,
    seller_name: masterJson.seller_name,
    packing_list_number: masterJson.packing_list_number,
    available_invoices: (masterJson.invoice_list || []).map((inv) => ({
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date
    }))
  };

  if (totalPages <= headerEnd) {
    mergeItemsByProductNumber(masterJson);
    await debugLog(docCode, 'cipl_final_output', masterJson);
    return masterJson;
  }

  // Fase 3: Context-Injected Chunking (Detail Items)
  let summaryStart = null, summaryEnd = null;
  if (boundary.is_document_contain_summary && boundary.document_summary_page?.start) {
    summaryStart = boundary.document_summary_page.start;
    summaryEnd = boundary.document_summary_page.end;
  }

  const detailStart = headerEnd + 1;
  const detailEnd = summaryStart ? Math.min(summaryStart - 1, totalPages) : totalPages;

  if (detailStart <= detailEnd) {
    log.info({ event: 'cipl_detail_chunking' }, `Fase 3: Mengekstrak Detail Items hal ${detailStart}-${detailEnd} dengan Global Context`);
    const detailData = await processPageRangeChunked(detailStart, detailEnd, false, globalContext);
    mergeCiplChunks(masterJson, detailData);
  }

  // Fase 4: Summary & Reconciliation
  if (summaryStart && summaryStart > headerEnd) {
    summaryEnd = Math.min(summaryEnd || totalPages, totalPages);
    log.info({ event: 'cipl_summary_scan' }, `Fase 4: Mengekstrak Summary hal ${summaryStart}-${summaryEnd}`);
    const summaryData = await processPageRangeChunked(summaryStart, summaryEnd, true, globalContext);
    mergeCiplChunks(masterJson, summaryData);
  }

  // Grouping by product_number
  mergeItemsByProductNumber(masterJson);

  // Fallback missing fields from Global Context to prevent attention drift
  if (Array.isArray(masterJson.invoice_list)) {
    masterJson.invoice_list.forEach((inv) => {
      if (Array.isArray(inv.items)) {
        inv.items.forEach((item) => {
          if (!item.vendor_name) item.vendor_name = masterJson.seller_name || null;
          if (!item.origin) item.origin = masterJson.origin || null;
          if (!item.currency) item.currency = masterJson.currency_code || null;
        });
      }
    });
  }

  await debugLog(docCode, 'cipl_final_output', masterJson);
  log.info({ event: 'cipl_extraction_completed' }, 'CIPL Pipeline Selesai');
  return masterJson;
};
