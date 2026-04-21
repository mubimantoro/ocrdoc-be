/* eslint-disable camelcase */
import * as xlsx from 'xlsx';

// Peta nama sheet ke kode dokumen berdasarkan nama sheet (case-insensitive)
const SHEET_NAME_TO_DOC_CODE = [
  { pattern: 'CIPL', code: '001' },
  { pattern: 'INV',  code: '380' },
  { pattern: 'PL',   code: '217' },
];

/**
 * Mendeteksi kode dokumen dari nama sheet Excel.
 * @param {string} sheetName
 * @returns {string|null}
 */
const detectDocCodeFromSheetName = (sheetName) => {
  const upperName = sheetName.toUpperCase();
  for (const { pattern, code } of SHEET_NAME_TO_DOC_CODE) {
    if (upperName.includes(pattern)) return code;
  }
  return null;
};

/**
 * Memproses boundary detection untuk file Excel.
 * Setiap sheet diperlakukan sebagai satu dokumen terpisah.
 *
 * @param {Buffer} fileBuffer - Buffer file Excel.
 * @param {string} fileName - Nama file asli (untuk document_number fallback).
 * @param {string|null} manualDocType - Tipe dokumen yang dipilih user.
 * @returns {{documents: Array, usage: object, modelUsed: null}}
 */
export const processExcelBoundary = (fileBuffer, fileName, manualDocType) => {
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });

  const documents = workbook.SheetNames
    .map((sheetName) => {
      const detectedCode = detectDocCodeFromSheetName(sheetName);

      // Jika user pilih tipe tertentu dan sheet tidak cocok, buang
      if (manualDocType && detectedCode !== manualDocType) return null;

      const finalDocCode = manualDocType || detectedCode;
      if (!finalDocCode) return null;

      return {
        doc_code: finalDocCode,
        sheetName,
        start_page: 1,
        end_page: 1,
        document_number: `${fileName}_${sheetName}`,
        vendor: 'EXCEL_SHEET'
      };
    })
    .filter(Boolean);

  // Excel tidak menggunakan AI, sehingga tidak ada token usage
  return {
    documents,
    usage: { inputTotal: 0, inputText: 0, ocr: 0, output: 0, total: 0 },
    modelUsed: null
  };
};
