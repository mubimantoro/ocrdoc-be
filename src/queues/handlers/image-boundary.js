/* eslint-disable camelcase */
import { detectBoundaries } from '../../services/integrations/ai/boundary.js';

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
