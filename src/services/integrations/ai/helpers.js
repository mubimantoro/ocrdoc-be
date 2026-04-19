import fs from 'fs/promises';
import path from 'path';
import { ai, MODELS } from '../../../config/gemini.js';
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

      if (key === 'invoice_list' && master[key].length > 0 && batchVal.length > 0) {
        if (batchVal[0].items && Array.isArray(batchVal[0].items)) {
          if (!master[key][0].items) master[key][0].items = [];
          master[key][0].items.push(...batchVal[0].items);
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
 * THE SELF-HEALING ENGINE
 */
export const callGeminiWithRetry = async (geminiContents, maxRetries = 3) => {
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
          maxOutputTokens: 8192
        }
      });
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
export const applyForwardFill = (finalParsedData) => {
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];
  const targetArray = findTabularArray(finalParsedData);

  if (targetArray && targetArray.length > 0) {
    const memory = {};
    targetArray.forEach((row) => {
      if (row && typeof row === 'object') {
        fillableFields.forEach((field) => {
          if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
            memory[field] = row[field];
          } else if (memory[field] !== undefined) {
            row[field] = memory[field];
          }
        });
      }
    });
  }
};

/**
 * DECOMPRESSOR: Pemetaan balik key yang disingkat (Compressed) ke format asli skema
 */
export const decompressPlData = (data) => {
  if (!data) return;
  const keyMap = {
    desc: 'description',
    qty: 'quantity',
    nw: 'net_weight',
    gw: 'gross_weight',
    ms: 'measurement',
    pq: 'packaging_qty',
    pu: 'packaging_unit',
    qu: 'quantity_unit'
  };

  const recursiveDecompress = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach(recursiveDecompress);
    } else if (obj !== null && typeof obj === 'object') {
      Object.keys(obj).forEach((key) => {
        if (keyMap[key]) {
          obj[keyMap[key]] = obj[key];
          delete obj[key];
        }
        // Rekursif untuk nested objects (seperti items di dalam pl_list)
        if (typeof obj[keyMap[key] || key] === 'object') {
          recursiveDecompress(obj[keyMap[key] || key]);
        }
      });
    }
  };

  recursiveDecompress(data);
};
