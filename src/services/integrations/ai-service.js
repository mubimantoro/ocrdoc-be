/* eslint-disable camelcase */
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import * as xlsx from 'xlsx';
import { getBoundaryPrompt } from '../../prompts/boundary.js';
import { ai, MODELS } from '../../config/gemini.js';
import { getExtractionPrompt } from '../../prompts/extraction.js';
import { PDFDocument } from 'pdf-lib';
import { cleanAIJson } from '../../utils/ai-sanitizer.js';
import { buildDocumentsFromPages } from '../../utils/boundary-resolver.js';
import { enforceSchemaStrictness } from '../../utils/schema-enforcer.js';
import { applyBusinessRules } from '../../utils/business-rules.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ekstraksi token spesifik OCR dari metadata Gemini
 * Time Complexity: O(N) dimana N adalah jumlah modality details
 */
const extractOcrTokens = (metadata) => {
  let ocrTokens = 0;
  if (metadata.promptTokensDetails && Array.isArray(metadata.promptTokensDetails)) {
    const docOrImageDetail = metadata.promptTokensDetails.find(
      (detail) => detail.modality === 'IMAGE' || detail.modality === 'DOCUMENT'
    );
    if (docOrImageDetail) {
      ocrTokens = docOrImageDetail.tokenCount || 0;
    }
  }
  return ocrTokens;
};

/**
 * API Call Level Rendah ke Gemini (Tidak boleh dipanggil langsung untuk file masif)
 */
export const detectBoundaries = async (fileBuffer, mimeType, absoluteStartPage, totalPagesInChunk) => {
  const prompt = getBoundaryPrompt(absoluteStartPage, totalPagesInChunk);

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

  const parsedResult = cleanAIJson(response.text);
  const usageMetadata = response.usageMetadata || {};

  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);
  const textInput = Math.max(0, totalInput - ocrTokens);

  return {
    pages: parsedResult.pages || [],
    usage: {
      input_total: usageMetadata.promptTokenCount,
      input_text: textInput,
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    model_used: MODELS.CHEAP,
  };
};

/**
 * ENTERPRISE ARCHITECTURE: Sequential Chunked Boundary Detection
 * O(N/K) Space Complexity. Menghindari Context Bleed pada Vision LLM.
 */
export const detectBoundariesChunked = async (absoluteFilePath, mimeType, maxPagesPerChunk = 15) => {
  const pdfBuffer = await fs.readFile(absoluteFilePath);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  const allPagesRaw = [];
  const totalUsage = { input_total: 0, input_text: 0, ocr: 0, output: 0, total: 0 };

  for (let startPage = 1; startPage <= totalPages; startPage += maxPagesPerChunk) {
    const endPage = Math.min(startPage + maxPagesPerChunk - 1, totalPages);
    const pagesInThisChunk = (endPage - startPage) + 1;

    const newPdf = await PDFDocument.create();
    const pageIndices = Array.from({ length: pagesInThisChunk }, (_, i) => startPage - 1 + i);
    const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    const chunkBuffer = await newPdf.save();
    console.log(`[AI-SERVICE] Tagging Chunk: hal ${startPage} - ${endPage}`);

    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType, startPage, pagesInThisChunk);
    const taggedPages = result.pages || [];

    // Defensive Loop: Mencegah hilangnya halaman akibat LLM Omission
    for (let p = startPage; p <= endPage; p++) {
      const foundPage = taggedPages.find((t) => t.absolute_page_number === p);
      if (foundPage) {
        allPagesRaw.push(foundPage);
      } else {
        console.warn(`[AI-SERVICE] Missing data for page ${p}, applying fallback tag.`);
        allPagesRaw.push({
          absolute_page_number: p,
          is_new_document: false,
          doc_code: '999',
          document_number: null,
          vendor: null,
          confidence: 0
        });
      }
    }

    totalUsage.input_total += result.usage.input_total;
    totalUsage.input_text += result.usage.input_text;
    totalUsage.ocr += result.usage.ocr;
    totalUsage.output += result.usage.output;
    totalUsage.total += result.usage.total;
  }

  // O(N) Deterministic Aggregation
  const finalDocuments = buildDocumentsFromPages(allPagesRaw);

  return {
    documents: finalDocuments,
    usage: totalUsage,
    model_used: MODELS.CHEAP,
    page_count: totalPages
  };
};
/**
 * Ekstraksi Data Spesifik (Fase 2)
 * Tidak memerlukan chunking karena inputnya adalah PDF yang sudah displit (1-5 halaman).
 */
