/* eslint-disable camelcase */
import { detectBoundaries } from '../../services/integrations/ai/boundary.js';
import { BYPASS_CIPL_TO_WEBHOOK } from '../../config/gemini.js';

/**
 * Memproses boundary detection untuk file gambar (single-page).
 * Gambar selalu dianggap satu halaman, sehingga tidak perlu chunking.
 *
 * @param {Buffer} fileBuffer - Buffer file gambar.
 * @param {string} mimeType - MIME type gambar.
 * @param {string|null} manualDocType - Tipe dokumen yang dipilih user.
 * @returns {Promise<{documents: Array, usage: object, modelUsed: string}>}
 */
export const processImageBoundary = async (fileBuffer, mimeType, manualDocType) => {
  // BYPASS TOGGLE: CIPL Webhook Testing
  // Konfigurasi pusat ada di src/config/gemini.js (BYPASS_CIPL_TO_WEBHOOK)
  if (BYPASS_CIPL_TO_WEBHOOK && manualDocType === '001') {
    return {
      documents: [{
        doc_code: '001',
        start_page: 1,
        end_page: 1,
        document_number: null,
        vendor: null,
        confidence: 1.0
      }],
      usage: { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 },
      modelUsed: 'system-bypass'
    };
  }

  const boundaryResult = await detectBoundaries(fileBuffer, mimeType, 1, 1, manualDocType);
  const detectedPages = boundaryResult.pages || [];

  let documents = detectedPages.map((page) => ({
    ...page,
    start_page: 1,
    end_page: 1
  }));

  if (manualDocType) {
    const kept = documents.filter((doc) => doc.doc_code === manualDocType);
    if (kept.length === 0) {
      console.warn(`[IMAGE-BOUNDARY] Gambar tidak cocok dengan tipe yang diminta: '${manualDocType}'`);
    }
    documents = kept;
  }

  return {
    documents,
    usage: boundaryResult.usage,
    modelUsed: boundaryResult.modelUsed
  };
};
