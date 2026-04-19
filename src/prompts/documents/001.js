export const instructions = `
KHUSUS CIPL (COMMERCIAL INVOICE & PACKING LIST):
1. Dokumen ini adalah gabungan data Finansial dan Fisik.
2. FOKUS UTAMA: Pastikan setiap "item" memiliki data part_number, description, quantity, unit_price, dan total_amount.
3. Jika data fisik (weight/dimension) berada di halaman berbeda namun merujuk pada item yang sama, jahit data tersebut ke item yang relevan.
4. Pastikan "invoice_number" dan "packing_list_number" diekstrak dengan akurat. Jika hanya ada satu nomor, gunakan untuk keduanya jika relevan.
`;
