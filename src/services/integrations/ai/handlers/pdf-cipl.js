/* eslint-disable no-useless-escape */
/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import { PDFDocument } from 'pdf-lib';
import { ai, MODELS } from '../../../../config/gemini.js';
import {
  callGeminiWithRetry,
  extractOcrTokens,
  debugLog,
  parseItemsCsv,
} from '../helpers.js';
import { getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { getCIPLSectionBoundaryPrompt } from '../../../../prompts/boundary/doc-001.js';
import { cleanAIJson } from '../../../../utils/ai-sanitizer.js';
import logger from '../../../../config/logger.js';



// ─────────────────────────────────────────────────────────────────────────────
// TOP-LEVEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

const extractSpecificPages = async (pdfDoc, pages) => {
  if (!pages || pages.length === 0) return null;
  const singlePdf = await PDFDocument.create();
  const numPages = pdfDoc.getPageCount();
  const validIndices = pages
    .map((p) => p - 1)
    .filter((i) => i >= 0 && i < numPages);
  if (validIndices.length === 0) return null;
  const copiedPages = await singlePdf.copyPages(pdfDoc, validIndices);
  copiedPages.forEach((p) => singlePdf.addPage(p));
  return Buffer.from(await singlePdf.save());
};

const buildSummaryPages = (boundary) => {
  const summaryPages = new Set();
  if (!boundary.is_document_contain_summary) return summaryPages;
  const sp = boundary.document_summary_page;
  if (!sp || sp.start == null || sp.end == null) return summaryPages;
  for (let i = sp.start; i <= sp.end; i++) {
    if (!(sp.exclude || []).includes(i)) summaryPages.add(i);
  }
  return summaryPages;
};

const isSameInvoice = (inv1, inv2) => {
  if (!inv1 || !inv2) return false;
  const s1 = String(inv1).trim();
  const s2 = String(inv2).trim();
  if (s1 === s2) return true;
  if (s1.length >= 4 && s2.length >= 4) {
    const longer = Math.max(s1.length, s2.length);
    const shorter = Math.min(s1.length, s2.length);
    if (shorter <= longer * 0.6) {
      return s1.endsWith(s2) || s2.endsWith(s1);
    }
  }
  return false;
};

const reconcileCiplData = (masterJson, log = logger) => {
  const invoiceGroups = {};
  const plGroups = {};

  // [FIX] ID kini menyertakan 'number' urutan agar data dengan prod_number yang sama tidak saling menimpa
  const getInvoiceItemKey = (item) => {
    const invNo = String(item.invoice_number || '').trim();
    const prod = String(item.prod_number || '').trim();
    const num = String(item.number || '').trim();

    if (!prod) return `APPEND_INV_${Math.random().toString(36).substring(2, 9)}`;
    let key = 'INV';
    if (invNo) key += `_INV_${invNo}`;
    key += `_PROD_${prod}`;
    if (num) key += `_NUM_${num}`;
    return key;
  };

  const getPlItemKey = (item) => {
    const plNo = String(item.packing_list_number || '').trim();
    const pkg = String(item.package_number || '').trim();
    const prod = String(item.prod_number || '').trim();
    const num = String(item.number || '').trim();

    if (!pkg && !prod) return `APPEND_PL_${Math.random().toString(36).substring(2, 9)}`;
    let key = 'PL';
    if (plNo) key += `_PL_${plNo}`;
    if (pkg) key += `_PKG_${pkg}`;
    if (prod) key += `_PROD_${prod}`;
    if (num) key += `_NUM_${num}`;
    return key;
  };

  const processList = (list, targetMap, groupingFn, type) => {
    if (!Array.isArray(list)) return;
    for (const wrapper of list) {
      const docNo = type === 'INV' ? wrapper.invoice_number : wrapper.packing_list_number;
      let groupKey = null;

      if (docNo) {
        groupKey = Object.keys(targetMap).find((k) => isSameInvoice(k, docNo));
      }

      if (!groupKey) {
        groupKey = docNo || `ORPHAN_${Math.random().toString(36).substring(2, 9)}`;
        targetMap[groupKey] = { data: { ...wrapper }, items: {} };
      } else {
        if (docNo && docNo.length > groupKey.length) {
          targetMap[docNo] = targetMap[groupKey];
          if (type === 'INV') targetMap[docNo].data.invoice_number = docNo;
          else targetMap[docNo].data.packing_list_number = docNo;
          delete targetMap[groupKey];
          groupKey = docNo;
        }
        Object.keys(wrapper).forEach((k) => {
          if (k !== 'items' && (targetMap[groupKey].data[k] == null || targetMap[groupKey].data[k] === '')) {
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
            Object.keys(item).forEach((k) => {
              if (item[k] != null && item[k] !== '') {
                const existingVal = targetMap[groupKey].items[itemKey][k];
                if (existingVal == null || existingVal === '') {
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

  const deduplicateGhostItems = (groups, type) => {
    Object.values(groups).forEach((group) => {
      const items = Object.values(group.items);
      const withId = items.filter((it) => !it._tmp_key?.startsWith('APPEND'));
      const appendOnly = items.filter((it) => it._tmp_key?.startsWith('APPEND'));

      appendOnly.forEach((ghost) => {
        let match = null;
        if (ghost.prod_number) {
          match = withId.find((real) => {
            if (!real.prod_number || real.prod_number !== ghost.prod_number) return false;
            if (type === 'PL' && ghost.package_number && real.package_number) {
              return real.package_number === ghost.package_number;
            }
            return true;
          });
        }
        if (!match) {
          match = withId.find(
            (real) => real.description === ghost.description && real.quantity === ghost.quantity && real.origin === ghost.origin
          );
        }
        if (match) {
          Object.keys(ghost).forEach((k) => {
            if (match[k] == null || match[k] === '') match[k] = ghost[k];
          });
          delete group.items[ghost._tmp_key];
        }
      });
    });
  };

  deduplicateGhostItems(invoiceGroups, 'INV');
  deduplicateGhostItems(plGroups, 'PL');

  masterJson.invoice_list = Object.values(invoiceGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items).map(({ _tmp_key, ...rest }) => rest),
  }));
  masterJson.pl_list = Object.values(plGroups).map((g) => ({
    ...g.data,
    items: Object.values(g.items).map(({ _tmp_key, ...rest }) => rest),
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export const processCiplPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, log = logger) => {
  log.info({ event: 'cipl_extraction_start' }, 'Memulai CIPL Extraction Pipeline v2.2 (Token & Boundary Fix)');

  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    log.warn('Secured PDF terdeteksi — fallback ke One-Shot Extraction');
    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [prompt, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );
    tokenUsage.inputTotal += usageMetadata?.promptTokenCount || 0;
    tokenUsage.output += usageMetadata?.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata || {});
    tokenUsage.total += usageMetadata?.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  }

  // ── CLOSURES ────────────────────────────────────────────────────────────────
  const mergeCiplChunks = (target, source) => {
    if (!source) return;
    Object.keys(source).forEach((key) => {
      if (!Array.isArray(source[key]) && typeof source[key] !== 'object') {
        if (target[key] == null || target[key] === '') target[key] = source[key];
      }
    });

    const mergeList = (listKey) => {
      if (!Array.isArray(source[listKey])) return;
      if (!target[listKey]) target[listKey] = [];
      const idKey = listKey === 'invoice_list' ? 'invoice_number' : 'packing_list_number';

      for (const srcItem of source[listKey]) {
        const docId = srcItem[idKey];
        let targetItem = null;

        if (docId) {
          targetItem = target[listKey].find((t) => isSameInvoice(t[idKey], docId));
        }

        if (!targetItem) {
          targetItem = { ...srcItem, items: Array.isArray(srcItem.items) ? [...srcItem.items] : [] };
          target[listKey].push(targetItem);
        } else {
          Object.keys(srcItem).forEach((k) => {
            if (k !== 'items' && !Array.isArray(srcItem[k])) {
              if (targetItem[k] == null || targetItem[k] === '') targetItem[k] = srcItem[k];
            }
          });
          if (Array.isArray(srcItem.items)) {
            if (!Array.isArray(targetItem.items)) targetItem.items = [];
            targetItem.items = targetItem.items.concat(srcItem.items);
          }
          if (srcItem.items_csv) {
            if (!targetItem.items_csv) targetItem.items_csv = [];
            const masterCsv = Array.isArray(targetItem.items_csv) ? targetItem.items_csv : [targetItem.items_csv];
            const batchCsv = Array.isArray(srcItem.items_csv) ? srcItem.items_csv : [srcItem.items_csv];
            targetItem.items_csv = [...masterCsv, ...batchCsv];
          }
        }
      }
    };
    mergeList('invoice_list');
    mergeList('pl_list');
  };

  const getDomainDirective = (domain) => {
    if (domain === 'invoice') {
      return '\n\n>>> DOMAIN RESTRICTION — WAJIB DIIKUTI <<<\nHalaman ini adalah bagian INVOICE. HANYA ekstrak data ke "invoice_list". DILARANG KERAS membuat "pl_list" entries (set sebagai array kosong []). Abaikan nomor packing list.';
    }
    if (domain === 'pl') {
      return '\n\n>>> DOMAIN RESTRICTION — WAJIB DIIKUTI <<<\nHalaman ini adalah bagian PACKING LIST. HANYA ekstrak data ke "pl_list". DILARANG KERAS membuat "invoice_list" entries (set sebagai array kosong []).';
    }
    return '';
  };

  const processPageRange = async (start, end, exclude = [], useFullPrompt = false, context = null, domain = null) => {
    if (!start || !end || start > end) return null;
    const buffer = await extractPageBuffer(pdfDoc, start, end, exclude);
    if (!buffer) return null;

    const basePrompt = useFullPrompt ? prompt : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, context);
    const selectedPrompt = basePrompt + getDomainDirective(domain);

    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [selectedPrompt, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );

    tokenUsage.inputTotal += usageMetadata?.promptTokenCount || 0;
    tokenUsage.output += usageMetadata?.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata || {});
    tokenUsage.total += usageMetadata?.totalTokenCount || 0;

    // [FIX] Isolasi Domain Strict - Force clear agar tidak menyilang
    if (parsedData) {
      if (domain === 'invoice') parsedData.pl_list = [];
      if (domain === 'pl') parsedData.invoice_list = [];
    }

    parseItemsCsv(parsedData, docCode);
    return parsedData;
  };

  const processSpecificPages = async (pageList, useFullPrompt = false, context = null) => {
    if (!pageList || pageList.length === 0) return null;
    const buffer = await extractSpecificPages(pdfDoc, pageList);
    if (!buffer) return null;
    const selectedPrompt = useFullPrompt ? prompt : getItemOnlyExtractionPrompt(docCode, jsonSchema, false, context);
    const { parsedData, usageMetadata } = await callGeminiWithRetry(
      [selectedPrompt, { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }],
      3, null, log
    );
    tokenUsage.inputTotal += usageMetadata?.promptTokenCount || 0;
    tokenUsage.output += usageMetadata?.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata || {});
    tokenUsage.total += usageMetadata?.totalTokenCount || 0;
    parseItemsCsv(parsedData, docCode);
    return parsedData;
  };

  const processPageRangeChunked = async (start, end, exclude = [], useFullPrompt = false, context = null, domain = null) => {
    if (!start || !end || start > end) return null;

    // [FIX] Mengurangi Chunk Size dari 3 ke 2 untuk mengamankan 8192 MAX_TOKENS
    const CHUNK_SIZE = 2;
    const promises = [];
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
      const chunkPagesSet = new Set(chunkPages);
      const chunkExclude = [];
      for (let p = chunkStart; p <= chunkEnd; p++) {
        if (!chunkPagesSet.has(p)) chunkExclude.push(p);
      }
      promises.push(processPageRange(chunkStart, chunkEnd, chunkExclude, useFullPrompt, context, domain));
    }

    const results = await Promise.all(promises);
    const mergedResult = {};
    for (const res of results) if (res) mergeCiplChunks(mergedResult, res);
    return mergedResult;
  };

  // ── FASE 1: BOUNDARY DETECTION ───────────────────────────────────────────
  log.info({ event: 'cipl_boundary_scan' }, 'Fase 1: Scanning boundary dokumen...');
  const boundaryResponse = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      getCIPLSectionBoundaryPrompt(),
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });

  const boundaryUsage = boundaryResponse.usageMetadata || {};
  tokenUsage.inputTotal += boundaryUsage.promptTokenCount || 0;
  tokenUsage.output += boundaryUsage.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(boundaryUsage);
  tokenUsage.total += boundaryUsage.totalTokenCount || 0;

  // [FIX] Handing response AI Boundary yang berbentuk ARRAY
  const rawBoundary = cleanAIJson(boundaryResponse.text) || {};
  const boundary = Array.isArray(rawBoundary) ? (rawBoundary[0] || {}) : rawBoundary;

  log.info({ event: 'cipl_boundary_detected', boundary }, 'Boundary terdeteksi');

  const headerStart = boundary?.page_contain_header?.start;
  const headerEnd = boundary?.page_contain_header?.end;
  const headerExclude = boundary?.page_contain_header?.exclude || [];

  const invStart = boundary?.page_contain_invoice_data?.start;
  const invEnd = boundary?.page_contain_invoice_data?.end || totalPages;
  const invExclude = boundary?.page_contain_invoice_data?.exclude || [];

  const plStart = boundary?.page_contain_packing_list_data?.start;
  const plEnd = boundary?.page_contain_packing_list_data?.end || totalPages;
  const plExclude = boundary?.page_contain_packing_list_data?.exclude || [];

  const summaryPagesSet = buildSummaryPages(boundary);
  const finalInvExclude = Array.from(new Set([...invExclude, ...summaryPagesSet]));
  const finalPlExclude = Array.from(new Set([...plExclude, ...summaryPagesSet]));

  // ── FASE 2: HEADER EXTRACTION ─────────────────────────────────────────────
  const firstInvPage = invStart || 1;
  const firstPlPage = plStart || 1;

  let rawHeaderPages = [];
  if (headerStart && headerEnd) {
    const hExcludeSet = new Set(headerExclude);
    for (let i = headerStart; i <= headerEnd; i++) {
      if (!hExcludeSet.has(i)) rawHeaderPages.push(i);
    }
    rawHeaderPages = rawHeaderPages.slice(0, 3);
  }

  const finalHeaderPages = Array.from(new Set([...rawHeaderPages, firstInvPage, firstPlPage]))
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  log.info(
    { event: 'cipl_extracting_header', pages: finalHeaderPages },
    `Fase 2: Mengekstrak Header halaman [${finalHeaderPages.join(',')}]`
  );

  const masterJson = (await processSpecificPages(finalHeaderPages, true)) || {};
  if (!masterJson.invoice_list) masterJson.invoice_list = [];
  if (!masterJson.pl_list) masterJson.pl_list = [];

  const globalContext = {
    buyer_name: masterJson.buyer_name,
    seller_name: masterJson.seller_name,
    packing_list_number: masterJson.packing_list_number,
    initial_invoices: (masterJson.invoice_list || []).map((inv) => inv.invoice_number),
    initial_items: [
      ...(masterJson.invoice_list || []).flatMap((inv) => (inv.items || []).map((it) => it.prod_number)),
      ...(masterJson.pl_list || []).flatMap((pl) => (pl.items || []).map((it) => it.package_number)),
    ].filter(Boolean).slice(0, 20),
  };

  // ── FASE 3: INVOICE DATA EXTRACTION ──────────────────────────────────────
  const lastHeaderPage = finalHeaderPages.length > 0 ? finalHeaderPages[finalHeaderPages.length - 1] : 0;
  const finalInvStart = invStart || lastHeaderPage + 1;

  if (finalInvStart && finalInvStart <= totalPages) {
    log.info(
      { event: 'cipl_extracting_invoice_data', range: `${finalInvStart}-${invEnd}`, exclude: finalInvExclude },
      `Fase 3: Mengekstrak Invoice Data hal ${finalInvStart}-${invEnd}`
    );
    const invData = await processPageRangeChunked(finalInvStart, invEnd, finalInvExclude, true, globalContext, 'invoice');
    mergeCiplChunks(masterJson, invData);
  }

  // ── FASE 4: PACKING LIST DATA EXTRACTION ─────────────────────────────────
  const isPhase4Ran = Boolean(plStart && plEnd);

  if (isPhase4Ran) {
    log.info(
      { event: 'cipl_extracting_pl_data', range: `${plStart}-${plEnd}`, exclude: finalPlExclude },
      `Fase 4: Mengekstrak Packing List Data hal ${plStart}-${plEnd}`
    );
    const plData = await processPageRangeChunked(plStart, plEnd, finalPlExclude, true, globalContext, 'pl');
    mergeCiplChunks(masterJson, plData);
  }

  // ── FASE 4.5: PL FALLBACK STRATEGY ───────────────────────────────────────
  // [FIX] Cek dari `isPhase4Ran` bukan dari `hasPLItems` (karena fase Header bisa menyisakan item PL)
  if (!isPhase4Ran && finalInvStart && finalInvStart <= totalPages) {
    log.warn(
      { event: 'cipl_pl_fallback_triggered', fallbackRange: `${finalInvStart}-${invEnd}` },
      `Fase 4.5 Fallback: PL boundary tersembunyi (Format B) → mengekstrak PL dari hal ${finalInvStart}-${invEnd}`
    );
    const plFallbackData = await processPageRangeChunked(finalInvStart, invEnd, finalInvExclude, true, globalContext, 'pl');
    if (plFallbackData) mergeCiplChunks(masterJson, plFallbackData);
  }

  // ── FASE 5: RECONCILIATION ────────────────────────────────────────────────
  reconcileCiplData(masterJson, log);

  // ── DETERMINISTIC POST-PROCESSING ────────────────────────────────────────
  if (Array.isArray(masterJson.invoice_list)) {
    const beforeCount = masterJson.invoice_list.length;
    masterJson.invoice_list = masterJson.invoice_list.filter((inv) => {
      if (!inv.invoice_number) return false;
      if (!Array.isArray(inv.items) || inv.items.length === 0) return false;
      return inv.items.some((item) => item.amount != null && Number(item.amount) > 0);
    });
  }

  if (Array.isArray(masterJson.pl_list) && Array.isArray(masterJson.invoice_list)) {
    const validInvoiceNos = new Set(masterJson.invoice_list.map((inv) => inv.invoice_number).filter(Boolean));
    masterJson.pl_list = masterJson.pl_list.filter((pl) => {
      const plNo = pl.packing_list_number;
      if (!Array.isArray(pl.items) || pl.items.length === 0) return false;
      if (plNo && validInvoiceNos.has(plNo)) return false;
      return true;
    });
  }

  // [PP-4] Explode Section-Level PL Entries
  if (Array.isArray(masterJson.pl_list)) {
    const DELIVERY_NO_REGEX = /^\d{10}$/;
    const resultPl = [];
    let totalExploded = 0;

    for (const pl of masterJson.pl_list) {
      const plNo = pl.packing_list_number;
      const items = pl.items || [];
      const isSectionLevel = !plNo || !DELIVERY_NO_REGEX.test(String(plNo).trim());
      const hasItemWithDeliveryNo = items.some((item) => item.package_number && DELIVERY_NO_REGEX.test(String(item.package_number).trim()));

      if (isSectionLevel && hasItemWithDeliveryNo) {
        const toExplode = [];
        const toKeep = [];
        for (const item of items) {
          const pkgNo = item.package_number ? String(item.package_number).trim() : null;
          if (pkgNo && DELIVERY_NO_REGEX.test(pkgNo)) toExplode.push({ item, deliveryNo: pkgNo });
          else toKeep.push(item);
        }

        const deliveryGroups = new Map();
        for (const { item, deliveryNo } of toExplode) {
          if (!deliveryGroups.has(deliveryNo)) deliveryGroups.set(deliveryNo, []);
          deliveryGroups.get(deliveryNo).push({ ...item, package_number: null });
        }

        for (const [deliveryNo, groupItems] of deliveryGroups) {
          resultPl.push({
            packing_list_number: deliveryNo,
            packing_list_date: pl.packing_list_date,
            invoice_number: pl.invoice_number,
            items: groupItems,
          });
          totalExploded++;
        }
        if (toKeep.length > 0) resultPl.push({ ...pl, items: toKeep });
      } else {
        resultPl.push(pl);
      }
    }
    if (totalExploded > 0) masterJson.pl_list = resultPl;
  }

  // [PP-1] ship_to Sanitizer
  if (masterJson.ship_to && typeof masterJson.ship_to === 'string') {
    masterJson.ship_to = masterJson.ship_to.replace(/\s*\d+\s*\/\/.*$/i, '').replace(/\s+\d+\s*$/, '').trim();
  }

  // [PP-1.5] Delivery Number Contamination Cleanup
  const DELIVERY_NO_REGEX = /^\d{10}$/;
  const PROD_NO_REGEX = /^([A-Z0-9][A-Z0-9\-]{2,})(?:\s|$)/;
  if (Array.isArray(masterJson.invoice_list)) {
    masterJson.invoice_list.forEach((inv) => {
      if (!Array.isArray(inv.items)) return;
      const cleanedItems = [];
      for (const item of inv.items) {
        const prodNo = String(item.prod_number || '').trim();
        if (!DELIVERY_NO_REGEX.test(prodNo)) {
          cleanedItems.push(item);
          continue;
        }
        const desc = String(item.description || '').trim();
        const match = desc.match(PROD_NO_REGEX);
        if (match) {
          const recoveredProdNo = match[1];
          if (!DELIVERY_NO_REGEX.test(recoveredProdNo)) {
            item.prod_number = recoveredProdNo;
            item.description = desc.substring(recoveredProdNo.length).trim() || desc;
            cleanedItems.push(item);
          }
        }
      }
      inv.items = cleanedItems;
    });
  }

  // [PP-2] Sort invoice items by number ASC
  if (Array.isArray(masterJson.invoice_list)) {
    masterJson.invoice_list.forEach((inv) => {
      if (Array.isArray(inv.items)) {
        inv.items.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
      }
    });
  }

  // [PP-3] Total & Invoice Mapping
  if (masterJson.total == null) {
    let calculatedTotal = 0;
    for (const invoice of (masterJson.invoice_list || [])) {
      for (const item of (invoice.items || [])) calculatedTotal += Number(item.amount) || 0;
    }
    if (calculatedTotal > 0) masterJson.total = calculatedTotal;
  }

  const prodToInvoices = new Map();
  for (const invoice of (masterJson.invoice_list || [])) {
    if (!invoice.invoice_number) continue;
    for (const item of (invoice.items || [])) {
      if (!item.prod_number) continue;
      if (!prodToInvoices.has(item.prod_number)) prodToInvoices.set(item.prod_number, new Set());
      prodToInvoices.get(item.prod_number).add(invoice.invoice_number);
    }
  }

  if (Array.isArray(masterJson.pl_list)) {
    masterJson.pl_list.forEach((pl) => {
      if (pl.invoice_number && Array.isArray(pl.invoice_number) && pl.invoice_number.length > 0) return;
      const found = new Set();
      for (const item of (pl.items || [])) {
        if (!item.prod_number) continue;
        const matched = prodToInvoices.get(item.prod_number);
        if (matched) for (const n of matched) found.add(n);
      }
      if (found.size > 0) {
        pl.invoice_number = Array.from(found);
      } else {
        const allInvoiceNos = (masterJson.invoice_list || []).map((inv) => inv.invoice_number).filter(Boolean);
        if (allInvoiceNos.length > 0) pl.invoice_number = allInvoiceNos;
      }
    });
  }

  await debugLog(docCode, 'cipl_final_output', masterJson);
  log.info({ event: 'cipl_extraction_completed' }, 'CIPL Pipeline v2.2 Selesai (Fully Restored)');
  return masterJson;
};