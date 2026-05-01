import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getExtractionPrompt } from '../../../prompts/extraction/index.js';
import { enforceSchemaStrictness } from '../../../utils/schema-enforcer.js';
import { applyBusinessRules } from '../../../utils/business-rules.js';
import { MODELS } from '../../../config/gemini.js';
import { callGeminiWithRetry, extractOcrTokens, applyForwardFill, debugLog } from './helpers.js';
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
    const hasItemList = Object.values(jsonSchema).some((val) => {
      if (Array.isArray(val)) return true;
      if (val && typeof val === 'object' && Array.isArray(val.items)) return true;
      return false;
    });
    const isLightSchema = !hasItemList && Object.keys(jsonSchema).length <= 5;

    const pdfDocCheck = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const numPagesPdf = pdfDocCheck.getPageCount();
    const isHeavyDocument = hasItemList && numPagesPdf > 5;

    console.log(`[AI-SERVICE] Routing Check -> hasItemList: ${hasItemList}, numPages: ${numPagesPdf}, isHeavy: ${isHeavyDocument}`);

    if (isLightSchema) {
      finalParsedData = await processLightPdfExtraction(fileBuffer, prompt, tokenUsage);
      const hasNumber = finalParsedData?.doc_number || finalParsedData?.ls_number;
      const isConfident = (finalParsedData?.confidence_score || 0) >= 0.6;

      if (!hasNumber || !isConfident) {
        console.warn('[AI-SERVICE] Hasil Light Mode kurang memuaskan. Fallback ke Full Extraction...');
        finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
      }
    } else if (isHeavyDocument) {
      // 🚀 MASUK KE ARSITEKTUR MASTER-SLAVE PARALLEL
      finalParsedData = await processParallelPdfExtraction(fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf);
    } else {
      finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
    }
  } else {
    // IMAGE PROCESSING
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

  if (finalParsedData && finalParsedData._reasoning) console.log(`[AI-SERVICE] AI Reasoning: ${finalParsedData._reasoning}`);
  if (Array.isArray(finalParsedData)) {
    finalParsedData.forEach((item) => delete item._reasoning);
  } else if (finalParsedData && typeof finalParsedData === 'object') {
    delete finalParsedData._reasoning;
  }

  applyForwardFill(finalParsedData);
  await applyBusinessRules(docCode, finalParsedData);

  const strictParsedData = enforceSchemaStrictness(finalParsedData, jsonSchema);
  await debugLog(docCode, 'final_strict_schema_output', strictParsedData);

  return {
    data: strictParsedData,
    usage: tokenUsage,
    modelUsed: MODELS.FLAGSHIP
  };
};
