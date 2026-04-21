/* eslint-disable camelcase */
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getBoundaryPromptForDocType } from '../../../prompts/boundary/index.js';
import { ai, MODELS } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';
import { buildDocumentsFromPages } from '../../../utils/boundary-resolver.js';
import { extractOcrTokens } from './helpers.js';

/**
 * Membuat chunk buffer dari PDF. Bypass pdf-lib jika dokumen sudah utuh
 * untuk mencegah "Blank Page Bug" pada PDF ber-layer atau ber-enkripsi.
 * @param {Buffer} pdfBuffer - Buffer PDF asli.
 * @param {import('pdf-lib').PDFDocument} pdfDoc - Dokumen pdf-lib yang sudah di-load.
 * @param {number} startPage - Halaman awal (1-indexed).
 * @param {number} endPage - Halaman akhir (1-indexed).
 * @returns {Promise<Buffer>}
 */
const buildChunkBuffer = async (pdfBuffer, pdfDoc, startPage, endPage) => {
  const totalPages = pdfDoc.getPageCount();
  if (startPage === 1 && endPage === totalPages) {
    return pdfBuffer;
  }
  const pagesInChunk = endPage - startPage + 1;
  const newPdf = await PDFDocument.create();
  const pageIndices = Array.from({ length: pagesInChunk }, (_, i) => startPage - 1 + i);
  const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));
  return Buffer.from(await newPdf.save());
};

/**
 * Mengakumulasi token usage dari satu result ke objek kumulatif.
 * @param {object} accumulator - Objek token usage kumulatif.
 * @param {object} result - Hasil dari satu pemanggilan detectBoundaries.
 */
const accumulateTokenUsage = (accumulator, result) => {
  accumulator.inputTotal += result.usage.inputTotal;
  accumulator.inputText += result.usage.inputText;
  accumulator.ocr += result.usage.ocr;
  accumulator.output += result.usage.output;
  accumulator.total += result.usage.total;
};

/**
 * Panggilan API level-rendah ke Gemini untuk mendeteksi batas dokumen pada satu chunk.
 * @param {Buffer} fileBuffer - Buffer file (chunk PDF atau gambar).
 * @param {string} mimeType - MIME type file.
 * @param {number} absoluteStartPage - Halaman absolut pertama dalam chunk.
 * @param {number} totalPagesInChunk - Total halaman dalam chunk.
 * @param {string|null} docType - Tipe dokumen target (menentukan prompt yang dipakai).
 * @returns {Promise<{pages: Array, usage: object, modelUsed: string}>}
 */
export const detectBoundaries = async (fileBuffer, mimeType, absoluteStartPage, totalPagesInChunk, docType = null) => {
  const prompt = getBoundaryPromptForDocType(docType, absoluteStartPage, totalPagesInChunk);

  const response = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType } }
    ],
    config: { responseMimeType: 'application/json', temperature: 0.1 }
  });

  const parsedResult = cleanAIJson(response.text);
  const usageMetadata = response.usageMetadata || {};
  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);

  return {
    pages: parsedResult.pages || [],
    usage: {
      inputTotal: totalInput,
      inputText: Math.max(0, totalInput - ocrTokens),
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    modelUsed: MODELS.CHEAP
  };
};

/**
 * Orkestrasi chunked boundary detection untuk file PDF besar.
 * Membagi PDF menjadi chunk, memanggil detectBoundaries per chunk, lalu merakitnya.
 * @param {string} absoluteFilePath - Path absolut ke file PDF.
 * @param {string} mimeType - MIME type file.
 * @param {number} maxPagesPerChunk - Maksimum halaman per chunk AI call.
 * @param {string|null} docType - Tipe dokumen target.
 * @returns {Promise<{documents: Array, usage: object, modelUsed: string, pageCount: number}>}
 */
export const detectBoundariesChunked = async (absoluteFilePath, mimeType, maxPagesPerChunk = 15, docType = null) => {
  const pdfBuffer = await fs.readFile(absoluteFilePath);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  if (pdfDoc.isEncrypted) {
    throw new Error('FILE_ENCRYPTED: Dokumen PDF terenkripsi. Proses dibatalkan untuk mencegah hilangnya data/gambar saat pemotongan.');
  }

  const totalPages = pdfDoc.getPageCount();
  const allPagesRaw = [];
  const tokenUsage = { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 };

  for (let startPage = 1; startPage <= totalPages; startPage += maxPagesPerChunk) {
    const endPage = Math.min(startPage + maxPagesPerChunk - 1, totalPages);
    const pagesInThisChunk = endPage - startPage + 1;

    console.log(`[BOUNDARY] Tagging chunk: Hal ${startPage} - ${endPage} dari ${totalPages}`);

    const chunkBuffer = await buildChunkBuffer(pdfBuffer, pdfDoc, startPage, endPage);
    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType, startPage, pagesInThisChunk, docType);
    const taggedPages = result.pages || [];

    for (let p = startPage; p <= endPage; p++) {
      const foundPage = taggedPages.find((t) => t.absolute_page_number === p);
      if (foundPage) {
        allPagesRaw.push(foundPage);
      } else {
        console.warn(`[BOUNDARY] Missing page data for page ${p}, using fallback.`);
        allPagesRaw.push({ absolute_page_number: p, is_new_document: false, doc_code: '999', document_number: null, vendor: null, confidence: 0 });
      }
    }

    accumulateTokenUsage(tokenUsage, result);
  }

  return {
    documents: buildDocumentsFromPages(allPagesRaw),
    usage: tokenUsage,
    modelUsed: MODELS.CHEAP,
    pageCount: totalPages
  };
};
