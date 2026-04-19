export const instructions = `
KHUSUS PACKING LIST (217):

1. OUTPUT COMPRESSION (KRITIKAL): Untuk mencegah JSON terpotong pada dokumen padat, gunakan singkatan kunci (abbreviated keys) berikut HANYA di dalam array 'items':
   - 'desc' untuk 'description' (Ringkas teks deskripsi maksimal 60 karakter)
   - 'qty' untuk 'quantity'
   - 'nw' untuk 'net_weight'
   - 'gw' untuk 'gross_weight'
   - 'ms' untuk 'measurement'
   - 'pq' untuk 'packaging_qty'
   - 'pu' untuk 'packaging_unit'
   - 'qu' untuk 'quantity_unit'

2. PETA LOKASI DATA (MAPPING GUIDE):
   #### A. Informasi Entitas (Addresses)
   - Pola Blok / Label Eksplisit: Cari label "SHIP BY:", "SOLD BY:", "SOLD TO:", "SHIP TO:". Baris pertama di bawah label adalah 'name', baris berikutnya adalah 'address'.
   - Pola Kop Surat / Implisit: 'ship_by_name' adalah nama perusahaan terbesar di bagian paling atas (Kop Surat). 'ship_to_name' cari di bagian berlabel "Messrs", "To:", atau "Address:".

   #### B. Informasi Header & Pengiriman (Root Level)
   - 'packaging': Ekstrak tipe kemasan (contoh: "Cartons", "Pallets") di dekat bagian total.
   - 'packaging_qty_total': Cari angka di sebelah "Total Cartons" atau "Total Box".
   - 'total_gross_weight' & 'total_net_weight': Cari baris "TOTAL" di bagian paling bawah tabel berat. Ekstrak angkanya saja.
   - 'ship_date', 'due_date', 'terms_of_payment': Ekstrak dari label terkait, jika tidak ada berikan null.

   #### C. Informasi Rincian Barang (pl_list -> items)
   - 'number': Cari di kolom "Item No", "Model", atau "Customer's Model".
   - 'desc': Ambil dari kolom "Description" atau "Material Number". 
   - 'qty' & 'quantity_unit': Pisahkan angka dan satuannya (misal: "100 PCS" menjadi qty: 100, unit: "PCS").
   - 'origin': Cari teks "COO: [Negara]" atau "Made in [Negara]" di dalam deskripsi.
   - 'brand': Ekstrak merek HANYA jika tertulis eksplisit. JANGAN menebak dari konteks.
   - 'pq' (packaging_qty): Cari di kolom "No. of Boxes" atau "QTY OF CARTONS".

3. HANDLING MULTI-LINE ITEMS: Jika informasi satu barang terpecah ke beberapa baris (misal: deskripsi di baris 1, berat di baris 2), gabungkan menjadi satu objek item yang utuh.
4. DATA SANITIZATION: Field numerik ('qty', 'nw', 'gw') wajib berupa angka murni (Number) tanpa satuan teks (kg/pcs).
`;
