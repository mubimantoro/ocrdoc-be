/* eslint-disable camelcase */
import { standardizePackagingUnit } from './mapper/uom-mapper.js';
import { applyAwbRules } from '../services/documents/740-awb.js';
import { applyBlRules } from '../services/documents/705-bl.js';


/**
 * Rules Registry
 * Bertindak sebagai Strategy pattern dictionary.
 */
const rulesRegistry = {
  // ==========================================
  // RULES UNTUK CIPL (001)
  // ==========================================
  '001': (data) => {
    const root = data.data || data;

    // 1. Auto-fill Freight Terms dari Inco Terms
    if (root.inco_terms && !root.freight_terms) {
      const match = root.inco_terms.match(/[A-Z]{3}/);
      root.freight_terms = match ? match[0] : root.inco_terms;
    }

    // 2. Mathematical Guard & Standarisasi UoM Invoice
    if (Array.isArray(root.invoice_list)) {
      root.invoice_list.forEach((inv) => {
        if (Array.isArray(inv.items)) {
          inv.items.forEach((item) => {
            // A. Standarisasi packaging_type_item
            if (item.packaging_type_item) {
              item.packaging_type_item = standardizePackagingUnit(item.packaging_type_item);
            }

            // B. Guard: Mencegah Division by Zero & Beda Mata Uang
            if (item.unit_price && item.quantity && item.amount) {
              const calcAmount = Number(item.unit_price) * Number(item.quantity);
              const actualAmount = Number(item.amount);

              if (calcAmount > 0 && actualAmount > 0) {
                const deviation = Math.abs(calcAmount - actualAmount) / actualAmount;
                if (deviation > 0.2) {
                  console.warn(`[Business Rules] Math Anomaly: Qty(${item.quantity}) * UP(${item.unit_price}) != Amount(${item.amount}). Forcing unit_price to null.`);
                  item.unit_price = null;
                }
              }
            }
          });
        }
      });
    }

    // 3. Relational Data Join & Standarisasi UoM (PL List)
    if (Array.isArray(root.pl_list)) {
      root.pl_list.forEach((pl) => {
        if (Array.isArray(pl.items)) {
          pl.items.forEach((plItem) => {
            if (plItem.packaging_unit) {
              plItem.packaging_unit = standardizePackagingUnit(plItem.packaging_unit);
            }
            if (plItem.quantity_unit) {
              plItem.quantity_unit = standardizePackagingUnit(plItem.quantity_unit);
            }
          });
        }
      });
    }

    // 4. Relational Data Join (Invoice -> PL)
    if (Array.isArray(root.invoice_list) && Array.isArray(root.pl_list)) {
      const normalizeItemNum = (numStr) => {
        if (!numStr) return '';
        const cleaned = String(numStr).replace(/^0+/, '');
        return cleaned === '' ? '0' : cleaned;
      };

      root.pl_list.forEach((pl) => {
        const plItems = pl.items || [];
        plItems.forEach((plItem) => {
          let match = null;
          root.invoice_list.forEach((inv) => {
            const invItems = inv.items || [];
            const found = invItems.find((invItem) => {
              const invNum = normalizeItemNum(invItem.number);
              const plNum = normalizeItemNum(plItem.number);
              return (
                (invNum && plNum && invNum === plNum) ||
                (invItem.description && plItem.description && invItem.description.trim() === plItem.description.trim())
              );
            });
            if (found) match = found;
          });

          if (match) {
            if (!plItem.unit_price) plItem.unit_price = match.unit_price;
            if (!plItem.amount) plItem.amount = match.amount;
          }
        });
      });
    }
  },

  // ==========================================
  // RULES UNTUK PACKING LIST (217)
  // ==========================================
  '217': (data) => {
    const root = data.data || data;

    if (root.packaging) {
      root.packaging = standardizePackagingUnit(root.packaging);
    } else if (root.packaging_type) {
      root.packaging_type = standardizePackagingUnit(root.packaging_type);
    }

    if (Array.isArray(root.pl_list)) {
      root.pl_list.forEach((pl) => {
        if (Array.isArray(pl.items)) {
          pl.items.forEach((plItem) => {
            if (plItem.packaging_unit) {
              plItem.packaging_unit = standardizePackagingUnit(plItem.packaging_unit);
            }
            if (plItem.quantity_unit) {
              plItem.quantity_unit = standardizePackagingUnit(plItem.quantity_unit);
            }
          });
        }
      });
    }
  },

  // ==========================================
  // RULES UNTUK INVOICE (380) - UNIVERSAL MODE
  // ==========================================
  '380': (data) => {
    const root = data.data || data;
    const masterCurrency = root.currency_code || null;

    if (root.packaging_type) {
      root.packaging_type = standardizePackagingUnit(root.packaging_type);
    }

    if (Array.isArray(root.invoice_list)) {
      root.invoice_list.forEach((inv) => {
        if (Array.isArray(inv.items)) {
          let dominantPackagingType = root.packaging_type || null;

          if (!dominantPackagingType) {
            const itemWithPack = inv.items.find((item) => item && item.packaging_type_item);
            if (itemWithPack) {
              dominantPackagingType = standardizePackagingUnit(itemWithPack.packaging_type_item);
              root.packaging_type = dominantPackagingType;
            }
          }

          inv.items.forEach((item) => {
            if (!item) return;

            if (!item.currency || String(item.currency).trim() === '') {
              item.currency = masterCurrency;
            }

            if (item.packaging_type_item) {
              item.packaging_type_item = standardizePackagingUnit(item.packaging_type_item);
            } else if (dominantPackagingType) {
              item.packaging_type_item = dominantPackagingType;
            }

            ['quantity', 'unit_price', 'amount'].forEach((field) => {
              if (typeof item[field] === 'string') {
                const cleanNum = item[field].replace(/[^\d.-]/g, '');
                item[field] = cleanNum !== '' ? Number(cleanNum) : null;
              }
            });
          });
        }
      });
    }
  },

  // ==========================================
  // RULES UNTUK BILL OF LADING (705)
  // ==========================================
  // ==========================================
  // RULES UNTUK BILL OF LADING (705) - ISOLATED CALL
  // ==========================================
  '705': async (data) => {
    return await applyBlRules(data);
  },


  // ==========================================
  // RULES UNTUK AIR WAYBILL (740) - ISOLATED CALL
  // ==========================================
  '740': async (data) => {
    return await applyAwbRules(data);
  },

  // ==========================================
  // RULES UNTUK ELECTRONIC CERTIFICATE OF ORIGIN - ECOO (860)
  // ==========================================
  '860': (data) => {
    const root = data.data || data;

    if (Array.isArray(root.items)) {
      root.items = root.items.filter((item) => {
        const prodStr = String(item.prod_number || '');
        const descStr = String(item.description || '');
        if (prodStr.includes('4M-') || descStr.includes('4M-')) return false;
        return true;
      });

      let currentItemNumber = 1;

      root.items.forEach((item) => {
        if (!item.item_number || String(item.item_number).trim() === '') {
          item.item_number = String(currentItemNumber);
        } else {
          currentItemNumber = Number(item.item_number);
        }
        currentItemNumber++;

        if (typeof item.unit_value === 'string' || typeof item.unit_value === 'number') {
          const valStr = String(item.unit_value).replace(/,/g, '');
          const floatMatch = valStr.match(/[\d]+\.\d+/);
          item.unit_value = floatMatch ? Number(floatMatch[0]) : (Number(valStr) || null);
        }

        if (item.type_package) {
          item.type_package = standardizePackagingUnit(item.type_package);
        }

        if (item.gross_weight !== null && item.gross_weight !== undefined) {
          const gwStr = String(item.gross_weight).toUpperCase();
          const weightCode = String(item.weight_code || item.quantity_code || '').trim();
          const isActuallyWeight = weightCode === '001' || gwStr.includes('KG') || gwStr.includes('MT');

          if (!isActuallyWeight) {
            if (
              gwStr.includes('PIECE') || gwStr.includes('PCS') ||
              gwStr.includes('SET') || gwStr.includes('UNIT') ||
              gwStr.includes('N.W') || gwStr.includes('N. W') ||
              gwStr.includes('NET WEIGHT')
            ) {
              item.gross_weight = null;
            }
          } else {
            const numMatch = gwStr.replace(/,/g, '').match(/[\d.]+/);
            item.gross_weight = numMatch ? Number(numMatch[0]) : item.gross_weight;
          }
        }

        if (item.description && typeof item.description === 'string') {
          let desc = item.description;
          const hsMatch = desc.match(/HS\s*CODE/i);
          if (hsMatch) desc = desc.substring(0, hsMatch.index);
          const totalMatch = desc.match(/TOTAL:/i);
          if (totalMatch) desc = desc.substring(0, totalMatch.index);
          const thirdPartyMatch = desc.match(/THIRD-?PARTY/i);
          if (thirdPartyMatch) desc = desc.substring(0, thirdPartyMatch.index);
          const starMatch = desc.match(/\*\*\*/);
          if (starMatch) desc = desc.substring(0, starMatch.index);
          item.description = desc.trim();
        }
      });
    }
  },

  // ==========================================
  // RULES UNTUK CERTIFICATE OF ORIGIN (861)
  // ==========================================
  '861': (data) => {
    const root = data.data || data;
    if (!Array.isArray(root.items)) return;

    const CONFIG = {
      ATTACHMENT_INDICATORS: ['4M-', 'C/NO', 'SEE ATTACHMENT', 'THIRD-PARTY'],
      VALID_ORIGIN_CODES: ['PSR', 'WO', 'PE', 'CTH', 'CTC', 'B', 'RVC', 'CC', 'A', 'C', 'D'],
      NOISE_REGEX: /(?:THIRD-PARTY OPERATOR|SEE ATTACHMENT|THIS IS TO CERTIFY|WE|TOTAL)[\s\S]*/i
    };

    const sanitizeGrossWeight = (item) => {
      const raw = item.gross_weight;
      if (raw === null || raw === undefined) return null;
      const rawStr = String(raw).trim().toUpperCase();
      if (typeof raw === 'number') return raw > 0 ? raw : null;

      const numMatch = rawStr.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      return numMatch ? parseFloat(numMatch[0]) : null;
    };

    root.items = root.items.filter((item) => {
      const prodStr = String(item.prod_number || '').toUpperCase();
      const descStr = String(item.description || '').toUpperCase();
      const pkgStr = String(item.type_package || '').toUpperCase();
      const isAttachment = CONFIG.ATTACHMENT_INDICATORS.some(
        (ind) => prodStr.includes(ind) || descStr.includes(ind)
      ) || pkgStr.includes('C/NO');
      return !isAttachment;
    }).map((item) => {
      const parseNum = (val) => {
        if (typeof val === 'number') return val;
        if (typeof val === 'string') {
          const match = val.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
          return match ? parseFloat(match[0]) : null;
        }
        return null;
      };

      item.unit_value = parseNum(item.unit_value);
      item.gross_weight = sanitizeGrossWeight(item);
      item.number_package = parseNum(item.number_package);

      const ocStr = String(item.origin_criteria || '').replace(/[^A-Z]/g, '').toUpperCase();
      item.origin_criteria = CONFIG.VALID_ORIGIN_CODES.includes(ocStr) ? ocStr : null;

      if (item.description) {
        item.description = item.description
          .replace(CONFIG.NOISE_REGEX, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
      return item;
    });

    const processedItems = [];
    for (let i = 0; i < root.items.length; i++) {
      const curr = root.items[i];
      if (processedItems.length > 0) {
        const prev = processedItems[processedItems.length - 1];
        if (curr.item_number === null || String(curr.item_number).trim() === '') {
          prev.unit_value = prev.unit_value ?? curr.unit_value;
          prev.gross_weight = prev.gross_weight ?? curr.gross_weight;
          const currDesc = String(curr.description || '').trim();
          if (currDesc) prev.description = `${prev.description || ''} ${currDesc}`.trim();
          continue;
        }
      }
      processedItems.push(curr);
    }

    root.items = processedItems.map((item, index) => {
      item.item_number = String(index + 1);
      return item;
    });
  }
};

export const applyBusinessRules = async (docCode, data) => {
  if (!data || typeof data !== 'object') return data;
  const applyRule = rulesRegistry[docCode];
  if (applyRule) {
    await applyRule(data);
  } else {
    console.warn(`[Business Rules] No specific rules registered for docCode: ${docCode}`);
  }
  return data;
};