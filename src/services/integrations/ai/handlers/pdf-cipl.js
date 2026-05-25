/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt, getExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { getCIPLSectionBoundaryPrompt } from '../../../../prompts/boundary/doc-001.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';

const CONCURRENCY_LIMIT = 4;

// ── Helpers ──────────────────────────────────────────────────────────────────
const limitConcurrency = async (concurrencyLimit, items, asyncFn, log, delayMs = 300) => {
  const results = new Array(items.length);
  const executing = new Set();
  for (let i = 0; i < items.length; i++) {
    const idx = i;
    const p = Promise.resolve().then(async () => {
      try { return { status: 'fulfilled', value: await asyncFn(items[idx]) }; }
      catch (err) { return { status: 'rejected', reason: err, item: items[idx] }; }
    });
    results[idx] = p;
    executing.add(p);
    p.then(() => executing.delete(p));
    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return Promise.all(results);
};

const extractPageBuffer = async (pdfDoc, startPage, endPage, exclude = []) => {
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const startIndex = Math.max(0, startPage - 1);
  const endIndex = Math.min(numPages - 1, endPage - 1);
  const excludeSet = new Set(exclude.map((p) => p - 1));
  const indices = [];
  for (let i = startIndex; i <= endIndex; i++) if (!excludeSet.has(i)) indices.push(i);
  if (indices.length === 0) return null;
  const pages = await singlePdf.copyPages(pdfDoc, indices);
  pages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-A: executeGeminiCall — max_tokens naik per domain
// ─────────────────────────────────────────────────────────────────────────────
// BEFORE: callConfig = { ..., maxOutputTokens: 1000 } hardcoded
//         → 55× json_repair_attempt per run, PL dense rows terpotong
// AFTER:  pl=6000 (window 2 hal), invoice=3000, header/default=2000
// ════════════════════════════════════════════════════════════════════════════
const executeGeminiCall = async (promptData, buffer, log, tokenUsage, domain = null) => {
  const maxTokensByDomain = { pl: 6000, invoice: 3000, header: 2000 };
  const maxOutputTokens = maxTokensByDomain[domain] || 2000;
  const callConfig = { responseMimeType: 'application/json', temperature: 0.0, maxOutputTokens };
  const response = await callGeminiWithRetry(
    [promptData, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
    3, callConfig, log, domain
  );
  const meta = response.usageMetadata || {};
  tokenUsage.inputTotal += meta.promptTokenCount || 0;
  tokenUsage.output    += meta.candidatesTokenCount || 0;
  tokenUsage.ocr       += extractOcrTokens(meta);
  tokenUsage.total     += meta.totalTokenCount || 0;
  return response.parsedData;
};

// ── FIX RC-2: isValidPackageNumber ───────────────────────────────────────────
const isValidPackageNumber = (pkgNum) => {
  if (pkgNum === null || pkgNum === undefined) return false;
  const s = String(pkgNum).trim();
  return s !== '';
};

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-B: isHeaderPollutionRow
// ─────────────────────────────────────────────────────────────────────────────
// ROOT CAUSE: Gemini kadang mengembalikan baris dengan nilai persis nama field
// (prod_number="prod_number", brand="brand", dll) saat halaman kosong atau
// halaman pertama sebelum data muncul. Row ini lolos ke output.
// CONTOH dari raw: { "prod_number":"prod_number", "brand":"brand",
//   "gross_weight":0, "measurement":"measurement", ... }
// ════════════════════════════════════════════════════════════════════════════
const PLACEHOLDER_STRINGS = new Set([
  'prod_number', 'package_number', 'description', 'brand', 'origin',
  'measurement', 'quantity_unit', 'packaging_type', 'packaging_unit',
  'number', 'prod number', 'package number', 'item_number',
]);
const isHeaderPollutionRow = (item) => {
  if (!item) return true;
  const prodStr = item.prod_number != null ? String(item.prod_number).toLowerCase().trim() : '';
  const pkgStr  = item.package_number != null ? String(item.package_number).toLowerCase().trim() : '';
  if (prodStr && PLACEHOLDER_STRINGS.has(prodStr)) return true;
  if (pkgStr  && PLACEHOLDER_STRINGS.has(pkgStr))  return true;
  return false;
};

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-C: normalizeWeight — gross/net weight 0 → null
// ROOT CAUSE: Gemini baca kolom kosong sebagai 0, bukan null
// ════════════════════════════════════════════════════════════════════════════
const normalizeWeight = (val) =>
  (val === null || val === undefined || val === 0) ? null : val;

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-D: normalizePackagingUnit
// ROOT CAUSE: PALLET dengan unit "CT" (seharusnya "PLT") — Gemini salah baca
// ════════════════════════════════════════════════════════════════════════════
const PACKAGING_UNIT_MAP = {
  PALLET: 'PLT', PALLETS: 'PLT',
  CARTON: 'CT',  CARTONS: 'CT',
  BOX: 'BOX',    BOXES: 'BOX',
  CRATE: 'CRT',  DRUM: 'DRM',  BAG: 'BAG',
};
const normalizePackagingUnit = (packagingType, packagingUnit) => {
  if (!packagingType) return packagingUnit;
  return PACKAGING_UNIT_MAP[packagingType.toUpperCase()] ?? packagingUnit;
};

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-E: calculateTotal via integer cents
// ROOT CAUSE: JS float accumulation → 318301.7099999954
// ════════════════════════════════════════════════════════════════════════════
const calculateTotal = (invoiceList) => {
  let totalCents = 0;
  for (const invoice of invoiceList) {
    for (const item of invoice.items) {
      totalCents += Math.round((item.amount || 0) * 100);
    }
  }
  return Math.round(totalCents) / 100;
};

// ════════════════════════════════════════════════════════════════════════════
// FIX v14.3 BUG-F: resolveRootOrigin
// ROOT CAUSE: origin null di header padahal ada di item-level invoice
// ════════════════════════════════════════════════════════════════════════════
const resolveRootOrigin = (headerData, invoiceList) => {
  if (headerData.origin) return headerData.origin;
  for (const invoice of invoiceList) {
    const origin = invoice.items?.[0]?.origin;
    if (origin) return origin;
  }
  return null;
};

// ════════════════════════════════════════════════════════════════════════════
// Header extraction prompt
// ════════════════════════════════════════════════════════════════════════════
const getCiplHeaderExtractionPrompt = () => `Ekstrak informasi HEADER dari dokumen CIPL (Commercial Invoice & Packing List) ini.
Fokus HANYA pada halaman pertama atau halaman yang berisi informasi pengirim/penerima.

Kembalikan JSON dengan struktur berikut (tanpa markdown fence):
{
  "seller_name": "nama shipper/eksportir",
  "seller_address": "alamat lengkap shipper",
  "seller_country": "negara asal pengirim",
  "seller_country_code": "kode 2 huruf (ISO 3166)",
  "seller_phone": "nomor telepon shipper",
  "buyer_name": "nama consignee/importir",
  "buyer_address": "alamat lengkap buyer",
  "buyer_country": "negara tujuan",
  "buyer_country_code": "kode 2 huruf (ISO 3166)",
  "buyer_phone": "nomor telepon buyer",
  "buyer_tax": "NPWP atau tax ID buyer",
  "ship_to": "nama/alamat tujuan pengiriman (jika berbeda dari buyer)",
  "ship_to_city": "kota tujuan pengiriman",
  "shipment_date": "tanggal pengiriman format YYYY-MM-DD",
  "payment_terms": "term pembayaran (misal: T/T, L/C, Net 30)",
  "payment_terms_code": "kode singkat (TT, LC, dll)",
  "inco_terms": "incoterm (misal: FOB, CIF, EXW)",
  "freight_terms": "freight terms jika ada",
  "origin": "negara asal barang",
  "ultimate_dest": "tujuan akhir barang",
  "currency_code": "kode mata uang (USD, EUR, dll)",
  "packaging_total": "total jumlah kemasan (angka)",
  "packaging_type": "jenis kemasan dominan (CARTON, PALLET, dll)",
  "packing_list_date": "tanggal packing list format YYYY-MM-DD",
  "confidence_score": 0.95
}

ATURAN KETAT:
1. Jika field tidak ditemukan di dokumen → null (JANGAN menebak)
2. Tanggal WAJIB format YYYY-MM-DD
3. confidence_score: persentase keyakinan 0.0-1.0
4. Output HANYA JSON valid, tidak ada komentar atau markdown`;

// ════════════════════════════════════════════════════════════════════════════
// FIX RC-1: Sliding Window — PL extraction 2 halaman per call
// ════════════════════════════════════════════════════════════════════════════
const PL_WINDOW_SIZE = 2;

const getPlWindowExtractionPrompt = (docCode, jsonSchema, windowSize) => {
  const basePrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, false, null, 'pl');
  const windowContext = `INSTRUKSI PENTING — MULTI-PAGE CONTEXT:
Anda menerima ${windowSize} halaman PDF sekaligus.
- Halaman 1 s/d ${windowSize - 1}: halaman KONTEKS (untuk referensi nomor PL, header, dll)
- Halaman ${windowSize}: halaman TARGET yang harus di-extract

ATURAN:
1. Ekstrak data item HANYA dari halaman TARGET (halaman terakhir).
2. Gunakan halaman konteks HANYA untuk mengisi field yang tidak ditemukan di halaman target,
   terutama: packing_list_number, packing_list_date, invoice_number.
3. Jika packing_list_number tidak ada di halaman target, cari di halaman konteks.
4. Jangan ekstrak item dari halaman konteks — hanya dari halaman target.

`;
  if (typeof basePrompt === 'string') return windowContext + basePrompt;
  if (Array.isArray(basePrompt)) return [windowContext + (basePrompt[0] || ''), ...basePrompt.slice(1)];
  return windowContext + String(basePrompt);
};

// ════════════════════════════════════════════════════════════════════════════
export const processCiplPdfExtraction = async (
  fileBuffer, docCode, prompt, jsonSchema, tokenUsage, log = logger
) => {
  log.info({ event: 'cipl_extraction_start' }, 'Memulai CIPL Pipeline v14.3');

  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

  // ── processInvoicePages: 1 page per call ─────────────────────────────────
  const processInvoicePages = async (pages, domain = null) => {
    if (!pages || pages.length === 0) return [];
    log.info(`[WORKER] Invoice: ${pages.length} halaman, concurrency=${CONCURRENCY_LIMIT}`);
    const chunkResults = [];
    const settled = await limitConcurrency(
      CONCURRENCY_LIMIT, pages,
      async (pageTarget) => {
        const buffer = await extractPageBuffer(pdfDoc, pageTarget, pageTarget, []);
        if (!buffer) return null;
        const targetPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, false, null, domain);
        const parsedData = await executeGeminiCall(targetPrompt, buffer, log, tokenUsage, domain);
        if (parsedData) parseItemsCsv(parsedData, docCode, domain);
        return parsedData;
      },
      log, 300
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) chunkResults.push(s.value);
      else if (s.status === 'rejected') {
        log.error({ event: 'invoice_page_failed', page: s.item },
          `[INVOICE] Halaman ${s.item} gagal total setelah 3 retry — data hilang`);
      }
    }
    return chunkResults;
  };

  // ── processPlPages: sliding window 2 halaman per call ────────────────────
  const processPlPages = async (pages, allPlPages, domain = 'pl') => {
    if (!pages || pages.length === 0) return [];
    log.info(`[WORKER] PL: ${pages.length} halaman, sliding window (size=${PL_WINDOW_SIZE}), concurrency=${CONCURRENCY_LIMIT}`);
    const plPageSet = new Set(allPlPages);
    const chunkResults = [];
    const settled = await limitConcurrency(
      CONCURRENCY_LIMIT, pages,
      async (pageTarget) => {
        const contextPages = [];
        for (let lookback = PL_WINDOW_SIZE - 1; lookback >= 1; lookback--) {
          const candidate = pageTarget - lookback;
          if (candidate > 0 && plPageSet.has(candidate)) contextPages.push(candidate);
        }
        const startPage = contextPages.length > 0 ? contextPages[0] : pageTarget;
        const buffer = await extractPageBuffer(pdfDoc, startPage, pageTarget, []);
        if (!buffer) return null;
        const windowSize = pageTarget - startPage + 1;
        const targetPrompt = windowSize > 1
          ? getPlWindowExtractionPrompt(docCode, jsonSchema, windowSize)
          : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, null, domain);
        const parsedData = await executeGeminiCall(targetPrompt, buffer, log, tokenUsage, domain);
        if (parsedData) parseItemsCsv(parsedData, docCode, domain);
        log.debug(`[PL-WINDOW] page ${pageTarget}: context=[${contextPages.join(',')}] window=${windowSize}`);
        return parsedData;
      },
      log, 300
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) chunkResults.push(s.value);
      else if (s.status === 'rejected') {
        log.error({ event: 'pl_page_failed', page: s.item },
          `[PL] Halaman ${s.item} gagal total setelah 3 retry — data hilang`);
      }
    }
    return chunkResults;
  };

  // ── Fase 1: Boundary Detection ────────────────────────────────────────────
  log.info({ event: 'cipl_boundary_scan' }, 'Fase 1: Scanning boundary...');
  const boundaryResponse = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      getCIPLSectionBoundaryPrompt(),
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  const rawBoundary = cleanAIJson(boundaryResponse.text) || {};
  const b = Array.isArray(rawBoundary) ? (rawBoundary[0] || {}) : rawBoundary;

  const formatRange = (range) => {
    if (!range || !range.start) return 'N/A';
    const excl = (range.exclude?.length > 0) ? ` (Exclude: ${range.exclude.join(', ')})` : '';
    return `Hal ${range.start} - ${range.end}${excl}`;
  };
  log.info({
    event: 'cipl_boundary_result',
    header_range:        b.page_contain_header,
    invoice_range:       b.page_contain_invoice_data,
    pl_range:            b.page_contain_packing_list_data,
    summary:             b.document_summary_page,
    is_pl_header_repeated: b.pl_header_repeated,
  }, `[BOUNDARY] Header: ${formatRange(b.page_contain_header)} | Invoice: ${formatRange(b.page_contain_invoice_data)} | PL: ${formatRange(b.page_contain_packing_list_data)} | Summary: ${b.is_document_contain_summary ? formatRange(b.document_summary_page) : 'Tidak Ada'}`);

  const summaryPages = new Set();
  if (b.is_document_contain_summary && b.document_summary_page) {
    const sp = b.document_summary_page;
    const spExclude = new Set(sp.exclude || []);
    if (sp.start && sp.end) {
      for (let i = sp.start; i <= sp.end; i++) {
        if (!spExclude.has(i)) summaryPages.add(i);
      }
    }
  }

  const invExclude = new Set([...(b.page_contain_invoice_data?.exclude || []), ...summaryPages]);
  const invoicePages = [];
  if (b.page_contain_invoice_data?.start) {
    for (let i = b.page_contain_invoice_data.start; i <= b.page_contain_invoice_data.end; i++) {
      if (!invExclude.has(i)) invoicePages.push(i);
    }
  }

  const allPlPages = [];
  const plExclude = new Set([...(b.page_contain_packing_list_data?.exclude || []), ...summaryPages]);
  const plPages = [];
  if (b.page_contain_packing_list_data?.start) {
    for (let i = b.page_contain_packing_list_data.start; i <= b.page_contain_packing_list_data.end; i++) {
      allPlPages.push(i);
      if (!plExclude.has(i)) plPages.push(i);
    }
  }

  // ── Fase 0: Header Extraction ─────────────────────────────────────────────
  log.info({ event: 'cipl_header_extraction' }, 'Fase 0: Header extraction...');
  let headerData = {};
  const headerRange = b.page_contain_header;
  if (headerRange?.start) {
    const headerBuffer = await extractPageBuffer(
      pdfDoc, headerRange.start, headerRange.end || headerRange.start, headerRange.exclude || []
    );
    if (headerBuffer) {
      try {
        const headerResponse = await callGeminiWithRetry(
          [getCiplHeaderExtractionPrompt(), { inlineData: { data: headerBuffer.toString('base64'), mimeType: 'application/pdf' } }],
          3, { responseMimeType: 'application/json', temperature: 0.0 }, log, 'header'
        );
        headerData = headerResponse.parsedData || {};
        log.info({
          event: 'cipl_header_extracted',
          fields: Object.keys(headerData).filter((k) => headerData[k] !== null).length,
        }, 'Header berhasil diekstrak');
      } catch (err) {
        log.warn({ event: 'cipl_header_failed', err: err.message }, 'Header extraction gagal, lanjut tanpa header');
      }
    }
  } else {
    log.warn({ event: 'cipl_header_fallback' }, 'Tidak ada page_contain_header dari boundary, gunakan halaman 1-2');
    const fallbackBuffer = await extractPageBuffer(pdfDoc, 1, 2, []);
    if (fallbackBuffer) {
      try {
        const headerResponse = await callGeminiWithRetry(
          [getCiplHeaderExtractionPrompt(), { inlineData: { data: fallbackBuffer.toString('base64'), mimeType: 'application/pdf' } }],
          3, { responseMimeType: 'application/json', temperature: 0.0 }, log, 'header'
        );
        headerData = headerResponse.parsedData || {};
      } catch (err) {
        log.warn({ event: 'cipl_header_fallback_failed' }, 'Header fallback juga gagal');
      }
    }
  }

  const masterJson = { invoice_list: [], pl_list: [] };

  // ── Fase 2: Ekstraksi paralel ─────────────────────────────────────────────
  const invPagesData = await processInvoicePages(invoicePages, 'invoice');
  const plPagesData  = await processPlPages(plPages, allPlPages, 'pl');

  log.info('Fase 3: Merge & Normalize (v14.3)');

  // ── TAHAP 4A — INVOICE MERGE ──────────────────────────────────────────────
  const invoiceMap = new Map();

  for (const page of invPagesData) {
    for (const inv of (page.invoice_list || [])) {
      const key = inv.invoice_number;
      if (!key) continue;

      if (!invoiceMap.has(key)) {
        invoiceMap.set(key, {
          invoice_number: key,
          invoice_date:   inv.invoice_date || null,
          items: [],
          _ctx: { origin: null, origin_code: null, currency: null, vendor_name: null, vendor_number: null },
        });
      }

      const existing = invoiceMap.get(key);
      if (!existing.invoice_date && inv.invoice_date) existing.invoice_date = inv.invoice_date;

      for (const item of (inv.items || [])) {
        if (item.origin       && !existing._ctx.origin)        existing._ctx.origin        = item.origin;
        if (item.origin_code  && !existing._ctx.origin_code)   existing._ctx.origin_code   = item.origin_code;
        if (item.currency     && !existing._ctx.currency)      existing._ctx.currency      = item.currency;
        if (item.vendor_name  && !existing._ctx.vendor_name)   existing._ctx.vendor_name   = item.vendor_name;
        if (item.vendor_number && !existing._ctx.vendor_number) existing._ctx.vendor_number = item.vendor_number;
      }

      existing.items.push(...(inv.items || []));
    }
  }

  masterJson.invoice_list = Array.from(invoiceMap.values()).map((inv) => {
    const ctx = inv._ctx;
    const propagated = inv.items.map((item) => ({
      ...item,
      origin:        item.origin        ?? ctx.origin,
      origin_code:   item.origin_code   ?? ctx.origin_code,
      currency:      item.currency      ?? ctx.currency,
      vendor_name:   item.vendor_name   ?? ctx.vendor_name,
      vendor_number: item.vendor_number ?? ctx.vendor_number,
    }));

    return {
      invoice_number: inv.invoice_number,
      invoice_date:   inv.invoice_date,
      items: propagated.sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        return (isNaN(numA) ? 0 : numA) - (isNaN(numB) ? 0 : numB);
      }),
    };
  });

  // ── TAHAP 4B — PL MERGE (MULTI-PL GROUPING + HARVESTER INHERITANCE + BUG-B FIX) ──
  const PHYSICAL_FIELDS = [
    'net_weight', 'gross_weight', 'measurement',
    'packaging_qty', 'packaging_unit', 'packaging_type', 'brand', 'origin',
  ];
  const plMap = new Map();

  // Variabel memori untuk menyelamatkan baris yang terpotong (Harvester)
  let lastValidPlNumber = 'UNKNOWN_PL';
  let lastValidPlDate = null;

  for (const page of plPagesData) {
    for (const pl of (page.pl_list || [])) {
      let plKey = pl.packing_list_number;

      // 1. Logika PL Number & Date Inheritance (JANGAN DIHAPUS!)
      if (plKey) {
        lastValidPlNumber = plKey;
      } else {
        plKey = lastValidPlNumber; // Inherit nomor PL sebelumnya jika baris saat ini null
      }

      if (pl.packing_list_date) {
        lastValidPlDate = pl.packing_list_date;
      }

      if (!plMap.has(plKey)) {
        plMap.set(plKey, {
          packing_list_number: plKey === 'UNKNOWN_PL' ? null : plKey,
          packing_list_date: pl.packing_list_date || lastValidPlDate || null,
          invoice_number: [...(pl.invoice_number || [])],
          packageMap: new Map(),
        });
      }

      const plEntry = plMap.get(plKey);
      if (!plEntry.packing_list_date && pl.packing_list_date) {
        plEntry.packing_list_date = pl.packing_list_date;
      }
      if (pl.invoice_number?.length) {
        plEntry.invoice_number = [...new Set([...plEntry.invoice_number, ...pl.invoice_number])];
      }

      for (const item of (pl.items || [])) {
        // ── FIX BUG-B: filter header pollution row (Inovasi Claude) ────────
        if (isHeaderPollutionRow(item)) {
          log.debug(`[CIPL] Header pollution row dibuang: PL=${plKey} prod="${item.prod_number}"`);
          continue;
        }

        const pkgKey = item.package_number;
        if (!isValidPackageNumber(pkgKey)) continue;

        const pkgMap = plEntry.packageMap;
        if (!pkgMap.has(pkgKey)) {
          pkgMap.set(pkgKey, {
            package_number: pkgKey,
            net_weight: null, gross_weight: null, measurement: null,
            packaging_qty: null, packaging_unit: null, packaging_type: null,
            brand: null, origin: null,
            items: [],
          });
        }

        const pkg = pkgMap.get(pkgKey);
        for (const field of PHYSICAL_FIELDS) {
          if (pkg[field] === null && item[field] != null) pkg[field] = item[field];
        }

        if (item.prod_number) {
          const isDuplicate = pkg.items.some((i) => i.prod_number === item.prod_number);
          if (!isDuplicate) {
            pkg.items.push({
              item_number:   item.number        || null,
              prod_number:   item.prod_number,
              description:   item.description   || null,
              quantity:      item.quantity      || null,
              quantity_unit: item.quantity_unit || null,
              brand:         item.brand         || null,
              origin:        item.origin        || null,
            });
          }
        }
      }
    }
  }

  // ── TAHAP 5 — FINAL FLATTEN & NORMALIZE ──────────────────────────────────
  const prodDescriptionMap = new Map();
  for (const inv of masterJson.invoice_list) {
    for (const item of inv.items) {
      if (item.prod_number && item.description && !prodDescriptionMap.has(item.prod_number)) {
        prodDescriptionMap.set(item.prod_number, item.description);
      }
    }
  }

  const finalPlList = [];
  for (const pl of Array.from(plMap.values())) {
    const flatItems = [];
    const packages = Array.from(pl.packageMap.values());

    for (const pkg of packages) {
      for (const item of (pkg.items || [])) {
        const description = item.description
          || prodDescriptionMap.get(item.prod_number)
          || null;

        flatItems.push({
          number:         item.item_number ?? item.number ?? null,
          package_number: pkg.package_number,
          prod_number:    item.prod_number  ?? null,
          description,
          quantity:       item.quantity,
          quantity_unit:  item.quantity_unit,
          net_weight:     normalizeWeight(pkg.net_weight),             // FIX BUG-C
          gross_weight:   normalizeWeight(pkg.gross_weight),           // FIX BUG-C
          measurement:    pkg.measurement   ?? null,
          packaging_qty:  pkg.packaging_qty,
          packaging_unit: normalizePackagingUnit(pkg.packaging_type, pkg.packaging_unit), // FIX BUG-D
          packaging_type: pkg.packaging_type,
          brand:  item.brand  ?? pkg.brand  ?? null,
          origin: item.origin ?? pkg.origin ?? null,
        });
      }
    }

    if (flatItems.length === 0) {
      log.warn(`[CIPL] PL ${pl.packing_list_number} dibuang karena items kosong.`);
      continue;
    }

    finalPlList.push({
      packing_list_number: pl.packing_list_number,
      packing_list_date:   pl.packing_list_date,
      invoice_number:      pl.invoice_number,
      items:               flatItems,
    });
  }
  masterJson.pl_list = finalPlList;

  // ── FIX BUG-E: Hitung total via integer cents ─────────────────────────────
  masterJson.total = calculateTotal(masterJson.invoice_list);

  // ── Coerce number → integer (safety net) ─────────────────────────────────
  for (const invoice of masterJson.invoice_list) {
    for (const item of invoice.items) {
      if (item.number !== null && item.number !== undefined) {
        item.number = parseInt(item.number, 10);
        if (isNaN(item.number)) item.number = null;
      }
    }
  }
  for (const pl of masterJson.pl_list) {
    for (const item of pl.items) {
      if (item.number !== null && item.number !== undefined) {
        item.number = parseInt(item.number, 10);
        if (isNaN(item.number)) item.number = null;
      }
    }
  }

  // ── Cross-ref invoice_number di PL yang kosong ────────────────────────────
  const prodToInvoices = new Map();
  for (const invoice of masterJson.invoice_list) {
    for (const item of invoice.items) {
      if (!item.prod_number) continue;
      if (!prodToInvoices.has(item.prod_number)) prodToInvoices.set(item.prod_number, new Set());
      prodToInvoices.get(item.prod_number).add(invoice.invoice_number);
    }
  }
  for (const pl of masterJson.pl_list) {
    if (pl.invoice_number && pl.invoice_number.length > 0) continue;
    const foundInvoices = new Set();
    for (const item of pl.items) {
      if (!item.prod_number) continue;
      const matched = prodToInvoices.get(item.prod_number);
      if (matched) for (const invNum of matched) foundInvoices.add(invNum);
    }
    pl.invoice_number = Array.from(foundInvoices);
  }

  // ── FIX BUG-F: Gabungkan header + resolve origin ──────────────────────────
  const resolvedOrigin = resolveRootOrigin(headerData, masterJson.invoice_list);
  const output = {
    ...headerData,
    origin:       resolvedOrigin,           // FIX BUG-F: override null
    total:        masterJson.total,          // FIX BUG-E: no float leak
    invoice_list: masterJson.invoice_list,
    pl_list:      masterJson.pl_list,
  };

  await debugLog(docCode, 'cipl_final_output', output);
  log.info({
    event:         'cipl_extraction_completed',
    invoice_count: masterJson.invoice_list.length,
    pl_count:      masterJson.pl_list.length,
    total:         masterJson.total,
  }, `CIPL Pipeline v14.3 Selesai — ${masterJson.invoice_list.length} invoice, ${masterJson.pl_list.length} PL, total: ${masterJson.total}`);
  return output;
};