/* eslint-disable camelcase */
/**
 * O(N) Sequential Document Builder
 * Membangun dokumen dari deretan halaman yang sudah di-tag oleh AI.
 */
export const buildDocumentsFromPages = (allTaggedPages) => {
  // 1. Sortir halaman secara absolut untuk menjamin urutan (Sanity Check)
  const sortedPages = allTaggedPages.sort((a, b) => a.absolute_page_number - b.absolute_page_number);

  const documents = [];
  let currentDoc = null;

  for (const page of sortedPages) {
    // TRIGGER DOKUMEN BARU JIKA:
    // 1. Belum ada currentDoc
    // 2. AI secara eksplisit menandai is_new_document = true
    // 3. Kode dokumen berubah (misal dari 380 ke 740) secara tiba-tiba
    const forceNewDoc = !currentDoc || page.is_new_document || page.doc_code !== currentDoc.doc_code;

    if (forceNewDoc) {
      // Simpan dokumen sebelumnya (jika ada) ke array final
      if (currentDoc) documents.push(currentDoc);

      // Mulai dokumen baru
      currentDoc = {
        doc_code: page.doc_code,
        document_number: page.document_number,
        vendor: page.vendor || null,
        start_page: page.absolute_page_number,
        end_page: page.absolute_page_number, // Default awal
        confidence: page.confidence
      };
    } else {
      // INI HALAMAN LANJUTAN: Lebarkan end_page dokumen saat ini
      currentDoc.end_page = page.absolute_page_number;

      // Amankan document_number jika sebelumnya null tapi di halaman lanjutan AI menemukannya
      if (!currentDoc.document_number && page.document_number) {
        currentDoc.document_number = page.document_number;
      }
    }
  }

  // Push dokumen terakhir di akhir loop
  if (currentDoc) documents.push(currentDoc);

  return documents;
};