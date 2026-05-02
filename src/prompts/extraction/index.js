import { instructions as ciplInstructions } from './rules/001.js';
import { instructions as plInstructions } from './rules/217.js';
import { instructions as plExcelInstructions } from './rules/217_excel.js';
import { instructions as invInstructions } from './rules/380.js';
import { instructions as lsInstructions } from './rules/958.js';
import { instructions as skemInstructions } from './rules/846.js';
import { instructions as ecooInstructions } from './rules/860.js';
import { instructions as cooInstructions } from './rules/861.js';
import { instructions as awbInstructions } from './rules/740.js';
import { instructions as blInstructions } from './rules/705.js';

// Registry untuk instruksi spesifik dokumen
const DOCUMENT_SPECIFIC_INSTRUCTIONS = {
  '001': ciplInstructions,
  '217': plInstructions,
  '217_EXCEL': plExcelInstructions,
  '380': invInstructions,
  '705': blInstructions,
  '740': awbInstructions,
  '846': skemInstructions,
  '860': ecooInstructions,
  '861': cooInstructions,
  '958': lsInstructions,
};

export const getExtractionPrompt = (docCode, schemaDefinition, isExcelToPdf = false) => {
  // Pilih instruksi spesifik: jika mode Excel-to-PDF dan ada varian _EXCEL, gunakan itu.
  let lookupCode = docCode;
  if (isExcelToPdf && DOCUMENT_SPECIFIC_INSTRUCTIONS[`${docCode}_EXCEL`]) {
    lookupCode = `${docCode}_EXCEL`;
  }

  const specificInstructions = DOCUMENT_SPECIFIC_INSTRUCTIONS[lookupCode] || '';

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
 * Mendapatkan prompt untuk ekstraksi sekuensial (halaman lanjutan).
 * docCode digunakan untuk instruksi scoped khusus per jenis dokumen (misal: COO 861).
 */
export const getSequentialExtractionPrompt = (basePrompt, contextSummary, docCode) => {
  const isCooManual = docCode === '861';

  // 1. Aturan Dasar (Berlaku untuk semua dokumen)
  let sequentialInstruction = `
CRITICAL: Ini adalah HALAMAN LANJUTAN. Gunakan konteks di atas untuk menyambung data yang terpotong antar halaman. 
FOKUS: Menjahit detail yang terpisah ke item yang relevan atau menambah baris baru jika ada identitas baru.`;

  // 2. Scoped Instruction (Agar tidak merusak schema lain)
  if (isCooManual) {
    sequentialInstruction += `
CRITICAL DIRECTIVE FOR COO:
- JANGAN PERNAH menghapus baris dengan asumsi itu adalah duplikat data sebelumnya.
- Di COO, banyak barang memiliki deskripsi dan HS Code yang sama. Ekstrak SEMUA baris secara persis!
- Jika ada teks/harga di awal halaman tanpa nomor urut, ekstrak sebagai objek baru dengan "item_number": null.`;
  }

  return `${basePrompt}\n${contextSummary}\n${sequentialInstruction}`;
};

/**
 * Prompt khusus untuk ekstraksi item-only (Parallel Mode).
 *
 * Untuk 217_EXCEL: menggunakan pendekatan universal — AI memahami struktur
 * dokumen secara mandiri tanpa mapping kolom hardcode, karena format Excel
 * antar vendor berbeda-beda (grid tabular, hybrid template, dst).
 */
export const getItemOnlyExtractionPrompt = (docCode, schemaDefinition, isExcelToPdf = false) => {
  const itemKey = schemaDefinition.invoice_list ? 'invoice_list[].items' : 'items';

  // ================================================================
  // JALUR KHUSUS 217_EXCEL — PENDEKATAN UNIVERSAL
  //
  // Tidak ada mapping kolom hardcode. AI memahami struktur dokumen
  // secara mandiri dan memetakannya ke schema PL yang sudah ada.
  // Berlaku untuk semua format Excel-converted PL dari vendor apapun.
  // ================================================================
  if (isExcelToPdf && docCode === '217') {
    const itemBlueprint = schemaDefinition.items
      || schemaDefinition.pl_list?.items
      || schemaDefinition.invoice_list?.items
      || [];

    return `Kamu adalah AI Extractor untuk dokumen Packing List yang dihasilkan dari file Excel (Excel-to-PDF).
 
KONTEKS DOKUMEN:
Dokumen ini adalah Packing List yang dikonversi dari Excel ke PDF. Formatnya bisa berupa:
- Grid spreadsheet dengan banyak kolom (tabular murni)
- Template Excel hybrid dengan tabel dan teks narasi
- Layout apapun sesuai template vendor
 
TUGASMU: Ekstrak SEMUA baris data barang dari halaman ini ke dalam format JSON array.
 
PRINSIP UNIVERSAL (berlaku untuk format apapun):
1. Identifikasi secara mandiri mana yang merupakan "nomor dokumen induk" (bisa berupa: Billing Document, Invoice No, PO No, Delivery No, atau identifier lain yang mengelompokkan baris-baris item).
2. Identifikasi mana yang merupakan "nomor urut item" dalam satu dokumen induk.
3. Identifikasi kolom description, quantity, unit, berat, harga jika ada.
4. Jika satu item memiliki beberapa sub-baris (batch, lot, partial shipment), ekstrak SETIAP sub-baris sebagai item terpisah dengan nomor induk dan nomor urut yang sama.
5. Abaikan baris yang merupakan header kolom, baris total/summary, dan baris kosong.
6. EKSTRAK SEMUA baris hingga baris terakhir di halaman ini — jangan berhenti di tengah.
 
TARGET SCHEMA PER ITEM:
${JSON.stringify(itemBlueprint)}
 
ATURAN OUTPUT:
1. OUTPUT HANYA JSON array. Buka dengan "[" dan tutup dengan "]".
2. JANGAN bungkus dalam key apapun — langsung array.
3. JANGAN sertakan key yang nilainya null atau kosong.
4. Setiap object item WAJIB memiliki minimal satu field yang terisi.
5. WAJIB: Sertakan field "invoice_number" di SETIAP item object, diisi dengan nomor dokumen
   induk yang mengelompokkan item tersebut (Billing Document / PO No / Invoice No / dll).
   Ini kritis untuk pengelompokan item yang benar di sistem backend.
   Jika satu halaman memiliki item dari beberapa dokumen induk yang berbeda, pastikan
   setiap item membawa invoice_number miliknya sendiri — jangan pakai nilai yang sama
   untuk semua item jika invoice_number-nya berbeda.
 
CRITICAL: Output harus berupa JSON array yang valid dan tertutup sempurna dengan "]".`;
  }

  // ================================================================
  // JALUR STANDAR — SEMUA DOKUMEN LAIN (001, 217 normal, 380, 861, dll)
  // ================================================================

  // Pilih instruksi spesifik: gunakan varian _EXCEL jika ada dan relevan
  let lookupCode = docCode;
  if (isExcelToPdf && DOCUMENT_SPECIFIC_INSTRUCTIONS[`${docCode}_EXCEL`]) {
    lookupCode = `${docCode}_EXCEL`;
  }

  const specificInstructions = DOCUMENT_SPECIFIC_INSTRUCTIONS[lookupCode] || '';
  const cooParallelDirective = docCode === '861'
    ? '\nCRITICAL COO RULE: Jika baris teratas di halaman ini adalah potongan deskripsi/harga tanpa Nomor Urut (Item Number), EKSTRAK SEBAGAI OBJECT SENDIRI dengan "item_number": null. Dilarang mengabaikannya!'
    : '';

  const itemBlueprint = schemaDefinition.items
    || schemaDefinition.invoice_list?.items
    || schemaDefinition.pl_list?.items
    || [];

  return `Kamu adalah AI Extractor Tabel. TUGASMU SANGAT SEMPIT:
Ekstrak HANYA baris-baris data dari tabel/list yang ada di halaman ini.
 
TARGET KEY: "${itemKey}"
 
ATURAN KETAT:
1. OUTPUT HANYA array JSON. Contoh: [{...}, {...}]
2. JANGAN bungkus array tersebut di dalam key apapun (jangan gunakan "pl_list" atau "items"). Langsung buka dengan bracket "[" dan tutup dengan "]".
3. JANGAN sertakan header dokumen (nomor, tanggal, vendor, dll).
4. Jika halaman ini tidak mengandung baris tabel (misal: halaman cover/tanda tangan), return array kosong: []
5. Setiap item WAJIB memiliki minimal satu field yang terisi.${cooParallelDirective}
 
${specificInstructions}
 
BLUEPRINT FIELDS PER ITEM:
${JSON.stringify(itemBlueprint)}
 
CRITICAL: Output harus berupa JSON array yang valid dan tertutup sempurna.`;
};
