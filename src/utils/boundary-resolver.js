/* eslint-disable camelcase */
export const resolveBoundaryOverlaps = (allExtractedDocs) => {
  const sortedDocs = allExtractedDocs.sort((a, b) => a.start_page - b.start_page);
  const resolvedDocs = [];
  let currentDoc = null;

  for (const doc of sortedDocs) {
    if (!currentDoc) {
      currentDoc = { ...doc };
      continue;
    }

    const isOverlap = doc.start_page <= currentDoc.end_page;
    const isAdjacent = doc.start_page === currentDoc.end_page + 1;

    const docNum1 = currentDoc.document_number?.trim();
    const docNum2 = doc.document_number?.trim();

    // 1. Apakah nomor dokumennya VALID dan SAMA PERSIS?
    const isSameNumber = docNum1 && docNum2 && docNum1 === docNum2;

    // 2. Apakah ini dokumen "Yatim Piatu" (hanya 1 halaman) yang kehilangan nomornya?
    // Jika rentangnya > 1 (misal 10-12), dia BUKAN yatim piatu, jangan sembarangan digabung!
    const isDoc2Orphan = doc.start_page === doc.end_page && !docNum2;
    const isSameType = doc.doc_code === currentDoc.doc_code;

    // SKENARIO A: Nomor Jelas Sama dan mereka Overlap/Bersebelahan
    if (isSameNumber && (isOverlap || isAdjacent)) {
      console.log(`[RESOLVER] Menggabungkan karena Nomor Dokumen sama: Hal ${currentDoc.start_page} s/d ${doc.end_page}`);
      currentDoc.end_page = Math.max(currentDoc.end_page, doc.end_page);
    }
    // SKENARIO B: Dokumen saat ini bersebelahan/overlap dengan halaman "Yatim Piatu" (1-1, 2-2) dari tipe yang sama
    else if (isSameType && isDoc2Orphan && (isOverlap || isAdjacent)) {
      console.log(`[RESOLVER] Menggabungkan halaman yatim piatu ke dokumen utama: Hal ${doc.start_page}`);
      currentDoc.end_page = Math.max(currentDoc.end_page, doc.end_page);

      // Pertahankan nomor dokumen utama jika ada
      if (!currentDoc.document_number && docNum2) {
        currentDoc.document_number = docNum2;
      }
    }
    // SKENARIO C: Tabrakan (Overlap) tapi Dokumen BEDA (Nomor beda, atau rentang halamannya valid/bukan yatim piatu)
    else if (isOverlap) {
      console.warn(`[RESOLVER] Resolusi tabrakan: Memaksa pemisahan Doc ${docNum1} dan ${docNum2} di hal ${doc.start_page}`);
      currentDoc.end_page = doc.start_page - 1;
      resolvedDocs.push(currentDoc);
      currentDoc = { ...doc };
    }
    // SKENARIO D: Aman, Bersebelahan tapi dokumen jelas berbeda (KASUS 7-9 dan 10-12 MASUK KE SINI!)
    else {
      resolvedDocs.push(currentDoc);
      currentDoc = { ...doc };
    }
  }

  if (currentDoc) resolvedDocs.push(currentDoc);

  // Bersihkan anomali (dokumen dengan end_page yang lebih kecil dari start_page)
  return resolvedDocs.filter((d) => d.start_page <= d.end_page);
};