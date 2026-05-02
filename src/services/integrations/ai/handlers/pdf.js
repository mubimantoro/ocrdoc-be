/* eslint-disable camelcase */

import { PDFDocument } from 'pdf-lib';
import { Type } from '@google/genai';
import { getSequentialExtractionPrompt, getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { callGeminiWithRetry, mergeArraysDeep, extractOcrTokens, debugLog, parseItemsCsv } from '../helpers.js';

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

export const processLightPdfExtraction = async (fileBuffer, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  console.log('\n[AI-SERVICE] [LIGHT PDF MODE] Mencoba Ekstraksi Cepat (Halaman 1 & Terakhir)...');

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

  const { parsedData, usageMetadata } = await callGeminiWithRetry([prompt, { inlineData: { data: Buffer.from(lightPdfBytes).toString('base64'), mimeType: 'application/pdf' } }]);
  tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0; tokenUsage.output += usageMetadata.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(usageMetadata); tokenUsage.total += usageMetadata.totalTokenCount || 0;
  return parsedData;
};

// ====================================================================================
// 🚀 ARSITEKTUR PARALLEL (HYBRID: 14-COLUMN FLAT UNTUK 217_EXCEL + HEURISTIC UNTUK LAINNYA)
// ====================================================================================
export const processParallelPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf = false) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    console.warn('[AI-SERVICE] [PARALLEL MODE] Secured PDF tidak bisa diproses paralel. Mengalihkan ke One-Shot...');
    return processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
  }

  console.log(`\n[AI-SERVICE] [PARALLEL MODE] Memulai Parallel Extraction untuk ${numPages} halaman...`);

  const extractPageBuffer = async (pageIndex) => {
    const singlePdf = await PDFDocument.create();
    const [page] = await singlePdf.copyPages(pdfDoc, [pageIndex]);
    singlePdf.addPage(page);
    return Buffer.from(await singlePdf.save());
  };

  // 🛡️ ====================================================================================
  // JALUR A: KHUSUS 217_EXCEL (FLAT ARRAY + ROW LEVEL STITCHING)
  // ====================================================================================
  if (isExcelToPdf && docCode === '217') {
    console.log('[AI-SERVICE] [PARALLEL MODE] Menggunakan Jalur Khusus 217_EXCEL (14-Column Flat Array)...');

    const itemSchema = { type: Type.ARRAY, items: { type: Type.STRING } };
    const phase1HeaderOnlySchema = {
      type: Type.OBJECT,
      properties: {
        doc_code: { type: Type.STRING },
        doc_name: { type: Type.STRING },
        confidence_score: { type: Type.NUMBER },
        pl_list: {
          type: Type.ARRAY,
          items: { type: Type.OBJECT, properties: { invoice_number: { type: Type.STRING }, invoice_date: { type: Type.STRING } } },
          minItems: 1
        }
      },
      required: ['pl_list']
    };

    console.log('[AI-SERVICE] [PARALLEL MODE] Phase 1: Mengekstrak Header HANYA dari Halaman 1...');
    const page1Buffer = await extractPageBuffer(0);
    const masterPrompt = `${prompt}\n\nCRITICAL INSTRUCTION KHUSUS PHASE 1: JANGAN PERNAH MENGEKSTRAK BARIS BARANG (items / items_csv)! ABAIKAN BLUEPRINT ITEM. Ekstrak HANYA Header (invoice_number, invoice_date). Output WAJIB berupa objek JSON murni tanpa isi data barang.`;

    const { parsedData: rawMasterJson, usageMetadata: headerMeta } = await callGeminiWithRetry([masterPrompt, { inlineData: { data: page1Buffer.toString('base64'), mimeType: 'application/pdf' } }], 3, phase1HeaderOnlySchema);
    tokenUsage.inputTotal += headerMeta.promptTokenCount || 0; tokenUsage.output += headerMeta.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(headerMeta); tokenUsage.total += headerMeta.totalTokenCount || 0;

    let masterJson = rawMasterJson;
    if (Array.isArray(rawMasterJson)) masterJson = { doc_code: docCode, pl_list: [{ invoice_number: 'UNKNOWN' }] };
    if (!masterJson.pl_list || masterJson.pl_list.length === 0) masterJson.pl_list = [{ invoice_number: masterJson.doc_code || 'UNKNOWN' }];
    masterJson.pl_list.forEach((pl) => { pl.items = []; });

    console.log('[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan worker paralel...');
    const itemOnlyPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, isExcelToPdf);
    const parallelResults = [];
    const CONCURRENCY_LIMIT = 5;
    const pagesToProcess = Array.from({ length: numPages }, (_, i) => i);

    for (let i = 0; i < pagesToProcess.length; i += CONCURRENCY_LIMIT) {
      const batchPages = pagesToProcess.slice(i, i + CONCURRENCY_LIMIT);
      const batchTasks = batchPages.map(async (pageIndex) => {
        const pageBuffer = await extractPageBuffer(pageIndex);
        const { parsedData: rawData, usageMetadata: pageMeta } = await callGeminiWithRetry([itemOnlyPrompt, { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }], 3, itemSchema);
        tokenUsage.inputTotal += pageMeta.promptTokenCount || 0; tokenUsage.output += pageMeta.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(pageMeta); tokenUsage.total += pageMeta.totalTokenCount || 0;
        const items = Array.isArray(rawData) ? rawData : (rawData?.items_csv || rawData?.items || []);
        return { pageIndex, items };
      });
      const batchResults = await Promise.all(batchTasks);
      parallelResults.push(...batchResults);
      if (i + CONCURRENCY_LIMIT < pagesToProcess.length) await new Promise((res) => setTimeout(res, 2000));
    }

    parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);
    console.log('[AI-SERVICE] [PARALLEL MODE] Phase 3: Penjahitan Row-Level Mapping...');

    let lastSeenInvoiceNo = masterJson.pl_list[0].invoice_number || 'UNKNOWN';
    const keys = ['number', 'description', 'quantity', 'quantity_unit', 'origin', 'brand', 'net_weight', 'gross_weight', 'amount', 'unit_price', 'measurement', 'packaging_qty', 'packaging_unit'];

    for (let i = 0; i < parallelResults.length; i++) {
      const { items: pageItems } = parallelResults[i];
      if (!pageItems || pageItems.length === 0) continue;
      pageItems.forEach((line) => {
        if (typeof line !== 'string') return;
        const parts = line.split('|');
        if (parts.length < 2) return;

        let currentInvoiceNo = parts[0] ? parts[0].trim() : '';
        if (!currentInvoiceNo || currentInvoiceNo === 'CONTINUATION_PAGE' || currentInvoiceNo === 'UNKNOWN') currentInvoiceNo = lastSeenInvoiceNo;
        else lastSeenInvoiceNo = currentInvoiceNo;

        let targetInvoice = masterJson.pl_list.find((pl) => pl.invoice_number === currentInvoiceNo);
        if (!targetInvoice) { targetInvoice = { invoice_number: currentInvoiceNo, items: [] }; masterJson.pl_list.push(targetInvoice); }
        if (!targetInvoice.items) targetInvoice.items = [];

        const obj = {};
        keys.forEach((k, idx) => {
          let val = parts[idx + 1] ? parts[idx + 1].trim() : null;
          if (val === '') val = null;
          else if (['quantity', 'net_weight', 'gross_weight', 'measurement', 'packaging_qty', 'unit_price', 'amount'].includes(k) && val) {
            const cleanedStr = val.toString().replace(/[^\d.-]/g, '');
            val = cleanedStr !== '' ? Number(cleanedStr) : null;
          }
          obj[k] = val;
        });
        targetInvoice.items.push(obj);
      });
    }

    masterJson.pl_list = masterJson.pl_list.filter((pl) => pl.items && pl.items.length > 0);
    await debugLog(docCode, 'parallel_merged_output', masterJson);
    const finalItemsCount = masterJson.pl_list?.reduce((acc, pl) => acc + (pl.items?.length || 0), 0);
    console.log(`[AI-SERVICE] [PARALLEL MODE] ✅ Selesai (217_EXCEL). Total item: ${finalItemsCount || 0}`);
    return masterJson;
  }

  // 🛡️ ====================================================================================
  // JALUR B: DOKUMEN LAIN (001, 217 NORMAL, 380) - ORIGINAL GITHUB COMMIT LOGIC
  // ====================================================================================
  console.log('[AI-SERVICE] [PARALLEL MODE] Menggunakan Jalur Standar (Heuristic Boundary Reconciliation)...');

  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 1: Mengekstrak Header dari Halaman 1...');
  const page1Buffer = await extractPageBuffer(0);
  const { parsedData: headerData, usageMetadata: headerMeta } = await callGeminiWithRetry([
    prompt,
    { inlineData: { data: page1Buffer.toString('base64'), mimeType: 'application/pdf' } }
  ]);
  tokenUsage.inputTotal += headerMeta.promptTokenCount || 0; tokenUsage.output += headerMeta.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(headerMeta); tokenUsage.total += headerMeta.totalTokenCount || 0;

  const masterJson = headerData;
  if (docCode === '001' || docCode === '217') parseItemsCsv(masterJson, docCode);
  await debugLog(docCode, 'parallel_page_1_header', masterJson);

  if (numPages === 1) return masterJson;

  const lastPageIndex = numPages - 1;
  console.log(`[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan ${numPages - 1} worker paralel...`);
  const itemOnlyPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema);

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
    const selectedPrompt = isLastPage ? prompt : itemOnlyPrompt;

    const { parsedData: rawData, usageMetadata: pageMeta } = await callGeminiWithRetry([
      selectedPrompt,
      { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);

    tokenUsage.inputTotal += pageMeta.promptTokenCount || 0; tokenUsage.output += pageMeta.candidatesTokenCount || 0; tokenUsage.ocr += extractOcrTokens(pageMeta); tokenUsage.total += pageMeta.totalTokenCount || 0;

    return {
      pageIndex,
      isLastPage,
      items: isLastPage ? getItemArray(rawData) : (Array.isArray(rawData) ? rawData : []),
      fullData: isLastPage ? rawData : null,
    };
  });

  const parallelResults = await Promise.all(parallelTasks);
  parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);
  console.log(`[AI-SERVICE] [PARALLEL MODE] Semua ${parallelResults.length} worker selesai.`);

  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 3 & 4: Heuristic Reconciliation & Merging...');
  const masterItems = getItemArray(masterJson);

  for (let i = 0; i < parallelResults.length; i++) {
    const { items: pageItems, isLastPage, fullData } = parallelResults[i];
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

    if (isLastPage && fullData) {
      console.log('[AI-SERVICE] [PARALLEL MODE] 🧩 Merging Last Page (Footer/Summary Data)...');
      if (docCode === '001' || docCode === '217') parseItemsCsv(fullData, docCode);
      mergeArraysDeep(masterJson, fullData);
    }

    if (pageItems.length === 0) continue;

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