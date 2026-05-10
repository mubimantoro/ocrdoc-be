export const instructions = `
>>> DIREKTIF KHUSUS DOKUMEN: AIR WAYBILL (AWB / 740) <<<

1. IDENTIFIKASI & SANITASI NOMOR DOKUMEN:
   - \`awb_num\`: Ekstrak nomor 11-digit (3 prefix + 8 serial). 
   - ATURAN KETAT: HAPUS semua kode alfabet (TPE, YVR, dll) DAN SEMUA SPASI di dalam nomor. Hasil akhir harus format [3digit]-[8digit] murni angka.
   - \`awb_num_add\`: Ekstrak nomor referensi/HAWB di pojok kanan atas dokumen.

2. STANDARISASI ALAMAT (Anti-Drift):
   - UNTUK SEMUA FIELD ALAMAT (\`shipper_address\`, \`consignee_address\`, \`carrier_address\`):
   - Jika alamat terdiri dari beberapa baris, GABUNGKAN dengan menggunakan SPASI sebagai pemisah (DILARANG menggunakan koma jika di dokumen asli tidak ada koma).
   - Pastikan tidak ada spasi ganda.

3. ANCHORING DATA HEADER & ROUTING:
   - \`departure_airport\` & \`destination_airport\`: Ekstrak TULISAN LENGKAP di dalam kotak. Gabungkan dengan spasi.
   - \`carrier_name\` & \`carrier_address\`: Cari di kotak "Issued by" (kanan atas). Ekstrak NAMA & ALAMAT LENGKAP.
   - \`consignee_notify_name\`: Jika tertulis "PLEASE NOTIFY CONSIGNEE" atau "SAME AS", tulis "SAME AS CONSIGNEE".
   - \`departure_airport_code\`: Fallback ke 3-huruf alfabet di tengah nomor AWB header jika kotak departure kosong.
   - \`transit_airport_code\`: JIKA ada lebih dari satu entitas di tabel routing, ambil kode "To" PERTAMA sebagai transit (misal: "IST"). Jika hanya ada satu rute, biarkan null.
   - \`destination_airport_code\`: Ambil kode "To" PALING AKHIR di tabel routing (misal: "CGK", "JKT").
   - \`flight_name\`: Kode maskapai 2-huruf (BR, SQ, KE) dari "By first Carrier".

4. RESOLUSI ARRAY "packs" & "box_num":
   - \`box_num\` (Root) & \`no_pieces\` (Packs): WAJIB berupa NUMBER.
   - \`packaging_unit\`: Unit kemasan (CTN, PKGS, dll).
   - \`uow\` & \`uom\`: Isi nilai yang sama. Ambil 1 karakter pertama ('K' atau 'L') dari kolom "kg/lb".
   - \`quantity\`: Ekstrak jumlah unit barang (misal "100" dari "100PCS"). 
   - **CRITICAL RULE**: Jika tidak ada satuan hitung barang (PCS, SETS, UNIT) yang eksplisit, isi \`quantity\` dengan null. **DILARANG KERAS** menyalin angka dari \`no_pieces\` ke \`quantity\`.
   - \`brand\` & \`prod_number\`: Selalu isi null untuk dokumen AWB.

5. STANDARISASI BERAT & FILTER REDUNDANSI:
   - \`weight\` & \`charger_weight\`: Ekstrak sebagai NUMBER murni.
   - \`items\`: Ekstrak nama inti barang. ABAIKAN teks prosedural (S.T.C., AS AGREED).
   - \`hs_code\`: 6-10 digit setelah "HS CODE:".

6. CROSS-FIELD DATE ASSEMBLY:
   - \`flight_num\`: [Carrier][Number]/[Day] (contoh: "BR237/29"). JANGAN sertakan bulan/tahun.
   - \`doc_date\`: Dari kotak "Executed on (date)". Format: YYYY-MM-DD.
`;