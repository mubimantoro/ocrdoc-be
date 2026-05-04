/* eslint-disable no-unused-vars */
import logger from '../config/logger.js';

/**
 * Utility untuk memperbaiki JSON yang terpotong (Truncated) menggunakan algoritma Stack LIFO.
 */
const repairTruncatedJson = (jsonString) => {
  let repaired = jsonString.trim();

  // 1. Hapus trailing comma yang menggantung
  repaired = repaired.replace(/,\s*$/, '');

  // 2. Deteksi kutipan ganjil
  let quoteCount = 0;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      quoteCount++;
    }
  }

  // 3. Tutup string
  if (quoteCount % 2 !== 0) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');

  // 4. LIFO Stack Array untuk menghitung kurung yang terbuka
  const stack = [];
  let inString = false;

  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inString = !inString;
    }
    if (!inString) {
      if (repaired[i] === '{') stack.push('}');
      else if (repaired[i] === '[') stack.push(']');
      else if (repaired[i] === '}' || repaired[i] === ']') stack.pop();
    }
  }

  // 5. Keluarkan isi stack (Last-In-First-Out) untuk menutup JSON dengan urutan yang BENAR
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  return repaired;
};

const harvestArrayStrings = (rawText, log = logger) => {
  log.warn({ event: 'harvester_triggered' }, 'The Harvester aktif: ekstraksi array secara kasar');

  const results = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*\|[^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = regex.exec(rawText)) !== null) {
    results.push(match[1]);
  }
  if (results.length > 0) {
    log.info({ event: 'harvester_success', rowCount: results.length },
      `The Harvester memanen ${results.length} baris data`);

    return results;
  }
  throw new Error('Harvester tidak menemukan pola Array of Strings yang valid.');
};

export const cleanAIJson = (rawText, log = logger) => {
  if (!rawText) throw new Error('Respons AI kosong (null/undefined).');

  const cleanedText = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch (error) {
    try {
      log.warn({ event: 'json_repair_attempt' }, 'JSON terpotong terdeteksi — mencoba perbaikan LIFO');

      const repairedText = repairTruncatedJson(cleanedText);
      return JSON.parse(repairedText);
    } catch (repairError) {
      try {
        return harvestArrayStrings(cleanedText);
      } catch (harvestError) {
        log.error({
          event: 'json_parse_failed',
          repairError: repairError.message,
          harvestError: harvestError.message,
          rawTextPreview: rawText?.slice(0, 500), // Cukup 500 char untuk diagnosis
        }, 'Gagal parsing JSON dari respons AI setelah semua upaya perbaikan');

        throw new Error('Gagal mengekstrak data JSON dari respons AI. Format tidak valid setelah upaya perbaikan.');
      }
    }
  }
};