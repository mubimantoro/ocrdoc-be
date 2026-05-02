import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getExtractionPrompt } from '../../../prompts/extraction/index.js';
import { enforceSchemaStrictness } from '../../../utils/schema-enforcer.js';
import { applyBusinessRules } from '../../../utils/business-rules.js';
import { MODELS } from '../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, applyForwardFill, debugLog, parseItemsCsv } from './helpers.js';
import { processExcelExtraction } from './handlers/excel.js';
import { PDFDocument } from 'pdf-lib';
import { processPdfExtraction, processLightPdfExtraction, processParallelPdfExtraction } from './handlers/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Master: Omni-Channel Map Reduce (PDF & Excel) + Self-Healing
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null, isExcelToPdf = false) => {
  const tokenUsage = { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 };

  // ==============================================================
  // 🚀 MULAI EKSTRAKSI
  // ==============================================================
  let jsonSchema;
  try {
    const schemaPath = path.join(__dirname, '../../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (err) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${err.message}`);
  }

  const prompt = getExtractionPrompt(docCode, jsonSchema, isExcelToPdf);
  let finalParsedData = null;

  const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');
  const isPdf = mimeType === 'application/pdf';

  if (isExcel) {
    finalParsedData = await processExcelExtraction(fileBuffer, sheetName, prompt, tokenUsage);
  } else if (isPdf) {
    // 🔍 PENGECEKAN KOMPLEKSITAS SKEMA
    const hasItemList = Object.values(jsonSchema).some((val) => {
      if (Array.isArray(val)) return true;
      if (val && typeof val === 'object' && Array.isArray(val.items)) return true;
      return false;
    });
    const isLightSchema = !hasItemList && Object.keys(jsonSchema).length <= 5;

    // Cek jumlah halaman untuk routing decision
    const pdfDocCheck = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const numPagesPdf = pdfDocCheck.getPageCount();
    const isHeavyDocument = hasItemList && numPagesPdf > 5;

    // 🚀 THE FIX: Pastikan 217_EXCEL selalu masuk ke Parallel (karena logika 14-kolom ada di sana)
    const isSpecialExcelPdf = isExcelToPdf && docCode === '217';
    const forceParallel = isHeavyDocument || isSpecialExcelPdf;

    console.log(`[AI-SERVICE] Routing Check -> hasItemList: ${hasItemList}, numPages: ${numPagesPdf}, isHeavy: ${isHeavyDocument}`);

    if (isLightSchema) {
      // ⚡ Strategi 1: Light Mode
      finalParsedData = await processLightPdfExtraction(fileBuffer, prompt, tokenUsage);
      const hasNumber = finalParsedData?.doc_number || finalParsedData?.ls_number;
      const isConfident = (finalParsedData?.confidence_score || 0) >= 0.6;

      if (!hasNumber || !isConfident) {
        console.warn('[AI-SERVICE] Hasil Light Mode kurang memuaskan. Fallback ke Full Extraction...');
        finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
      }
    } else if (forceParallel) {
      // Masuk ke arsitektur master-slave
      finalParsedData = await processParallelPdfExtraction(fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf);
    } else {
      // Sequential mode normal
      finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
    }
  } else {
    // 🖼️ IMAGE PROCESSING
    const { parsedData: imgJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
    ]);
    finalParsedData = imgJson;
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
  }

  tokenUsage.inputText = Math.max(0, tokenUsage.inputTotal - tokenUsage.ocr);

  // POST-PROCESSING: Reasoning Cleanup
  if (finalParsedData && finalParsedData._reasoning) console.log(`[AI-SERVICE] AI Reasoning: ${finalParsedData._reasoning}`);
  if (Array.isArray(finalParsedData)) {
    finalParsedData.forEach((item) => delete item._reasoning);
  } else if (finalParsedData && typeof finalParsedData === 'object') {
    delete finalParsedData._reasoning;
  }

  // 🛡️ ZERO-REGRESSION: Kembalikan fungsi parseItemsCsv agar dokumen PDF berhalaman sedikit (Sequential) tetap ter-parsing!
  if (docCode === '217' || docCode === '001') {
    // Catatan: Untuk 217_EXCEL, data sudah dalam bentuk objek dari pdf.js (Phase 3 stitching),
    // fungsi parseItemsCsv dirancang aman (idempotent) karena ia hanya mem-parsing properti 'items_csv'.
    // Jika tidak ada 'items_csv', ia tidak akan merusak objek yang sudah ada.
    parseItemsCsv(finalParsedData, docCode);
  }

  // POST-PROCESSING: Universal Forward-Fill
  applyForwardFill(finalParsedData);

  // POST-PROCESSING: Business Rules
  await applyBusinessRules(docCode, finalParsedData);

  // POST-PROCESSING: Schema Contract Enforcer
  const strictParsedData = enforceSchemaStrictness(finalParsedData, jsonSchema);
  await debugLog(docCode, 'final_strict_schema_output', strictParsedData);

  return {
    data: strictParsedData,
    usage: tokenUsage,
    modelUsed: MODELS.FLAGSHIP
  };
};