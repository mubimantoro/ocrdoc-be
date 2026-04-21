/**
 * BOUNDARY PROMPT FACTORY
 * Satu titik masuk (Single Entry Point) untuk memilih prompt boundary yang tepat.
 * Mengikuti prinsip Open/Closed: tambah tipe baru cukup di sini, tanpa ubah kode lain.
 */
import { getGenericBoundaryPrompt } from './generic.js';
import { getCIPLBoundaryPrompt } from './cipl.js';

const PROMPT_REGISTRY = {
  '001': (startPage, total) => getCIPLBoundaryPrompt(startPage, total),
};

/**
 * Mengembalikan prompt boundary yang sesuai berdasarkan tipe dokumen.
 * @param {string|null} docType - Kode tipe dokumen (misal: '001', '380'). Null = generic.
 * @param {number} absoluteStartPage - Halaman absolut pertama dalam chunk ini.
 * @param {number} totalPagesInChunk - Total halaman dalam chunk ini.
 * @returns {string} Teks prompt yang siap dikirim ke Gemini.
 */
export const getBoundaryPromptForDocType = (docType, absoluteStartPage, totalPagesInChunk) => {
  const factory = PROMPT_REGISTRY[docType];
  if (factory) return factory(absoluteStartPage, totalPagesInChunk);
  return getGenericBoundaryPrompt(absoluteStartPage, totalPagesInChunk, docType);
};
