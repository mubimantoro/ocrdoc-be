/* eslint-disable camelcase */
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getBoundaryPrompt } from '../../../prompts/boundary.js';
import { getCIPLBoundaryPrompt } from '../../../prompts/boundary-cipl.js';
import { ai, MODELS } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';
import { buildDocumentsFromPages } from '../../../utils/boundary-resolver.js';
import { extractOcrTokens } from './helpers.js';

/**
 * API Call Level Rendah ke Gemini untuk Deteksi Batas Dokumen
 */
export const detectBoundaries = async (fileBuffer, mimeType, absoluteStartPage, totalPagesInChunk, manualDocType = null) => {
  let prompt;
  if (manualDocType === '001') {
    prompt = getCIPLBoundaryPrompt(absoluteStartPage, totalPagesInChunk);
  } else {
    prompt = getBoundaryPrompt(absoluteStartPage, totalPagesInChunk);
  }

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
      inputTotal: usageMetadata.promptTokenCount,
      inputText: textInput,
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    modelUsed: MODELS.CHEAP,
  };
};

/**
 * ENTERPRISE ARCHITECTURE: Sequential Chunked Boundary Detection
 */
export const detectBoundariesChunked = async (absoluteFilePath, mimeType, maxPagesPerChunk = 15, manualDocType = null) => {
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
    const pagesInThisChunk = (endPage - startPage) + 1;

    let chunkBuffer;

    // BYPASS pdf-lib jika dokumen utuh (<= maxPagesPerChunk) untuk mencegah bug "Blank Page" pada PDF ber-layer/enkripsi
    if (startPage === 1 && endPage === totalPages) {
      console.log(`[AI-SERVICE] Bypass pdf-lib chunking untuk dokumen utuh (Hal 1 - ${totalPages})`);
      chunkBuffer = pdfBuffer;
    } else {
      const newPdf = await PDFDocument.create();
      const pageIndices = Array.from({ length: pagesInThisChunk }, (_, i) => startPage - 1 + i);
      const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => newPdf.addPage(page));
      chunkBuffer = await newPdf.save();
    }

    console.log(`[AI-SERVICE] Tagging Chunk: hal ${startPage} - ${endPage}`);

    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType, startPage, pagesInThisChunk, manualDocType);
    const taggedPages = result.pages || [];

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

    tokenUsage.inputTotal += result.usage.inputTotal;
    tokenUsage.inputText += result.usage.inputText;
    tokenUsage.ocr += result.usage.ocr;
    tokenUsage.output += result.usage.output;
    tokenUsage.total += result.usage.total;
  }

  const finalDocuments = buildDocumentsFromPages(allPagesRaw);

  return {
    documents: finalDocuments,
    usage: tokenUsage,
    modelUsed: MODELS.CHEAP,
    pageCount: totalPages
  };
};
