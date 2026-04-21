import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getValidationPrompt } from '../../../prompts/validation.js';
import { ai, MODELS } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';

/**
 * Memvalidasi apakah file sesuai dengan tipe dokumen yang dipilih user
 */
export const validateDocumentType = async (absoluteFilePath, mimeType, expectedDocType) => {
  if (!expectedDocType) return { isMatch: true, detectedType: null };

  const pdfBuffer = await fs.readFile(absoluteFilePath);
  let sampleBuffer = pdfBuffer;

  // Jika PDF, ambil hanya 3 halaman pertama untuk penghematan token
  if (mimeType === 'application/pdf') {
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const totalPages = pdfDoc.getPageCount();
      const sampleCount = Math.min(3, totalPages);

      const newPdf = await PDFDocument.create();
      const pageIndices = Array.from({ length: sampleCount }, (_, i) => i);
      const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => newPdf.addPage(page));
      sampleBuffer = Buffer.from(await newPdf.save());
    } catch (err) {
      console.warn('[AI-VALIDATION] Gagal melakukan sampling PDF, menggunakan file utuh.');
      console.warn(err);
    }
  }

  const prompt = getValidationPrompt(expectedDocType, 1); // pageCount placeholder

  const response = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      prompt,
      {
        inlineData: {
          data: sampleBuffer.toString('base64'),
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

  return {
    isMatch: parsedResult.is_match,
    detectedType: parsedResult.detected_type,
    reason: parsedResult.reason,
    confidence: parsedResult.confidence
  };
};
