/**
 * VALIDATION PROMPT
 * Digunakan untuk memverifikasi apakah isi file sesuai dengan tipe dokumen yang dipilih user.
 * Dipakai di dua tempat: boundary pipeline (pre-segmentation) dan extraction pipeline (guardrail).
 */

/**
 * Prompt untuk validasi pre-segmentation (di boundary pipeline).
 * Memverifikasi kecocokan secara umum sebelum melakukan splitting penuh.
 * @param {string} expectedDocType - Kode tipe dokumen yang diharapkan (misal: '001').
 * @returns {string}
 */
export const getPreSegmentationValidationPrompt = (expectedDocType) => {
  return `Kamu adalah AI Validator Dokumen Logistik.
TUGAS: Verifikasi apakah file ini sesuai dengan tipe dokumen yang diharapkan oleh user.

Tipe yang Diharapkan: "${expectedDocType}"

## INSTRUKSI EVALUASI:
1. Analisis halaman-halaman awal dokumen ini.
2. Tentukan apakah karakteristik visual dan teksnya sesuai dengan tipe "${expectedDocType}".
3. Contoh:
   - Jika expectedDocType "001" (CIPL): Harus ada Invoice (harga, currency) DAN/ATAU Packing List (weight, dimensions).
   - Jika expectedDocType "740" (AWB): Harus ada nomor AWB dan teks "Air Waybill".
   - Jika expectedDocType "380" (Invoice): Harus ada nomor Invoice dan detail harga.

## OUTPUT JSON STRICT (TANPA MARKDOWN):
{
  "is_match": boolean,
  "detected_type": "string",
  "reason": "string",
  "confidence": 0.0
}`;
};

/**
 * Prompt untuk validasi guardrail di extraction pipeline.
 * Memverifikasi secara lebih dalam setelah file sudah di-split.
 * @param {string} expectedDocCode - Kode tipe dokumen yang diharapkan.
 * @returns {string}
 */
export const getExtractionGuardrailPrompt = (expectedDocCode) => {
  return `Kamu adalah AI Validator Dokumen Logistik.
TUGAS: Konfirmasi apakah dokumen ini adalah tipe "${expectedDocCode}" sebelum ekstraksi data dilakukan.

## VERIFIKASI CEPAT:
Apakah dokumen ini secara substansi adalah dokumen tipe "${expectedDocCode}"?
- Cari elemen kunci yang mendefinisikan dokumen tersebut (Nomor Dokumen, Judul, Layout, Data Utama).
- Jawab dengan jujur bahkan jika kamu tidak yakin.

## OUTPUT JSON STRICT (TANPA MARKDOWN):
{
  "is_match": boolean,
  "detected_doc_code": "string",
  "reason": "string",
  "confidence": 0.0
}`;
};
