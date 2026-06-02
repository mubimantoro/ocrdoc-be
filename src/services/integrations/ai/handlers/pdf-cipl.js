/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { getCIPLSectionBoundaryPrompt } from '../../../../prompts/boundary/doc-001.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';
import fs from 'fs/promises';
import path from 'path';

// ─── n8n-aligned batch sizes ─────────────────────────────────────────────────
const CONCURRENCY_LIMIT  = 2;
const PL_BATCH_SIZE      = 5; // n8n: 5
const INVOICE_BATCH_SIZE = 5; // n8n: 5

// ─── Page debug helpers (tidak berubah) ──────────────────────────────────────
let _pageDebugDir = null;
let _runId        = null;

const initPageDebug = (docCode) => {
  const baseDir = process.env.PAGE_DEBUG_DIR;
  if (!baseDir) return;
  _runId        = Date.now();
  _pageDebugDir = path.join(baseDir, `${docCode}_${_runId}`);
};

const writePageDebugLog = async (domain, pageNum, rawAiOutput, parsedResult, meta = {}) => {
  if (!_pageDebugDir) return;
  try {
    await fs.mkdir(_pageDebugDir, { recursive: true });
    const plEntries  = parsedResult?.pl_list      || [];
    const invEntries = parsedResult?.invoice_list || [];
    const targetList = domain === 'pl' ? plEntries : invEntries;
    const summary = {
      page:          pageNum,
      domain,
      timestamp:     new Date().toISOString(),
      token_usage:   meta.tokens || null,
      entries_count: targetList.length,
      entries: targetList.map((entry) => {
        if (domain === 'pl') {
          const items = entry.items || [];
          const pkgs  = [...new Set(items.map((i) => i.package_number).filter(Boolean))];
          return {
            packing_list_number: entry.packing_list_number,
            invoice_number:      entry.invoice_number,
            items_count:         items.length,
            unique_pkg_numbers:  pkgs.length,
            pkg_numbers_sample:  pkgs.slice(0, 5),
            flag_pkg_collapse:   pkgs.length > 3,
            flag_null_pl_number: !entry.packing_list_number,
          };
        }
        const items = entry.items || [];
        return {
          invoice_number:  entry.invoice_number,
          items_count:     items.length,
          has_null_number: items.some((i) => i.number == null),
          has_null_prod:   items.some((i) => !i.prod_number),
          pkg_ref_count:   items.filter((i) => i.packaging_type_item).length,
        };
      }),
      flags: {
        has_null_pl_number: domain === 'pl' && targetList.some((e) => !e.packing_list_number),
        has_pkg_collapse:   domain === 'pl' && targetList.some((e) => {
          const pkgs = [...new Set((e.items || []).map((i) => i.package_number).filter(Boolean))];
          return pkgs.length > 3;
        }),
        zero_entries: targetList.length === 0,
      },
      raw_output_file: `page_${domain}_${pageNum}_raw.json`,
    };
    const summaryFile = path.join(_pageDebugDir, `page_${domain}_${pageNum}.json`);
    const rawFile     = path.join(_pageDebugDir, `page_${domain}_${pageNum}_raw.json`);
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
    await fs.writeFile(rawFile,     JSON.stringify(rawAiOutput ?? parsedResult, null, 2));
  } catch (err) {
    logger.warn(`[PAGE-DEBUG] Gagal tulis log halaman ${pageNum}: ${err.message}`);
  }
};

