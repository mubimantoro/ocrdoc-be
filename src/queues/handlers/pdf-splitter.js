import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { uploadToStorage } from '../../services/integrations/storage-service.js';

/**
 * Memotong halaman tertentu dari master PDF dan mengembalikan buffer-nya.
 * Menggunakan bypass jika halaman yang dipotong adalah seluruh dokumen
 * untuk menghindari "Blank Page Bug" pada PDF ber-layer.
 *
 * @param {Buffer} masterPdfBuffer - Buffer PDF asli.
 * @param {import('pdf-lib').PDFDocument} masterPdfDoc - Dokumen pdf-lib yang sudah di-load.
 * @param {number} startPage - Halaman awal potongan (1-indexed).
 * @param {number} endPage - Halaman akhir potongan (1-indexed).
 * @param {number} totalPages - Total halaman dalam PDF asli.
 * @returns {Promise<Buffer>}
 */
const slicePdf = async (masterPdfBuffer, masterPdfDoc, startPage, endPage, totalPages) => {
  const safeStart = Math.max(1, startPage);
  const safeEnd = Math.min(totalPages, endPage);

  // Bypass pdf-lib jika tidak perlu potong (dokumen utuh)
  if (safeStart === 1 && safeEnd === totalPages) {
    console.log('[PDF-SPLITTER] Bypass: Dokumen utuh, tidak perlu dipotong.');
    return masterPdfBuffer;
  }

  const newPdf = await PDFDocument.create();
  const pageIndices = Array.from({ length: safeEnd - safeStart + 1 }, (_, i) => safeStart - 1 + i);
  const copiedPages = await newPdf.copyPages(masterPdfDoc, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));
  return Buffer.from(await newPdf.save());
};

/**
 * Memotong PDF master berdasarkan range halaman dokumen dan menguploadnya ke storage.
 *
 * @param {object} doc - Objek dokumen hasil segmentasi { start_page, end_page, doc_code }.
 * @param {string} docRecordId - ID record dokumen di database.
 * @param {Buffer} masterPdfBuffer - Buffer PDF asli.
 * @param {import('pdf-lib').PDFDocument} masterPdfDoc - Dokumen pdf-lib yang sudah di-load.
 * @param {number} totalPages - Total halaman dalam PDF asli.
 * @param {string} mimeType - MIME type file.
 * @returns {Promise<string>} - Path file yang sudah diupload.
 */
export const splitAndUploadPdf = async (doc, docRecordId, masterPdfBuffer, masterPdfDoc, totalPages, mimeType) => {
  const splitBuffer = await slicePdf(masterPdfBuffer, masterPdfDoc, doc.start_page, doc.end_page, totalPages);
  const splitFileName = `split-${docRecordId}-${Date.now()}.pdf`;
  return uploadToStorage(splitFileName, splitBuffer, mimeType);
};

/**
 * Mengupload file non-PDF (gambar atau Excel) langsung ke storage tanpa modifikasi.
 *
 * @param {Buffer} fileBuffer - Buffer file.
 * @param {string} docRecordId - ID record dokumen di database.
 * @param {string} mimeType - MIME type file.
 * @returns {Promise<string>} - Path file yang sudah diupload.
 */
export const uploadNonPdfFile = async (fileBuffer, docRecordId, mimeType) => {
  let ext = '.xlsx';
  if (mimeType === 'image/jpeg') ext = '.jpg';
  else if (mimeType === 'image/png') ext = '.png';

  const splitFileName = `file-${docRecordId}-${Date.now()}${ext}`;
  return uploadToStorage(splitFileName, fileBuffer, mimeType);
};

/**
 * Memuat PDF dari path dan mengembalikan buffer dan dokumen pdf-lib.
 * @param {string} absoluteFilePath
 * @returns {Promise<{buffer: Buffer, doc: import('pdf-lib').PDFDocument, totalPages: number}>}
 */
export const loadMasterPdf = async (absoluteFilePath) => {
  const buffer = await fs.readFile(absoluteFilePath);
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  if (doc.isEncrypted) {
    throw new Error('FILE_ENCRYPTED: Dokumen PDF terenkripsi. Proses pemotongan dihentikan.');
  }
  return { buffer, doc, totalPages: doc.getPageCount() };
};
