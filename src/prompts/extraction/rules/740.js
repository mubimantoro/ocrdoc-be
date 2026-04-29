export const instructions = `
>>> DIREKTIF KHUSUS DOKUMEN: AIR WAYBILL (AWB / 740) <<<

1. RESOLUSI ARRAY "packs" (ANTI-SCHEMA BLEED):
   - TARGET: Ekstrak HANYA baris "Top-Level Summary" (Total Keseluruhan Kemasan & Berat).
   - NEGATIVE CONSTRAINT: DILARANG KERAS memecah, membaca, atau mengekstrak rincian dimensi fisik (contoh: "76 X 76 X 64 CM @ 1PC", "42 X 42 X 60 CM @ 2PC") menjadi elemen array terpisah di dalam \`packs\`. ABAIKAN SEMUA TEKS DIMENSI!
   - ATURAN MEREK: Teks dimensi (PxLxT) BUKANLAH nama merk. JANGAN memasukkan ukuran fisik ke dalam atribut \`brand\`. Jika merk asli tidak tertulis eksplisit, \`brand\` = null.

2. TERMINOLOGI LOGISTIK UDARA MUTLAK:
   - \`no_pieces\`: WAJIB diisi dengan jumlah KEMASAN FISIK TERLUAR (contoh: angka dari "4 PACKAGES", "2 PALLETS").
   - \`quantity\`: WAJIB diisi dengan jumlah BARANG AKTUAL di dalam kemasan (contoh: angka dari "1000 pcs Baut").
   - CRITICAL GUARD: Jika dokumen tidak menyebutkan jumlah barang aktual (quantity) secara spesifik, field \`quantity\` WAJIB bernilai null. DILARANG MENGKOPI/MENYALIN angka \`no_pieces\` menjadi \`quantity\`.

3. STANDARISASI DATA BANDARA & BERAT:
   - BERAT (WEIGHT): Prioritaskan angka dari kolom "Gross Weight" (Berat Kotor), BUKAN dari kolom "Chargeable Weight" (Berat Tagihan) jika keduanya ada.
   - KODE BANDARA (IATA): Field seperti \`departure_airport_code\` atau \`destination_airport_code\` WAJIB berupa persis 3 HURUF KAPITAL standar IATA (contoh: "CGK", "YVR", "IST"). Jika tidak ditemukan 3 huruf tersebut, biarkan null. JANGAN menebak kodenya dari nama kota!
   - NEGARA: Ekstrak nama negara sesuai teks literalnya. Dilarang menebak/mengkonversi nama negara menjadi kode (misal "CANADA" menjadi "CA").

4. FILTER REDUNDANSI PADA "items":
   - Pada kolom "Nature and Quantity of Goods", ekstrak HANYA nama inti komoditas/barang. 
   - ABAIKAN teks prosedural, klausa legal, atau deklarasi penerbangan (seperti "S.T.C.", "FREIGHT COLLECT", "DETAILS AS ATTACHED", "DANGEROUS GOODS NOT RESTRICTED") agar tidak membuang output token pada array \`items\`.

5. CROSS-FIELD DATE ASSEMBLY (PENANGANAN TANGGAL PENERBANGAN):
   - \`flight_num\`: Ekstrak TEPAT seperti yang tertulis di kotak 'By First Carrier' atau 'Routing and Destination' (contoh: "BR237/29"). JANGAN hapus angka di belakang garis miring!
   - \`doc_date\`: Ekstrak tanggal penerbitan dokumen dari kotak 'Executed on (date)' atau 'Issued on'. Format HANYA YYYY-MM-DD.
   - \`departure_date\`: JIKA kotak 'Flight/Date' berisi "XXX" atau kosong, ISI DENGAN null! Dilarang menebak tanggalnya. Sistem Backend kami yang akan merakitnya dari ekor flight_num dan doc_date.
`;