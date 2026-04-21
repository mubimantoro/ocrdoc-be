/* eslint-disable camelcase */
import { detectBoundariesChunked } from '../../services/integrations/ai/boundary.js';

/**
 * Memproses boundary detection untuk file PDF.
 * Pipeline Baru: Segmentasi berdasarkan docType yang di-request, tanpa validasi/filter.
 *
 * @param {string} absoluteFilePath - Path absolut ke file PDF.
 * @param {string} mimeType - MIME type file.
 * @param {string} manualDocType - Tipe dokumen yang diwajibkan oleh user.
 * @returns {Promise<{documents: Array, usage: object, modelUsed: string}>}
 */
export const processPdfBoundary = async (absoluteFilePath, mimeType, manualDocType) => {
  if (!manualDocType) {
    throw new Error('manualDocType is required in the new architecture.');
  }

  console.log(`[PDF-BOUNDARY] Memulai segmentasi dengan rute paksa tipe: '${manualDocType}'`);

  // LAYER 1: Segmentasi (Gunakan prompt sesuai docType)
  const boundaryResult = await detectBoundariesChunked(absoluteFilePath, mimeType, 15, manualDocType);
  let documents = boundaryResult.documents || [];

  // LAYER 2: Enforce Data (Memastikan semua dokumen memiliki doc_code yang diminta user)
  documents = documents.map((doc) => ({
    ...doc,
    doc_code: manualDocType // Paksa override apapun jawaban AI
  }));

  // LAYER 3: CIPL Safety Net (Force Single Document)
  if (manualDocType === '001' && documents.length > 0) {
    console.log('[PDF-BOUNDARY] CIPL Mode: Enforcing single document for the entire file.');
    return {
      documents: [{
        doc_code: '001',
        start_page: 1,
        end_page: boundaryResult.pageCount,
        document_number: documents[0].document_number,
        vendor: documents[0].vendor,
        confidence: 1.0
      }],
      usage: boundaryResult.usage,
      modelUsed: boundaryResult.modelUsed
    };
  }

  console.log(`[PDF-BOUNDARY] Segmentasi selesai. Menghasilkan ${documents.length} dokumen tipe '${manualDocType}'.`);

  return {
    documents,
    usage: boundaryResult.usage,
    modelUsed: boundaryResult.modelUsed
  };
};
