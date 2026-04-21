/**
 * BOUNDARY PROMPT FACTORY
 * Satu titik masuk (Single Entry Point) untuk memilih prompt boundary yang tepat.
 */
import { getGenericBoundaryPrompt } from './generic.js';
import { getCIPLBoundaryPrompt } from './doc-001.js';
import { getInvoiceBoundaryPrompt } from './doc-380.js';

const PROMPT_REGISTRY = {
  '001': (startPage, total) => getCIPLBoundaryPrompt(startPage, total),
  '380': (startPage, total) => getInvoiceBoundaryPrompt(startPage, total),
};

/**
 * Mengembalikan prompt boundary yang sesuai berdasarkan tipe dokumen.
 */
export const getBoundaryPromptForDocType = (docType, absoluteStartPage, totalPagesInChunk) => {
  const factory = PROMPT_REGISTRY[docType];
  if (factory) return factory(absoluteStartPage, totalPagesInChunk);
  return getGenericBoundaryPrompt(absoluteStartPage, totalPagesInChunk, docType);
};
