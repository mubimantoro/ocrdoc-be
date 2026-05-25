// ── N8N COMPACT PROMPT BUILDERS (ARRAY OF ARRAYS) ─────────────────────────
//
// PATCH v14.2 — Perbaikan prompt:
//   B4  — Invoice: tambah instruksi forward-fill currency/vendor per baris
//   B5  — Invoice: contoh packaging_type_item lebih lengkap + contoh negatif
//   B6  — PL: standardisasi format measurement (LxWxH dalam cm)
//   B7  — Invoice: tambah catatan format SAP (titik-koma sebagai delimiter)
//   B8  — PL: perkuat instruksi packing_list_number untuk window context (RC-1)
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// getInvoiceCompactPrompt — FIX B4, B5, B7 (tidak berubah dari v14.1)
// ════════════════════════════════════════════════════════════════════════════
export const getInvoiceCompactPrompt = () => {
  return `Ekstrak data invoice dari dokumen berikut ke dalam format JSON compact.

ATURAN EKSTRAKSI:
1. Hanya ekstrak yang secara EKSPLISIT tertulis. Jika ragu dan keyakinan di bawah 70%, isi null.

CATATAN FORMAT SAP (FIX B7):
Beberapa dokumen menggunakan format SAP dengan delimiter titik-koma (;) antar kolom,
bukan spasi atau tab. Identifikasi delimiter yang digunakan berdasarkan konteks dokumen,
lalu parse dengan benar. Contoh baris SAP:
  "001;W816253480313;ATV71 ENCODER;48;PC;21.76;1044.48;USD;Indonesia;ID"

FORWARD-FILL (FIX B4):
Jika kolom currency, vendor_name, origin, atau origin_code hanya tertulis
di baris pertama invoice (header baris) dan tidak diulang di baris berikutnya,
WAJIB isi field tersebut dengan nilai dari baris pertama untuk SEMUA baris dalam
invoice yang sama. Jangan biarkan null hanya karena tidak tercetak ulang.

CATATAN PENTING UNTUK FIELD "packaging_type_item" (FIX B5):
- Field ini HANYA diisi dengan BARCODE PAKET dari kolom Packing List / Delivery.
- Format VALID: angka numerik panjang 12-20 digit.
  Contoh valid: "689943561067474782" (18 digit), "123456789012" (12 digit EAN)
- Format TIDAK VALID (isi null):
  • Nomor SAP internal format "S" + angka (contoh: "S94253", "S0012345")
  • Kode produk alfanumerik (contoh: "W816253480313")
  • Nomor PO / order (contoh: "4500123456")
  • Teks deskriptif apapun
  • Angka kurang dari 12 digit
- Jika satu baris invoice tidak memiliki referensi barcode yang jelas → null.
- Jika ada beberapa nomor di kolom yang sama, ambil hanya yang 12-20 digit numerik murni.

Output HARUS berupa JSON valid sesuai skema berikut (tanpa markdown fence):
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
        [1, "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 21.76, 1044.48, "USD", "Indonesia", "ID", null, "PT Schneider Electric Manufacturing Batam", null, "689943561063867762"],
        [2, "W816253480314", "ATV71 ENCODER PP 24V PCBA", 24, "PC", 21.76, 522.24, "USD", "Indonesia", "ID", null, "PT Schneider Electric Manufacturing Batam", null, null]
      ]
    }
  ]
}

ATURAN TOKEN:
- WAJIB output item_headers hanya SEKALI di root level, tidak diulang per invoice.
- Isi null sebagai nilai kosong di dalam array row (bukan string "null").
- Jangan tambahkan key apapun di luar skema.`;
};

