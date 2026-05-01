/* eslint-disable camelcase */

import { PDFDocument } from 'pdf-lib';
import { Type } from '@google/genai';
import { getSequentialExtractionPrompt, getItemOnlyExtractionPrompt } from '../../../../prompts/extraction/index.js';
import { callGeminiWithRetry, mergeArraysDeep, extractOcrTokens, debugLog, parseItemsCsv, jsonToGeminiSchema } from '../helpers.js';

export const processPdfExtraction = async (fileBuffer, docCode, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    return pdfJson;
  }

  if (docCode === '001' && numPages <= 8) {
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    return pdfJson;
  }

  let masterJson = null;
  for (let i = 0; i < numPages; i++) {
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

    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;

    if (i === 0) masterJson = pageJson;
    else mergeArraysDeep(masterJson, pageJson);
  }
  return masterJson;
};

export const processLightPdfExtraction = async (fileBuffer, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    const { parsedData, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
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
  tokenUsage.total += usageMetadata.totalTokenCount || 0;
  return parsedData;
};

// ====================================================================================
// 🚀 ARSITEKTUR MASTER-SLAVE PARALLEL (ZERO-REGRESSION SECURE)
// ====================================================================================
export const processParallelPdfExtraction = async (fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf = false) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  if (pdfDoc.isEncrypted) {
    return processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
  }

  console.log(`\n[AI-SERVICE] [PARALLEL MODE] Memulai Ekstraksi Master-Slave untuk ${numPages} halaman...`);

  const extractPageBuffer = async (pageIndex) => {
    const singlePdf = await PDFDocument.create();
    const [page] = await singlePdf.copyPages(pdfDoc, [pageIndex]);
    singlePdf.addPage(page);
    return Buffer.from(await singlePdf.save());
  };

  // --- 1. SCHEMA BUILDING ---
  let masterSchema = null;
  let itemSchema = null;
  let phase1HeaderOnlySchema = null;

  if (isExcelToPdf && docCode === '217') {
    itemSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          invoice_number: { type: Type.STRING },
          items_csv: { type: Type.ARRAY, items: { type: Type.STRING } }
        }
      }
    };

    phase1HeaderOnlySchema = {
      type: Type.OBJECT,
      properties: {
        doc_code: { type: Type.STRING },
        doc_name: { type: Type.STRING },
        confidence_score: { type: Type.NUMBER },
        pl_list: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              invoice_number: { type: Type.STRING },
              invoice_date: { type: Type.STRING }
            }
          },
          minItems: 1
        }
      },
      required: ['pl_list']
    };
  } else {
    masterSchema = jsonToGeminiSchema(jsonSchema);
    const itemBlueprint = jsonSchema.pl_list?.[0]?.items || jsonSchema.invoice_list?.[0]?.items || jsonSchema.items || [];
    itemSchema = jsonToGeminiSchema(itemBlueprint);

    if (masterSchema && masterSchema.properties) {
      phase1HeaderOnlySchema = JSON.parse(JSON.stringify(masterSchema));
      delete phase1HeaderOnlySchema.properties.items;
      if (phase1HeaderOnlySchema.properties.pl_list?.items?.properties?.items) {
        delete phase1HeaderOnlySchema.properties.pl_list.items.properties.items;
      }
      if (phase1HeaderOnlySchema.properties.invoice_list?.items?.properties?.items) {
        delete phase1HeaderOnlySchema.properties.invoice_list.items.properties.items;
      }
    }
  }

  // --- 2. PHASE 1: Halaman 1 (HEADER ONLY) ---
  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 1: Mengekstrak Header...');
  const page1Buffer = await extractPageBuffer(0);

  // 🛡️ ZERO-REGRESSION: Isolasi prompt khusus Excel 217 agar tidak menyentuh item di Phase 1
  let masterPrompt = prompt;
  if (isExcelToPdf && docCode === '217') {
    masterPrompt = `${prompt}\n\nCRITICAL INSTRUCTION KHUSUS PHASE 1: JANGAN PERNAH MENGEKSTRAK BARIS BARANG (items / items_csv)! ABAIKAN BLUEPRINT ITEM. Ekstrak HANYA Header (invoice_number, invoice_date). Output WAJIB berupa objek JSON murni tanpa isi data barang.`;
  } else {
    masterPrompt = `${prompt}\n\nCRITICAL INSTRUCTION: Ekstrak HANYA informasi Header (seperti nomor dokumen, tanggal, dll). JANGAN ekstrak tabel baris barang.`;
  }

  const { parsedData: rawMasterJson, usageMetadata: headerMeta } = await callGeminiWithRetry([
    masterPrompt,
    { inlineData: { data: page1Buffer.toString('base64'), mimeType: 'application/pdf' } }
  ], 3, phase1HeaderOnlySchema);

  tokenUsage.inputTotal += headerMeta.promptTokenCount || 0;
  tokenUsage.output += headerMeta.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(headerMeta);
  tokenUsage.total += headerMeta.totalTokenCount || 0;

  // 🛡️ THE HARVESTER PROTECTOR
  // Jika Phase 1 terpotong & Harvester merespons berupa Array, kita rakit kembali jadi Object
  let masterJson = rawMasterJson;
  if (Array.isArray(rawMasterJson)) {
    console.warn('[AI-SERVICE] Harvester terpicu di Phase 1. Merakit ulang menjadi Master Object...');
    masterJson = {
      doc_code: docCode,
      pl_list: [{ invoice_number: 'N/A', items_csv: rawMasterJson }]
    };
  }

  // Siapkan rumah data secara aman
  if (docCode === '217') {
    if (!masterJson.pl_list || masterJson.pl_list.length === 0) masterJson.pl_list = [{ invoice_number: masterJson.doc_code || 'N/A' }];
    if (!masterJson.pl_list[0].items_csv) masterJson.pl_list[0].items_csv = [];
    if (!masterJson.pl_list[0].items) masterJson.pl_list[0].items = [];
  } else {
    const targetListKey = masterJson.invoice_list ? 'invoice_list' : 'pl_list';
    if (!masterJson[targetListKey] || masterJson[targetListKey].length === 0) masterJson[targetListKey] = [{}];
    if (!masterJson[targetListKey][0].items) masterJson[targetListKey][0].items = [];
  }

  // --- 3. PHASE 2: Batched Parallel Worker (Hanya Items, SEMUA HALAMAN 0 sampai N) ---
  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 2: Meluncurkan worker paralel untuk SELURUH halaman...');
  const itemOnlyPrompt = getItemOnlyExtractionPrompt(docCode, jsonSchema, isExcelToPdf);
  const parallelResults = [];
  const CONCURRENCY_LIMIT = 5;
  const pagesToProcess = Array.from({ length: numPages }, (_, i) => i); // Mulai dari 0

  for (let i = 0; i < pagesToProcess.length; i += CONCURRENCY_LIMIT) {
    const batchPages = pagesToProcess.slice(i, i + CONCURRENCY_LIMIT);
    const batchTasks = batchPages.map(async (pageIndex) => {
      const pageBuffer = await extractPageBuffer(pageIndex);

      const { parsedData: rawData, usageMetadata: pageMeta } = await callGeminiWithRetry([
        itemOnlyPrompt,
        { inlineData: { data: pageBuffer.toString('base64'), mimeType: 'application/pdf' } }
      ], 3, itemSchema);

      tokenUsage.inputTotal += pageMeta.promptTokenCount || 0;
      tokenUsage.output += pageMeta.candidatesTokenCount || 0;
      tokenUsage.ocr += extractOcrTokens(pageMeta);
      tokenUsage.total += pageMeta.totalTokenCount || 0;

      // Tarik array murni (Aman dari objek campuran)
      let items = [];
      if (Array.isArray(rawData)) {
        // 🚀 THE HARVESTER SAFEGUARD: Jika Harvester mengembalikan Array String mentah, kita paksakan masuk ke objek CONTINUATION
        if (rawData.length > 0 && typeof rawData[0] === 'string') {
          items = [{ invoice_number: 'CONTINUATION_PAGE', items_csv: rawData }];
        } else {
          items = rawData;
        }
      } else if (rawData && typeof rawData === 'object') {
        const potentialItems = rawData.items_csv || rawData.items || [];
        if (Array.isArray(potentialItems)) items = potentialItems;
      }

      return { pageIndex, items };
    });

    const batchResults = await Promise.all(batchTasks);
    parallelResults.push(...batchResults);
    if (i + CONCURRENCY_LIMIT < pagesToProcess.length) await new Promise((res) => setTimeout(res, 2000));
  }

  parallelResults.sort((a, b) => a.pageIndex - b.pageIndex);

  // --- 4. PHASE 3: DYNAMIC INVOICE MERGING ---
  console.log('[AI-SERVICE] [PARALLEL MODE] Phase 3: Menjahit data berdasarkan Nomor Invoice...');

  let lastSeenInvoiceNo = 'UNKNOWN'; // 🚀 Tracker Context Bleeding

  for (let i = 0; i < parallelResults.length; i++) {
    const { items: pageItems } = parallelResults[i];
    if (!pageItems || pageItems.length === 0) continue;

    if (docCode === '217' && isExcelToPdf) {
      pageItems.forEach((group) => {
        if (!group.items_csv || group.items_csv.length === 0) return;

        let currentInvoiceNo = group.invoice_number || 'UNKNOWN';

        // 🚀 THE STITCHER: Jahit barang dari halaman lanjutan ke invoice terakhir
        if (currentInvoiceNo === 'CONTINUATION_PAGE' || currentInvoiceNo === 'UNKNOWN') {
          currentInvoiceNo = lastSeenInvoiceNo;
        } else {
          lastSeenInvoiceNo = currentInvoiceNo; // Update memori invoice terbaru
        }

        let targetInvoice = masterJson.pl_list.find((pl) => pl.invoice_number === currentInvoiceNo);

        if (!targetInvoice) {
          targetInvoice = { invoice_number: currentInvoiceNo, items_csv: [] };
          masterJson.pl_list.push(targetInvoice);
        }

        if (!targetInvoice.items_csv) targetInvoice.items_csv = [];
        targetInvoice.items_csv.push(...group.items_csv);
      });
    } else {
      const targetListKey = masterJson.invoice_list ? 'invoice_list' : 'pl_list';
      masterJson[targetListKey][0].items.push(...pageItems);
    }
  }

  if (docCode === '217' && isExcelToPdf) {
    masterJson.pl_list = masterJson.pl_list.filter((pl) => pl.items_csv && pl.items_csv.length > 0);
  }

  if (docCode === '001' || (docCode === '217' && isExcelToPdf)) {
    parseItemsCsv(masterJson, docCode);
  }

  await debugLog(docCode, 'parallel_merged_output', masterJson);

  const finalItemsCount = docCode === '217' ? masterJson.pl_list?.reduce((acc, pl) => acc + (pl.items?.length || 0), 0) : (masterJson.invoice_list?.[0]?.items?.length || masterJson.pl_list?.[0]?.items?.length);
  console.log(`[AI-SERVICE] [PARALLEL MODE] ✅ Selesai. Total item berhasil dirakit & digroup: ${finalItemsCount || 0}`);

  return masterJson;
};