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
export const detectBoundaries = async (fileBuffer, mimeType, absoluteStartPage = 1) => {
  const prompt = getBoundaryPrompt(absoluteStartPage);

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

  const parsedText = cleanAIJson(response.text);
  const usageMetadata = response.usageMetadata || {};

  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);
  const textInput = Math.max(0, totalInput - ocrTokens);

  return {
    documents: parsedText.documents || [],
    usage: {
      input_total: totalInput,
      input_text: textInput,
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    model_used: MODELS.CHEAP,
  };
};

/**
 * ENTERPRISE ARCHITECTURE: Chunked Boundary Detection
 * Membaca PDF fisik, memecahnya per batas aman (maxPagesPerChunk),
 * mencegah V8 Engine Out of Memory (OOM) dan Bypass Limit Payload API (20MB).
 */
export const detectBoundariesChunked = async (absoluteFilePath, mimeType, maxPagesPerChunk = 30) => {
  // 1. Load dokumen utuh ke RAM (Aman karena dijalankan di Background Worker dengan Concurrency 1)
  const pdfBuffer = await fs.readFile(absoluteFilePath);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  const rawSegments = [];
  const totalUsage = { input_total: 0, input_text: 0, ocr: 0, output: 0, total: 0 };

  // 1. Fase Deteksi per Chunk
  for (let startPage = 1; startPage <= totalPages; startPage += maxPagesPerChunk) {
    const endPage = Math.min(startPage + maxPagesPerChunk - 1, totalPages);

    const newPdf = await PDFDocument.create();
    const pageIndices = Array.from({ length: (endPage - startPage) + 1 }, (_, i) => startPage - 1 + i);
    const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    const chunkBuffer = await newPdf.save();
    console.log(`[AI-SERVICE] Menganalisis chunk: hal ${startPage} - ${endPage}`);

    // 🚀 PASSING startPage KE FUNGSI DETECT BOUNDARIES!
    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType, startPage);

    const chunkDocuments = result.documents || [];
    const offsetDocuments = chunkDocuments.map((doc) => {
      let finalStart = doc.start_page;
      let finalEnd = doc.end_page;

      // Jika AI ngeyel mereturn angka relatif (misal AI return hal 2, padahal kita di Chunk hal 31)
      if (finalStart < startPage) {
        finalStart = doc.start_page + startPage - 1;
        finalEnd = doc.end_page + startPage - 1;
      }

      return {
        ...doc,
        start_page: finalStart,
        end_page: finalEnd
      };
    });

    // 🚀 LANGSUNG PUSH HASIL AI (Tanpa offset manual, karena prompt sudah meminta nilai Absolut)
    rawSegments.push(...offsetDocuments);

    totalUsage.input_total += result.usage.input_total;
    totalUsage.input_text += result.usage.input_text;
    totalUsage.ocr += result.usage.ocr;
    totalUsage.output += result.usage.output;
    totalUsage.total += result.usage.total;
  }

  return {
    documents: rawSegments, // Kirim mentah ke Queue untuk di-resolve
    usage: totalUsage,
    model_used: MODELS.FLAGSHIP,
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
  // 1. Cetak di log server
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