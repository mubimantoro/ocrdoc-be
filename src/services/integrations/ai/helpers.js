
/* eslint-disable camelcase */
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

export const extractOcrTokens = (metadata) => {
  let ocrTokens = 0;
  if (metadata.promptTokensDetails && Array.isArray(metadata.promptTokensDetails)) {
    const docOrImageDetail = metadata.promptTokensDetails.find(
      (detail) => detail.modality === 'IMAGE' || detail.modality === 'DOCUMENT'
    );
    if (docOrImageDetail) ocrTokens = docOrImageDetail.tokenCount || 0;
  }
  return ocrTokens;
};

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

      if ((key === 'invoice_list' || key === 'pl_list') && batchVal.length > 0) {
        batchVal.forEach((batchEntry) => {
          const idField = key === 'invoice_list' ? 'invoice_number' : 'packing_list_number';
          const batchId = batchEntry[idField];

          const masterEntry = master[key].find((m) => {
            const masterId = m[idField];
            if (!masterId || !batchId) return false;
            if (Array.isArray(masterId) && Array.isArray(batchId)) return masterId[0] === batchId[0];
            if (Array.isArray(masterId)) return masterId.includes(batchId);
            if (Array.isArray(batchId)) return batchId.includes(masterId);
            return String(masterId) === String(batchId);
          });

          if (masterEntry) {
            if (batchEntry.items && Array.isArray(batchEntry.items)) {
              if (!masterEntry.items) masterEntry.items = [];
              masterEntry.items.push(...batchEntry.items);
            }
            if (batchEntry.rows && Array.isArray(batchEntry.rows)) {
              if (!masterEntry.rows) masterEntry.rows = [];
              masterEntry.rows.push(...batchEntry.rows);
            }
            if (key === 'pl_list' && Array.isArray(batchEntry.invoice_number)) {
              const currentInvs = Array.isArray(masterEntry.invoice_number) ? masterEntry.invoice_number : [];
              masterEntry.invoice_number = [...new Set([...currentInvs, ...batchEntry.invoice_number])].filter(Boolean);
            }
            Object.keys(batchEntry).forEach((k) => {
              if (k !== 'items' && k !== 'rows' && k !== 'invoice_number' && (masterEntry[k] === null || masterEntry[k] === undefined || masterEntry[k] === '')) {
                masterEntry[k] = batchEntry[k];
              }
            });
          } else {
            master[key].push(batchEntry);
          }
        });
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

// ════════════════════════════════════════════════════════════════════════════
// FIX B2 (lanjutan dari sanitizer): callGeminiWithRetry menerima domain,
// dan meneruskannya ke cleanAIJson dengan urutan parameter yang benar:
//   cleanAIJson(text, domain, log)  ← sesuai signature baru di ai-sanitizer.js
// ════════════════════════════════════════════════════════════════════════════
export const callGeminiWithRetry = async (
  geminiContents,
  maxRetries = 3,
  customConfig = null,
  log = console,
  domain = null
) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      attempt++;
      const config = {
        responseMimeType: 'application/json',
        temperature: 0.0,
        maxOutputTokens: 81920,
        safetySettings
      };

      if (customConfig && typeof customConfig === 'object') {
        Object.assign(config, customConfig);
      }

      const response = await ai.models.generateContent({
        model: MODELS.FLAGSHIP,
        contents: geminiContents,
        config
      });

      // Urutan argumen sesuai signature baru: cleanAIJson(text, domain, log)
      return {
        parsedData: cleanAIJson(response.text, domain, log),
        usageMetadata: response.usageMetadata || {}
      };
    } catch (error) {
      if (log.warn) log.warn(`\n[AI-SERVICE] ⚠️ Error API (Attempt ${attempt}/${maxRetries}): ${error.message}`);
      else console.warn(`\n[AI-SERVICE] ⚠️ Error API (Attempt ${attempt}/${maxRetries}): ${error.message}`);

      if (attempt >= maxRetries) throw new Error(`AI API Error setelah ${maxRetries} percobaan: ${error.message}`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
};

export const applyForwardFill = (data) => {
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];
  const recursiveFill = (obj) => {
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object' && !obj[0].items) {
        const memory = {};
        obj.forEach((row) => {
          fillableFields.forEach((field) => {
            if (row[field] !== undefined && row[field] !== null && row[field] !== '') memory[field] = row[field];
            else if (memory[field] !== undefined) row[field] = memory[field];
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

// ════════════════════════════════════════════════════════════════════════════
// parseItemsCsv — FIX B2 (domain param) + FIX B3 (expandRows) +
//                 FIX HARVESTER (handler untuk _is_harvested)
//
// HARVESTER BUG (akar masalah invoice_list/pl_list selalu []):
//   Ketika cleanAIJson gagal parse normal dan Harvester mengambil alih,
//   ia return: { _is_harvested: true, harvested_rows: [...], domain }
//   Tapi parseItemsCsv tidak punya handler untuk struktur ini →
//   data masuk ke merge phase tanpa item_headers dan tanpa invoices/pl_list
//   → invoiceMap dan plMap tetap kosong → output [].
//
// FIX: Tambah blok rekonstruksi di awal parseItemsCsv untuk docCode='001':
//   Jika data._is_harvested === true, wrap harvested_rows ke dalam struktur
//   { item_headers, invoices/pl_list } yang diharapkan oleh kode di bawahnya.
// ════════════════════════════════════════════════════════════════════════════
export const parseItemsCsv = (data, docCode, domain = null) => {
  if (!data) return;

  // ── FIX HARVESTER: Rekonstruksi data dari hasil Harvester ────────────────
  // Harvester menghasilkan { _is_harvested: true, harvested_rows, domain }
  // Struktur ini tidak dikenali oleh parser di bawah → harus di-unwrap dulu
  if (data._is_harvested && Array.isArray(data.harvested_rows) && docCode === '001') {
    const effectiveDomain = data.domain || domain;

    // Kita tidak punya item_headers dari Harvester (JSON terpotong sebelum headers selesai).
    // Gunakan header canonical sesuai domain sebagai fallback.
    // Ini adalah best-effort recovery — field yang ter-harvest mungkin tidak
    // sempurna, tapi lebih baik dari array kosong.
    const INVOICE_HEADERS = [
      'number', 'prod_number', 'description', 'quantity', 'uom',
      'unit_price', 'amount', 'currency', 'origin', 'origin_code',
      'hs_code', 'vendor_name', 'vendor_number', 'packaging_type_item',
    ];
    const PL_HEADERS = [
      'number', 'package_number', 'prod_number', 'description', 'quantity',
      'quantity_unit', 'net_weight', 'gross_weight', 'measurement',
      'packaging_qty', 'packaging_unit', 'packaging_type', 'brand', 'origin',
    ];

    const headers = effectiveDomain === 'pl' ? PL_HEADERS : INVOICE_HEADERS;

    // Wrap rows ke dalam struktur yang diharapkan:
    // invoice → data.invoices = [{ invoice_number: null, rows: [...] }]
    // pl      → data.pl_list  = [{ packing_list_number: null, rows: [...] }]
    if (effectiveDomain === 'pl') {
      data.pl_list = [{
        packing_list_number: null,  // tidak bisa diketahui dari harvested rows
        packing_list_date:   null,
        invoice_number:      [],
        rows: data.harvested_rows,
      }];
    } else {
      // invoice atau domain tidak diketahui → assume invoice
      data.invoices = [{
        invoice_number: null,
        invoice_date:   null,
        rows: data.harvested_rows,
      }];
    }

    // Ganti item_headers dengan canonical headers
    data.item_headers = headers;

    // Hapus key Harvester agar tidak mengacaukan parser di bawah
    delete data._is_harvested;
    delete data.harvested_rows;
    delete data.domain;
  }

  const NUMERIC_FIELDS = new Set([
    'quantity', 'net_weight', 'gross_weight', 'packaging_qty', 'unit_price', 'amount',
  ]);

  const normalizeUom = (val) => {
    if (!val) return val;
    const v = String(val).toUpperCase().trim();
    if (['PC', 'PCE', 'PIECE', 'PCS', 'PCS.'].includes(v)) return 'PC';
    if (['KG', 'KILO', 'KGS', 'KGS.'].includes(v)) return 'KGS';
    return v;
  };

  const normalizePackagingUnit = (val) => {
    if (!val) return val;
    const v = String(val).toUpperCase().trim();
    if (['CARTON', 'CTN', 'CT', 'CT.'].includes(v)) return 'CARTON';
    if (['BOX', 'BX', 'BX.'].includes(v)) return 'BOX';
    if (['PALLET', 'PLT', 'PL'].includes(v)) return 'PALLET';
    if (['PC', 'PCE', 'PIECE', 'PCS'].includes(v)) return 'PC';
    return v;
  };

  const normalizePackagingType = (val) => {
    if (!val) return val;
    const v = String(val).toUpperCase().trim();
    if (['CARTON', 'CTN', 'CT', 'CT.'].includes(v)) return 'CARTON';
    if (['PALLET', 'PLT'].includes(v)) return 'PALLET';
    if (['BOX', 'BX'].includes(v)) return 'BOX';
    return v;
  };

  // ── FIX B3: expandRows yang benar menggunakan reduce ────────────────────
  // Bug asli: headers.forEach() di dalam rows.map() — forEach tidak return value
  // → setiap row di-map ke undefined → obj selalu {}
  const expandRows = (rows, headers) => {
    if (!Array.isArray(rows) || !Array.isArray(headers)) return [];

    return rows.reduce((acc, row) => {
      const obj = headers.reduce((o, key, idx) => {
        let val = Array.isArray(row) ? row[idx] : row[key];

        if (val === undefined || val === '' || val === 'null' || val === null) {
          val = null;
        } else {
          val = String(val).trim();
          if (val === '') val = null;
        }

        if (val !== null) {
          if (NUMERIC_FIELDS.has(key)) {
            const cleaned = val.replace(/[^\d.-]/g, '');
            val = cleaned !== '' ? Number(cleaned) : null;
          } else if (key === 'uom' || key === 'quantity_unit') {
            val = normalizeUom(val);
          } else if (key === 'packaging_unit') {
            val = normalizePackagingUnit(val);
          } else if (key === 'packaging_type') {
            val = normalizePackagingType(val);
          }
        }

        o[key] = val;
        return o;
      }, {});

      // Buang baris yang semua valuenya null (artifact dari JSON terpotong)
      const hasData = Object.values(obj).some((v) => v !== null);
      if (hasData) acc.push(obj);

      return acc;
    }, []);
  };

  // ════════════════════════════════════════════════════════════════════════════
  // CIPL COMPACT FORMAT PARSER (docCode === '001')
  // ════════════════════════════════════════════════════════════════════════════
  if (docCode === '001') {
    const headers = data.item_headers;
    if (!Array.isArray(headers) || headers.length === 0) return;

    if (Array.isArray(data.invoices)) {
      data.invoice_list = data.invoices.map((invEntry) => ({
        invoice_number: invEntry.invoice_number || null,
        invoice_date:   invEntry.invoice_date   || null,
        items:          expandRows(invEntry.rows || [], headers),
      }));
      delete data.invoices;
    }

    if (Array.isArray(data.pl_list)) {
      data.pl_list = data.pl_list.map((plEntry) => {
        if (!Array.isArray(plEntry.rows)) return plEntry;
        return {
          packing_list_number: plEntry.packing_list_number || null,
          packing_list_date:   plEntry.packing_list_date   || null,
          invoice_number:      plEntry.invoice_number      || [],
          items:               expandRows(plEntry.rows, headers),
        };
      });
    }

    delete data.item_headers;
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // NON-CIPL: Logika default untuk dokumen lainnya (tidak berubah)
  // ════════════════════════════════════════════════════════════════════════════
  const normalizePackagingUnitLegacy = (val) => {
    if (!val) return val;
    const v = String(val).toUpperCase();
    if (['BOX', 'BX.'].includes(v)) return 'BX';
    if (['CARTON', 'CTN', 'CT.'].includes(v)) return 'CT';
    if (['PALLET', 'PLT'].includes(v)) return 'PL';
    return v;
  };

  const processList = (listArray, keys) => {
    if (!Array.isArray(listArray)) return;
    listArray.forEach((entry) => {
      if (Array.isArray(entry.rows)) {
        const newItems = entry.rows.map((row) => {
          const obj = {};
          keys.forEach((k, i) => {
            let val = row[i];
            if (typeof val === 'string') { val = val.trim(); if (val === '') val = null; }
            if (val !== null && val !== undefined) {
              if (NUMERIC_FIELDS.has(k)) {
                const cleanedStr = String(val).replace(/[^\d.-]/g, '');
                val = cleanedStr !== '' ? Number(cleanedStr) : null;
              } else if (k === 'uom' || k === 'quantity_unit') {
                val = normalizeUom(val);
              } else if (k === 'packaging_unit' || k === 'packaging_type_item') {
                val = normalizePackagingUnitLegacy(val);
              } else if (k === 'description') {
                val = String(val).replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').trim();
              }
            } else { val = null; }
            obj[k] = val;
          });
          return obj;
        });
        entry.items = Array.isArray(entry.items) ? entry.items.concat(newItems) : newItems;
        delete entry.rows;
      }
      if (!entry.items) entry.items = [];
    });
  };

  if (docCode === '217') {
    processList(data['pl_list'], [
      'number', 'description', 'quantity', 'quantity_unit', 'origin', 'brand',
      'net_weight', 'gross_weight', 'amount', 'unit_price', 'measurement',
      'packaging_qty', 'packaging_unit',
    ]);
  }
};