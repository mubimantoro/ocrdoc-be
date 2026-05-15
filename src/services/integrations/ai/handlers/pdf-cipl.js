
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY PROMPT
// [FIX-1] Ditambahkan: is_document_contain_summary + document_summary_page
// Sesuai n8n Node 2 (Analyze document) boundary detection schema
// ─────────────────────────────────────────────────────────────────────────────
const CIPL_BOUNDARY_PROMPT = `Anda adalah ahli ekstraksi dokumen logistik. Tugas Anda menganalisis batas halaman dokumen CIPL (001).
Sebuah dokumen CIPL memiliki struktur berikut:
1. Header: Informasi pengirim, penerima, nomor dokumen utama, dan syarat pengiriman.
2. Invoice Data: Tabel detail barang berisi harga, nilai, dan deskripsi material per baris.
3. Packing List Data: Tabel detail barang berisi nomor kemasan (pallet/carton), berat, dan dimensi.
4. Summary Page (Opsional): Halaman yang HANYA berisi ringkasan total/agregat, tanpa baris item data.

TUGAS ANDA: Tentukan rentang halaman untuk setiap kategori.

ATURAN PENTING:
- Halaman di-exclude HANYA jika tidak mengandung baris item data sama sekali.
- Halaman yang mengandung baris item TETAP dimasukkan meski juga mengandung header/summary.
- is_document_contain_summary = true HANYA jika ada halaman yang MURNI berisi ringkasan tanpa baris item.
- Jika satu halaman mengandung data Invoice DAN PL sekaligus, cantumkan di kedua kategori.
- Jika is_document_contain_summary = false, set document_summary_page.start dan .end ke null.

Jawab HANYA dengan JSON murni (tanpa markdown fence):
{
  "page_contain_header": {"start": number, "end": number, "exclude": [number]},
  "is_document_contain_summary": boolean,
  "document_summary_page": {"start": number | null, "end": number | null, "exclude": [number]},
  "page_contain_invoice_data": {"start": number, "end": number, "exclude": [number]},
  "page_contain_packing_list_data": {"start": number, "end": number, "exclude": [number]}
}`;


// ─────────────────────────────────────────────────────────────────────────────
// TOP-LEVEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a contiguous page range from a PDF, with optional exclusions.
 * (Tidak berubah dari v2.0)
 */
