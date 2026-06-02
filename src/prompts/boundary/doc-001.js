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
// SECTION BOUNDARY PROMPT — v2.2
// ─────────────────────────────────────────────────────────────────────────────
// PERUBAHAN dari v2.1:
//   FIX KRITIS: document_summary_page dikembalikan ke format { pages: [] }
//   agar sesuai kontrak n8n (invoice list only & packing list only1 membaca sp.pages).
//   Format start/end/exclude di v2.1 menyebabkan halaman summary tidak pernah
//   di-exclude dari range invoice/PL.
//
// PERUBAHAN dari kode current (post-v2.1 revert):
//   REMOVE: pl_header_repeated dihapus — tidak pernah dibaca di pdf-cipl.js
//   (dead field, hanya membuang output tokens tanpa manfaat apapun).
//   FIX: Instruksi document_summary_page kini eksplisit menjelaskan format pages:[].
//   FIX: Formatting template literal dibersihkan (trailing spaces dihapus).
// ─────────────────────────────────────────────────────────────────────────────

export const getCIPLSectionBoundaryPrompt = () =>
  `Anda adalah seorang ahli ekstraksi dokumen. Tugas Anda adalah menganalisis dokumen CIPL (Commercial Invoice & Packing List) yang dilampirkan dan mengekstrak informasi berdasarkan aturan berikut:

## IDENTIFIKASI HALAMAN HEADER (page_contain_header)
Cari halaman yang berisi informasi header (data pengirim, penerima, nomor dokumen, tanggal).
Halaman tersebut HARUS merupakan satu kesatuan informasi header yang lengkap.

## DETEKSI RINGKASAN (is_document_contain_summary & document_summary_page)
Periksa apakah ada halaman yang secara eksplisit merupakan halaman summary TERPISAH.
- Sub Total di akhir setiap invoice BUKAN termasuk summary.
- Jika ada halaman summary terpisah, set is_document_contain_summary ke true.
- Jika true, isi document_summary_page.pages dengan array nomor halaman summary.
  Contoh: halaman 5 adalah summary → "pages": [5]
  Contoh: halaman 5 dan 6 adalah summary → "pages": [5, 6]
- Jika tidak ada summary, set is_document_contain_summary ke false dan pages ke [].

## DATA UTAMA
Identifikasi halaman yang berisi tabel/daftar barang untuk:
- page_contain_invoice_data
- page_contain_packing_list_data

## ATURAN FIELD 'exclude'
Hanya diisi jika ada halaman di dalam rentang start-end yang tidak relevan.
Jika tidak ada, gunakan array kosong [].

Halaman HANYA boleh di-exclude jika tidak mengandung baris item data SAMA SEKALI.

Halaman yang mengandung baris item data TETAP dimasukkan meskipun juga mengandung:
- Blok header invoice (Date, Bill-To, Ship-To)
- Blok summary / sub total
- Payment instructions
- Tanda tangan / stempel

Satu-satunya alasan valid untuk exclude adalah halaman yang 100% tidak memiliki
baris item (contoh: halaman kosong, halaman hanya berisi payment instructions
tanpa item apapun).

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
        "pages": { "type": "array", "items": { "type": "number" } }
      },
      "required": ["pages"]
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
    }
  },
  "propertyOrdering": [
    "page_contain_header",
    "is_document_contain_summary",
    "document_summary_page",
    "page_contain_invoice_data",
    "page_contain_packing_list_data"
  ],
  "required": [
    "page_contain_header",
    "is_document_contain_summary",
    "page_contain_invoice_data",
    "page_contain_packing_list_data"
  ]
}`;