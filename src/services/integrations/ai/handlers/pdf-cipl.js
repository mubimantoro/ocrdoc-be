
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';

const CIPL_BOUNDARY_PROMPT = `Anda adalah ahli ekstraksi dokumen logistik. Tugas Anda menganalisis batas halaman dokumen CIPL (001).
Sebuah dokumen CIPL memiliki struktur berikut:
1. Header: Berisi informasi utama pengirim, penerima, nomor dokumen utama.
2. Detail Data (Invoice / Packing List): Tabel padat berisi detail item/handling unit.
3. Summary Page: Rekapitulasi/total dari seluruh dokumen di bagian akhir.

TUGAS ANDA: Tentukan rentang halaman untuk setiap kategori.
PENTING: Gunakan field "exclude" untuk mencantumkan halaman di dalam rentang start-end yang BUKAN merupakan bagian dari kategori tersebut (misal: halaman kosong atau halaman sisa teks yang tidak relevan).

Jawab HANYA dengan JSON murni berikut:
{
  "page_contain_header": {"start": number, "end": number, "exclude": [number]},
  "is_document_contain_summary": boolean,
  "document_summary_page": {"start": number, "end": number, "exclude": [number]},
  "page_contain_invoice_data": {"start": number, "end": number, "exclude": [number]},
  "page_contain_packing_list_data": {"start": number, "end": number, "exclude": [number]}
}
Keterangan:
- Halaman header mencakup cover page dan halaman utama yang memuat informasi shipment/invoice/packing list.
- Summary adalah halaman rekapitulasi/total dari dokumen di akhir. Summary merupakan Single Source of Truth untuk data item.
- Halaman "data" adalah halaman yang memiliki tabel atau daftar barang.
Jika suatu bagian tidak ada, berikan null.`;


const extractPageBuffer = async (pdfDoc, startPage, endPage, exclude = []) => {
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const startIndex = Math.max(0, startPage - 1);
  const endIndex = Math.min(numPages - 1, endPage - 1);
  const excludeSet = new Set(exclude.map((p) => p - 1));
  const indices = [];
  for (let i = startIndex; i <= endIndex; i++) {
    if (!excludeSet.has(i)) {
      indices.push(i);
    }
  }
  if (indices.length === 0) return null;
  const pages = await singlePdf.copyPages(pdfDoc, indices);
  pages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};


/**
 * Helper untuk membandingkan nomor invoice secara cerdas (mendukung suffix matching).
 * Contoh: "2221865350" dianggap sama dengan "5350".
 */
const isSameInvoice = (inv1, inv2) => {
  if (!inv1 || !inv2) return false;
  const s1 = String(inv1).trim();
  const s2 = String(inv2).trim();
  if (s1 === s2) return true;

  // Suffix matching: Jika salah satu merupakan akhiran dari yang lain (min 4 digit)
  if (s1.length >= 4 && s2.length >= 4) {
    return s1.endsWith(s2) || s2.endsWith(s1);
  }
  return false;
};

/**
 * Reconcile and group items for CIPL based on the new architecture.
 * Supports SSOT (Summary overrides details) and different grouping for Invoice vs PL.
 */
