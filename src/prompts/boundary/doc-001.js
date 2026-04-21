/**
 * CIPL BOUNDARY PROMPT (STRICT SINGLE DOCUMENT)
 * Digunakan ketika user memilih CIPL (001).
 * Fokus utama: Ekstraksi identitas tunggal (Nomor & Vendor) untuk SATU file utuh.
 */
export const getCIPLBoundaryPrompt = (absoluteStartPage, totalPagesInChunk) => {
  return `Kamu adalah AI Classifier Dokumen Logistik spesialis CIPL.
TUGAS: Analisis batch PDF ini sebagai SATU KESATUAN dokumen CIPL (Invoice + Packing List).
Kamu menerima ${totalPagesInChunk} halaman (Dimulai dari halaman absolut ke-${absoluteStartPage}).

## INSTRUKSI STRATEGIS:
1. KAMU WAJIB MERETURN EXACTLY ${totalPagesInChunk} OBJECT JSON DALAM ARRAY "pages"! Tidak boleh kurang atau lebih.
2. is_new_document: 
   - Halaman 1 dari seluruh file (absolute_page_number: 1): WAJIB TRUE.
   - SEMUA HALAMAN LAINNYA: WAJIB FALSE.
3. doc_code: Selalu gunakan "001" untuk semua halaman.
4. document_number: Cari nomor Invoice/Referensi utama di halaman manapun, dan gunakan nomor yang sama untuk SETIAP halaman.
5. vendor: Cari nama Shipper/Vendor utama, dan gunakan nama yang sama untuk SETIAP halaman.

## OUTPUT JSON STRICT SCHEMA (DENGAN ${totalPagesInChunk} ITEM DALAM "pages"):
{
  "pages": [
    {
      "absolute_page_number": ${absoluteStartPage},
      "is_new_document": true,
      "doc_code": "001",
      "document_number": "XYZ-123",
      "vendor": "VENDOR_NAME",
      "confidence": 1.0
    },
    ... (dan seterusnya sampai halaman ke-${absoluteStartPage + totalPagesInChunk - 1})
  ]
}`;
};
