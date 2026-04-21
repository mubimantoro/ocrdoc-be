/**
 * AI SERVICE FACADE
 * Entry point tunggal untuk semua layanan bertenaga AI.
 * Konsumen (queue, controller) hanya perlu import dari sini.
 *
 * Prinsip Dependency Inversion: Queue bergantung pada abstraksi ini,
 * bukan pada implementasi detail di folder ./ai/.
 */

export { detectBoundaries, detectBoundariesChunked } from './ai/boundary.js';
export { extractSmartData } from './ai/extraction.js';