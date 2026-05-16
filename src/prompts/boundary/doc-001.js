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
// 2. SECTION-LEVEL BOUNDARY
//    Dipanggil oleh: src/services/integrations/ai/handlers/pdf-cipl.js
//    Langsung — TIDAK melalui index.js (karena bukan boundary dokumen-level)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CIPL SECTION BOUNDARY PROMPT
 *
 * Mendeteksi rentang halaman untuk tiap seksi (Header / Invoice / Packing List)
 * dalam SATU dokumen CIPL yang sudah teridentifikasi.
 *
 * Sesuai n8n Node 2 "Analyze document" — boundary detection schema:
 * {
 *   page_contain_header, is_document_contain_summary,
 *   document_summary_page, page_contain_invoice_data,
 *   page_contain_packing_list_data
 * }
 *
 * Catatan desain:
 *   - Prompt ini dipanggil dengan FULL PDF buffer (bukan per-chunk) agar Gemini
 *     bisa melihat keseluruhan struktur dokumen sebelum menentukan boundary.
 *   - Model yang digunakan: MODELS.CHEAP (gemini-3.1-flash-lite) — cukup untuk
 *     tugas struktural ini, tidak perlu FLAGSHIP.
 */
export const getCIPLSectionBoundaryPrompt = () => {
  return `Anda adalah seorang ahli ekstraksi dokumen. Tugas Anda adalah menganalisis dokumen CIPL (Commercial Invoice & Packing List) yang dilampirkan dan mengekstrak informasi berdasarkan aturan berikut:

Identifikasi Halaman Header (page_contain_header): Cari halaman yang berisi informasi header (data pengirim, penerima, nomor dokumen, tanggal). Halaman tersebut HARUS merupakan satu kesatuan informasi header yang lengkap.

Deteksi Ringkasan Dokumen (is_document_contain_summary & document_summary_page): Periksa apakah ada halaman yang secara explisit mengatakan summary terpisah. Sub Total di akhir setiap invoice bukan termasuk summary. Jika ada, set is_document_contain_summary ke true.

Data Utama: Identifikasi halaman yang berisi tabel/daftar barang untuk page_contain_invoice_data dan page_contain_packing_list_data.

DETEKSI FORMAT DOKUMEN (KRITIS):
Dokumen CIPL hadir dalam dua format utama. Kenali dengan benar:

FORMAT A — TERPISAH (Roche, dokumen standar):
  - Halaman Invoice: tabel berisi harga, unit price, amount per baris item
  - Halaman Packing List: tabel TERPISAH berisi nomor kemasan, berat, dimensi
  - page_contain_invoice_data dan page_contain_packing_list_data memiliki range BERBEDA

FORMAT B — INTERLEAVED / SAP-ERP (Schneider Electric, dll):
  - Setiap baris item memiliki NOMOR PACKING LIST TERSENDIRI (1 item = 1 PL number)
  - Data Invoice (harga, amount) DAN data Packing List (no. kemasan, berat) berada
    pada HALAMAN YANG SAMA — tidak ada halaman PL yang terpisah
  - WAJIB: Untuk format ini, set page_contain_packing_list_data dengan range yang
    SAMA atau TUMPANG TINDIH dengan page_contain_invoice_data
  - JANGAN set page_contain_packing_list_data ke range yang sangat sempit atau null
    hanya karena tidak ada halaman PL yang berdiri sendiri

CARA MENGENALI FORMAT B:
  - Kolom terakhir di tabel invoice berisi nomor barcode panjang (18+ digit)
  - Setiap baris item memiliki nomor PL/Delivery yang unik (bukan nomor yang sama)
  - Tidak ada seksi "Packing List" yang terpisah dari seksi "Invoice"

Field 'exclude': Hanya diisi jika ada halaman di dalam rentang start-end yang tidak relevan. Jika tidak ada, gunakan array kosong [].

ATURAN EXCLUDE:
Halaman HANYA boleh di-exclude jika tidak mengandung
baris item data SAMA SEKALI.

Halaman yang mengandung baris item data TETAP dimasukkan
meskipun juga mengandung:
- Blok header invoice (Date, Bill-To, Ship-To)
- Blok summary
- Payment instructions
- Tanda tangan / stempel

Satu-satunya alasan valid untuk exclude adalah halaman
yang 100% tidak memiliki baris item (contoh: halaman
kosong, halaman hanya berisi payment instructions tanpa
item apapun).

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
};