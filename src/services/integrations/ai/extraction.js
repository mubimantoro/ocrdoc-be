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
import logger from '../../../config/logger.js';

/**
 * POST-PROCESSING: Buang item ghost di mana semua field bernilai null/undefined/string kosong.
 *
 * Konteks: enforceSchemaStrictness meng-inject semua key schema dengan nilai null
 * ke setiap item. Item "ghost" seperti {invoice_number: ""} yang lolos dari
 * routeItemToList (karena invoice_number empty string dianggap sebagai fallback
 * ke entry pertama) kemudian setelah strip invoice_number menjadi {} kosong,
 * lalu enforcer meng-inject semua null → item all-null muncul di output final.
 *
 * AMAN untuk sub-baris batch dengan amount=0, quantity=1, net_weight=0.001
 * karena nilai 0 dan angka valid TIDAK dianggap null oleh fungsi ini.
 *
 */
const purgeNullItems = (data, log) => {
  if (!data || typeof data !== 'object') return;

  const isNullItem = (item) =>
    !item ||
    typeof item !== 'object' ||
    Object.values(item).every((v) => v === null || v === undefined || v === '');

  // Hapus item dari array secara in-place (splice dari belakang agar index tidak bergeser)
  const purgeFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (isNullItem(arr[i])) {
        log.debug({ event: 'null_item_purged', index: i }, `Item all-null di index ${i} dibuang`);
        arr.splice(i, 1);
      }
    }
  };

  // Cakupan: pl_list[*].items, invoice_list[*].items, items root
  if (Array.isArray(data.pl_list)) {
    data.pl_list.forEach((entry) => purgeFromArray(entry?.items));
  }
  if (Array.isArray(data.invoice_list)) {
    data.invoice_list.forEach((entry) => purgeFromArray(entry?.items));
  }
  if (Array.isArray(data.items)) {
    purgeFromArray(data.items);
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Master: Omni-Channel Map Reduce (PDF & Excel) + Self-Healing
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null, isExcelToPdf = false, log = logger) => {
  const tokenUsage = { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 };

  // ==============================================================
  // MULAI EKSTRAKSI
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
    finalParsedData = await processExcelExtraction(fileBuffer, sheetName, prompt, tokenUsage, log);
  } else if (isPdf) {
    // PENGECEKAN KOMPLEKSITAS SKEMA
    const hasItemList = Object.values(jsonSchema).some((val) => {
      if (Array.isArray(val)) return true;
      if (val && typeof val === 'object' && Array.isArray(val.items)) return true;
      return false;
    });
    const isLightSchema = !hasItemList && Object.keys(jsonSchema).length <= 5;

    // Cek jumlah halaman untuk routing decision
    const pdfDocCheck = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const numPagesPdf = pdfDocCheck.getPageCount();


    // 217_EXCEL selalu masuk ke Parallel (karena logika 14-kolom ada di sana)
    const isSpecialExcelPdf = isExcelToPdf && docCode === '217';

    // Dokumen dianggap "berat" jika punya item list DAN > 5 halaman.
    // Threshold 5 dipertahankan untuk dokumen umum (001, 217, 861, dll).
    const isHeavyDocument = hasItemList && numPagesPdf > 5;

    const isShortInvoice = docCode === '380' && hasItemList && numPagesPdf <= 5;

    const forceParallel = isHeavyDocument || isSpecialExcelPdf;

    log.debug({
      event: 'routing_decision',
      docCode,
      hasItemList,
      numPages: numPagesPdf,
      isHeavyDocument,
      isShortInvoice,
      forceParallel,
      isSpecialExcelPdf,
    }, 'Routing check selesai');

    if (isLightSchema) {
      // Strategi 1: Light Mode
      finalParsedData = await processLightPdfExtraction(fileBuffer, prompt, tokenUsage, log);
      const hasNumber = finalParsedData?.doc_number || finalParsedData?.ls_number;
      const isConfident = (finalParsedData?.confidence_score || 0) >= 0.6;

      if (!hasNumber || !isConfident) {
        log.warn({
          event: 'light_mode_fallback',
          docCode,
          hasNumber: !!hasNumber,
          confidenceScore: finalParsedData?.confidence_score ?? null,
        }, 'Light Mode kurang memuaskan, fallback ke Full Extraction');
        finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage, log);
      }
    } else if (isShortInvoice) {
      // Strategi 2: One-Shot untuk Invoice (380) pendek (≤ 5 halaman)
      // Mengirim seluruh PDF sekaligus agar AI mendapat konteks penuh
      // menghindari kegagalan Sequential mode pada format vendor dengan banyak halaman non-item.
      log.info({ event: 'one_shot_extraction', docCode, numPages: numPagesPdf },
        `One-Shot mode: Invoice 380 (${numPagesPdf} hal)`);
      const { parsedData: oneShotJson, usageMetadata } = await callGeminiWithRetry([
        prompt,
        { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
      ], 3, null, log);
      tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
      tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
      tokenUsage.ocr += extractOcrTokens(usageMetadata);
      tokenUsage.total += usageMetadata.totalTokenCount || 0;
      finalParsedData = oneShotJson;
    } else if (forceParallel) {
      // Strategi 3: Parallel mode untuk dokumen berat atau 217_EXCEL
      finalParsedData = await processParallelPdfExtraction(fileBuffer, docCode, prompt, jsonSchema, tokenUsage, isExcelToPdf, log);
    } else {
      // Strategi 4: Sequential mode untuk dokumen non-heavy lainnya
      finalParsedData = await processPdfExtraction(fileBuffer, docCode, prompt, tokenUsage, log);
    }
  } else {
    // IMAGE PROCESSING
    const { parsedData: imgJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
    ], 3, null, log);
    finalParsedData = imgJson;
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
  }

  tokenUsage.inputText = Math.max(0, tokenUsage.inputTotal - tokenUsage.ocr);

  // POST-PROCESSING: Reasoning Cleanup
  if (finalParsedData?._reasoning) {
    log.debug({ event: 'ai_reasoning', docCode, reasoning: finalParsedData._reasoning }, 'AI reasoning captured');
  }
  if (Array.isArray(finalParsedData)) {
    finalParsedData.forEach((item) => delete item._reasoning);
  } else if (finalParsedData && typeof finalParsedData === 'object') {
    delete finalParsedData._reasoning;
  }

  // ZERO-REGRESSION: Kembalikan fungsi parseItemsCsv agar dokumen PDF berhalaman sedikit (Sequential) tetap ter-parsing!
  if (docCode === '217' || docCode === '001') {
    // Catatan: Untuk 217_EXCEL, data sudah dalam bentuk objek dari pdf.js (Phase 3 stitching),
    // fungsi parseItemsCsv dirancang aman (idempotent) karena ia hanya mem-parsing properti 'items_csv'.
    // Jika tidak ada 'items_csv', ia tidak akan merusak objek yang sudah ada.
    parseItemsCsv(finalParsedData, docCode);
  }

  // POST-PROCESSING: Universal Forward-Fill
  applyForwardFill(finalParsedData);

  // POST-PROCESSING: Buang item ghost (semua field null)
  // Dipanggil setelah forwardFill agar item yang sebelumnya kosong
  // tapi sudah diisi via forward-fill tidak ikut terbuang.
  purgeNullItems(finalParsedData, log);

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
