/**
 * GENERIC BOUNDARY PROMPT (SPLITTING ONLY)
 * Digunakan untuk file multi-dokumen.
 * AI TIDAK LAGI MENGKLASIFIKASIKAN TIPE DOKUMEN. AI hanya bertugas mencari batas awal/akhir dokumen.
 */
export const getGenericBoundaryPrompt = (absoluteStartPage, totalPagesInChunk, manualDocType) => {
  return `Kamu adalah AI Penganalisis Batas Dokumen Logistik tingkat lanjut.
TUGAS: Analisis batch PDF ini HALAMAN PER HALAMAN untuk mencari batas perpindahan dokumen.
SEMUA halaman dalam file ini DIASUMSIKAN BERTIPE KODE "${manualDocType}".

Kamu menerima ${totalPagesInChunk} halaman (Dimulai dari halaman absolut ke-${absoluteStartPage}).
KAMU WAJIB MERETURN EXACTLY ${totalPagesInChunk} OBJECT JSON DALAM ARRAY "pages"!

## ATURAN SPLITTING (SANGAT KETAT):
Satu-satunya pemicu valid untuk dokumen baru (is_new_document: true) adalah PERUBAHAN NOMOR DOKUMEN UTAMA.

1. is_new_document:
   - SET TRUE jika dan hanya jika:
     a. Halaman pertama dari batch (${absoluteStartPage}).
     b. Kamu menemukan Nomor Dokumen (Invoice#, AWB#, dsb) yang BERBEDA dari halaman sebelumnya.
   - SET FALSE jika:
     a. Nomor Dokumen SAMA dengan halaman sebelumnya, meskipun di halaman ini terdapat judul/header baru atau tulisan "Page 1".
     b. Halaman ini adalah lampiran atau kelanjutan tabel dari halaman sebelumnya.
     c. Nomor Dokumen tidak ditemukan tetapi layout dan vendor masih identik dengan sebelumnya.

2. document_number: Ekstrak nomor dokumen (Invoice#, AWB#, BL#, dll) yang tertera paling dominan di header. Pastikan nomor ini konsisten untuk halaman-halaman yang merupakan kelanjutan dokumen yang sama.

3. vendor: Nama pengirim/penerbit (Shipper/Vendor).

4. doc_code: SELALU ISI "${manualDocType}".

## TIPS UNTUK AKURASI:
Banyak dokumen logistik mencantumkan header di setiap halaman. Jangan terkecoh! Jika nomor dokumennya tetap "INV123" di halaman 1 dan halaman 2, maka halaman 2 adalah is_new_document: false.

## OUTPUT JSON STRICT SCHEMA:
{
  "pages": [
    {
      "absolute_page_number": ${absoluteStartPage},
      "is_new_document": true,
      "doc_code": "${manualDocType}",
      "document_number": "DOC-12345",
      "vendor": "Vendor Name",
      "confidence": 0.99
    }
  ]
}`;
};