const writePageDebugIndex = async (domain, allSummaries) => {
  if (!_pageDebugDir) return;
  try {
    const flagged = allSummaries.filter((s) =>
      s?.flags?.has_null_pl_number ||
      s?.flags?.has_pkg_collapse   ||
      s?.flags?.zero_entries
    );
    const index = {
      domain,
      run_id:        _runId,
      total_pages:   allSummaries.length,
      total_entries: allSummaries.reduce((acc, s) => acc + (s?.entries_count || 0), 0),
      flagged_pages: flagged.map((s) => ({ page: s.page, flags: s.flags, entries: s.entries_count })),
      per_page:      allSummaries.map((s) => ({ page: s?.page, entries: s?.entries_count ?? 0, flags: s?.flags ?? {} })),
    };
    const indexFile = path.join(_pageDebugDir, `_INDEX_${domain}.json`);
    await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
    logger.info(`[PAGE-DEBUG] Index tersimpan: ${indexFile}`);
    logger.info(`[PAGE-DEBUG] ${flagged.length} halaman bermasalah dari ${allSummaries.length} total`);
  } catch (err) {
    logger.warn(`[PAGE-DEBUG] Gagal tulis index: ${err.message}`);
  }
};

// ─── Concurrency & PDF helpers (tidak berubah) ───────────────────────────────
const limitConcurrency = async (concurrencyLimit, items, asyncFn, log, delayMs = 1500) => {
  const results  = new Array(items.length);
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
  const singlePdf   = await PDFDocument.create();
  const numPages    = pdfDoc.getPageCount();
  const startIndex  = Math.max(0, startPage - 1);
  const endIndex    = Math.min(numPages - 1, endPage - 1);
  const excludeSet  = new Set(exclude.map((p) => p - 1));
  const indices     = [];
  for (let i = startIndex; i <= endIndex; i++) if (!excludeSet.has(i)) indices.push(i);
  if (indices.length === 0) return null;
  const pages = await singlePdf.copyPages(pdfDoc, indices);
  pages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

const extractBatchBuffer = (pdfDoc, batch) => {
  if (!batch || batch.length === 0) return Promise.resolve(null);
  const minPage  = Math.min(...batch);
  const maxPage  = Math.max(...batch);
  const batchSet = new Set(batch);
  const gaps     = [];
  for (let p = minPage; p <= maxPage; p++) {
    if (!batchSet.has(p)) gaps.push(p);
  }
  return extractPageBuffer(pdfDoc, minPage, maxPage, gaps);
};

const executeGeminiCall = async (promptData, buffer, log, tokenUsage, domain = null) => {
  const maxOutputTokens = 65536;
  const callConfig      = { responseMimeType: 'text/plain', temperature: 0.0, maxOutputTokens };
  const response        = await callGeminiWithRetry(
    [promptData, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
    3, callConfig, log, domain
  );
  const meta = response.usageMetadata || {};
  tokenUsage.inputTotal += meta.promptTokenCount    || 0;
  tokenUsage.output     += meta.candidatesTokenCount || 0;
  tokenUsage.ocr        += extractOcrTokens(meta);
  tokenUsage.total      += meta.totalTokenCount     || 0;
  return { parsedData: response.parsedData, tokens: meta.totalTokenCount || 0 };
};

// ─── Header pollution filter (tidak berubah) ─────────────────────────────────
const PLACEHOLDER_STRINGS = new Set([
  'prod_number', 'package_number', 'description', 'brand', 'origin',
  'measurement', 'quantity_unit', 'packaging_type', 'packaging_unit',
  'number', 'prod number', 'package number', 'item_number',
]);

const isHeaderPollutionRow = (item) => {
  if (!item) return true;
  const prodStr = item.prod_number    != null ? String(item.prod_number).toLowerCase().trim()    : '';
  const pkgStr  = item.package_number != null ? String(item.package_number).toLowerCase().trim() : '';
  if (prodStr && PLACEHOLDER_STRINGS.has(prodStr)) return true;
  if (pkgStr  && PLACEHOLDER_STRINGS.has(pkgStr))  return true;
  return false;
};

// ─── Invoice dedup (tidak berubah) ───────────────────────────────────────────
const countNonNull = (obj) =>
  Object.values(obj).filter((v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)).length;

const deduplicateInvoiceItems = (items) => {
  const byNumber = new Map();
  const noNumber = [];
  for (const item of items) {
    if (item.number != null) {
      const key = item.number;
      if (!byNumber.has(key) || countNonNull(item) > countNonNull(byNumber.get(key))) {
        byNumber.set(key, item);
      }
    } else {
      noNumber.push(item);
    }
  }
  return [...Array.from(byNumber.values()), ...noNumber];
};

// ─── PL dedup — n8n Strategy B: flat key merge ───────────────────────────────
//
// Urutan prioritas merge key (identik dengan n8n node "merge / reduce1"):
//   1. package_number  → key: "pkg::{package_number}"
//   2. prod_number     → key: "prod::{prod_number}"
//   3. tidak keduanya  → key unik, tidak di-merge
//
// Merge rule: non-null wins — field yang sudah terisi tidak ditimpa.
//
const deduplicatePlItems = (plKey, items) => {
  const mergeMap   = new Map();
  const orderedKeys = [];
  let unmergedIdx  = 0;

  for (const item of items) {
    const pkgStr = item.package_number != null && String(item.package_number).trim() !== ''
      ? String(item.package_number).trim()
      : null;

    let key;
    if (pkgStr) {
      key = `pkg::${pkgStr}`;
    } else if (item.prod_number) {
      key = `prod::${item.prod_number}`;
    } else {
      // Tidak bisa di-merge — key unik per item
      key = `unmerged::${unmergedIdx++}`;
    }

    if (!mergeMap.has(key)) {
      mergeMap.set(key, { ...item });
      orderedKeys.push(key);
    } else {
      // Non-null wins: isi field yang kosong dari entry berikutnya
      const existing = mergeMap.get(key);
      for (const [field, val] of Object.entries(item)) {
        if (existing[field] === null || existing[field] === undefined) {
          existing[field] = val;
        }
      }
    }
  }

  return orderedKeys.map((k) => mergeMap.get(k));
};

// ─── Utilities ───────────────────────────────────────────────────────────────
const calculateTotal = (invoiceList) => {
  let totalCents = 0;
  for (const invoice of invoiceList) {
    for (const item of invoice.items) {
      totalCents += Math.round((item.amount || 0) * 100);
    }
  }
  return Math.round(totalCents) / 100;
};

const resolveRootOrigin = (headerData, invoiceList) => {
  if (headerData.origin) return headerData.origin;
  for (const invoice of invoiceList) {
    const origin = invoice.items?.[0]?.origin;
    if (origin) return origin;
  }
  return null;
};

// ─── Header prompt — sesuai n8n schema (tambah "total", hapus confidence_score)
const getCiplHeaderExtractionPrompt = () =>
  `Ekstrak informasi HEADER dari dokumen CIPL (Commercial Invoice & Packing List) ini.
Hanya extract yang secara eksplisit tertulis dan sesuai dengan skema yang diberikan.
Jika ada indikator dimana valuenya secara reasoning kamu temukan, maka hanya isi jika
indikatornya kuat, misalnya di atas 70% yakin.

Output HARUS berupa JSON valid dengan struktur berikut (tanpa markdown fence):
{
  "packing_list_date": "YYYY-MM-DD",
  "seller_name": "nama shipper",
  "seller_address": "alamat lengkap shipper",
  "seller_country": "negara asal pengirim",
  "seller_country_code": "kode 2 huruf ISO 3166-1 alpha-2",
  "seller_phone": "nomor telepon shipper",
  "buyer_name": "nama consignee",
  "buyer_address": "alamat lengkap buyer",
  "buyer_country": "negara tujuan",
  "buyer_country_code": "kode 2 huruf ISO 3166-1 alpha-2",
  "buyer_phone": "nomor telepon buyer",
  "buyer_tax": "NPWP atau tax ID buyer",
  "ship_to": "nama atau alamat tujuan pengiriman",
  "ship_to_city": "kota tujuan",
  "shipment_date": "YYYY-MM-DD",
  "payment_terms": "term pembayaran",
  "payment_terms_code": "kode singkat term",
  "inco_terms": "incoterm",
  "freight_terms": "freight terms",
  "origin": "negara asal barang",
  "ultimate_dest": "tujuan akhir pengiriman",
  "total": null,
  "currency_code": "kode mata uang ISO 4217",
  "packaging_total": null,
  "packaging_type": "jenis kemasan"
}`;

// ════════════════════════════════════════════════════════════════════════════
export const processCiplPdfExtraction = async (
  fileBuffer, docCode, prompt, jsonSchema, tokenUsage, log = logger
) => {
  log.info(
    { event: 'cipl_extraction_start' },
    'Memulai CIPL Pipeline v15.0 (n8n-aligned: PL_BATCH=5, INV_BATCH=5)'
  );
  initPageDebug(docCode);

  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

  // ── Worker: Invoice ─────────────────────────────────────────────────────
  const processInvoicePages = async (pages, domain = 'invoice') => {
    if (!pages || pages.length === 0) return [];
    const batches = chunkArray(pages, INVOICE_BATCH_SIZE);
    log.info(
      `[WORKER] Invoice: ${pages.length} halaman → ${batches.length} batch` +
      ` (batchSize=${INVOICE_BATCH_SIZE}), concurrency=${CONCURRENCY_LIMIT}`
    );
    const pageSummaries = [];
    const chunkResults  = [];
    const settled = await limitConcurrency(
      CONCURRENCY_LIMIT, batches,
      async (batch) => {
        const buffer = await extractBatchBuffer(pdfDoc, batch);
        if (!buffer) return null;
        const targetPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, false, null, domain);
        const { parsedData, tokens } = await executeGeminiCall(targetPrompt, buffer, log, tokenUsage, domain);
        if (parsedData) parseItemsCsv(parsedData, docCode, domain);
        const repPage = batch[0];
        const summary = { page: repPage, batch, domain, entries_count: 0, flags: {}, entries: [] };
        if (parsedData) {
          const list            = parsedData.invoice_list || [];
          summary.entries_count = list.length;
          summary.entries       = list.map((e) => ({
            invoice_number: e.invoice_number,
            items_count:    (e.items || []).length,
          }));
          summary.flags.zero_entries = list.length === 0;
          summary.tokens             = tokens;
        }
        await writePageDebugLog(domain, repPage, null, parsedData, { tokens });
        pageSummaries.push(summary);
        return parsedData;
      },
      log, 1500
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) chunkResults.push(s.value);
      else if (s.status === 'rejected')
        log.warn(
          { event: 'batch_failed', pages: s.item, reason: s.reason?.message },
          '[WORKER] Batch gagal setelah max retry — data halaman ini hilang'
        );
    }
    await writePageDebugIndex(domain, pageSummaries);
    return chunkResults;
  };

  // ── Worker: Packing List ─────────────────────────────────────────────────
  const processPlPages = async (pages, domain = 'pl') => {
    if (!pages || pages.length === 0) return [];
    const batches = chunkArray(pages, PL_BATCH_SIZE);
    log.info(
      `[WORKER] PL: ${pages.length} halaman → ${batches.length} batch` +
      ` (batchSize=${PL_BATCH_SIZE}), concurrency=${CONCURRENCY_LIMIT}`
    );
    const pageSummaries = [];
    const chunkResults  = [];
    const settled = await limitConcurrency(
      CONCURRENCY_LIMIT, batches,
      async (batch) => {
        const buffer = await extractBatchBuffer(pdfDoc, batch);
        if (!buffer) return null;
        const targetPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, false, null, domain);
        const { parsedData, tokens } = await executeGeminiCall(targetPrompt, buffer, log, tokenUsage, domain);
        if (parsedData) parseItemsCsv(parsedData, docCode, domain);
        const repPage = batch[0];
        const summary = { page: repPage, batch, domain, entries_count: 0, flags: {}, entries: [], tokens };
        if (parsedData) {
          const list            = parsedData.pl_list || [];
          summary.entries_count = list.length;
          summary.entries       = list.map((e) => {
            const items = e.items || [];
            const pkgs  = [...new Set(items.map((i) => i.package_number).filter(Boolean))];
            return {
              packing_list_number: e.packing_list_number,
              invoice_number:      e.invoice_number,
              items_count:         items.length,
              unique_pkg_count:    pkgs.length,
              pkg_sample:          pkgs.slice(0, 4),
              flag_null_pl_number: !e.packing_list_number,
              flag_pkg_collapse:   pkgs.length > 3,
            };
          });
          summary.flags = {
            zero_entries:       list.length === 0,
            has_null_pl_number: list.some((e) => !e.packing_list_number),
            has_pkg_collapse:   list.some((e) => {
              const pkgs = [...new Set((e.items || []).map((i) => i.package_number).filter(Boolean))];
              return pkgs.length > 3;
            }),
          };
        }
        await writePageDebugLog(domain, repPage, null, parsedData, { tokens });
        pageSummaries.push(summary);
        return parsedData;
      },
      log, 1500
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) chunkResults.push(s.value);
      else if (s.status === 'rejected')
        log.warn(
          { event: 'batch_failed', pages: s.item, reason: s.reason?.message },
          '[WORKER] Batch gagal setelah max retry — data halaman ini hilang'
        );
    }
    await writePageDebugIndex(domain, pageSummaries);
    return chunkResults;
  };

  // ── Fase 1: Boundary Scan ────────────────────────────────────────────────
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
  const b           = Array.isArray(rawBoundary) ? (rawBoundary[0] || {}) : rawBoundary;

  log.info({ event: 'cipl_boundary_result', boundary: b }, 'Boundary scan selesai');

  // ── Summary pages ────────────────────────────────────────────────────────
  const summaryPages = new Set();
  if (b.is_document_contain_summary && b.document_summary_page) {
    const sp = b.document_summary_page;
    if (Array.isArray(sp.pages)) sp.pages.forEach((page) => summaryPages.add(page));
  }

  // ── Page range computation ───────────────────────────────────────────────
  const invExclude  = new Set([...(b.page_contain_invoice_data?.exclude || []), ...summaryPages]);
  const invoicePages = [];
  if (b.page_contain_invoice_data?.start) {
    for (let i = b.page_contain_invoice_data.start; i <= b.page_contain_invoice_data.end; i++) {
      if (!invExclude.has(i)) invoicePages.push(i);
    }
  }

  const plExclude = new Set([...(b.page_contain_packing_list_data?.exclude || []), ...summaryPages]);
  const plPages   = [];
  if (b.page_contain_packing_list_data?.start) {
    for (let i = b.page_contain_packing_list_data.start; i <= b.page_contain_packing_list_data.end; i++) {
      if (!plExclude.has(i)) plPages.push(i);
    }
  }

  log.info({
    event:         'cipl_page_ranges',
    invoice_pages: invoicePages.length,
    pl_pages:      plPages.length,
    summary_pages: summaryPages.size,
  }, 'Range halaman terdeteksi');

  // ── Fase 0: Header Extraction ────────────────────────────────────────────
  log.info({ event: 'cipl_header_extraction' }, 'Fase 0: Header extraction...');
  let headerData   = {};
  const headerRange = b.page_contain_header;
  if (headerRange?.start) {
    const rawHeaderPages = [];
    for (let i = headerRange.start; i <= (headerRange.end ?? headerRange.start); i++) {
      if (!(headerRange.exclude || []).includes(i)) rawHeaderPages.push(i);
    }
    // Max 3 header pages + first invoice page + first PL page (konteks, sesuai n8n)
    const headerPages   = rawHeaderPages.slice(0, 3);
    const firstInvoice  = b.page_contain_invoice_data?.start;
    const firstPL       = b.page_contain_packing_list_data?.start;
    const selectedPages = Array.from(
      new Set([...headerPages, ...(firstInvoice ? [firstInvoice] : []), ...(firstPL ? [firstPL] : [])])
    ).sort((a, c) => a - c);

    const headerBuffer = await (async () => {
      const doc         = await PDFDocument.create();
      const totalPages  = pdfDoc.getPageCount();
      const validIdx    = selectedPages.map((p) => p - 1).filter((idx) => idx >= 0 && idx < totalPages);
      if (validIdx.length === 0) return null;
      const copied = await doc.copyPages(pdfDoc, validIdx);
      copied.forEach((p) => doc.addPage(p));
      return Buffer.from(await doc.save());
    })();

    if (headerBuffer) {
      try {
        const headerResponse = await callGeminiWithRetry(
          [
            getCiplHeaderExtractionPrompt(),
            { inlineData: { data: headerBuffer.toString('base64'), mimeType: 'application/pdf' } },
          ],
          3, { responseMimeType: 'text/plain', temperature: 0.0 }, log, 'header'
        );
        headerData = headerResponse.parsedData || {};
        log.info({
          event:          'cipl_header_ok',
          selected_pages: selectedPages,
          fields:         Object.keys(headerData).filter((k) => headerData[k] !== null).length,
        }, 'Header extracted');
      } catch (err) {
        log.warn({ event: 'cipl_header_failed', err: err.message });
      }
    }
  }

  // ── Fase 2: Parallel Extraction ──────────────────────────────────────────
  const masterJson   = { invoice_list: [], pl_list: [] };
  const invPagesData = await processInvoicePages(invoicePages, 'invoice');
  const plPagesData  = await processPlPages(plPages, 'pl');

  // ── Fase 3: Merge & Normalize ────────────────────────────────────────────
  log.info('Fase 3: Merge & Normalize');

  // ── Invoice merge ────────────────────────────────────────────────────────
  // n8n: skip entry tanpa invoice_number — tidak ada redistribusi.
  const globalInvoices = [];
  for (const page of invPagesData) {
    const invoiceArray = page.invoice_list || page.invoices || [];
    for (const inv of invoiceArray) {
      if (!inv.invoice_number) {
        log.warn(
          { event: 'invoice_null_number_skipped' },
          '[INVOICE] Entry dengan invoice_number null dilewati (sesuai n8n)'
        );
        continue;
      }
      const validItems = (inv.items || inv.rows || []).filter((item) => !isHeaderPollutionRow(item));
      if (validItems.length === 0) continue;

      let targetInv = globalInvoices.find((i) => i.invoice_number === inv.invoice_number);
      if (!targetInv) {
        targetInv = {
          invoice_number: inv.invoice_number,
          invoice_date:   inv.invoice_date || null,
          items:          [],
        };
        globalInvoices.push(targetInv);
      }

      validItems.forEach((item) => {
        // parseFloat: preserve decimal sub-item numbers (e.g. "1.1")
        const parsed = parseFloat(item.number);
        item.number  = !isNaN(parsed) ? parsed : null;
        targetInv.items.push(item);
      });
    }
  }

  globalInvoices.forEach((inv) => {
    inv.items = deduplicateInvoiceItems(inv.items);
    inv.items.sort((a, b) => (a.number || 0) - (b.number || 0));
  });
  masterJson.invoice_list = globalInvoices;

  // ── PL merge ─────────────────────────────────────────────────────────────
  const plMap = new Map();
  for (const page of plPagesData) {
    const plArray = page.pl_list || page.pls || [];
    for (const pl of plArray) {
      const plKey = pl.packing_list_number && pl.packing_list_number !== 'null'
        ? pl.packing_list_number
        : null;

      if (!plKey) {
        log.warn(
          { event: 'pl_null_number_skipped', items: (pl.items || []).length, pl_date: pl.packing_list_date },
          '[PL] Entri dengan packing_list_number null dilewati — data hilang'
        );
        continue;
      }

      const validItems = (pl.items || pl.rows || []).filter((item) => !isHeaderPollutionRow(item));
      if (validItems.length === 0) continue;

      let finalInvNum = [];
      if (Array.isArray(pl.invoice_number)) {
        finalInvNum = pl.invoice_number.filter((i) => i && i !== 'null');
      } else if (typeof pl.invoice_number === 'string' && pl.invoice_number !== 'null') {
        finalInvNum = [pl.invoice_number];
      }

      validItems.forEach((item) => {
        const parsed = parseFloat(item.number);
        item.number  = !isNaN(parsed) ? parsed : null;
      });

      if (!plMap.has(plKey)) {
        plMap.set(plKey, {
          packing_list_number: plKey,
          packing_list_date:   pl.packing_list_date && pl.packing_list_date !== 'null'
            ? pl.packing_list_date
            : null,
          invoice_number: new Set(finalInvNum),
          items:          [...validItems],
        });
      } else {
        const entry = plMap.get(plKey);
        finalInvNum.forEach((inv) => entry.invoice_number.add(inv));
        entry.items.push(...validItems);
        if (!entry.packing_list_date && pl.packing_list_date && pl.packing_list_date !== 'null') {
          entry.packing_list_date = pl.packing_list_date;
        }
      }
    }
  }

  // Dedup per PL menggunakan n8n Strategy B
  const globalPls = Array.from(plMap.values()).map((entry) => ({
    packing_list_number: entry.packing_list_number,
    packing_list_date:   entry.packing_list_date,
    invoice_number:      Array.from(entry.invoice_number),
    items:               deduplicatePlItems(entry.packing_list_number, entry.items),
  }));
  masterJson.pl_list = globalPls;

  // ── Packages flatten (fallback format) ───────────────────────────────────
  for (const pl of masterJson.pl_list) {
    if (!Array.isArray(pl.packages)) continue;
    const flatItems = [];
    for (const pkg of pl.packages) {
      const pkgPhysical = {
        gross_weight: pkg.gross_weight ?? null,
        net_weight:   pkg.net_weight   ?? null,
        measurement:  pkg.measurement  ?? null,
      };
      for (const item of (pkg.items || [])) {
        flatItems.push({ package_number: pkg.package_number, ...item, ...pkgPhysical });
      }
    }
    pl.items = flatItems;
    delete pl.packages;
  }

  // ── Fill invoice_number di PL via prod_number lookup ─────────────────────
  // Sesuai n8n node "Code in JavaScript4"
  const prodToInvoices = new Map();
  for (const invoice of masterJson.invoice_list) {
    for (const item of (invoice.items || [])) {
      if (!item.prod_number) continue;
      if (!prodToInvoices.has(item.prod_number)) prodToInvoices.set(item.prod_number, new Set());
      if (invoice.invoice_number) prodToInvoices.get(item.prod_number).add(invoice.invoice_number);
    }
  }
  for (const pl of masterJson.pl_list) {
    if (pl.invoice_number && pl.invoice_number.length > 0) continue;
    const matched = new Set();
    for (const item of (pl.items || [])) {
      if (!item.prod_number) continue;
      const invs = prodToInvoices.get(item.prod_number);
      if (invs) invs.forEach((inv) => matched.add(inv));
    }
    if (matched.size > 0) {
      pl.invoice_number = Array.from(matched);
      log.info(
        { event: 'pl_invoice_filled', pl: pl.packing_list_number, filled: pl.invoice_number },
        'invoice_number diisi via prod_number lookup'
      );
    }
  }

  // ── Final Assembly ───────────────────────────────────────────────────────
  // n8n: hitung total hanya jika header tidak menyediakan nilai (header.total ?? calculated)
  const calculatedTotal = calculateTotal(masterJson.invoice_list);
  const resolvedOrigin  = resolveRootOrigin(headerData, masterJson.invoice_list);

  const output = {
    ...headerData,
    origin:       resolvedOrigin,
    total:        headerData.total ?? calculatedTotal, // preserve stated total dari dokumen
    invoice_list: masterJson.invoice_list,
    pl_list:      masterJson.pl_list,
  };

  log.info({
    event:                  'cipl_extraction_completed',
    invoice_count:          masterJson.invoice_list.length,
    pl_count:               masterJson.pl_list.length,
    total:                  output.total,
    summary_pages_excluded: summaryPages.size,
    debug_dir:              _pageDebugDir || 'disabled',
  }, 'CIPL Pipeline v15.0 Selesai');

  await debugLog(docCode, 'cipl_final_output', output);
  return output;
};