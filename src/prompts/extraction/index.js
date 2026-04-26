import { instructions as ciplInstructions } from './rules/001.js';
import { instructions as plInstructions } from './rules/217.js';
import { instructions as invInstructions } from './rules/380.js';
import { instructions as lsInstructions } from './rules/958.js';
import { instructions as skemInstructions } from './rules/846.js';
import { instructions as awbInstructions } from './rules/740.js';

// Registry untuk instruksi spesifik dokumen
const DOCUMENT_SPECIFIC_INSTRUCTIONS = {
  '001': ciplInstructions,
  '217': plInstructions,
  '380': invInstructions,
  '958': lsInstructions,
  '846': skemInstructions,
  '740': awbInstructions,
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
1. PRETTY-PRINTED JSON: Gunakan indentasi dan baris baru (\\n) agar struktur JSON tetap terjaga dan tidak terputus di tengah jalan.
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
4. TOKEN ECONOMY (SANGAT PENTING): Untuk mencegah JSON terpotong (truncation), JANGAN PERNAH menulis key yang nilainya null, kosong (""), atau array kosong ([]) di dalam objek array. Jika data tidak ada di dokumen fisik, WAJIB hapus/abaikan key tersebut.
5. DENSE TABLE RULE: Jika dokumen memiliki tabel yang sangat panjang (padat), ringkaslah "description" produk hanya pada informasi intinya saja (abaikan spesifikasi teknis yang sangat detail) untuk memastikan semua baris item dapat terambil tanpa terpotong.
`;
};

/**
 * Mendapatkan prompt untuk ekstraksi sekuensial (halaman lanjutan)
 */
export const getSequentialExtractionPrompt = (basePrompt, contextSummary) => {
  return `${basePrompt}
${contextSummary}
CRITICAL: Ini adalah HALAMAN LANJUTAN. Gunakan konteks di atas agar tidak menduplikasi data. FOKUS menjahit detail part number ke item yang relevan atau menambah baris baru jika berbeda.`;
};

/**
 * Prompt khusus untuk ekstraksi item-only (Parallel Mode).
 */
export const getItemOnlyExtractionPrompt = (schemaDefinition) => {
  const itemKey = schemaDefinition.invoice_list ? 'invoice_list[].items' : 'items';

  return `Kamu adalah AI Extractor Tabel. TUGASMU SANGAT SEMPIT:
Ekstrak HANYA baris-baris data dari tabel/list yang ada di halaman ini.

TARGET KEY: "${itemKey}"

ATURAN KETAT:
1. OUTPUT HANYA array JSON. Contoh: [{...}, {...}]
2. JANGAN sertakan header dokumen (nomor, tanggal, vendor, dll).
3. JANGAN sertakan key yang nilainya null atau kosong.
4. Jika halaman ini tidak mengandung baris tabel (misal: halaman cover/tanda tangan), return array kosong: []
5. Setiap item WAJIB memiliki minimal satu field yang terisi.

BLUEPRINT FIELDS PER ITEM:
${JSON.stringify(schemaDefinition.items || schemaDefinition.invoice_list?.items || [])}

CRITICAL: Output harus berupa JSON array yang valid dan tertutup sempurna.`;
};