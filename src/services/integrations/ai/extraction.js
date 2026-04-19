import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getExtractionPrompt, getValidationPrompt } from '../../../prompts/extraction.js';
import { enforceSchemaStrictness } from '../../../utils/schema-enforcer.js';
import { applyBusinessRules } from '../../../utils/business-rules.js';
import { ai, MODELS } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';
import { callGeminiWithRetry, extractOcrTokens, applyForwardFill, parseItemsCsv, debugLog } from './helpers.js';
import { processExcelExtraction } from './handlers/excel.js';
import { processPdfExtraction } from './handlers/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validasi apakah tipe dokumen sesuai dengan yang diharapkan
 */
const verifyDocumentType = async (fileBuffer, mimeType, expectedDocCode) => {
  const prompt = getValidationPrompt(expectedDocCode);

  const response = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      prompt,
      {
        inlineData: {
          data: fileBuffer.toString('base64'),
          mimeType: mimeType
        }
      }
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  });

  const result = cleanAIJson(response.text);
  return {
    isMatch: result.is_match,
    detectedDocCode: result.detected_doc_code,
    confidence: result.confidence || 0,
    reason: result.reason,
    usage: response.usageMetadata || {}
  };
};

/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Master: Omni-Channel Map Reduce (PDF & Excel) + Self-Healing
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null) => {
  const tokenUsage = { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 };

  // ==============================================================
  // 🛡️ GUARDRAIL: VALIDASI TIPE DOKUMEN
  // ==============================================================
  console.log(`[AI-SERVICE] Verifikasi tipe dokumen (Expected: ${docCode})...`);
  const validation = await verifyDocumentType(fileBuffer, mimeType, docCode);

  tokenUsage.inputTotal += validation.usage.promptTokenCount || 0;
  tokenUsage.output += validation.usage.candidatesTokenCount || 0;
  tokenUsage.total += validation.usage.totalTokenCount || 0;

  if (!validation.isMatch && validation.confidence > 0.8) {
    const errorMsg = `MISMATCH: Dokumen terdeteksi sebagai [${validation.detectedDocCode}] namun dikirim sebagai [${docCode}]. Alasan: ${validation.reason}`;
    console.warn(`[AI-SERVICE] 🛑 ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // ==============================================================
  // 🚀 LANJUT EKSTRAKSI JIKA VALID
  // ==============================================================
  let jsonSchema;

  try {
    const schemaPath = path.join(__dirname, '../../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (err) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${err.message}`);
  }

  const prompt = getExtractionPrompt(docCode, jsonSchema);
  let finalParsedData = null;

  const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');
  const isPdf = mimeType === 'application/pdf';

  if (isExcel) {
    finalParsedData = await processExcelExtraction(fileBuffer, sheetName, prompt, tokenUsage);
  } else if (isPdf) {
    finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage);
  } else {
    // IMAGE PROCESSING (Normal 1-Shot)
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

  // POST-PROCESSING: Decompress CSV format to Array of Objects
  if (docCode === '217' || docCode === '001') {
    parseItemsCsv(finalParsedData, docCode);
  }

  // POST-PROCESSING: Universal Forward-Fill
  applyForwardFill(finalParsedData);

  // POST-PROCESSING: Business Rules
  applyBusinessRules(docCode, finalParsedData);

  // POST-PROCESSING: Schema Contract Enforcer
  const strictParsedData = enforceSchemaStrictness(finalParsedData, jsonSchema);
  await debugLog(docCode, 'final_strict_schema_output', strictParsedData);

  return {
    data: strictParsedData,
    usage: tokenUsage,
    modelUsed: MODELS.FLAGSHIP
  };
};