/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Hybrid: Map-Reduce Batching (Excel) + Self-Healing Loop
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null) => {
  let jsonSchema;

  try {
    const schemaPath = path.join(__dirname, '../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (error) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${error.message}`);
  }

  const basePrompt = getExtractionPrompt(jsonSchema);
  const prompt = `${basePrompt}
  ABSOLUTE DIRECTIVE (MANUAL OVERRIDE & UNIVERSAL EXTRACTION MODE):
  1. Terapkan teknik "Chain of Thought". Buat key "_reasoning" di baris paling atas pada output JSON. (Maks 2 kalimat).
  2. CRITICAL WARNING: Pastikan output JSON tertutup sempurna ( } atau ] ) di bagian akhir.
  3. TOKEN ECONOMY (SANGAT PENTING): Untuk menghemat token dan mencegah truncation, JANGAN PERNAH menulis key yang nilainya kosong/null (terutama di dalam array items atau details_list). Jika data tidak ada di dokumen, hapus/abaikan saja key tersebut dari JSON. Sistem backend kami yang akan mengurus sisanya.
  `;

  const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');

  // ==============================================================
  // HELPER 1: SHAPE-BASED ARRAY FINDER
  // ==============================================================
  const findTabularArray = (data) => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const value of Object.values(data)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') return value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const subValue of Object.values(value)) {
            if (Array.isArray(subValue) && subValue.length > 0 && typeof subValue[0] === 'object') return subValue;
          }
        }
      }
    }
    return null;
  };

  // ==============================================================
  // HELPER 2: THE SELF-HEALING ENGINE (ANTI-TRUNCATION)
  // ==============================================================
  const callGeminiWithRetry = async (geminiContents, maxRetries = 3) => {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        attempt++;
        const response = await ai.models.generateContent({
          model: MODELS.FLAGSHIP,
          contents: geminiContents,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1 + (attempt * 0.1), // Jittering temperature
            maxOutputTokens: 8192
          }
        });

        const parsedData = cleanAIJson(response.text);
        return { parsedData, usageMetadata: response.usageMetadata || {} };

      } catch (error) {
        console.warn(`\n[AI-SERVICE] JSON Truncation Error pada Attempt ${attempt}/${maxRetries}: ${error.message}`);
        if (attempt >= maxRetries) {
          throw new Error(`AI Gagal mereturn JSON valid setelah ${maxRetries} percobaan. Error: ${error.message}`);
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  };

  let finalParsedData = null;
  const totalUsage = { input_total: 0, input_text: 0, ocr: 0, output: 0, total: 0 };

  // ==============================================================
  // JALUR 1: EXCEL MAP-REDUCE PROCESSING
  // ==============================================================
  if (isExcel) {
    console.log('\n[AI-SERVICE] [EXCEL MODE] Menerapkan Map-Reduce Batching...');
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const targetSheetName = sheetName || workbook.SheetNames[0];
    const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[targetSheetName]);

    const csvLines = csvData.split('\n').filter((line) => line.replace(/,/g, '').trim() !== '');

    // Anchor Header Konteks
    const ANCHOR_LINES_COUNT = Math.min(20, csvLines.length);
    const anchorCsv = csvLines.slice(0, ANCHOR_LINES_COUNT).join('\n');
    const dataCsvLines = csvLines.slice(ANCHOR_LINES_COUNT);

    const BATCH_SIZE = 15;
    const batches = [];

    if (dataCsvLines.length === 0) {
      batches.push(anchorCsv);
    } else {
      for (let i = 0; i < dataCsvLines.length; i += BATCH_SIZE) {
        const chunk = dataCsvLines.slice(i, i + BATCH_SIZE).join('\n');
        batches.push(`${anchorCsv}\n--- LANJUTAN DATA BARIS KE-${i + 1} ---\n${chunk}`);
      }
    }

    console.log(`[AI-SERVICE] Excel dipecah menjadi ${batches.length} batch requests.`);
    let masterJson = null;

    for (let i = 0; i < batches.length; i++) {
      console.log(`[AI-SERVICE] Memproses Excel Batch ${i + 1}/${batches.length}...`);
      const geminiContents = [prompt, `Berikut adalah data mentah Excel (CSV format):\n${batches[i]}`];

      // Panggil AI dengan perlindungan Self-Healing
      const { parsedData: batchJson, usageMetadata } = await callGeminiWithRetry(geminiContents);

      totalUsage.input_total += usageMetadata.promptTokenCount || 0;
      totalUsage.output += usageMetadata.candidatesTokenCount || 0;
      totalUsage.total += usageMetadata.totalTokenCount || 0;

      if (i === 0) {
        masterJson = batchJson;
      } else {
        const masterArray = findTabularArray(masterJson);
        const batchArray = findTabularArray(batchJson);
        if (masterArray && batchArray) {
          masterArray.push(...batchArray);
        }
      }
    }
    finalParsedData = masterJson;

  }
  // ==============================================================
  // JALUR 2: PDF / IMAGE PROCESSING NORMAL
  // ==============================================================
  else {
    const geminiContents = [
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
    ];

    // Panggil AI dengan perlindungan Self-Healing
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry(geminiContents);
    finalParsedData = pdfJson;

    totalUsage.input_total = usageMetadata.promptTokenCount || 0;
    totalUsage.output = usageMetadata.candidatesTokenCount || 0;
    totalUsage.ocr = extractOcrTokens(usageMetadata);
    totalUsage.total = usageMetadata.totalTokenCount || 0;
  }

  totalUsage.input_text = Math.max(0, totalUsage.input_total - totalUsage.ocr);

  // =================================================================
  // POST-PROCESSING & INTERCEPTORS
  // =================================================================
  if (finalParsedData._reasoning) console.log(`[AI-SERVICE] AI Reasoning: ${finalParsedData._reasoning}`);
  else if (Array.isArray(finalParsedData) && finalParsedData[0]?._reasoning) console.log(`[AI-SERVICE] AI Reasoning: ${finalParsedData[0]._reasoning}`);

  if (Array.isArray(finalParsedData)) finalParsedData.forEach((item) => delete item._reasoning);
  else if (finalParsedData && typeof finalParsedData === 'object') delete finalParsedData._reasoning;

  // UNIVERSAL FORWARD-FILL (O(N))
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];
  const targetArray = findTabularArray(finalParsedData);

  if (targetArray && targetArray.length > 0) {
    const memory = {};
    targetArray.forEach((row) => {
      if (row && typeof row === 'object') {
        fillableFields.forEach((field) => {
          if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
            memory[field] = row[field];
          } else if (memory[field] !== undefined) {
            row[field] = memory[field];
          }
        });
      }
    });
  }

  // =================================================================
  // DOCUMENT-SPECIFIC BUSINESS RULES (RULE ENGINE)
  // Menjalankan request spesifik PM (seperti propagasi currency) sesuai docCode
  // =================================================================
  applyBusinessRules(docCode, finalParsedData);

  // =================================================================
  // POST-PROCESSING: SCHEMA CONTRACT ENFORCER
  // =================================================================
  const strictParsedData = enforceSchemaStrictness(finalParsedData, jsonSchema);

  return {
    data: strictParsedData,
    usage: totalUsage,
    model_used: MODELS.FLAGSHIP
  };
};