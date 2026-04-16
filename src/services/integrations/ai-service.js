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
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null) => {
  let jsonSchema;

  try {
    const schemaPath = path.join(__dirname, '../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (error) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${error.message}`);
  }

  // UNIVERSAL CHAIN OF THOUGHT (CoT) PROMPT
  const basePrompt = getExtractionPrompt(jsonSchema);
  const prompt = `${basePrompt}
  ABSOLUTE DIRECTIVE (MANUAL OVERRIDE & UNIVERSAL EXTRACTION MODE):
  ...
  Terapkan teknik "Chain of Thought". Buat key "_reasoning" di baris paling atas pada output JSON.
  ATURAN REASONING: WAJIB SANGAT SINGKAT! Maksimal 2 kalimat pendek...
  ...
  `;

  const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');
  let geminiContents = [];

  if (isExcel) {
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    let excelTextData = '';

    if (sheetName && workbook.Sheets[sheetName]) {
      console.log(`[AI-SERVICE] Ekstraksi sheet: ${sheetName}`);
      const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      excelTextData = `DATA DARI SHEET: ${sheetName}\n${csvData}`;
    } else {
      workbook.SheetNames.forEach((name) => {
        const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[name]);
        excelTextData += `\n--- SHEET: ${name} ---\n${csvData}\n`;
      });
    }
    geminiContents = [
      prompt,
      `Berikut adalah data mentah Excel (CSV format):\n${excelTextData}`
    ];

  } else {
    geminiContents = [
      prompt,
      {
        inlineData: {
          data: fileBuffer.toString('base64'),
          mimeType: mimeType
        }
      }
    ];
  }

  const response = await ai.models.generateContent({
    model: MODELS.FLAGSHIP,
    contents: geminiContents,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
      maxOutputTokens: 8192
    }
  });

  const parsedData = cleanAIJson(response.text);

  // =================================================================
  // 🚀 INTERSEPTOR: LOG & HAPUS REASONING
  // =================================================================
  if (parsedData._reasoning) {
    console.log(`\n[AI-SERVICE] AI Reasoning: ${parsedData._reasoning}`);
  } else if (Array.isArray(parsedData) && parsedData[0]?._reasoning) {
    console.log(`\n[AI-SERVICE] AI Reasoning: ${parsedData[0]._reasoning}`);
  }

  if (Array.isArray(parsedData)) {
    parsedData.forEach((item) => delete item._reasoning);
  } else if (parsedData && typeof parsedData === 'object') {
    delete parsedData._reasoning;
  }

  // =================================================================
  // 🚀 POST-PROCESSING: UNIVERSAL FORWARD-FILL (O(N))
  // Deteksi array dinamis dan isi baris kosong dengan memori baris sebelumnya
  // =================================================================
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];

  const findTabularArray = (data) => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const value of Object.values(data)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          return value;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const subValue of Object.values(value)) {
            if (Array.isArray(subValue) && subValue.length > 0 && typeof subValue[0] === 'object') {
              return subValue;
            }
          }
        }
      }
    }
    return null;
  };

  const targetArray = findTabularArray(parsedData);

  if (targetArray && targetArray.length > 0) {
    const memory = {};

    targetArray.forEach((row) => {
      if (row && typeof row === 'object') {
        fillableFields.forEach((field) => {
          if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
            memory[field] = row[field]; // Update ingatan
          } else if (memory[field] !== undefined) {
            row[field] = memory[field]; // Tarik dari ingatan (Forward-Fill / Ditto)
          }
        });
      }
    });
  }

  const usageMetadata = response.usageMetadata || {};

  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);
  const textInput = Math.max(0, totalInput - ocrTokens);

  // console.log('\n[AI-SERVICE] RAW JSON DARI GEMINI:');
  // console.log(JSON.stringify(parsedData, null, 2));

  return {
    data: parsedData,
    usage: {
      input_total: totalInput,
      input_text: textInput,
      ocr: isExcel ? 0 : ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    model_used: MODELS.FLAGSHIP
  };
};