const extractPageBuffer = async (pdfDoc, startPage, endPage, exclude = []) => {
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const startIndex = Math.max(0, startPage - 1);
  const endIndex = Math.min(numPages - 1, endPage - 1);
  const excludeSet = new Set(exclude.map((p) => p - 1));
  const indices = [];
  for (let i = startIndex; i <= endIndex; i++) {
    if (!excludeSet.has(i)) indices.push(i);
  }
  if (indices.length === 0) return null;
  const pages = await singlePdf.copyPages(pdfDoc, indices);
  pages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

/**
 * [NEW-1] Extract a specific non-contiguous list of page numbers.
 * Digunakan untuk header extraction (n8n "take only header" logic).
 */
const extractSpecificPages = async (pdfDoc, pages) => {
  if (!pages || pages.length === 0) return null;
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const validIndices = pages
    .map((p) => p - 1) // convert ke 0-based index
    .filter((i) => i >= 0 && i < numPages);
  if (validIndices.length === 0) return null;
  const copiedPages = await singlePdf.copyPages(pdfDoc, validIndices);
  copiedPages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

/**
 * [NEW-2] Build set of page numbers yang merupakan summary pages.
 * Digunakan untuk exclude summary pages dari invoice & PL extraction.
 * Sesuai n8n Node 8 (invoice list only) & Node 15 (packing list only).
 */
const buildSummaryPages = (boundary) => {
  const summaryPages = new Set();
  if (boundary.is_document_contain_summary && boundary.document_summary_page) {
    const sp = boundary.document_summary_page;
    if (sp.start && sp.end) {
      for (let i = sp.start; i <= sp.end; i++) {
        if (!(sp.exclude || []).includes(i)) summaryPages.add(i);
      }
    }
  }
  return summaryPages;
};

/**
 * Helper untuk membandingkan nomor invoice secara cerdas (mendukung suffix matching).
 * (Tidak berubah dari v2.0)
 */
const isSameInvoice = (inv1, inv2) => {
  if (!inv1 || !inv2) return false;
  const s1 = String(inv1).trim();
  const s2 = String(inv2).trim();
  if (s1 === s2) return true;
  if (s1.length >= 4 && s2.length >= 4) {
    return s1.endsWith(s2) || s2.endsWith(s1);
  }
  return false;
};

/**
 * Reconcile and group items for CIPL.
 *
 * [FIX-6] getPlItemKey sekarang menggunakan package_number + prod_number sebagai key.
 *   Sebelumnya hanya package_number, sehingga semua item dalam satu package
 *   di-collapse menjadi satu item (bug kritis).
 *   Sesuai n8n merge/reduce Node 18: dedup by prod_number within same package.
 *
 * [FIX-7] deduplicateGhostItems: prioritaskan matching via prod_number (n8n approach),
 *   bukan hanya desc+qty+origin.
 */
const reconcileCiplData = (masterJson, log = logger) => {
  const invoiceGroups = {};
  const plGroups = {};

  // Invoice item key: invoice_number + prod_number
  const getInvoiceItemKey = (item) => {
    const invNo = String(item.invoice_number || '').trim();
    const prod = String(item.prod_number || '').trim();
    if (!prod) {
      return `APPEND_INV_${Math.random().toString(36).substring(2, 9)}`;
    }
    let key = 'INV';
    if (invNo) key += `_INV_${invNo}`;
    key += `_PROD_${prod}`;
    return key;
  };

  // [FIX-6] PL item key: packing_list_number + package_number + prod_number
  // Sebelumnya hanya: packing_list_number + package_number
  // → menyebabkan satu package hanya punya 1 item (semua item di-collapse)
  const getPlItemKey = (item) => {
    const plNo = String(item.packing_list_number || '').trim();
    const pkg = String(item.package_number || '').trim();
    const prod = String(item.prod_number || '').trim();

    // Jika tidak ada package DAN tidak ada prod → tidak bisa di-dedup, treat as appendable
    if (!pkg && !prod) {
      return `APPEND_PL_${Math.random().toString(36).substring(2, 9)}`;
    }

    let key = 'PL';
    if (plNo) key += `_PL_${plNo}`;
    if (pkg) key += `_PKG_${pkg}`;
    if (prod) key += `_PROD_${prod}`;
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
        // Gunakan ID yang lebih panjang (lebih lengkap) sebagai canonical key
        if (docNo.length > groupKey.length) {
          targetMap[docNo] = targetMap[groupKey];
          if (type === 'INV') targetMap[docNo].data.invoice_number = docNo;
          else targetMap[docNo].data.packing_list_number = docNo;
          delete targetMap[groupKey];
          groupKey = docNo;
        }
        // Merge header fields: first-non-null wins
        Object.keys(wrapper).forEach((k) => {
          if (
            k !== 'items' &&
            (targetMap[groupKey].data[k] === undefined ||
              targetMap[groupKey].data[k] === null ||
              targetMap[groupKey].data[k] === '')
          ) {
            targetMap[groupKey].data[k] = wrapper[k];
          }
        });
      }

      if (Array.isArray(wrapper.items)) {
        for (const item of wrapper.items) {
          const itemKey = groupingFn(item);
          if (!targetMap[groupKey].items[itemKey]) {
            targetMap[groupKey].items[itemKey] = { ...item, _tmp_key: itemKey };
          } else {
            // MATCH & UPDATE: first-non-null wins untuk semua field
            // Sesuai n8n merge/reduce: physical fields first-non-null wins
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

  processList(masterJson.invoice_list, invoiceGroups, getInvoiceItemKey, 'INV');
  processList(masterJson.pl_list, plGroups, getPlItemKey, 'PL');

  // [FIX-7] Ghost deduplication: prioritas prod_number matching (n8n approach)
  // Sebelumnya: hanya match by desc+qty+origin
  const deduplicateGhostItems = (groups, type) => {
    Object.values(groups).forEach((group) => {
      const items = Object.values(group.items);
      const withId = items.filter((it) => !it._tmp_key?.startsWith('APPEND'));
      const appendOnly = items.filter((it) => it._tmp_key?.startsWith('APPEND'));

      appendOnly.forEach((ghost) => {
        let match = null;

        // Priority 1 (n8n approach): Match by prod_number
        // Untuk PL, juga cocokkan package_number jika tersedia
        if (ghost.prod_number) {
          match = withId.find((real) => {
            if (!real.prod_number || real.prod_number !== ghost.prod_number) return false;
            if (type === 'PL' && ghost.package_number && real.package_number) {
              return real.package_number === ghost.package_number;
            }
            return true;
          });
        }

        // Priority 2 (fallback): Match by description + quantity + origin
        if (!match) {
          match = withId.find(
            (real) =>
              real.description === ghost.description &&
              real.quantity === ghost.quantity &&
              real.origin === ghost.origin
          );
        }

        if (match) {
          log.info(
            { event: 'cipl_ghost_merged', desc: ghost.description },
            'Menghapus ghost item duplikat'
          );
          // Merge field null dari ghost ke real (first-non-null wins)
          Object.keys(ghost).forEach((k) => {
            if (match[k] === undefined || match[k] === null || match[k] === '') {
              match[k] = ghost[k];
            }
          });
          delete group.items[ghost._tmp_key];
        }
      });
    });
  };

  deduplicateGhostItems(invoiceGroups, 'INV');
  deduplicateGhostItems(plGroups, 'PL');

  // Rebuild masterJson dari grouped data
  masterJson.invoice_list = Object.values(invoiceGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items).map((it) => {
      const { _tmp_key, ...rest } = it;
      return rest;
    }),
  }));
  masterJson.pl_list = Object.values(plGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items).map((it) => {
      const { _tmp_key, ...rest } = it;
      return rest;
    }),
  }));
};


// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export const processCiplPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, log = logger) => {
  log.info({ event: 'cipl_extraction_start' }, 'Memulai CIPL Extraction Pipeline v2.1 (n8n-Aligned)');

  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  // Secured PDF fallback ke one-shot
  if (pdfDoc.isEncrypted) {
    log.warn('Secured PDF terdeteksi — fallback ke One-Shot Extraction');
    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [prompt, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  }

  // ── CLOSURES ────────────────────────────────────────────────────────────────

  /**
   * Merge source chunk ke target masterJson.
   * Primitive fields: first-non-null wins.
   * invoice_list / pl_list: group by ID, concat items.
   */
  const mergeCiplChunks = (target, source) => {
    if (!source) return;

    Object.keys(source).forEach((key) => {
      if (!Array.isArray(source[key]) && typeof source[key] !== 'object') {
        if (target[key] === undefined || target[key] === null || target[key] === '') {
          target[key] = source[key];
        }
      }
    });

    const mergeList = (listKey) => {
      if (!Array.isArray(source[listKey])) return;
      if (!target[listKey]) target[listKey] = [];

      const idKey = listKey === 'invoice_list' ? 'invoice_number' : 'packing_list_number';

      for (const srcItem of source[listKey]) {
        const docId = srcItem[idKey] || 'UNKNOWN';
        let targetItem = target[listKey].find((t) => isSameInvoice(t[idKey] || 'UNKNOWN', docId));

        if (!targetItem) {
          targetItem = { ...srcItem, items: Array.isArray(srcItem.items) ? [...srcItem.items] : [] };
          target[listKey].push(targetItem);
        } else {
          // Merge header fields (first-non-null wins)
          Object.keys(srcItem).forEach((k) => {
            if (k !== 'items' && !Array.isArray(srcItem[k])) {
              if (targetItem[k] === undefined || targetItem[k] === null || targetItem[k] === '') {
                targetItem[k] = srcItem[k];
              }
            }
          });
          // Concat items (dedup dilakukan di reconcileCiplData)
          if (Array.isArray(srcItem.items)) {
            if (!Array.isArray(targetItem.items)) targetItem.items = [];
            targetItem.items = targetItem.items.concat(srcItem.items);
          }
          // Merge items_csv jika ada (untuk kompatibilitas dengan parseItemsCsv)
          if (srcItem.items_csv) {
            if (!targetItem.items_csv) targetItem.items_csv = [];
            const masterCsv = Array.isArray(targetItem.items_csv)
              ? targetItem.items_csv
              : [targetItem.items_csv];
            const batchCsv = Array.isArray(srcItem.items_csv)
              ? srcItem.items_csv
              : [srcItem.items_csv];
            targetItem.items_csv = [...masterCsv, ...batchCsv];
          }
        }
      }
    };

    mergeList('invoice_list');
    mergeList('pl_list');
  };

  /**
   * Process a contiguous page range (start..end minus exclude).
   */
  const processPageRange = async (start, end, exclude = [], useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const buffer = await extractPageBuffer(pdfDoc, start, end, exclude);
    if (!buffer) return null;
    const selectedPrompt = useFullPrompt
      ? prompt
      : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, context);
    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [selectedPrompt, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  };

  /**
   * [NEW-3] Process a specific non-contiguous list of page numbers.
   * Sesuai n8n "header split" yang menggunakan page list spesifik (bukan range).
   */
  const processSpecificPages = async (pageList, useFullPrompt = false, context = null) => {
    if (!pageList || pageList.length === 0) return null;
    const buffer = await extractSpecificPages(pdfDoc, pageList);
    if (!buffer) return null;
    const selectedPrompt = useFullPrompt
      ? prompt
      : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, context);
    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [selectedPrompt, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  };

  /**
   * Process a page range in parallel chunks of CHUNK_SIZE pages.
   *
   * [FIX-5] Sebelumnya: semua chunk menggunakan exclude list global yang sama,
   *   sehingga halaman dalam range chunk yang tidak diexclude secara global
   *   tetap ikut ter-extract meski tidak ada di allPages.
   *   Sekarang: setiap chunk menghitung chunkExclude sendiri berdasarkan
   *   halaman dalam range [chunkStart..chunkEnd] yang tidak ada di chunkPages.
   */
  const processPageRangeChunked = async (start, end, exclude = [], useFullPrompt = false, context = null) => {
    if (!start || !end || start > end) return null;
    const CHUNK_SIZE = 3;
    const promises = [];

    // Filter halaman valid (exclude summary + boundary exclude)
    const excludeSet = new Set(exclude);
    const allPages = [];
    for (let i = start; i <= end; i++) {
      if (!excludeSet.has(i)) allPages.push(i);
    }

    if (allPages.length === 0) return null;

    for (let i = 0; i < allPages.length; i += CHUNK_SIZE) {
      const chunkPages = allPages.slice(i, i + CHUNK_SIZE);
      const chunkStart = chunkPages[0];
      const chunkEnd = chunkPages[chunkPages.length - 1];

      // [FIX-5] Hitung exclude per chunk:
      // Halaman dalam range [chunkStart..chunkEnd] yang TIDAK ada di chunkPages
      const chunkPagesSet = new Set(chunkPages);
      const chunkExclude = [];
      for (let p = chunkStart; p <= chunkEnd; p++) {
        if (!chunkPagesSet.has(p)) chunkExclude.push(p);
      }

      promises.push(processPageRange(chunkStart, chunkEnd, chunkExclude, useFullPrompt, context));
    }

    const results = await Promise.all(promises);
    const mergedResult = {};
    for (const res of results) {
      if (res) mergeCiplChunks(mergedResult, res);
    }
    return mergedResult;
  };

  // ── FASE 1: BOUNDARY DETECTION ───────────────────────────────────────────
  // [FIX-2] Gunakan MODELS.CHEAP (gemini-3.1-flash-lite) — sesuai n8n Node 2
  // Boundary detection adalah tugas struktural ringan, tidak butuh FLAGSHIP
  log.info({ event: 'cipl_boundary_scan' }, 'Fase 1: Scanning boundary dokumen...');

  const boundaryResponse = await ai.models.generateContent({
    model: MODELS.CHEAP, // [FIX-2] Was: MODELS.FLAGSHIP
    contents: [
      CIPL_BOUNDARY_PROMPT,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });

  const boundaryUsage = boundaryResponse.usageMetadata || {};
  tokenUsage.inputTotal += boundaryUsage.promptTokenCount || 0;
  tokenUsage.output += boundaryUsage.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(boundaryUsage);
  tokenUsage.total += boundaryUsage.totalTokenCount || 0;

  const boundary = cleanAIJson(boundaryResponse.text) || {};
  log.info({ event: 'cipl_boundary_detected', boundary }, 'Boundary terdeteksi');

  // Ekstrak boundary ranges
  const headerStart = boundary?.page_contain_header?.start;
  const headerEnd = boundary?.page_contain_header?.end;
  const headerExclude = boundary?.page_contain_header?.exclude || [];

  const invStart = boundary?.page_contain_invoice_data?.start;
  const invEnd = boundary?.page_contain_invoice_data?.end || totalPages;
  const invExclude = boundary?.page_contain_invoice_data?.exclude || [];

  const plStart = boundary?.page_contain_packing_list_data?.start;
  const plEnd = boundary?.page_contain_packing_list_data?.end || totalPages;
  const plExclude = boundary?.page_contain_packing_list_data?.exclude || [];

  // [FIX-4] Build summary pages set — akan di-exclude dari invoice & PL extraction
  // Sesuai n8n Node 8 (invoice list only) & Node 15 (packing list only)
  const summaryPagesSet = buildSummaryPages(boundary);
  if (summaryPagesSet.size > 0) {
    log.info(
      { event: 'cipl_summary_pages_detected', pages: Array.from(summaryPagesSet) },
      `Summary pages terdeteksi: [${Array.from(summaryPagesSet).join(',')}] — akan di-exclude`
    );
  }

  // Final exclude lists = boundary exclude + summary pages
  const finalInvExclude = Array.from(new Set([...invExclude, ...summaryPagesSet]));
  const finalPlExclude = Array.from(new Set([...plExclude, ...summaryPagesSet]));


  // ── FASE 2: HEADER EXTRACTION ─────────────────────────────────────────────
  // [FIX-3] Implementasi eksak logika n8n NODE 4 "take only header":
  //   1. Ambil semua halaman header (setelah apply exclude), max 3 halaman
  //   2. Tambahkan halaman pertama invoice & PL sebagai transition context
  //   3. Deduplicate & sort ascending
  //   4. Extract halaman spesifik (bukan range) menggunakan processSpecificPages

  const firstInvPage = invStart || 1;
  const firstPlPage = plStart || 1;

  let rawHeaderPages = [];
  if (headerStart && headerEnd) {
    const hExcludeSet = new Set(headerExclude);
    for (let i = headerStart; i <= headerEnd; i++) {
      if (!hExcludeSet.has(i)) rawHeaderPages.push(i);
    }
    rawHeaderPages = rawHeaderPages.slice(0, 3); // max 3 halaman header (sesuai n8n)
  }

  // Gabungkan: max 3 header pages + first invoice page + first PL page
  const finalHeaderPages = Array.from(new Set([...rawHeaderPages, firstInvPage, firstPlPage]))
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  log.info(
    { event: 'cipl_extracting_header', pages: finalHeaderPages },
    `Fase 2: Mengekstrak Header halaman [${finalHeaderPages.join(',')}]`
  );

  // [NEW-3] Gunakan processSpecificPages (bukan processPageRange) untuk header
  const masterJson = (await processSpecificPages(finalHeaderPages, true)) || {};
  if (!masterJson.invoice_list) masterJson.invoice_list = [];
  if (!masterJson.pl_list) masterJson.pl_list = [];

  // Global context untuk disambiguasi invoice pada chunk berikutnya
  const globalContext = {
    buyer_name: masterJson.buyer_name,
    seller_name: masterJson.seller_name,
    packing_list_number: masterJson.packing_list_number,
    initial_invoices: (masterJson.invoice_list || []).map((inv) => inv.invoice_number),
    initial_items: [
      ...(masterJson.invoice_list || []).flatMap((inv) =>
        (inv.items || []).map((it) => it.prod_number)
      ),
      ...(masterJson.pl_list || []).flatMap((pl) =>
        (pl.items || []).map((it) => it.package_number)
      ),
    ]
      .filter(Boolean)
      .slice(0, 20), // Batasi untuk hemat token
  };


  // ── FASE 3: INVOICE DATA EXTRACTION ──────────────────────────────────────
  // [FIX-4] finalInvExclude sudah include summary pages
  const lastHeaderPage = finalHeaderPages.length > 0
    ? finalHeaderPages[finalHeaderPages.length - 1]
    : 0;
  const finalInvStart = invStart || lastHeaderPage + 1;

  if (finalInvStart && finalInvStart <= totalPages) {
    log.info(
      { event: 'cipl_extracting_invoice_data', range: `${finalInvStart}-${invEnd}`, exclude: finalInvExclude },
      `Fase 3: Mengekstrak Invoice Data hal ${finalInvStart}-${invEnd}`
    );
    const invData = await processPageRangeChunked(finalInvStart, invEnd, finalInvExclude, true, globalContext);
    mergeCiplChunks(masterJson, invData);
  }


  // ── FASE 4: PACKING LIST DATA EXTRACTION ─────────────────────────────────
  // [FIX-4] finalPlExclude sudah include summary pages
  if (plStart && plEnd) {
    log.info(
      { event: 'cipl_extracting_pl_data', range: `${plStart}-${plEnd}`, exclude: finalPlExclude },
      `Fase 4: Mengekstrak Packing List Data hal ${plStart}-${plEnd}`
    );
    const plData = await processPageRangeChunked(plStart, plEnd, finalPlExclude, true, globalContext);
    mergeCiplChunks(masterJson, plData);
  }


  // ── FASE 5: RECONCILIATION ────────────────────────────────────────────────
  // Grouping, dedup, first-non-null merge
  reconcileCiplData(masterJson, log);


  // ── DETERMINISTIC POST-PROCESSING ────────────────────────────────────────

  // [PP-1] packing_list_number Sanitizer: ambil token terpanjang jika ada koma
  if (masterJson.packing_list_number && String(masterJson.packing_list_number).includes(',')) {
    const tokens = String(masterJson.packing_list_number)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const primary = tokens.reduce((a, b) => (a.length >= b.length ? a : b), tokens[0]);
    masterJson.packing_list_number = primary;
  }

  // [PP-2] ship_to Sanitizer: hapus warehouse code suffix
  if (masterJson.ship_to && typeof masterJson.ship_to === 'string') {
    let cleaned = masterJson.ship_to.replace(/\s*\d+\s*\/\/.*$/i, '').trim();
    cleaned = cleaned.replace(/\s+\d+\s*$/, '').trim();
    masterJson.ship_to = cleaned;
  }

  // [NEW-4] [PP-3] Sort invoice items by number ASC
  // Sesuai n8n Code JS3: items.sort((a, b) => (a.number || 0) - (b.number || 0))
  if (Array.isArray(masterJson.invoice_list)) {
    masterJson.invoice_list.forEach((inv) => {
      if (Array.isArray(inv.items)) {
        inv.items.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
      }
    });
  }

  // [NEW-5] [PP-4] n8n Code JS4 Equivalent
  // ─── Part A: Hitung total otomatis jika null ───────────────────────────
  // Sesuai n8n Code JS4 Bagian 1:
  // if (input.total === null) { sum semua item.amount dari invoice_list }
  if (masterJson.total === null || masterJson.total === undefined) {
    let calculatedTotal = 0;
    for (const invoice of (masterJson.invoice_list || [])) {
      for (const item of (invoice.items || [])) {
        calculatedTotal += Number(item.amount) || 0;
      }
    }
    if (calculatedTotal > 0) {
      masterJson.total = calculatedTotal;
      log.info(
        { event: 'cipl_total_calculated', total: calculatedTotal },
        'Total dihitung otomatis dari sum invoice items'
      );
    }
  }

  // ─── Part B: Build prod_number → invoice_number map ───────────────────
  // Sesuai n8n Code JS4 Bagian 2
  const prodToInvoices = new Map();
  for (const invoice of (masterJson.invoice_list || [])) {
    if (!invoice.invoice_number) continue;
    for (const item of (invoice.items || [])) {
      if (!item.prod_number) continue;
      if (!prodToInvoices.has(item.prod_number)) {
        prodToInvoices.set(item.prod_number, new Set());
      }
      prodToInvoices.get(item.prod_number).add(invoice.invoice_number);
    }
  }

  // ─── Part C: Fill invoice_number kosong di PL via prod_number matching ─
  // Sesuai n8n Code JS4 Bagian 3
  // Sebelumnya (v2.0): assign SEMUA invoice_number ke PL yang kosong — tidak akurat
  // Sekarang: match via prod_number terlebih dahulu, fallback ke semua jika tidak ada match
  if (Array.isArray(masterJson.pl_list)) {
    masterJson.pl_list.forEach((pl) => {
      // Skip PL yang sudah punya invoice_number valid
      if (pl.invoice_number && Array.isArray(pl.invoice_number) && pl.invoice_number.length > 0) {
        return;
      }

      const found = new Set();
      for (const item of (pl.items || [])) {
        if (!item.prod_number) continue;
        const matched = prodToInvoices.get(item.prod_number);
        if (matched) for (const n of matched) found.add(n);
      }

      if (found.size > 0) {
        pl.invoice_number = Array.from(found);
        log.info(
          { event: 'cipl_pl_invoice_filled_by_prod', plNo: pl.packing_list_number, invoices: pl.invoice_number },
          'invoice_number diisi via prod_number matching'
        );
      } else {
        // Fallback: assign semua invoice yang tersedia (last resort)
        const allInvoiceNos = (masterJson.invoice_list || [])
          .map((inv) => inv.invoice_number)
          .filter(Boolean);
        if (allInvoiceNos.length > 0) {
          pl.invoice_number = allInvoiceNos;
          log.warn(
            { event: 'cipl_pl_invoice_fallback', plNo: pl.packing_list_number },
            'invoice_number diisi via fallback (prod_number tidak ditemukan di invoice)'
          );
        }
      }
    });
  }

  await debugLog(docCode, 'cipl_final_output', masterJson);
  log.info({ event: 'cipl_extraction_completed' }, 'CIPL Pipeline v2.1 Selesai (n8n-Aligned)');
  return masterJson;
};