/* eslint-disable camelcase */
import * as xlsx from 'xlsx';


/**
 * Memproses boundary detection untuk file Excel (STRICT MANUAL MODE).
 * Setiap sheet diperlakukan sebagai satu dokumen terpisah dengan doc_code yang di-passing dari form-data.
 *
 * @param {Buffer} fileBuffer - Buffer file Excel.
 * @param {string} fileName - Nama file asli (untuk document_number fallback).
 * @param {string} manualDocType - Tipe dokumen WAJIB dari pilihan user.
 * @returns {{documents: Array, usage: object, modelUsed: null}}
 */
export const processExcelBoundary = (fileBuffer, fileName, manualDocType) => {
  if (!manualDocType) {
    throw new Error('doc_type WAJIB diisi untuk pemrosesan file Excel.');
  }

  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });

  // Karena sifatnya mutlak, semua sheet di dalam file Excel ini
  // akan otomatis di-assign ke tipe dokumen yang dipilih user.
  const documents = workbook.SheetNames.map((sheetName) => ({
    doc_code: manualDocType,
    sheetName,
    start_page: 1,
    end_page: 1,
    document_number: `${fileName}_${sheetName}`,
    vendor: 'EXCEL_SHEET'
  }));

  // Excel tidak menggunakan AI di Fase Boundary, sehingga usage 0
  return {
    documents,
    usage: { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 },
    modelUsed: null
  };
};