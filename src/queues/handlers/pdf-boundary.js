/* eslint-disable camelcase */
import { detectBoundariesChunked } from '../../services/integrations/ai/boundary.js';
import { validateDocumentType } from '../../services/integrations/ai/validation.js';

/**
 * Menentukan docType yang sebenarnya akan digunakan untuk boundary detection.
 * Jika user memilih tipe tertentu, validasi dulu. Jika mismatch, fallback ke generic.
 * @param {string} absoluteFilePath
 * @param {string} mimeType
 * @param {string|null} manualDocType
 * @returns {Promise<string|null>} - docType yang aman digunakan, atau null jika generic.
 */
const resolveDocType = async (absoluteFilePath, mimeType, manualDocType) => {
  if (!manualDocType) return null;

  console.log(`[PDF-BOUNDARY] Validasi pre-segmentasi untuk tipe: '${manualDocType}'...`);
  const validation = await validateDocumentType(absoluteFilePath, mimeType, manualDocType);

  if (!validation.isMatch) {
    console.warn(`[PDF-BOUNDARY] MISMATCH: User pilih '${manualDocType}', AI deteksi '${validation.detectedType}'. Alasan: ${validation.reason}`);
    console.warn('[PDF-BOUNDARY] Fallback ke mode generic segmentation.');
    return null;
  }

  console.log(`[PDF-BOUNDARY] Validasi sukses. Menggunakan prompt khusus untuk: '${manualDocType}'`);
  return manualDocType;
};

/**
 * Memfilter dokumen hasil segmentasi berdasarkan tipe target.
 * Jika actualDocType null (fallback), semua dokumen diterima.
 * @param {Array} allDetectedDocuments
 * @param {string|null} manualDocType - Tipe yang user minta.
 * @param {string|null} actualDocType - Tipe yang digunakan setelah validasi.
 * @returns {Array}
 */
const filterDocuments = (allDetectedDocuments, manualDocType, actualDocType) => {
  if (!manualDocType) return allDetectedDocuments;

  // Jika mismatch terjadi (actualDocType null), kembalikan semua dokumen apa adanya
  if (!actualDocType) return allDetectedDocuments;

  const kept = allDetectedDocuments.filter((doc) => doc.doc_code === actualDocType);
  const discarded = allDetectedDocuments.filter((doc) => doc.doc_code !== actualDocType);

  if (discarded.length > 0) {
    console.log(`[PDF-BOUNDARY] Membuang ${discarded.length} dokumen yang tidak sesuai tipe '${actualDocType}':`);
    discarded.forEach((d) => {
      const pageRange = d.start_page === d.end_page ? `Hal ${d.start_page}` : `Hal ${d.start_page}-${d.end_page}`;
      console.log(`  → ${pageRange} | Tipe terdeteksi: ${d.doc_code}`);
    });
  }

  return kept;
};

/**
 * Memproses boundary detection untuk file PDF.
 * Pipeline: Validate → Segment → Filter
 *
 * @param {string} absoluteFilePath - Path absolut ke file PDF.
 * @param {string} mimeType - MIME type file.
 * @param {string|null} manualDocType - Tipe dokumen yang dipilih user.
 * @returns {Promise<{documents: Array, usage: object, modelUsed: string}>}
 */
export const processPdfBoundary = async (absoluteFilePath, mimeType, manualDocType) => {
  // LAYER 1: Validasi (Resolve docType yang aman)
  const actualDocType = await resolveDocType(absoluteFilePath, mimeType, manualDocType);

  // LAYER 2: Segmentasi (Gunakan prompt sesuai docType)
  const boundaryResult = await detectBoundariesChunked(absoluteFilePath, mimeType, 15, actualDocType);
  const allDetectedDocuments = boundaryResult.documents || [];

  // LAYER 3: Filtering
  const documents = filterDocuments(allDetectedDocuments, manualDocType, actualDocType);

  // LAYER 4: CIPL Safety Net (Force Single Document)
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

  return {
    documents,
    usage: boundaryResult.usage,
    modelUsed: boundaryResult.modelUsed
  };
};
