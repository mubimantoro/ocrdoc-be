/**
 * AI SERVICE FACADE
 * File ini berfungsi sebagai entry point tunggal untuk semua layanan bertenaga AI.
 * Logika internal dipisahkan ke dalam folder ./ai untuk skalabilitas.
 */

export { detectBoundaries, detectBoundariesChunked } from './ai/boundary.js';
export { validateDocumentType } from './ai/validation.js';
export { extractSmartData } from './ai/extraction.js';