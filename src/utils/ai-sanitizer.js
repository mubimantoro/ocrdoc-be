/* eslint-disable camelcase */
/* eslint-disable no-useless-escape */
/* eslint-disable no-unused-vars */
import logger from '../config/logger.js';

/**
 * Utility untuk memperbaiki JSON yang terpotong (Truncated) menggunakan algoritma Stack LIFO.
 */
const repairTruncatedJson = (jsonString) => {
  let repaired = jsonString.trim();
  repaired = repaired.replace(/[,\.\-:]\s*$/, '');
  repaired = repaired.replace(/(tr|tru|fa|fal|fals|nu|nul)$/i, '');

  let inString = false;
  let i = 0;
  while (i < repaired.length) {
    if (repaired[i] === '\\' && inString) { i += 2; continue; }
    if (repaired[i] === '"') inString = !inString;
    i++;
  }
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');

  const stack = [];
  inString = false;
  for (let j = 0; j < repaired.length; j++) {
    if (repaired[j] === '\\' && inString) { j++; continue; }
    if (repaired[j] === '"') { inString = !inString; continue; }
    if (!inString) {
      if (repaired[j] === '{') stack.push('}');
      else if (repaired[j] === '[') stack.push(']');
      else if (repaired[j] === '}' || repaired[j] === ']') stack.pop();
    }
  }
  while (stack.length > 0) repaired += stack.pop();
  return repaired;
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX: Object Harvester — tidak berubah, sudah benar
// ─────────────────────────────────────────────────────────────────────────────
const harvestObjectStrings = (rawText, log = logger) => {
  log.warn({ event: 'object_harvester_triggered' }, 'Object Harvester aktif untuk format Array of Objects');
  const results = [];
  const regex = /\{[^{}]{10,}\}/g;
  let match;
  while ((match = regex.exec(rawText)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        const hasCiplField = obj.prod_number || obj.package_number || obj.packing_list_number || obj.invoice_number;
        if (hasCiplField) results.push(obj);
      }
    } catch (e) { /* skip */ }
  }
  if (results.length > 0) {
    log.info(`[OBJECT-HARVESTER] Memanen ${results.length} objects`);
    return { _is_harvested: true, harvested_items: results };
  }
  throw new Error('Object Harvester tidak menemukan pola CIPL yang valid.');
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX: harvestArrayStrings sekarang menerima parameter `domain`
//
// ROOT CAUSE: Sebelumnya Harvester mengembalikan { _is_harvested, harvested_rows }
// tanpa informasi domain. parseItemsCsv tidak tahu apakah ini PL atau Invoice,
// sehingga tidak bisa melakukan wrapping yang benar → data dibuang.
//
// FIX: Sertakan `domain` dalam output Harvester agar parseItemsCsv bisa
// melakukan wrapping yang tepat ke struktur { item_headers, pl_list/invoices }.
// ─────────────────────────────────────────────────────────────────────────────
const harvestArrayStrings = (rawText, domain = null, log = logger) => {
  log.warn({ event: 'harvester_triggered' }, 'The Harvester aktif: ekstraksi Array of Arrays secara kasar');

  const results = [];
  const regex = /\[\s*(?:\d+|"[^"\\]*(?:\\.[^"\\]*)*"|null)\s*,[\s\S]*?\]/g;
  let match;

  while ((match = regex.exec(rawText)) !== null) {
    try {
      const parsedRow = JSON.parse(match[0]);
      if (Array.isArray(parsedRow) && parsedRow.length > 3) {
        results.push(parsedRow);
      }
    } catch (e) { /* skip */ }
  }

  if (results.length > 0) {
    log.info(
      { event: 'harvester_success', rowCount: results.length, domain },
      `The Harvester memanen ${results.length} baris (rows) data [domain: ${domain || 'unknown'}]`
    );
    // FIX: Sertakan domain dalam output
    return { _is_harvested: true, harvested_rows: results, domain };
  }

  throw new Error('Harvester tidak menemukan pola rows (Array of Arrays) yang valid.');
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX: cleanAIJson sekarang menerima parameter `domain`
// untuk diteruskan ke harvestArrayStrings
// ─────────────────────────────────────────────────────────────────────────────
export const cleanAIJson = (rawText, domain = null, log = logger) => {
  if (!rawText) throw new Error('Respons AI kosong.');
  const cleanedText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleanedText);
  } catch (e1) {
    try {
      log.warn({ event: 'json_repair_attempt' }, 'JSON terpotong — mencoba LIFO repair');
      return JSON.parse(repairTruncatedJson(cleanedText));
    } catch (e2) {
      try {
        return harvestArrayStrings(cleanedText, domain, log);
      } catch (e3) {
        try {
          return harvestObjectStrings(cleanedText, log);
        } catch (e4) {
          log.error({
            repair: e2.message, harvest: e3.message, objHarvest: e4.message,
            preview: rawText?.slice(0, 500)
          }, 'Semua upaya parsing gagal');
          throw new Error('Gagal mengekstrak JSON dari respons AI.');
        }
      }
    }
  }
};
