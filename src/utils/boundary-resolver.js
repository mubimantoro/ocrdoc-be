/* eslint-disable camelcase */
/**
 * O(N) Sequential Document Builder & Cross-Chunk Resolver
 * Menggunakan Type-Casting aman untuk mencegah TypeError pada JSON Numbers
 */
export const buildDocumentsFromPages = (allTaggedPages) => {
  // Sortir O(N log N)
  const sortedPages = allTaggedPages.sort((a, b) => a.absolute_page_number - b.absolute_page_number);

  const documents = [];
  let currentDoc = null;

  for (const page of sortedPages) {
    let forceNewDoc = false;

    if (!currentDoc) {
      forceNewDoc = true;
    } else {
      // PENANGANAN TIPE DATA AMAN (Mencegah Crash jika AI return tipe Integer)
      const docNum1 = currentDoc.document_number ? String(currentDoc.document_number).trim().toLowerCase() : null;
      const docNum2 = page.document_number ? String(page.document_number).trim().toLowerCase() : null;

      // HIERARKI KEBENARAN DETERMINISTIK
      if (page.doc_code !== currentDoc.doc_code) {
        forceNewDoc = true;
      }
      else if (docNum1 && docNum2 && docNum1 !== docNum2) {
        forceNewDoc = true;
      }
      else if (docNum1 && docNum2 && docNum1 === docNum2) {
        // AI Cross-Chunk Amnesia terobati di baris ini
        forceNewDoc = false;
      }
      else {
        forceNewDoc = page.is_new_document;
      }
    }

    if (forceNewDoc) {
      if (currentDoc) documents.push(currentDoc);

      currentDoc = {
        doc_code: page.doc_code,
        document_number: page.document_number ? String(page.document_number).trim() : null,
        vendor: page.vendor || null,
        start_page: page.absolute_page_number,
        end_page: page.absolute_page_number,
        confidence: page.confidence
      };
    } else {
      currentDoc.end_page = page.absolute_page_number;

      if (!currentDoc.document_number && page.document_number) {
        currentDoc.document_number = String(page.document_number).trim();
      }
    }
  }

  if (currentDoc) documents.push(currentDoc);

  return documents;
};