

/**
 * Document-Specific Business Rules Engine
 * Menangani propagasi data, kalkulasi ulang, atau modifikasi spesifik per tipe dokumen.
 */
export const applyBusinessRules = (docCode, data) => {
  if (!data || typeof data !== 'object') return;

  // ==========================================
  // RULES UNTUK INVOICE (380)
  // ==========================================
  if (docCode === '380') {
    const rootCurrency = data.currency_code;

    // PM Request: Header-to-Detail Currency Propagation
    if (rootCurrency && Array.isArray(data.invoice_list)) {
      data.invoice_list.forEach((inv) => {
        if (Array.isArray(inv.items)) {
          inv.items.forEach((item) => {
            if (!item.currency || item.currency === '') {
              item.currency = rootCurrency;
            }
          });
        }
      });
    }

    // Anda bisa menambahkan rule invoice lain di sini nanti
    // Contoh: if (!data.total) data.total = hitung_dari_items();
  }

  // ==========================================
  // RULES UNTUK DOKUMEN LAIN (Contoh: COO - 861)
  // ==========================================
  else if (docCode === '861') {
    // Logika spesifik COO jika PM me-request sesuatu di masa depan
  }

  return data; // Mutasi aman karena dilakukan sebelum Schema Enforcer
};