import { PDFDocument } from 'pdf-lib';
import { getSequentialExtractionPrompt, getItemOnlyExtractionPrompt } from '../../../../prompts/extraction.js';
import { callGeminiWithRetry, mergeArraysDeep, extractOcrTokens, debugLog } from '../helpers.js';

/**
 * HANDLER: PDF EXTRACTION (One-Shot vs Sequential)
 */
export const processPdfExtraction = async (fileBuffer, docCode, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  // 🚀 OPTIMIZATION 1: SAFE ONE-SHOT (UP TO 8 PAGES)
  // Threshold diturunkan dari 15 ke 8 hal untuk mencegah JSON Truncation pada data yang sangat padat.
  if (docCode === '001' && numPages <= 8) {
    console.log(`\n[AI-SERVICE] [PDF MODE] Safe One-Shot untuk CIPL ${numPages} halaman (Akurasi Maksimal)...`);
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    await debugLog(docCode, 'one_shot_pdf_output', pdfJson);
    return pdfJson;
  }

  // 🚀 OPTIMIZATION 2: CONTEXT-AWARE SEQUENTIAL EXTRACTION (> 15 PAGES)
  console.log(`\n[AI-SERVICE] [PDF MODE] Menerapkan Context-Aware Sequential Extraction (${numPages} hal)...`);
  let masterJson = null;

  for (let i = 0; i < numPages; i++) {
    console.log(`[AI-SERVICE] Memproses PDF Halaman ${i + 1}/${numPages}...`);

    const singlePdf = await PDFDocument.create();
    const [copiedPage] = await singlePdf.copyPages(pdfDoc, [i]);
    singlePdf.addPage(copiedPage);
    const singlePdfBytes = await singlePdf.save();

    const contextSummary = masterJson
      ? `\nPREVIOUS DATA CONTEXT (Sudah diekstrak):\n- Invoice/PL Number: ${masterJson.invoice_number || masterJson.packing_list_number}\n- Last Extracted Items Count: ${masterJson.invoice_list?.[0]?.items?.length || 0}\n`
      : '';

    const pagePrompt = i === 0 ? prompt : getSequentialExtractionPrompt(prompt, contextSummary);

    const { parsedData: pageJson, usageMetadata } = await callGeminiWithRetry([
      pagePrompt,
      { inlineData: { data: Buffer.from(singlePdfBytes).toString('base64'), mimeType: 'application/pdf' } }
    ]);
    await debugLog(docCode, `raw_pdf_page_${i + 1}`, pageJson);

    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;

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
 */
export const processParallelPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  console.log(`\n[AI-SERVICE] [PARALLEL MODE] Memulai Parallel Extraction untuk ${numPages} halaman...`);

  // Helper: Potong satu halaman menjadi PDF buffer
  const extractPageBuffer = async (pageIndex) => {
    const singlePdf = await PDFDocument.create();
    const [page] = await singlePdf.copyPages(pdfDoc, [pageIndex]);
    singlePdf.addPage(page);
    return Buffer.from(await singlePdf.save());
  };

  // ================================================================
  // PHASE 1: Halaman 1 - Full Extraction (Header + Items)
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
  await debugLog(docCode, 'parallel_page_1_header', masterJson);

  if (numPages === 1) return masterJson;

  // ================================================================
  // PHASE 2: Halaman 2-N - Parallel Item-Only Extraction
  // ================================================================
  console.log(`[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan ${numPages - 1} worker paralel...`);
  const itemOnlyPrompt = getItemOnlyExtractionPrompt(jsonSchema);

  const parallelTasks = Array.from({ length: numPages - 1 }, (_, i) => i + 1).map(async (pageIndex) => {
    const pageBuffer = await extractPageBuffer(pageIndex);
    const { parsedData: rawItems, usageMetadata: pageMeta } = await callGeminiWithRetry([
      itemOnlyPrompt,
      { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += pageMeta.promptTokenCount || 0;
    tokenUsage.output += pageMeta.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(pageMeta);
    tokenUsage.total += pageMeta.totalTokenCount || 0;
    return { pageIndex, items: Array.isArray(rawItems) ? rawItems : [] };
  });

  const parallelResults = await Promise.all(parallelTasks);
  parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);
  console.log(`[AI-SERVICE] [PARALLEL MODE] Semua ${parallelResults.length} worker selesai.`);

  // ================================================================
  // PHASE 3: Heuristic Boundary Reconciliation
  // Deteksi item terpotong di antara dua halaman berurutan
  // ================================================================
  const IDENTITY_KEYS = ['hs_code', 'number_item', 'item_no', 'description', 'commodity'];
  const VALUE_KEYS = ['quantity', 'unit_price', 'amount', 'net_weight', 'gross_weight'];

  const isLikelyContinuation = (prevLast, nextFirst) => {
    if (!prevLast || !nextFirst) return false;
    const hasIdentity = IDENTITY_KEYS.some((k) => nextFirst[k]);
    const hasValue = VALUE_KEYS.some((k) => nextFirst[k]);
    return !hasIdentity && hasValue;
  };

  const getItemArray = (data) => {
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.invoice_list?.[0]?.items)) return data.invoice_list[0].items;
    return [];
  };

  // ================================================================
  // PHASE 4: Merge semua hasil ke masterJson
  // ================================================================
  const masterItems = getItemArray(masterJson);

  for (let i = 0; i < parallelResults.length; i++) {
    const pageItems = parallelResults[i].items;
    if (pageItems.length === 0) continue;

    // Rekonsiliasi dengan batas dari halaman sebelumnya
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

    if (pageItems.length === 0) continue;

    // Sisipkan items ke struktur masterJson yang benar
    if (Array.isArray(masterJson?.invoice_list)) {
      if (!masterJson.invoice_list[0]) masterJson.invoice_list[0] = { items: [] };
      if (!Array.isArray(masterJson.invoice_list[0].items)) masterJson.invoice_list[0].items = [];
      masterJson.invoice_list[0].items.push(...pageItems);
    } else {
      if (!Array.isArray(masterJson.items)) masterJson.items = [];
      masterJson.items.push(...pageItems);
    }
  }

  await debugLog(docCode, 'parallel_merged_output', masterJson);
  const totalItems = getItemArray(masterJson).length;
  console.log(`[AI-SERVICE] [PARALLEL MODE] ✅ Selesai. Total item terkumpul: ${totalItems}`);
  return masterJson;
};

