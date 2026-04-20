export const instructions = `
## INSTRUKSI EKSTRAKSI KHUSUS: SKEM / SERTIFIKAT HEMAT ENERGI (KODE: 846)

Sertifikat Hemat Energi (SKEM) adalah dokumen resmi yang diterbitkan oleh Lembaga Sertifikasi Produk (seperti PT. Qualis Indonesia) yang menyatakan bahwa suatu produk telah memenuhi Nilai Standar Kinerja Energi Minimum (SKEM).

Gunakan panduan pemetaan (heuristik) berikut untuk secara akurat menemukan dan mengekstrak field yang diminta:

1. Nomor Dokumen (doc_number):
   - Instruksi: Cari baris yang diawali dengan kata kunci "Nomor".
   - Pola Ekstraksi: Ambil seluruh teks yang berada setelah tanda titik dua (:) pada baris tersebut.
   - Format Data: Teks biasanya berupa kombinasi alfanumerik yang dipisahkan oleh garis miring (/) atau tanda strip (-). Contoh: "038/LSP/QI/06.1-X/2022".
   - Validasi Tambahan (Opsional): Nomor yang sama juga dapat ditemukan pada halaman lampiran setelah kata kunci "SERTIFIKAT No:".

2. Tanggal Diterbitkan (doc_date):
   - Instruksi: Cari baris yang diawali dengan kata kunci "Tanggal diterbitkan".
   - Pola Ekstraksi: Ambil seluruh teks yang berada setelah tanda titik dua (:) pada baris tersebut.
   - Format Data: Teks berupa format tanggal, bulan (dalam teks), dan tahun. Contoh: "31 Oktober 2022".

ATURAN KEBERSIHAN DATA:
- Pastikan teks yang diekstrak TIDAK mengandung tanda titik dua (:) atau spasi berlebih di awal/akhir kata.
`;
