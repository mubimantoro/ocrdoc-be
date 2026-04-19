import fs from 'fs/promises';
import path from 'path';
import { ai, MODELS, safetySettings } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';

/**
 * DEBUGGER KHUSUS CIPL (001)
 */
export const debugLog = async (docCode, stepName, data) => {
  if (docCode !== '001' && docCode !== 'debug') return;
  try {
    const debugDir = path.join(process.cwd(), 'debug_logs');
    await fs.mkdir(debugDir, { recursive: true });

    if (stepName.includes('page_1') || stepName === 'one_shot_pdf_output') {
      const files = await fs.readdir(debugDir);
      for (const file of files) {
        if (file.endsWith('.json')) await fs.unlink(path.join(debugDir, file));
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(debugDir, `cipl_${timestamp}_${stepName}.json`);
    await fs.writeFile(filename, JSON.stringify(data, null, 2));
    console.log(`[DEBUG] Log tersimpan: ${filename}`);
  } catch (err) {
    console.error('[DEBUG] Gagal save log:', err.message);
  }
};

/**
 * Ekstraksi token spesifik OCR
 */
export const extractOcrTokens = (metadata) => {
  let ocrTokens = 0;
  if (metadata.promptTokensDetails && Array.isArray(metadata.promptTokensDetails)) {
    const docOrImageDetail = metadata.promptTokensDetails.find(
      (detail) => detail.modality === 'IMAGE' || detail.modality === 'DOCUMENT'
    );
    if (docOrImageDetail) {
      ocrTokens = docOrImageDetail.tokenCount || 0;
    }
  }
  return ocrTokens;
};

/**
 * SHAPE-BASED ARRAY FINDER
 */
export const findTabularArray = (data) => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') return value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const subValue of Object.values(value)) {
          if (Array.isArray(subValue) && subValue.length > 0 && typeof subValue[0] === 'object') return subValue;
        }
      }
    }
  }
  return null;
};

/**
 * ENTERPRISE DEEP MERGER
 */
export const mergeArraysDeep = (master, batch) => {
  if (!master || typeof master !== 'object' || !batch || typeof batch !== 'object') return;

  Object.keys(batch).forEach((key) => {
    const batchVal = batch[key];

    if (Array.isArray(batchVal)) {
      if (!master[key]) master[key] = [];

      // Khusus CIPL/PL: Jika ini adalah list invoice/PL, kita coba merge rinciannya
      if ((key === 'invoice_list' || key === 'pl_list') && master[key].length > 0 && batchVal.length > 0) {
        const masterEntry = master[key][0];
        const batchEntry = batchVal[0];

        // Merge Array items (jika format lama)
        if (batchEntry.items && Array.isArray(batchEntry.items)) {
          if (!masterEntry.items) masterEntry.items = [];
          masterEntry.items.push(...batchEntry.items);
        }

        // Merge String items_csv (Strategi Baru)
        if (batchEntry['items_csv'] && typeof batchEntry['items_csv'] === 'string') {
          if (!masterEntry['items_csv']) {
            masterEntry['items_csv'] = batchEntry['items_csv'];
          } else {
            // Gabungkan dengan newline agar tidak menempel
            masterEntry['items_csv'] = `${masterEntry['items_csv'].trim()}\n${batchEntry['items_csv'].trim()}`;
          }
        }
      } else {
        master[key].push(...batchVal);
      }
    } else if (batchVal !== null && typeof batchVal === 'object') {
      if (!master[key] || typeof master[key] !== 'object') master[key] = {};
      mergeArraysDeep(master[key], batchVal);
    } else if (batchVal !== null && batchVal !== '') {
      // Jika field adalah items_csv di tingkat object (bukan di dalam array), merge juga
      if (key === 'items_csv' && typeof batchVal === 'string' && master[key]) {
        master[key] = `${master[key].trim()}\n${batchVal.trim()}`;
      } else if (!master[key] || master[key] === '' || master[key] === null) {
        master[key] = batchVal;
      }
    }
  });
};

/**
 * THE SELF-HEALING ENGINE
 */
export const callGeminiWithRetry = async (geminiContents, maxRetries = 2) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      attempt++;
      const response = await ai.models.generateContent({
        model: MODELS.FLAGSHIP,
        contents: geminiContents,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1 + (attempt * 0.1),
          maxOutputTokens: 20480,
          safetySettings
        }
      });

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') {
        console.warn(`[AI-SERVICE] ⚠️ AI berhenti dengan alasan: ${candidate?.finishReason}`);
      }

      return { parsedData: cleanAIJson(response.text), usageMetadata: response.usageMetadata || {} };
    } catch (error) {
      console.warn(`\n[AI-SERVICE] ⚠️ JSON Truncation Error pada Attempt ${attempt}/${maxRetries}: ${error.message}`);
      if (attempt >= maxRetries) throw new Error(`AI Gagal mereturn JSON valid: ${error.message}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
};

/**
 * UNIVERSAL FORWARD-FILL
 */
export const applyForwardFill = (data) => {
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];

  const recursiveFill = (obj) => {
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object' && !obj[0].items) {
        // Ini adalah array baris barang (flat)
        const memory = {};
        obj.forEach((row) => {
          fillableFields.forEach((field) => {
            if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
              memory[field] = row[field];
            } else if (memory[field] !== undefined) {
              row[field] = memory[field];
            }
          });
        });
      } else {
        // Rekursif ke dalam elemen array
        obj.forEach(recursiveFill);
      }
    } else if (obj !== null && typeof obj === 'object') {
      Object.values(obj).forEach(recursiveFill);
    }
  };

  recursiveFill(data);
};

export const parseItemsCsv = (data, docCode) => {
  if (!data) return;

  const processList = (listArray, keys) => {
    if (!Array.isArray(listArray)) return;
    listArray.forEach((entry) => {
      if (entry['items_csv'] && typeof entry['items_csv'] === 'string') {
        const lines = entry['items_csv'].split('\n').filter((l) => l.trim() !== '');
        entry.items = lines.map((line) => {
          const parts = line.split('|');
          const obj = {};
          keys.forEach((k, i) => {
            let val = parts[i] ? parts[i].trim() : null;
            if (val === '') val = null;
            else if (['quantity', 'net_weight', 'gross_weight', 'measurement', 'packaging_qty', 'unit_price', 'amount'].includes(k) && val) {
              // Hapus semua karakter selain angka, titik, dan minus
              const cleanedStr = val.toString().replace(/[^\d.-]/g, '');
              val = cleanedStr !== '' ? Number(cleanedStr) : null;
            }
            obj[k] = val;
          });
          return obj;
        });
        delete entry['items_csv'];
      }
    });
  };

  if (docCode === '001') {
    processList(data['invoice_list'], ['number', 'prod_number', 'description', 'quantity', 'hs_code', 'uom', 'origin', 'origin_code', 'vendor_name', 'vendor_number', 'unit_price', 'amount', 'currency', 'packaging_type_item']);
    processList(data['pl_list'], ['number', 'description', 'quantity', 'quantity_unit', 'origin', 'brand', 'net_weight', 'gross_weight', 'amount', 'unit_price', 'measurement', 'packaging_qty', 'packaging_unit']);
  } else if (docCode === '217') {
    processList(data['pl_list'], ['number', 'description', 'quantity', 'quantity_unit', 'net_weight', 'gross_weight', 'measurement', 'packaging_qty', 'packaging_unit']);
  }
};
