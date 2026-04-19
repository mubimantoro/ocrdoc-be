import { instructions as ciplInstructions } from './documents/001.js';
import { instructions as plInstructions } from './documents/217.js';

// Registry untuk instruksi spesifik dokumen
const DOCUMENT_SPECIFIC_INSTRUCTIONS = {
  '001': ciplInstructions,
  '217': plInstructions,
  // Tambahkan kode dokumen lain di sini jika sudah ada promptnya
};

export const getExtractionPrompt = (docCode, schemaDefinition) => {
  const specificInstructions = DOCUMENT_SPECIFIC_INSTRUCTIONS[docCode] || '';

  const base = `Kamu adalah 'Data Extraction AI' tingkat lanjut yang ahli memproses dokumen operasional logistik, bea cukai, dan rantai pasok internasional.
Tugasmu adalah menganalisis dokumen PDF terlampir dan mengekstrak HANYA data yang eksplisit tertulis menjadi JSON aktual.

PENTING: JSON di bawah ini BUKAN format output akhir, melainkan BLUEPRINT (Kerangka Meta-Schema) yang mengatur data apa saja yang harus diekstrak.

BLUEPRINT SCHEMA:
${JSON.stringify(schemaDefinition)}

ATURAN INTERPRETASI BLUEPRINT (CARA MERAKIT OUTPUT JSON):
1. ATURAN "fields" (HEADER): Ubah array "fields" menjadi root-level keys dengan nilai tunggal.
2. ATURAN LIST/ARRAY ("items", "packs", dll): Buat ARRAY OF OBJECTS. Setiap baris fisik di dokumen menjadi satu objek.
3. ATURAN NESTED LIST (misal "invoice_list"): Buat ARRAY OF OBJECTS utama. Di dalamnya, ekstrak data parent berdasarkan "fields", dan buat array detailnya berdasarkan "items".

${specificInstructions}

ATURAN OUTPUT KETAT (PENGHEMATAN TOKEN):
1. PRETTY-PRINTED JSON: Gunakan indentasi dan baris baru (\n) agar struktur JSON tetap terjaga dan tidak terputus di tengah jalan.
2. CLEAN JSON: HANYA output 1 JSON object valid. DILARANG menggunakan blok markdown (\`\`\`json) atau menambahkan teks komentar apapun.
3. TOKEN DIET (KHUSUS ARRAY): Khusus di dalam array of objects ("items", "pl_list", dll), JANGAN menyertakan property/key yang bernilai null. Hilangkan saja key tersebut dari object untuk menghemat output token.
4. ANTI-REPETISI: JANGAN menyalin/mengulang data statis parent (seperti vendor_name, origin_country) ke setiap baris item jika datanya sama. Cukup taruh di header.

ATURAN KONTEN & ANTI-DRIFT (KUALITAS DATA):
1. STRICT KEYS: JANGAN PERNAH membuat key baru yang tidak ada di dalam blueprint.
2. NO INFERENCE (JANGAN MENEBAK): Ekstrak HANYA data eksplisit. Jangan menebak dari konteks yang tidak tertulis. Jika ragu atau tidak ada: null.
3. FORMAT TANGGAL: Jika tanggal eksplisit tertulis, format HANYA menjadi "YYYY-MM-DD". Selain itu: null.
4. ANGKA & TIPE DATA: Gunakan format String untuk teks, nomor dokumen, seri, atau identifier (agar angka 0 di depan tidak terhapus). Gunakan Number untuk nominal uang, berat, kuantitas (tanpa pemisah ribuan, desimal pakai titik).
5. NO DRIFT PADA ITEM: Nomor urut item/line WAJIB string dan harus persis seperti yang tercetak (misal: "1.1...1"). DILARANG membuat urutan 1..N otomatis atau mengurutkan ulang posisi baris.
6. ALAMAT & NAMA: Jangan menggabungkan angka awal alamat (contoh "2121") ke nama perusahaan/orang. Pisahkan dengan akurat sesuai letaknya.
7. PHONE & CURRENCY: Nomor telepon dipertahankan tanda plus (+)-nya jika ada. Jika ada currency_code di header, anggap semua item menggunakan mata uang tersebut kecuali tertulis lain.`;

  return `${base}

ABSOLUTE DIRECTIVE (MANUAL OVERRIDE & UNIVERSAL EXTRACTION MODE):
1. Terapkan teknik "Chain of Thought". Buat key "_reasoning" di baris paling atas pada output JSON.
2. ATURAN REASONING: WAJIB SANGAT SINGKAT! Maksimal 2 kalimat pendek.
3. CRITICAL WARNING: Pastikan output JSON tertutup sempurna ( } atau ] ) di bagian akhir.
4. TOKEN ECONOMY (SANGAT PENTING): Untuk mencegah JSON terpotong (truncation), JANGAN PERNAH menulis key yang nilainya null, kosong (""), atau array kosong ([]) di dalam objek array (seperti "items"). Jika data tidak ada di dokumen fisik, WAJIB hapus/abaikan key tersebut dari objek.
5. DENSE TABLE RULE: Jika dokumen memiliki tabel yang sangat panjang (padat), ringkaslah "description" produk hanya pada informasi intinya saja (abaikan spesifikasi teknis yang sangat detail) untuk memastikan semua baris item dapat terambil tanpa terpotong.
`;
};

/**
 * Mendapatkan prompt untuk validasi tipe dokumen (Guardrail)
 */
export const getValidationPrompt = (expectedDocCode) => {
  return `Kamu adalah AI Validator Dokumen Logistik.
TUGAS: Verifikasi apakah dokumen terlampir benar-benar sesuai dengan kategori: [${expectedDocCode}].

DAFTAR REFERENSI KODE:
- 380: Invoice | 217: Packing List | 001: CIPL
- 705: Bill of Lading (B/L) | 740: Air Way Bill (AWB) / House AWB
- 741: Master (AWB) | 704: Master (B/L)
- 860: ECOO | 861: COO | 958: Laporan Surveyor | 457: SKB PPh
- 000: Cukai | 999: Lainnya

OUTPUT HARUS JSON:
{
  "is_match": boolean, 
  "detected_doc_code": "string",
  "confidence": number,
  "reason": "Penjelasan singkat dalam Bahasa Indonesia"
}

ATURAN:
1. Jika dokumen mengandung data finansial dan fisik secara lengkap, kategorikan sebagai 001.
2. Jika hanya data barang tanpa harga, kategorikan sebagai 217.
3. Jika hanya data harga tanpa rincian packing, kategorikan sebagai 380.
4. Jangan tertipu oleh judul dokumen; lihat isinya.`;
};

/**
 * Mendapatkan prompt untuk ekstraksi sekuensial (halaman lanjutan)
 */
export const getSequentialExtractionPrompt = (basePrompt, contextSummary) => {
  return `${basePrompt}
${contextSummary}
CRITICAL: Ini adalah HALAMAN LANJUTAN. Gunakan konteks di atas agar tidak menduplikasi data. FOKUS menjahit detail part number ke item yang relevan atau menambah baris baru jika berbeda.`;
};