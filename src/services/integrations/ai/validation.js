import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getPreSegmentationValidationPrompt } from '../../../prompts/validation/index.js';
import { ai, MODELS } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';

/**
 * Memvalidasi apakah isi file sesuai dengan tipe dokumen yang dipilih user.
 * Digunakan di boundary pipeline SEBELUM segmentasi penuh dilakukan.
 * Hanya membaca 3 halaman pertama untuk efisiensi token.
 *
 * @param {string} absoluteFilePath - Path absolut ke file.
 * @param {string} mimeType - MIME type file.
 * @param {string} expectedDocType - Kode tipe dokumen yang diharapkan.
 * @returns {Promise<{isMatch: boolean, detectedType: string, reason: string, confidence: number}>}
 */
export const validateDocumentType = async (absoluteFilePath, mimeType, expectedDocType) => {
  if (!expectedDocType) return { isMatch: true, detectedType: null, reason: 'No expected type provided.', confidence: 1 };

  const fileBuffer = await fs.readFile(absoluteFilePath);
  let sampleBuffer = fileBuffer;

  if (mimeType === 'application/pdf') {
    try {
      const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      const sampleCount = Math.min(3, pdfDoc.getPageCount());
      const newPdf = await PDFDocument.create();
      const pageIndices = Array.from({ length: sampleCount }, (_, i) => i);
      const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => newPdf.addPage(page));
      sampleBuffer = Buffer.from(await newPdf.save());
    } catch {
      console.warn('[VALIDATION] Gagal sampling PDF, menggunakan file utuh.');
    }
  }

  const prompt = getPreSegmentationValidationPrompt(expectedDocType);

  const response = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      prompt,
      { inlineData: { data: sampleBuffer.toString('base64'), mimeType } }
    ],
    config: { responseMimeType: 'application/json', temperature: 0.1 }
  });

  const result = cleanAIJson(response.text);

  return {
    isMatch: result.is_match ?? true,
    detectedType: result.detected_type ?? null,
    reason: result.reason ?? '',
    confidence: result.confidence ?? 0
  };
};
