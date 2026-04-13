/* eslint-disable camelcase */

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { getBoundaryPrompt } from '../../prompts/boundary.js';
import { ai, MODELS } from '../../config/gemini.js';
import { getExtractionPrompt } from '../../prompts/extraction.js';
import { PDFDocument } from 'pdf-lib';


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
export const detectBoundaries = async (fileBuffer, mimeType) => {
  const prompt = getBoundaryPrompt();

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

  const parsedText = JSON.parse(response.text);
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

    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType);

    // Normalisasi offset halaman berdasarkan posisi chunk
    const offsetDocuments = (result.documents || []).map((doc) => ({
      ...doc,
      start_page: doc.start_page + startPage - 1,
      end_page: doc.end_page + startPage - 1
    }));

    rawSegments.push(...offsetDocuments);

    totalUsage.input_total += result.usage.input_total;
    totalUsage.input_text += result.usage.input_text;
    totalUsage.ocr += result.usage.ocr;
    totalUsage.output += result.usage.output;
    totalUsage.total += result.usage.total;
  }

  // 2. LOGIKA GROUPING: Konsolidasi Dokumen Berdasarkan Identitas
  // Menangani kasus dokumen (misal Invoice) yang terpotong di antara dua chunk
  const groupedDocuments = rawSegments.reduce((acc, current) => {
    const existing = acc.find((item) =>
      item.document_number &&
      item.document_number.trim() !== '' &&
      item.document_number === current.document_number &&
      item.doc_code === current.doc_code
    );

    if (existing) {
      // Jika nomor dokumen sama, lebarkan rentang halamannya
      existing.start_page = Math.min(existing.start_page, current.start_page);
      existing.end_page = Math.max(existing.end_page, current.end_page);
    } else {
      acc.push(current);
    }
    return acc;
  }, []);

  console.log(`[AI-SERVICE] Grouping selesai. Hasil: ${groupedDocuments.length} dokumen logis.`);

  return {
    documents: groupedDocuments,
    usage: totalUsage,
    model_used: MODELS.CHEAP,
    page_count: totalPages
  };
};

/**
 * Ekstraksi Data Spesifik (Fase 2)
 * Tidak memerlukan chunking karena inputnya adalah PDF yang sudah displit (1-5 halaman).
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode) => {
  let jsonSchema;

  try {
    const schemaPath = path.join(__dirname, '../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (error) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${error.message}`);
  }

  const prompt = getExtractionPrompt(jsonSchema);

  const response = await ai.models.generateContent({
    model: MODELS.FLAGSHIP,
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

  const parsedData = JSON.parse(response.text);
  const usageMetadata = response.usageMetadata || {};

  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);
  const textInput = Math.max(0, totalInput - ocrTokens);

  return {
    data: parsedData,
    usage: {
      input_total: totalInput,
      input_text: textInput,
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    model_used: MODELS.FLAGSHIP
  };
};