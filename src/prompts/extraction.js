import { instructions as ciplInstructions } from './documents/001.js';
import { instructions as plInstructions } from './documents/217.js';
import { instructions as lsInstructions } from './documents/958.js';
import { instructions as skemInstructions } from './documents/846.js';

// Registry untuk instruksi spesifik dokumen
const DOCUMENT_SPECIFIC_INSTRUCTIONS = {
  '001': ciplInstructions,
  '217': plInstructions,
  '958': lsInstructions,
  '846': skemInstructions,
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

// Kamus Referensi Dokumen untuk mengatasi ambiguitas singkatan
const DOCUMENT_DEFINITIONS = {
  '380': 'Invoice / Commercial Invoice (Faktur komersial yang berisi rincian harga barang)',
  '217': 'Packing List (Daftar rincian fisik kemasan, berat, dan dimensi barang)',
  '001': 'CIPL (Commercial Invoice & Packing List gabungan)',
  '705': 'Bill of Lading (B/L) (Dokumen pengangkutan laut)',
  '740': 'Air Way Bill (AWB) (Dokumen pengangkutan udara)',
  '860': 'ECOO (Electronic Certificate of Origin)',
  '861': 'COO (Certificate of Origin / Surat Keterangan Asal)',
  '958': 'Laporan Surveyor (Laporan verifikasi impor dari instansi resmi seperti Sucofindo/Surveyor Indonesia/Anindya)',
  '846': 'SKEM (Sertifikat Hemat Energi) - Dokumen terkait Standar Kinerja Energi Minimum yang menunjukkan bahwa peralatan pemanfaat energi telah memenuhi standar efisiensi energi yang diwajibkan.',
  '457': 'SKB (Surat Keterangan Bebas) - Bukti bahwa importir memperoleh fasilitas pembebasan pajak tertentu (PPh Pasal 22 impor).',
  '800': 'POSTEL - Dokumen sertifikasi alat/perangkat telekomunikasi untuk memenuhi persyaratan teknis telekomunikasi di Indonesia.',
  '854': 'BPOM - Dokumen persetujuan untuk barang di bawah pengawasan BPOM (Obat, Makanan, Kosmetik, Suplemen, dll).',
  '871': 'AKL (Alat Kesehatan Luar Negeri) - Nomor pendaftaran/izin edar alat kesehatan impor di Indonesia.',
  '957': 'SNI/SPB/DEPDAG - Dokumen terkait pemenuhan SNI wajib atau pengawasan mutu standar nasional Indonesia.',
  '813': 'CK (Cukai) - Dokumen cukai untuk barang terkait ketentuan atau pengawasan di bidang cukai.',
  '959': 'PI (Persetujuan Impor) - Izin impor komoditas tertentu yang diatur oleh Kementerian Perdagangan.',
  '000': 'Cukai (Dokumen terkait Cukai lainnya)',
  '999': 'Lainnya (Dokumen tidak teridentifikasi)'
};

/**
 * Mendapatkan prompt untuk validasi tipe dokumen (Guardrail)
 */
export const getValidationPrompt = (expectedDocCode) => {
  const targetDefinition = DOCUMENT_DEFINITIONS[expectedDocCode] || 'Dokumen Logistik/Regulasi';

  return `Kamu adalah AI Validator Dokumen Logistik & Regulasi.
TUGAS UTAMA: Verifikasi secara cermat apakah dokumen terlampir benar-benar sesuai dengan kategori target:
👉 [KODE: ${expectedDocCode}] -> ${targetDefinition}

OUTPUT HARUS JSON:
{
  "is_match": boolean, 
  "detected_doc_code": "string",
  "confidence": number,
  "reason": "Penjelasan singkat dalam Bahasa Indonesia"
}

ATURAN VALIDASI (BACA DENGAN TELITI):
1. FOKUS PADA TARGET: Periksa judul utama, logo instansi penerbit, atau teks regulasi di dalam dokumen. Jika sesuai dengan definisi [${expectedDocCode}] di atas, maka is_match = true.
2. TOLERANSI FORMAT: Jangan tolak dokumen (is_match: false) hanya karena tata letak atau formatnya tidak standar. Fokus pada instansi dan tujuan dokumennya.
3. JIKA MISMATCH: Jika dokumen benar-benar tidak sesuai dengan target, set is_match = false dan isi "detected_doc_code" dengan tebakan terdekat berdasarkan daftar berikut:
   - 380 (Invoice), 217 (Packing List), 705 (B/L), 740 (AWB)
   - 958 (Laporan Surveyor), 846 (SKEM), 800 (POSTEL), 854 (BPOM), 871 (AKL), 957 (SNI)
   - 999 (Lainnya)
4. ATURAN KHUSUS LOGISTIK:
   - Jika dokumen mengandung harga dan berat secara lengkap: 001
   - Jika hanya data barang tanpa harga: 217
   - Jika hanya harga tanpa dimensi kemasan: 380`;
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
 * Hanya mengambil baris-baris tabel dari halaman yang diberikan, tanpa header.
 */
export const getItemOnlyExtractionPrompt = (schemaDefinition) => {
  // Tentukan key array yang relevan dari schema
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
