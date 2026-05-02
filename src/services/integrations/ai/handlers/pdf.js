/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */

import { PDFDocument } from 'pdf-lib';
import { getSequentialExtractionPrompt, getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { callGeminiWithRetry, mergeArraysDeep, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';

/**
 * HANDLER: PDF EXTRACTION (One-Shot vs Sequential)
 */
export const processPdfExtraction = async (fileBuffer, docCode, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    console.log(`\n[AI-SERVICE] [PDF MODE] Secured PDF Terdeteksi! Memaksa mode ONE-SHOT Bypass (${numPages} hal)...`);
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
    await debugLog(docCode, 'one_shot_secured_pdf_output', pdfJson);
    return pdfJson;
  }

  // OPTIMIZATION 1: SAFE ONE-SHOT (UP TO 8 PAGES)
  // Threshold diturunkan dari 15 ke 8 hal untuk mencegah JSON Truncation pada data yang sangat padat.
  if (docCode === '001' && numPages <= 8) {
    console.log(`\n[AI-SERVICE] [PDF MODE] Safe One-Shot untuk CIPL ${numPages} halaman (Akurasi Maksimal)...`);
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
    await debugLog(docCode, 'one_shot_pdf_output', pdfJson);
    return pdfJson;
  }

  // OPTIMIZATION 2: CONTEXT-AWARE SEQUENTIAL EXTRACTION (> 8 PAGES)
  console.log(`\n[AI-SERVICE] [PDF MODE] Menerapkan Context-Aware Sequential Extraction (${numPages} hal)...`);
  let masterJson = null;
  for (let i = 0; i < numPages; i++) {
    console.log(`[AI-SERVICE] Memproses PDF Halaman ${i + 1}/${numPages}...`);
    const singlePdf = await PDFDocument.create();
    const [copiedPage] = await singlePdf.copyPages(pdfDoc, [i]);
    singlePdf.addPage(copiedPage);
    const singlePdfBytes = await singlePdf.save();

    const contextSummary = masterJson
      ? `\nPREVIOUS DATA CONTEXT:\n- Invoice/PL Number: ${masterJson.invoice_number || masterJson.packing_list_number}\n- Last Extracted Items Count: ${masterJson.invoice_list?.[0]?.items?.length || 0}\n`
      : '';

    // logika scoped instruction khusus dokumen COO (861) pada halaman lanjutan.
    const pagePrompt = i === 0 ? prompt : getSequentialExtractionPrompt(prompt, contextSummary, docCode);
    const { parsedData: pageJson, usageMetadata } = await callGeminiWithRetry([
      pagePrompt,
      { inlineData: { data: Buffer.from(singlePdfBytes).toString('base64'), mimeType: 'application/pdf' } }
    ]);

    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
    await debugLog(docCode, `raw_pdf_page_${i + 1}`, pageJson);

    if (i === 0) masterJson = pageJson;
    else mergeArraysDeep(masterJson, pageJson);
  }
  await debugLog(docCode, 'merged_pdf_output', masterJson);
  return masterJson;
};

/**
 * HANDLER: LIGHT PDF EXTRACTION (Page 1 & Last Page Only)
 * Dioptimalkan untuk dokumen perizinan/regulasi (BPOM, AKL, POSTEL, dll)
 * yang hanya butuh doc_number & doc_date.
 */
export const processLightPdfExtraction = async (fileBuffer, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  console.log('\n[AI-SERVICE] [LIGHT PDF MODE] Mencoba Ekstraksi Cepat (Halaman 1 & Terakhir)...');

  // Jika Secured, One-Shot Bypass
  if (pdfDoc.isEncrypted) {
    console.log('[AI-SERVICE] Secured PDF. Bypass ke One-Shot...');
    const { parsedData, usageMetadata } = await callGeminiWithRetry([prompt, { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
    return parsedData;
  }

  const lightPdf = await PDFDocument.create();
  const pagesToCopy = numPages === 1 ? [0] : [0, numPages - 1];
  const copiedPages = await lightPdf.copyPages(pdfDoc, pagesToCopy);
  copiedPages.forEach((page) => lightPdf.addPage(page));

  const lightPdfBytes = await lightPdf.save();

  const { parsedData, usageMetadata } = await callGeminiWithRetry([
    prompt,
    { inlineData: { data: Buffer.from(lightPdfBytes).toString('base64'), mimeType: 'application/pdf' } }
  ]);

  tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
  tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(usageMetadata);
  tokenUsage.total += usageMetadata.totalTokenCount || 0;

  return parsedData;
};

/**
 * HANDLER: PARALLEL PDF EXTRACTION (Map-Reduce + Boundary Reconciliation)
 * Dioptimalkan untuk dokumen panjang (>10 hal) dengan item list (Invoice, PL, CIPL).
 * Strategi:
 *   Phase 1: Halaman 1 diekstrak secara penuh (Header + Items)
 *   Phase 2: Halaman 2-N diekstrak paralel (Items Only) via Promise.all
 *   Phase 3: Heuristic Reconciliation pada item di batas halaman
 *   Phase 4: Merge semua hasil ke satu JSON
 *
 * 🆕 Jalur A (isExcelToPdf=true, docCode='217'): Universal extraction — AI memahami format vendor secara mandiri.
 * ✅ Jalur B (default): Logika heuristic boundary reconciliation — sama persis seperti commit stabil.
 */
export const processParallelPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf = false) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    console.warn('[AI-SERVICE] [PARALLEL MODE] Secured PDF tidak bisa diproses paralel. Mengalihkan ke One-Shot...');
    return processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
  }

  console.log(`\n[AI-SERVICE] [PARALLEL MODE] Memulai Parallel Extraction untuk ${numPages} halaman...`);

  // Helper: Potong satu halaman menjadi PDF buffer
  const extractPageBuffer = async (pageIndex) => {
    const singlePdf = await PDFDocument.create();
    const [page] = await singlePdf.copyPages(pdfDoc, [pageIndex]);
    singlePdf.addPage(page);
    return Buffer.from(await singlePdf.save());
  };

  // ================================================================
  // JALUR A: 217_EXCEL — PENDEKATAN UNIVERSAL
  //
  // Menggunakan arsitektur yang sama dengan Jalur B (Parallel + Merge)
  // karena format Excel-converted PL berbeda-beda antar vendor.
  // AI memahami struktur dokumen secara mandiri via item-only prompt
  // yang sudah dirancang universal di getItemOnlyExtractionPrompt.
  // ================================================================
  if (isExcelToPdf && docCode === '217') {
    console.log('[AI-SERVICE] [PARALLEL MODE] Menggunakan Jalur Universal 217_EXCEL...');

    // Phase 1: Halaman 1 — full extraction (header + items)
    console.log('[AI-SERVICE] [PARALLEL MODE] Phase 1: Full extraction halaman 1...');
    const page1Buffer = await extractPageBuffer(0);
    const { parsedData: headerData, usageMetadata: headerMeta } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: page1Buffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += headerMeta.promptTokenCount || 0;
    tokenUsage.output += headerMeta.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(headerMeta);
    tokenUsage.total += headerMeta.totalTokenCount || 0;

    const masterJson = headerData;
    parseItemsCsv(masterJson, docCode);
    await debugLog(docCode, 'excel_pdf_page_1', masterJson);

    if (numPages === 1) {
      console.log('[AI-SERVICE] [PARALLEL MODE] ✅ Selesai (217_EXCEL single-page).');
      return masterJson;
    }

    // Phase 2: Halaman 2-N — item-only extraction paralel (semua pakai itemOnlyPrompt)
    console.log(`[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan ${numPages - 1} worker paralel...`);
    const itemOnlyPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, isExcelToPdf);

    const getItemArray = (data) => {
      if (Array.isArray(data?.items)) return data.items;
      if (Array.isArray(data?.pl_list?.[0]?.items)) return data.pl_list[0].items;
      if (Array.isArray(data?.invoice_list?.[0]?.items)) return data.invoice_list[0].items;
      return [];
    };

    const parallelTasks = Array.from({ length: numPages - 1 }, (_, i) => i + 1).map(async (pageIndex) => {
      const pageBuffer = await extractPageBuffer(pageIndex);
      // 217_EXCEL: SEMUA halaman 2-N pakai itemOnlyPrompt (flat array).
      // Tidak ada last-page full prompt — root fields sudah tertangkap di Phase 1.
      // Ini memastikan AI selalu mengembalikan flat array yang bisa di-route
      // oleh routeItemToList, tidak peduli halaman berapa pun.
      const { parsedData: rawData, usageMetadata: pageMeta } = await callGeminiWithRetry([
        itemOnlyPrompt,
        { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }
      ]);
      tokenUsage.inputTotal += pageMeta.promptTokenCount || 0;
      tokenUsage.output += pageMeta.candidatesTokenCount || 0;
      tokenUsage.ocr += extractOcrTokens(pageMeta);
      tokenUsage.total += pageMeta.totalTokenCount || 0;

      await debugLog(docCode, `excel_pdf_page_${pageIndex + 1}`, rawData);
      // rawData selalu flat array dari itemOnlyPrompt
      const items = Array.isArray(rawData) ? rawData : getItemArray(rawData);
      return { pageIndex, items };
    });

    const parallelResults = await Promise.all(parallelTasks);
    parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);
    console.log(`[AI-SERVICE] [PARALLEL MODE] Semua ${parallelResults.length} worker selesai.`);

    // Phase 3: Merge hasil ke masterJson dengan grouping by invoice_number
    //
    // Helper: routing satu item object ke pl_list/invoice_list entry yang tepat.
    // Jika item memiliki field invoice_number, gunakan untuk menemukan atau membuat
    // entry yang sesuai di pl_list. Ini memastikan item dari Billing Document yang
    // berbeda tidak tercampur ke satu entry yang salah.
    const routeItemToList = (item) => {
      // Normalisasi ke String untuk mencegah mismatch tipe data (number vs string)
      // antara hasil Phase 1 (full prompt) dan Phase 2 (item-only prompt).
      const rawInvoiceNo = item?.invoice_number;
      const itemInvoiceNo = (rawInvoiceNo !== null && rawInvoiceNo !== undefined && rawInvoiceNo !== '')
        ? String(rawInvoiceNo).trim()
        : null;

      if (Array.isArray(masterJson?.pl_list)) {
        let targetEntry;
        if (itemInvoiceNo) {
          // Normalisasi ke String di sisi pl_list juga untuk konsistensi perbandingan
          targetEntry = masterJson.pl_list.find((pl) => String(pl.invoice_number ?? '').trim() === itemInvoiceNo);
          if (!targetEntry) {
            targetEntry = { invoice_number: itemInvoiceNo, items: [] };
            masterJson.pl_list.push(targetEntry);
          }
        } else {
          // Tidak ada invoice_number di item — gunakan entry pertama sebagai fallback
          if (!masterJson.pl_list[0]) masterJson.pl_list[0] = { items: [] };
          targetEntry = masterJson.pl_list[0];
        }
        if (!Array.isArray(targetEntry.items)) targetEntry.items = [];
        // Hapus invoice_number dari item sebelum push — sudah tersimpan di level pl_list
        const { invoice_number: _removed, ...itemWithoutInvoice } = item;
        targetEntry.items.push(itemInvoiceNo ? itemWithoutInvoice : item);

      } else if (Array.isArray(masterJson?.invoice_list)) {
        let targetEntry;
        if (itemInvoiceNo) {
          targetEntry = masterJson.invoice_list.find((inv) => String(inv.invoice_number ?? '').trim() === itemInvoiceNo);
          if (!targetEntry) {
            targetEntry = { invoice_number: itemInvoiceNo, items: [] };
            masterJson.invoice_list.push(targetEntry);
          }
        } else {
          if (!masterJson.invoice_list[0]) masterJson.invoice_list[0] = { items: [] };
          targetEntry = masterJson.invoice_list[0];
        }
        if (!Array.isArray(targetEntry.items)) targetEntry.items = [];
        const { invoice_number: _removed, ...itemWithoutInvoice } = item;
        targetEntry.items.push(itemInvoiceNo ? itemWithoutInvoice : item);

      } else {
        // Fallback: tidak ada pl_list/invoice_list — push langsung ke items root
        if (!Array.isArray(masterJson.items)) masterJson.items = [];
        masterJson.items.push(item);
      }
    };

    for (const { items: pageItems } of parallelResults) {
      if (!pageItems || pageItems.length === 0) continue;
      pageItems.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        routeItemToList(item);
      });
    }

    await debugLog(docCode, 'excel_pdf_merged_output', masterJson);
    // Hitung total items dari SEMUA pl_list entries (bukan hanya [0])
    const totalItems = Array.isArray(masterJson?.pl_list)
      ? masterJson.pl_list.reduce((sum, entry) => sum + (entry?.items?.length || 0), 0)
      : getItemArray(masterJson).length;
    console.log(`[AI-SERVICE] [PARALLEL MODE] ✅ Selesai (217_EXCEL). Total item: ${totalItems}`);
    return masterJson;
  }

  // ================================================================
  // JALUR B: DOKUMEN LAIN (001, 217 NORMAL, 380)
  // ================================================================
  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 1: Mengekstrak Header dari Halaman 1...');
  const page1Buffer = await extractPageBuffer(0);
  const { parsedData: headerData, usageMetadata: headerMeta } = await callGeminiWithRetry([
    prompt,
    { inlineData: { data: page1Buffer.toString('base64'), mimeType: 'application/pdf' } }
  ]);
  tokenUsage.inputTotal += headerMeta.promptTokenCount || 0;
  tokenUsage.output += headerMeta.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(headerMeta);
  tokenUsage.total += headerMeta.totalTokenCount || 0;

  const masterJson = headerData;
  if (docCode === '001' || docCode === '217') {
    parseItemsCsv(masterJson, docCode);
  }
  await debugLog(docCode, 'parallel_page_1_header', masterJson);

  if (numPages === 1) return masterJson;

  // Jika hanya 2 halaman, halaman 2 sekaligus menjadi halaman terakhir (Full Extraction)
  const lastPageIndex = numPages - 1;

  // ================================================================
  // PHASE 2: Halaman 2-N - Parallel Extraction
  //   - Halaman TENGAH (2 s/d N-1): Item-Only Prompt (Cepat & Hemat Token)
  //   - Halaman TERAKHIR (N)       : Full Prompt (Tangkap Total, Tanda Tangan, Footer)
  // ================================================================
  console.log(`[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan ${numPages - 1} worker paralel...`);
  const itemOnlyPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema);

  // Helper & Konstanta dideklarasikan DI SINI agar tersedia saat
  // async worker paralel resolve (mencegah Temporal Dead Zone error)
  const getItemArray = (data) => {
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.invoice_list?.[0]?.items)) return data.invoice_list[0].items;
    return [];
  };

  const IDENTITY_KEYS = ['hs_code', 'number_item', 'item_no', 'description', 'commodity'];
  const VALUE_KEYS = ['quantity', 'unit_price', 'amount', 'net_weight', 'gross_weight'];

  const isLikelyContinuation = (prevLast, nextFirst) => {
    if (!prevLast || !nextFirst) return false;
    const hasIdentity = IDENTITY_KEYS.some((k) => nextFirst[k]);
    const hasValue = VALUE_KEYS.some((k) => nextFirst[k]);
    return !hasIdentity && hasValue;
  };

  const parallelTasks = Array.from({ length: numPages - 1 }, (_, i) => i + 1).map(async (pageIndex) => {
    const isLastPage = pageIndex === lastPageIndex;
    const pageBuffer = await extractPageBuffer(pageIndex);

    // Halaman terakhir → Full Prompt agar Total/Footer data tertangkap
    const selectedPrompt = isLastPage ? prompt : itemOnlyPrompt;

    const { parsedData: rawData, usageMetadata: pageMeta } = await callGeminiWithRetry([
      selectedPrompt,
      { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);

    tokenUsage.inputTotal += pageMeta.promptTokenCount || 0;
    tokenUsage.output += pageMeta.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(pageMeta);
    tokenUsage.total += pageMeta.totalTokenCount || 0;

    return {
      pageIndex,
      isLastPage,
      // Untuk halaman tengah: rawData langsung berupa array items
      // Untuk halaman terakhir: rawData berupa object penuh, kita ambil items-nya
      items: isLastPage ? getItemArray(rawData) : (Array.isArray(rawData) ? rawData : []),
      fullData: isLastPage ? rawData : null,
    };
  });

  const parallelResults = await Promise.all(parallelTasks);
  parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);
  console.log(`[AI-SERVICE] [PARALLEL MODE] Semua ${parallelResults.length} worker selesai.`);

  // ================================================================
  // PHASE 3: Heuristic Boundary Reconciliation
  // Deteksi item terpotong di antara dua halaman berurutan
  // ================================================================

  // ================================================================
  // PHASE 4: Merge semua hasil ke masterJson
  // ================================================================
  const masterItems = getItemArray(masterJson);

  for (let i = 0; i < parallelResults.length; i++) {
    const { items: pageItems, isLastPage, fullData } = parallelResults[i];

    // Rekonsiliasi batas halaman (item terpotong antar halaman)
    const prevItems = i === 0 ? masterItems : (parallelResults[i - 1]?.items || []);
    if (prevItems.length > 0 && pageItems.length > 0) {
      const prevLast = prevItems[prevItems.length - 1];
      const nextFirst = pageItems[0];
      if (isLikelyContinuation(prevLast, nextFirst)) {
        const pageNum = parallelResults[i].pageIndex + 1;
        console.log(`[AI-SERVICE] [PARALLEL MODE] 🔀 Rekonsiliasi: Menjahit item terpotong di batas Hal ${pageNum - 1} & Hal ${pageNum}`);
        Object.assign(prevLast, nextFirst);
        pageItems.shift();
      }
    }

    // Merge footer/summary dari halaman terakhir ke masterJson
    // mergeArraysDeep hanya mengisi field yang masih null — tidak menimpa data halaman 1
    if (isLastPage && fullData) {
      console.log('[AI-SERVICE] [PARALLEL MODE] 🧩 Merging Last Page (Footer/Summary Data)...');
      if (docCode === '001' || docCode === '217') {
        parseItemsCsv(fullData, docCode);
      }
      mergeArraysDeep(masterJson, fullData);
    }

    if (pageItems.length === 0) continue;

    // Sisipkan items ke struktur masterJson (hanya untuk halaman non-last)
    // Halaman terakhir sudah di-merge via mergeArraysDeep di atas
    if (!isLastPage) {
      if (Array.isArray(masterJson?.invoice_list)) {
        if (!masterJson.invoice_list[0]) masterJson.invoice_list[0] = { items: [] };
        if (!Array.isArray(masterJson.invoice_list[0].items)) masterJson.invoice_list[0].items = [];
        masterJson.invoice_list[0].items.push(...pageItems);
      } else {
        if (!Array.isArray(masterJson.items)) masterJson.items = [];
        masterJson.items.push(...pageItems);
      }
    }
  }

  await debugLog(docCode, 'parallel_merged_output', masterJson);
  const totalItems = getItemArray(masterJson).length;
  console.log(`[AI-SERVICE] [PARALLEL MODE] ✅ Selesai. Total item terkumpul: ${totalItems}`);
  return masterJson;
};