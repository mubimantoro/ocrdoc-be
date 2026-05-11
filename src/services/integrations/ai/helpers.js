import fs from 'fs/promises';
import path from 'path';
import { Type } from '@google/genai';
import { ai, MODELS, safetySettings } from '../../../config/gemini.js';
import { cleanAIJson } from '../../../utils/ai-sanitizer.js';

export const jsonToGeminiSchema = (blueprint) => {
  if (Array.isArray(blueprint)) {
    return {
      type: Type.ARRAY,
      items: blueprint.length > 0 ? jsonToGeminiSchema(blueprint[0]) : { type: Type.STRING }
    };
  } else if (blueprint !== null && typeof blueprint === 'object') {
    const properties = {};
    for (const key in blueprint) {
      properties[key] = jsonToGeminiSchema(blueprint[key]);
    }
    return { type: Type.OBJECT, properties };
  } else if (typeof blueprint === 'number') {
    return { type: Type.NUMBER };
  } else if (typeof blueprint === 'boolean') {
    return { type: Type.BOOLEAN };
  } else {
    return { type: Type.STRING };
  }
};

/**
 * DEBUGGER — aktif untuk docCode: 001, 217, dan 'debug'
 */
export const debugLog = async (docCode, stepName, data) => {
  if (docCode !== '001' && docCode !== '217' && docCode !== 'debug') return;
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
    const filename = path.join(debugDir, `${docCode}_${timestamp}_${stepName}.json`);
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

export const mergeArraysDeep = (master, batch) => {
  if (!master || typeof master !== 'object' || !batch || typeof batch !== 'object') return;

  Object.keys(batch).forEach((key) => {
    const batchVal = batch[key];

    if (Array.isArray(batchVal)) {
      if (!master[key]) master[key] = [];

      if ((key === 'invoice_list' || key === 'pl_list') && master[key].length > 0 && batchVal.length > 0) {
        const masterEntry = master[key][0];
        const batchEntry = batchVal[0];

        if (batchEntry.items && Array.isArray(batchEntry.items)) {
          if (!masterEntry.items) masterEntry.items = [];
          masterEntry.items.push(...batchEntry.items);
        }

        if (batchEntry['items_csv']) {
          if (!masterEntry['items_csv']) masterEntry['items_csv'] = [];
          const masterCsv = Array.isArray(masterEntry['items_csv']) ? masterEntry['items_csv'] : [masterEntry['items_csv']];
          const batchCsv = Array.isArray(batchEntry['items_csv']) ? batchEntry['items_csv'] : [batchEntry['items_csv']];
          masterEntry['items_csv'] = [...masterCsv, ...batchCsv];
        }
      } else {
        master[key].push(...batchVal);
      }
    } else if (batchVal !== null && typeof batchVal === 'object') {
      if (!master[key] || typeof master[key] !== 'object') master[key] = {};
      mergeArraysDeep(master[key], batchVal);
    } else if (batchVal !== null && batchVal !== '') {
      if (!master[key] || master[key] === '' || master[key] === null) {
        master[key] = batchVal;
      }
    }
  });
};

/**
 * THE ENTERPRISE SELF-HEALING ENGINE (Exponential Backoff + Circuit Breaker)
 */
export const callGeminiWithRetry = async (geminiContents, maxRetries = 3, forceSchema = null) => {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      const config = {
        responseMimeType: 'application/json',
        temperature: 0.0,
        maxOutputTokens: 40960,
        safetySettings
      };

      if (forceSchema) {
        config.responseSchema = forceSchema;
      }

      const response = await ai.models.generateContent({
        model: MODELS.FLAGSHIP,
        contents: geminiContents,
        config
      });

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') {
        console.warn(`[AI-SERVICE] ⚠️ AI berhenti dengan alasan: ${candidate?.finishReason}`);
      }

      return { parsedData: cleanAIJson(response.text), usageMetadata: response.usageMetadata || {} };

    } catch (error) {
      const isRateLimit = error.message && error.message.includes('429');
      const isServiceUnavailable = error.message && error.message.includes('503');

      console.warn(`\n[AI-SERVICE] ⚠️ Error API (Attempt ${attempt}/${maxRetries}): ${error.message}`);

      if (attempt >= maxRetries) {
        throw new Error(`AI API Error setelah ${maxRetries} percobaan: ${error.message}`);
      }

      const delayMs = (isRateLimit || isServiceUnavailable) ? 5000 : (1000 * Math.pow(2, attempt));
      console.warn(`[AI-SERVICE] 🔄 Jeda ${delayMs}ms sebelum mencoba ulang...`);
      await new Promise((res) => setTimeout(res, delayMs));
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
      if (entry['items_csv']) {
        let lines = [];
        if (Array.isArray(entry['items_csv'])) {
          lines = entry['items_csv'].filter((l) => l && l.trim() !== '');
        } else if (typeof entry['items_csv'] === 'string') {
          lines = entry['items_csv'].split('\n').filter((l) => l.trim() !== '');
        }

        entry.items = lines.map((line) => {
          const parts = line.split('|');
          const obj = {};
          keys.forEach((k, i) => {
            let val = parts[i] ? parts[i].trim() : null;
            if (val === '') val = null;
            else if (['quantity', 'net_weight', 'gross_weight', 'measurement', 'packaging_qty', 'unit_price', 'amount'].includes(k) && val) {
              const cleanedStr = val.toString().replace(/[^\d.-]/g, '');
              val = cleanedStr !== '' ? Number(cleanedStr) : null;
            }
            // Sanitizer Layer 2
            else if (['uom', 'quantity_unit'].includes(k) && val) {
              val = val.toUpperCase();
            } else if (k === 'description' && val) {
              val = val.replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').trim();
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
    processList(data['pl_list'], ['number', 'description', 'quantity', 'quantity_unit', 'origin', 'brand', 'net_weight', 'gross_weight', 'amount', 'unit_price', 'measurement', 'packaging_qty', 'packaging_unit']);
  }
};