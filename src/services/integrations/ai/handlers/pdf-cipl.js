
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';

const CIPL_BOUNDARY_PROMPT = `Anda adalah ahli ekstraksi dokumen logistik. Tugas Anda menganalisis batas halaman dokumen CIPL (001).
Sebuah dokumen CIPL memiliki struktur berikut:
1. Header: Informasi pengirim, penerima, nomor dokumen utama.
2. Invoice Data: Tabel detail barang yang berisi harga, nilai, dan deskripsi material.
3. Packing List Data: Tabel detail barang yang berisi nomor kemasan (pallet/carton), berat, dan dimensi.

TUGAS ANDA: Tentukan rentang halaman untuk setiap kategori.
PENTING: Gunakan field "exclude" untuk mencantumkan halaman di dalam rentang start-end yang BUKAN merupakan bagian dari kategori tersebut (misal: halaman kosong).

Jawab HANYA dengan JSON murni:
{
  "page_contain_header": {"start": number, "end": number, "exclude": [number]},
  "page_contain_invoice_data": {"start": number, "end": number, "exclude": [number]},
  "page_contain_packing_list_data": {"start": number, "end": number, "exclude": [number]}
}
Keterangan:
- Halaman "data" adalah semua halaman yang memiliki tabel barang.
- Jika satu halaman berisi kedua data (Invoice & PL), cantumkan di kedua kategori.`;


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
const reconcileCiplData = (masterJson, log = logger) => {
  const invoiceGroups = {}; // Key: invoice_number
  const plGroups = {}; // Key: packing_list_number

  // Identity logic as per "Alur kerja (1)" diagram:
  // Invoice matching by invoice number + product_number
  const getInvoiceItemKey = (item) => {
    const invNo = String(item.invoice_number || '').trim();
    const prod = String(item.prod_number || '').trim();
    
    // Fallback: Jika product number tidak ada, tidak usah di-match (append)
    if (!prod) {
      return `APPEND_INV_${Math.random().toString(36).substring(2, 9)}`;
    }

    let key = 'INV';
    if (invNo) key += `_INV_${invNo}`;
    key += `_PROD_${prod}`;
    return key;
  };

  // Packing List matching by packing list number + package_number
  const getPlItemKey = (item) => {
    const plNo = String(item.packing_list_number || '').trim();
    const pkg = String(item.package_number || '').trim();
    
    // Fallback: Jika package_number tidak ada, tidak usah di-match (append)
    if (!pkg) {
      return `APPEND_PL_${Math.random().toString(36).substring(2, 9)}`;
    }

    let key = 'PL';
    if (plNo) key += `_PL_${plNo}`;
    key += `_PKG_${pkg}`;
    return key;
  };

  const processList = (list, targetMap, groupingFn, type) => {
    if (!Array.isArray(list)) return;
    for (const wrapper of list) {
      const docNo = (type === 'INV' ? wrapper.invoice_number : wrapper.packing_list_number) || 'UNKNOWN';
      
      let groupKey = Object.keys(targetMap).find((k) => isSameInvoice(k, docNo));
      if (!groupKey) {
        groupKey = docNo;
        targetMap[groupKey] = { data: { ...wrapper }, items: {} };
      } else {
        if (docNo.length > groupKey.length) {
          targetMap[docNo] = targetMap[groupKey];
          if (type === 'INV') targetMap[docNo].data.invoice_number = docNo;
          else targetMap[docNo].data.packing_list_number = docNo;
          delete targetMap[groupKey];
          groupKey = docNo;
        }
        // Match & Update Header fields (fill nulls)
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
            // MATCH & UPDATE: Isi yang null dari data baru
            Object.keys(item).forEach((k) => {
              if (item[k] !== null && item[k] !== undefined && item[k] !== '') {
                const existingVal = targetMap[groupKey].items[itemKey][k];
                if (existingVal === undefined || existingVal === null || existingVal === '') {
                  targetMap[groupKey].items[itemKey][k] = item[k];
                }
              }
            });
          }
        }
      }
    }
  };

  // Process all extracted data
  processList(masterJson.invoice_list, invoiceGroups, getInvoiceItemKey, 'INV');
  processList(masterJson.pl_list, plGroups, getPlItemKey, 'PL');

  // Rebuild masterJson
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

    // Helper untuk menyatukan list berdasarkan ID dokumen
    const mergeList = (listKey) => {
      if (!Array.isArray(source[listKey])) return;
      if (!target[listKey]) target[listKey] = [];

      const idKey = listKey === 'invoice_list' ? 'invoice_number' : 'packing_list_number';

      for (const srcItem of source[listKey]) {
        const docId = srcItem[idKey] || 'UNKNOWN';
        let targetItem = target[listKey].find((t) => isSameInvoice(t[idKey] || 'UNKNOWN', docId));

        if (!targetItem) {
          targetItem = { ...srcItem };
          targetItem.items = Array.isArray(srcItem.items) ? [...srcItem.items] : [];
          target[listKey].push(targetItem);
        } else {
          Object.keys(srcItem).forEach((k) => {
            if (k !== 'items' && !Array.isArray(srcItem[k])) {
              if (targetItem[k] === undefined || targetItem[k] === null || targetItem[k] === '') {
                targetItem[k] = srcItem[k];
              }
            }
          });
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
  const headerStart = boundary?.page_contain_header?.start;
  const headerEnd = boundary?.page_contain_header?.end;
  const headerExclude = boundary?.page_contain_header?.exclude || [];

  const invStart = boundary?.page_contain_invoice_data?.start;
  const invEnd = boundary?.page_contain_invoice_data?.end || totalPages;
  const invExclude = boundary?.page_contain_invoice_data?.exclude || [];

  const plStart = boundary?.page_contain_packing_list_data?.start;
  const plEnd = boundary?.page_contain_packing_list_data?.end || totalPages;
  const plExclude = boundary?.page_contain_packing_list_data?.exclude || [];
  
  // Sesuai diagram: Jika tidak ada header, ambil halaman pertama data untuk scan bersamaan
  let hStart = headerStart || 1;
  let hEnd = headerEnd || 1;
  
  if (!headerStart) {
    const firstDataPage = Math.min(invStart || totalPages, plStart || totalPages);
    hStart = firstDataPage;
    hEnd = firstDataPage;
  } else {
    // Jika ada header, ambil max 3 halaman header + 1 halaman transisi data (jika perlu)
    hEnd = Math.min(headerEnd, 3);
    const extraContextPage = Math.min(invStart || totalPages, plStart || totalPages);
    if (extraContextPage > hEnd) hEnd = Math.min(hEnd + 1, totalPages);
  }

  log.info({ event: 'cipl_extracting_header' }, `Fase 2: Mengekstrak Header hal ${hStart}-${hEnd}`);
  const masterJson = await processPageRange(hStart, hEnd, headerExclude, true) || {};
  if (!masterJson.invoice_list) masterJson.invoice_list = [];
  if (!masterJson.pl_list) masterJson.pl_list = [];

  const globalContext = {
    buyer_name: masterJson.buyer_name,
    seller_name: masterJson.seller_name,
    packing_list_number: masterJson.packing_list_number,
    initial_invoices: (masterJson.invoice_list || []).map((inv) => inv.invoice_number)
  };

  // Fase 3: Invoice Data Extraction
  // Fallback: Jika boundary gagal, scan seluruh halaman sebagai invoice data (minus header)
  const finalInvStart = invStart || hEnd + 1;

  if (finalInvStart <= totalPages) {
    log.info({ event: 'cipl_extracting_invoice_data' }, `Fase 3: Mengekstrak Invoice Data hal ${finalInvStart}-${invEnd}`);
    // Gunakan Full Prompt agar format CSV dan struktur JSON konsisten dengan masterJson
    const invData = await processPageRangeChunked(finalInvStart, invEnd, invExclude, true, globalContext);
    mergeCiplChunks(masterJson, invData);
  }

  // Fase 4: Packing List Data Extraction
  // Hanya jalankan jika boundary menemukan area PL yang spesifik, atau jika invoice data tidak ditemukan
  if (plStart && plEnd) {
    log.info({ event: 'cipl_extracting_pl_data' }, `Fase 4: Mengekstrak Packing List Data hal ${plStart}-${plEnd}`);
    const plData = await processPageRangeChunked(plStart, plEnd, plExclude, true, globalContext);
    mergeCiplChunks(masterJson, plData);
  }

  // Final Reconciliation & BE Grouping (Matching logic inside)
  reconcileCiplData(masterJson, log);

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
    masterJson.pl_list.forEach((pl) => {
      if (!pl.invoice_number || (Array.isArray(pl.invoice_number) && pl.invoice_number.length === 0)) {
        pl.invoice_number = (masterJson.invoice_list || []).map((inv) => inv.invoice_number).filter(Boolean);
      }
    });
  }

  await debugLog(docCode, 'cipl_final_output', masterJson);
  log.info({ event: 'cipl_extraction_completed' }, 'CIPL Pipeline Selesai (New Architecture)');
  return masterJson;
};

