// src/utils/extraction-validator.js

/**
 * Generic content validity check untuk hasil ekstraksi AI.
 *
 * Berlaku untuk semua doc types tanpa hardcode field name:
 *   001 CIPL    → invoice_list / pl_list (array)
 *   217 PL      → pl_list (array)
 *   380 Invoice → invoice_list (array)
 *   705 BL      → items (array)
 *   740 AWB     → packs / items (array)
 *   846 SKEM    → doc_date / doc_number (primitive, tidak ada array)
 *   860 ECOO    → items (array)
 *   861 COO     → items (array)
 *   958 LS      → items / invoice_list (array)
 */
export const EXTRACTION_METADATA_KEYS = new Set([
  'doc_code',
  'doc_name',
  'confidence_score',
  '_reasoning',
]);

export const hasValidExtractionContent = (data) => {
  if (!data || typeof data !== 'object') return false;

  for (const [key, val] of Object.entries(data)) {
    if (EXTRACTION_METADATA_KEYS.has(key)) continue;

    // Case 1: Non-empty array — invoice_list, pl_list, items, packs, dll
    if (Array.isArray(val) && val.length > 0) return true;

    // Case 2: Non-null primitive — untuk 846 SKEM (doc_date, doc_number)
    if (
      val !== null &&
      val !== undefined &&
      val !== '' &&
      typeof val !== 'object' &&
      !Array.isArray(val)
    ) return true;
  }

  return false;
};