const reconcileCiplData = (masterJson, summaryData = null, log = logger) => {
  const invoiceGroups = {}; // Key: invoice_number
  const plGroups = {}; // Key: packing_list_number

  // Identity logic for Schneider: Item is unique by its Line Number + Product Number
  const getInvoiceItemKey = (item) => {
    const num = String(item.number || '').trim();
    const prod = String(item.prod_number || '').trim();
    // Unique key: Combine line number and product to avoid overwriting same-product lines
    if (num && prod) return `INV_${num}_${prod}`;
    return num ? `INV_NUM_${num}` : (prod ? `INV_PROD_${prod}` : `ITEM_${Math.random().toString(36).substring(2, 7)}`);
  };

  const getPlItemKey = (item) => {
    const pkg = String(item.package_number || '').trim();
    const num = String(item.number || '').trim();
    const prod = String(item.prod_number || '').trim();
    
    // Identity for PL: Package + Line + Product
    let key = 'PL';
    if (pkg) key += `_PKG_${pkg}`;
    if (num) key += `_NUM_${num}`;
    if (prod) key += `_PROD_${prod}`;
    
    if (key === 'PL') return `ITEM_${Math.random().toString(36).substring(2, 7)}`;
    return key;
  };

  const processList = (list, targetMap, groupingFn, type) => {
    if (!Array.isArray(list)) return;
    for (const wrapper of list) {
      const docNo = (type === 'INV' ? wrapper.invoice_number : wrapper.packing_list_number) || 'UNKNOWN';
      
      // Find matching group using suffix matching if necessary
      let groupKey = Object.keys(targetMap).find((k) => isSameInvoice(k, docNo));
      if (!groupKey) {
        groupKey = docNo;
        targetMap[groupKey] = { data: { ...wrapper }, items: {} };
      } else {
        // Upgrade groupKey to the longer (full) number if found
        if (docNo.length > groupKey.length) {
          targetMap[docNo] = targetMap[groupKey];
          if (type === 'INV') targetMap[docNo].data.invoice_number = docNo;
          else targetMap[docNo].data.packing_list_number = docNo;
          delete targetMap[groupKey];
          groupKey = docNo;
        }
        // Merge wrapper fields
        Object.keys(wrapper).forEach((k) => {
          if (k !== 'items' && (targetMap[groupKey].data[k] === undefined || targetMap[groupKey].data[k] === null || targetMap[groupKey].data[k] === '')) {
            targetMap[groupKey].data[k] = wrapper[k];
          }
        });
      }

      if (Array.isArray(wrapper.items)) {
        for (const item of wrapper.items) {
          const itemKey = groupingFn(item);
          if (!targetMap[groupKey].items[itemKey]) {
            targetMap[groupKey].items[itemKey] = { ...item };
          } else {
            // Merge item fields: current values override only if previous was null/empty
            Object.keys(item).forEach((k) => {
              if (item[k] !== null && item[k] !== undefined && item[k] !== '') {
                if (targetMap[groupKey].items[itemKey][k] === undefined || targetMap[groupKey].items[itemKey][k] === null || targetMap[groupKey].items[itemKey][k] === '') {
                  targetMap[groupKey].items[itemKey][k] = item[k];
                }
              }
            });
          }
        }
      }
    }
  };

  // 1. Process Summary Data (SSOT) if exists
  if (summaryData) {
    log.info({ event: 'cipl_ssot_applied' }, 'Menggunakan data Summary sebagai Single Source of Truth');
    processList(summaryData.pl_list, plGroups, getPlItemKey, 'PL');
    processList(summaryData.invoice_list, invoiceGroups, getInvoiceItemKey, 'INV');
  }

  // 2. Process Detailed Data
  processList(masterJson.invoice_list, invoiceGroups, getInvoiceItemKey, 'INV');
  processList(masterJson.pl_list, plGroups, getPlItemKey, 'PL');

  // 3. Rebuild masterJson
  masterJson.invoice_list = Object.values(invoiceGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items)
  }));
  masterJson.pl_list = Object.values(plGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items)
  }));
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
        // Cari targetItem menggunakan isSameInvoice
        let targetItem = target[listKey].find((t) => isSameInvoice(t.invoice_number || 'UNKNOWN', invNo));

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

  const processPageRange = async (start, end, exclude = [], useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const buffer = await extractPageBuffer(pdfDoc, start, end, exclude);
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

  const processPageRangeChunked = async (start, end, exclude = [], useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const CHUNK_SIZE = 3; // Reduced for more thorough extraction
    const promises = [];
    
    // Filter out excluded pages before chunking
    const allPages = [];
    for (let i = start; i <= end; i++) {
      if (!exclude.includes(i)) allPages.push(i);
    }

    if (allPages.length === 0) return null;

    for (let i = 0; i < allPages.length; i += CHUNK_SIZE) {
      const chunkPages = allPages.slice(i, i + CHUNK_SIZE);
      const chunkStart = chunkPages[0];
      const chunkEnd = chunkPages[chunkPages.length - 1];
      // Note: We still use the original start/end logic but extractPageBuffer will handle the exclusion
      // However, to keep it simple, we can just pass the chunk's boundaries.
      promises.push(processPageRange(chunkStart, chunkEnd, exclude, useFullPrompt, context));
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
    model: MODELS.FLAGSHIP, // Gunakan FLAGSHIP untuk 64 hal agar lebih akurat
    contents: [CIPL_BOUNDARY_PROMPT, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }],
    config: { responseMimeType: 'application/json', temperature: 0.1 }
  });
  const boundaryUsage = boundaryResponse.usageMetadata || {};
  tokenUsage.inputTotal += boundaryUsage.promptTokenCount || 0;
  tokenUsage.output += boundaryUsage.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(boundaryUsage);
  tokenUsage.total += boundaryUsage.totalTokenCount || 0;

  const boundary = cleanAIJson(boundaryResponse.text) || {};
  log.info({ event: 'cipl_boundary_detected', boundary }, 'Boundary terdeteksi');

  // Fase 2: Global Context Extraction (Header)
  const headerStart = boundary?.page_contain_header?.start || 1;
  const headerEnd = boundary?.page_contain_header?.end || Math.min(3, totalPages);
  const headerExclude = boundary?.page_contain_header?.exclude || [];
  
  const extraContextPage = (boundary?.page_contain_invoice_data?.start || boundary?.page_contain_packing_list_data?.start);
  const headerScanEnd = extraContextPage && extraContextPage > headerEnd ? Math.min(headerEnd + 1, totalPages) : headerEnd;

  log.info({ event: 'cipl_extracting_header' }, `Fase 2: Mengekstrak Header hal ${headerStart}-${headerScanEnd}`);
  const masterJson = await processPageRange(headerStart, headerScanEnd, headerExclude, true) || {};
  if (!masterJson.invoice_list) masterJson.invoice_list = [];
  if (!masterJson.pl_list) masterJson.pl_list = [];

  const globalContext = {
    buyer_name: masterJson.buyer_name,
    seller_name: masterJson.seller_name,
    packing_list_number: masterJson.packing_list_number,
    // Tersedia informasi invoice dasar tapi tidak membatasi AI menemukan invoice baru
    initial_invoices: (masterJson.invoice_list || []).map((inv) => inv.invoice_number)
  };

  // Fase 3: Invoice Data Extraction
  // Fallback: Jika boundary gagal, scan seluruh halaman sebagai invoice data (minus header)
  const invStart = boundary?.page_contain_invoice_data?.start || headerScanEnd + 1;
  const invEnd = boundary?.page_contain_invoice_data?.end || totalPages;
  const invExclude = boundary?.page_contain_invoice_data?.exclude || [];
  
  if (invStart <= totalPages) {
    log.info({ event: 'cipl_extracting_invoice_data' }, `Fase 3: Mengekstrak Invoice Data hal ${invStart}-${invEnd}`);
    // Gunakan Full Prompt agar format CSV dan struktur JSON konsisten dengan masterJson
    const invData = await processPageRangeChunked(invStart, invEnd, invExclude, true, globalContext);
    mergeCiplChunks(masterJson, invData);
  }

  // Fase 4: Packing List Data Extraction
  const plStart = boundary?.page_contain_packing_list_data?.start;
  const plEnd = boundary?.page_contain_packing_list_data?.end;
  const plExclude = boundary?.page_contain_packing_list_data?.exclude || [];
  
  // Hanya jalankan jika boundary menemukan area PL yang spesifik, atau jika invoice data tidak ditemukan
  if (plStart && plEnd) {
    log.info({ event: 'cipl_extracting_pl_data' }, `Fase 4: Mengekstrak Packing List Data hal ${plStart}-${plEnd}`);
    const plData = await processPageRangeChunked(plStart, plEnd, plExclude, true, globalContext);
    mergeCiplChunks(masterJson, plData);
  }

  // Fase 5: Summary Extraction (SSOT)
  let summaryData = null;
  if (boundary.is_document_contain_summary && boundary.document_summary_page?.start) {
    const sStart = boundary.document_summary_page.start;
    const sEnd = boundary.document_summary_page.end || sStart;
    const sExclude = boundary.document_summary_page.exclude || [];
    log.info({ event: 'cipl_extracting_summary' }, `Fase 5: Mengekstrak Summary (SSOT) hal ${sStart}-${sEnd}`);
    summaryData = await processPageRangeChunked(sStart, sEnd, sExclude, true, globalContext);
  }

  // Final Reconciliation & BE Grouping
  reconcileCiplData(masterJson, summaryData, log);

  // ── DETERMINISTIC POST-PROCESSING ──────────────────────────────────────────

  // [1] packing_list_number Sanitizer: Rule 8A Guard
  if (masterJson.packing_list_number && String(masterJson.packing_list_number).includes(',')) {
    const tokens = String(masterJson.packing_list_number).split(',').map((t) => t.trim()).filter(Boolean);
    const primary = tokens.reduce((a, b) => (a.length >= b.length ? a : b), tokens[0]);
    masterJson.packing_list_number = primary;
  }

  // [2] ship_to Sanitizer: Warehouse Code Cleanup
  if (masterJson.ship_to && typeof masterJson.ship_to === 'string') {
    let cleaned = masterJson.ship_to.replace(/\s*\d+\s*\/\/.*$/i, '').trim();
    cleaned = cleaned.replace(/\s+\d+\s*$/, '').trim();
    masterJson.ship_to = cleaned;
  }

  // [3] Final Cleanup: Remove empty items and map available invoices to pl_list
  if (Array.isArray(masterJson.pl_list)) {
    masterJson.pl_list.forEach(pl => {
      if (!pl.invoice_number || (Array.isArray(pl.invoice_number) && pl.invoice_number.length === 0)) {
        pl.invoice_number = (masterJson.invoice_list || []).map(inv => inv.invoice_number).filter(Boolean);
      }
    });
  }

  await debugLog(docCode, 'cipl_final_output', masterJson);
  log.info({ event: 'cipl_extraction_completed' }, 'CIPL Pipeline Selesai (New Architecture)');
  return masterJson;
};

