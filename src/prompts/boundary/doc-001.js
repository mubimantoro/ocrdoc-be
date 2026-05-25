// ─────────────────────────────────────────────────────────────────────────────
// 1. DOCUMENT-LEVEL BOUNDARY
//    Dipanggil oleh: src/services/integrations/ai/boundary.js
//    Via: src/prompts/boundary/index.js → getBoundaryPromptForDocType('001')
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// SECTION BOUNDARY PROMPT — v2.1 (FIX RC-1)
// ─────────────────────────────────────────────────────────────────────────────
// PERUBAHAN dari v2.0:
//   Tambah instruksi eksplisit untuk mendeteksi pl_page_header_repeat —
//   apakah packing_list_number diulang di setiap halaman atau hanya di awal.
//   Info ini digunakan oleh pdf-cipl.js untuk memutuskan apakah window
//   context diperlukan atau tidak (optimasi token).
// ─────────────────────────────────────────────────────────────────────────────
export const getCIPLSectionBoundaryPrompt = () => {
  return `Anda adalah seorang ahli ekstraksi dokumen. Tugas Anda adalah menganalisis dokumen CIPL (Commercial Invoice & Packing List) yang dilampirkan dan mengekstrak informasi berdasarkan aturan berikut:
 
Identifikasi Halaman Header (page_contain_header): Cari halaman yang berisi informasi header (data pengirim, penerima, nomor dokumen, tanggal). Halaman tersebut HARUS merupakan satu kesatuan informasi header yang lengkap.
 
Deteksi Ringkasan Dokumen (is_document_contain_summary & document_summary_page): Periksa apakah ada halaman yang secara eksplisit merupakan halaman summary terpisah. Sub Total di akhir setiap invoice BUKAN termasuk summary. Jika ada halaman summary terpisah, set is_document_contain_summary ke true.
 
Data Utama: Identifikasi halaman yang berisi tabel/daftar barang untuk page_contain_invoice_data dan page_contain_packing_list_data.
 
Field 'exclude': Hanya diisi jika ada halaman di dalam rentang start-end yang tidak relevan. Jika tidak ada, gunakan array kosong [].
 
ATURAN EXCLUDE:
Halaman HANYA boleh di-exclude jika tidak mengandung baris item data SAMA SEKALI.
 
Halaman yang mengandung baris item data TETAP dimasukkan meskipun juga mengandung:
- Blok header invoice (Date, Bill-To, Ship-To)
- Blok summary / sub total
- Payment instructions
- Tanda tangan / stempel
 
Satu-satunya alasan valid untuk exclude adalah halaman yang 100% tidak memiliki baris item (contoh: halaman kosong, halaman hanya berisi payment instructions tanpa item apapun).
 
DETEKSI HEADER PL (pl_header_repeated):
Periksa apakah nomor Packing List (kolom seperti "Packing List No", "PL No", "PL Number")
diulang di setiap halaman Packing List, atau hanya muncul sekali di halaman pertama PL.
- true  = nomor PL tercetak di setiap halaman (header berulang)
- false = nomor PL hanya muncul sekali, lalu halaman berikutnya langsung baris item
Jika tidak bisa dipastikan → false (asumsikan tidak berulang, lebih aman).
 
Output HARUS berupa JSON valid sesuai JSON Schema berikut (tanpa markdown fence):
 
{
  "type": "object",
  "properties": {
    "page_contain_header": {
      "type": "object",
      "properties": {
        "start": { "type": "number" },
        "end": { "type": "number" },
        "exclude": { "type": "array", "items": { "type": "number" } }
      },
      "propertyOrdering": ["start", "end", "exclude"],
      "required": ["start", "end"]
    },
    "is_document_contain_summary": { "type": "boolean" },
    "document_summary_page": {
      "type": "object",
      "properties": {
        "start": { "type": "number" },
        "end": { "type": "number" },
        "exclude": { "type": "array", "items": { "type": "number" } }
      },
      "propertyOrdering": ["start", "end", "exclude"],
      "required": ["start", "end"]
    },
    "page_contain_invoice_data": {
      "type": "object",
      "properties": {
        "start": { "type": "number" },
        "end": { "type": "number" },
        "exclude": { "type": "array", "items": { "type": "number" } }
      },
      "propertyOrdering": ["start", "end", "exclude"],
      "required": ["start", "end"]
    },
    "page_contain_packing_list_data": {
      "type": "object",
      "properties": {
        "start": { "type": "number" },
        "end": { "type": "number" },
        "exclude": { "type": "array", "items": { "type": "number" } }
      },
      "propertyOrdering": ["start", "end", "exclude"],
      "required": ["start", "end"]
    },
    "pl_header_repeated": { "type": "boolean" }
  },
  "propertyOrdering": [
    "page_contain_header",
    "is_document_contain_summary",
    "document_summary_page",
    "page_contain_invoice_data",
    "page_contain_packing_list_data",
    "pl_header_repeated"
  ],
  "required": [
    "page_contain_header",
    "is_document_contain_summary",
    "page_contain_invoice_data",
    "page_contain_packing_list_data",
    "pl_header_repeated"
  ]
}`;
};