// ════════════════════════════════════════════════════════════════════════════
// getPlCompactPrompt — FIX B6 + FIX B8 (RC-1: packing_list_number awareness)
// ════════════════════════════════════════════════════════════════════════════
export const getPlCompactPrompt = () => {
  return `Ekstrak data packing list dari dokumen berikut ke dalam format JSON compact.

ATURAN EKSTRAKSI:
1. Hanya ekstrak yang secara EKSPLISIT tertulis, lengkap dan sesuai skema.
2. Jika ragu dan keyakinan di bawah 70%, isi null.

CATATAN FORMAT SAP:
Beberapa dokumen menggunakan format SAP dengan delimiter titik-koma (;) antar kolom.
Identifikasi delimiter yang digunakan berdasarkan konteks, lalu parse dengan benar.

ATURAN KRITIS — PACKING LIST NUMBER (FIX B8):
packing_list_number adalah nomor unik per entri packing list (bukan shipment number,
bukan package barcode, bukan invoice number).
- Jika dokumen menampilkan nomor PL di HEADER HALAMAN dan tidak diulang di setiap baris:
  WAJIB gunakan nomor PL dari header halaman tersebut untuk SEMUA baris item di halaman itu.
- Jika ada konteks dari halaman sebelumnya (Anda menerima multi-halaman):
  Cari packing_list_number di halaman mana pun yang tersedia, lalu gunakan untuk halaman target.
- JANGAN kembalikan null untuk packing_list_number jika ada nomor PL di mana pun dalam dokumen.
- Setiap entri pl_list WAJIB memiliki packing_list_number yang valid.
- Jika satu halaman mengandung MULTIPLE PL (header PL berbeda untuk kelompok baris berbeda),
  pisahkan menjadi entri pl_list yang berbeda per packing_list_number.

CATATAN KHUSUS:
1. packing_list_number: ambil dari EXACT nomor packing list, bukan shipment number
   atau package number. WAJIB diisi jika ada.
2. Data item bisa tersebar di satu tabel gabungan, tabel package saja,
   tabel item saja, atau keduanya terpisah. Jika ada dua tabel terpisah,
   join menggunakan package_number sebagai kunci — satu row output per item.
   Field weight/dimensi/packaging diambil dari tabel package yang cocok.
   Setiap package di tabel package WAJIB muncul sebagai row output,
   meskipun tidak ada item yang mereferensikannya.
3. Format angka: konvensi lokal (koma sebagai desimal, titik sebagai ribuan)
   dikonversi ke desimal standar berdasarkan konteks dokumen.

FORMAT MEASUREMENT (FIX B6):
- Field "measurement" WAJIB dalam format: "PanjangxLebarxTinggi" (dalam cm, tanpa spasi)
- Contoh VALID: "117.5x73x76.5", "60x40x30", "100x80x120"
- Contoh TIDAK VALID: "0.62L", "117.5 x 73 x 76.5", "117,5x73x76,5"
- Jika dokumen menggunakan format berbeda, konversi ke format LxWxH dalam cm.
- Jika satuan bukan cm (misal: mm atau inch), konversi terlebih dahulu.
- Jika measurement tidak tersedia atau tidak bisa dipastikan → null.

Output HARUS berupa JSON valid sesuai skema berikut (tanpa markdown fence):
{
  "item_headers": [
    "number", "package_number", "prod_number", "description", "quantity",
    "quantity_unit", "net_weight", "gross_weight", "measurement",
    "packaging_qty", "packaging_unit", "packaging_type", "brand", "origin"
  ],
  "pl_list": [
    {
      "packing_list_number": "PL-20250205-01",
      "packing_list_date": "2025-02-05",
      "invoice_number": ["2221852744", "2221852745"],
      "rows": [
        [1, "689943561063867762", "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 12.5, 14.0, "117.5x73x76.5", 1, "CARTON", "CARTON", "Schneider Electric", "Indonesia"],
        [2, "689943561063867763", "W816253480313", "ATV71 ENCODER PP 24V PCBA", 48, "PC", 12.5, null, "117.5x73x76.5", 1, "CARTON", "CARTON", "Schneider Electric", "Indonesia"]
      ]
    }
  ]
}

ATURAN TOKEN:
- WAJIB output item_headers hanya SEKALI di root level.
- Isi null sebagai nilai kosong di dalam array row (bukan string "null").
- Jangan tambahkan key apapun di luar skema.`;
};

export const instructions = '';
export const invoiceInstructions = '';
export const plInstructions = '';