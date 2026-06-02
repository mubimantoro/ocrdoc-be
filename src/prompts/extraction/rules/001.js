export const getInvoiceCompactPrompt = () => {
  return `Saya ingin kamu extract dokumen berikut.
Hanya extract yang secara eksplisit tertulis dan sesuai dengan skema yang diberikan. Jika ada indikator dimana valuenya secara reasoning kamu temukan, maka hanya isi jika indikatornya kuat, misalnya di atas 70% yakin.

Catatan:
1. Dokumen ini mungkin terdiri dari BEBERAPA HALAMAN berurutan dalam satu batch.
   Extract semua baris item dari SELURUH halaman yang ada dalam dokumen ini.
2. invoice_number terdapat pada kolom "Invoice Number" di setiap baris tabel.
   Jika satu halaman mengandung baris dari beberapa invoice berbeda, kelompokkan
   sesuai invoice_number masing-masing baris. JANGAN return invoice_number: null.
3. number (S/N) adalah nomor urut baris item dalam dokumen — ambil nilai eksak
   yang tercetak. JANGAN membuat urutan baru 1, 2, 3...

Output HARUS berupa JSON valid sesuai JSON Schema berikut (tanpa markdown fence):
{
  "item_headers": [
    "number", "prod_number", "description", "quantity", "uom",
    "unit_price", "amount", "currency", "origin", "origin_code",
    "hs_code", "vendor_name", "vendor_number", "packaging_type_item"
  ],
  "invoices": [
    {
      "invoice_number": "2221852744",
      "invoice_date": "2025-02-05",
      "rows": [
        [3, "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 21.76, 1044.48, "USD", "Indonesia", "ID", null, "PT Schneider Electric Manufacturing Batam", null, "F20446"],
        [4, "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 21.76, 1044.48, "USD", "Indonesia", "ID", null, "PT Schneider Electric Manufacturing Batam", null, null]
      ]
    }
  ]
}`;
};

export const getPlCompactPrompt = () => {
  return `Saya ingin kamu extract dokumen berikut.
Hanya extract yang secara eksplisit tertulis, lengkap dan sesuai dengan skema yang diberikan. Jika ada indikator dimana valuenya secara reasoning kamu temukan, maka hanya isi jika indikatornya kuat, misalnya di atas 70% yakin.

Catatan:
1. packing_list_number diambil dari kolom "Packing List" di setiap baris tabel.
   Setiap nilai unik di kolom tersebut menjadi satu entri pl_list tersendiri.
   JANGAN menggunakan Shipment Number atau Package Number sebagai packing_list_number.
2. package_number diambil dari kolom "Handling Unit" di setiap baris.
   Jika kolom Handling Unit bernilai "0" atau kosong, gunakan nilai Handling Unit
   dari baris sebelumnya yang bukan "0" (baris dalam kelompok paket yang sama).
3. Dokumen ini mungkin terdiri dari BEBERAPA HALAMAN berurutan dalam satu batch.
   Extract semua baris item dari SELURUH halaman yang ada dalam dokumen ini.
4. packing_list_number hanya boleh null jika benar-benar tidak ada nilai di kolom
   "Packing List" pada seluruh halaman dalam batch ini.

Output HARUS berupa JSON valid sesuai JSON Schema berikut (tanpa markdown fence):
{
  "item_headers": [
    "number", "package_number", "prod_number", "description", "quantity",
    "quantity_unit", "net_weight", "gross_weight", "measurement",
    "packaging_qty", "packaging_unit", "packaging_type", "brand", "origin"
  ],
  "pl_list": [
    {
      "packing_list_number": "2216074966",
      "packing_list_date": "2025-02-05",
      "invoice_number": ["2221852744"],
      "rows": [
        [3, "689943561063867434", "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 12.5, 14.0, "80x60x75", 1, "PC", "PALLET", "Schneider", "Indonesia"]
      ]
    },
    {
      "packing_list_number": "2216073868",
      "packing_list_date": "2025-02-05",
      "invoice_number": ["2221852745"],
      "rows": [
        [1, "689943561063867465", "W816253500113", "ATV71 ENCODER RS 05V PCBA", 48, "PC", 12.5, 14.0, "80x60x75", 1, "PC", "PALLET", "Schneider", "Indonesia"]
      ]
    }
  ]
}`;
};