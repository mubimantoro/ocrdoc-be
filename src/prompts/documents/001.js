export const instructions = `
KHUSUS COMMERCIAL INVOICE & PACKING LIST (001):

1. OUTPUT COMPRESSION (KRITIKAL): Untuk mencegah JSON terpotong, gunakan singkatan kunci berikut pada bagian array:
   - DI DALAM 'invoice_list': 'desc' (description), 'qty' (quantity), 'up' (unit_price), 'am' (amount), 'cur' (currency), 'pt' (packaging_type_item), 'ori' (origin), 'oc' (origin_code).
   - DI DALAM 'pl_list': 'desc' (description), 'qty' (quantity), 'nw' (net_weight), 'gw' (gross_weight), 'ms' (measurement), 'pq' (packaging_qty), 'pu' (packaging_unit), 'qu' (quantity_unit), 'ori' (origin), 'oc' (origin_code).

2. LOGIKA ASAL NEGARA (ORIGIN): Terapkan pencarian berjenjang (fallback) berikut:
   - PRIORITAS 1 (Kolom): Jika ada kolom "Origin", "C.O.O", atau "Made In".
   - PRIORITAS 2 (Deskripsi): Cari kata kunci "COO:", "Made in:", atau "Country of Origin:" di dalam deskripsi barang.
   - PRIORITAS 3 (Global): Jika tidak ada di baris barang, ambil dari deklarasi global di header/footer dokumen.
   
   ATURAN STANDARISASI:
   - 'ori': Isi dengan nama negara utuh (misal: "CHINA").
   - 'oc': Konversi menjadi kode ISO Alpha-2 (2 huruf, misal: "CN"). Jika di dokumen sudah berupa kode (contoh: "COO: CN"), isi 'oc' dengan "CN" dan 'ori' dengan "CHINA".

2. PETA LOKASI DATA (MAPPING GUIDE):
   #### A. Dokumen Identifikasi (Root Level)
   - Cari teks berdekatan dengan label "INVOICE NO." atau "PACKING LIST NO.". Jika nomor Packing List tidak tertulis eksplisit, gunakan Nomor Invoice untuk array 'packing_list_number'.

   #### B. Informasi Entitas (Addresses)
   - Seller (Penjual): Umumnya di Kop Surat (paling atas). Baris 1 = seller_name, baris bawahnya = seller_address. Ekstrak negara ke 'seller_country'.
   - Buyer (Pembeli): Cari blok "TO:", "SOLD TO:", atau "MESSRS:". Baris 1 = buyer_name. 
     * buyer_tax: Cari kata kunci "TAX ID", "NPWP", atau "VAT" di blok alamat Buyer.
   - Ship To (Consignee): Cari "DELIVERY TO:" atau "CONSIGNEE:". Jika tidak ada, kembalikan null (asumsi sama dengan Buyer). Ekstrak kota ke 'ship_to_city'.

   #### C. Informasi Pengiriman & Persyaratan
   - 'origin' & 'ultimate_dest': Cari "From:" / "装船口岸", dan "To:" / "Destination".
   - 'shipment_date': Cari "Sailing on or about", "Ship Date", atau "ETD".
   - 'payment_terms': Cari label "PAYMENT:".
   - 'inco_terms': Cari istilah internasional (contoh: "FOB NARITA", "CIF JAKARTA").
   - 'freight_terms': Cari label "FREIGHT:" (COLLECT/PREPAID).
   - 'currency_code': Ekstrak simbol uang (contoh: ¥ = RMB/JPY, $ = USD).

   #### D. Total & Kemasan Global
   - 'total': Cari "Total Amount" atau baris paling bawah Invoice.
   - 'packaging_total': Cari angka total kemasan (misal: "TOTAL: 11 PACKAGE(S)"). Ambil angkanya saja.
   - 'packaging_type': Ekstrak satuan kemasan global (contoh: "CARTONS", "PALLETS").

3. PEMISAHAN ARRAY (INVOICE VS PACKING LIST):
   - 'invoice_list': Fokus pada tabel dengan kolom harga (Unit Price / Amount).
   - 'pl_list': Fokus pada tabel dengan kolom berat (Net Weight / Gross Weight / Measurement).
   - Jika tabel digabung, pastikan data finansial masuk ke invoice_list dan data fisik masuk ke pl_list.

4. DATA SANITIZATION: Field numerik (quantity, net_weight, gross_weight, unit_price, amount) wajib angka murni (Number) tanpa satuan teks.
`;
