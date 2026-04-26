/* eslint-disable camelcase */
import { getCountryFromIATA } from './mapper/airport-mapper.js';
import { getCountryCode } from './mapper/country-mapper.js';
import { standardizePackagingUnit } from './mapper/uom-mapper.js';


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

    // Standarisasi Packaging Root
    // Mendukung field 'packaging' atau 'packaging_type' sesuai schema AI
    if (root.packaging) {
      root.packaging = standardizePackagingUnit(root.packaging);
    } else if (root.packaging_type) {
      root.packaging_type = standardizePackagingUnit(root.packaging_type);
    }

    // Standarisasi UoM pada pl_list detail
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
  // RULES UNTUK INVOICE (380)
  // ==========================================
  '380': (data) => {
    const root = data.data || data;
    const rootCurrency = root.currency_code;

    if (root.packaging_type) {
      root.packaging_type = standardizePackagingUnit(root.packaging_type);
    }

    if (Array.isArray(root.invoice_list)) {
      root.invoice_list.forEach((inv) => {
        if (Array.isArray(inv.items)) {
          inv.items.forEach((item) => {
            if (!item.currency || item.currency === '') {
              item.currency = rootCurrency;
            }

            if (item.packaging_type_item) {
              item.packaging_type_item = standardizePackagingUnit(item.packaging_type_item);
            }
          });
        }
      });
    }
  },
  // ==========================================
  // RULES UNTUK AIR WAYBILL (AWB)
  // ==========================================
  '740': async (data) => {
    const root = data.data || data;
    // Shipper Country
    if (root.shipper_country && !root.shipper_country_code) {
      root.shipper_country_code = getCountryCode(root.shipper_country);
    }

    // Airport Country Codes
    if (root.departure_airport_code && !root.departure_airport_country_code) {
      root.departure_airport_country_code = await getCountryFromIATA(root.departure_airport_code);
    }

    if (root.transit_airport_code && !root.transit_airport_country_code) {
      root.transit_airport_country_code = await getCountryFromIATA(root.transit_airport_code);
    }

    if (root.destination_airport_code && !root.destination_airport_country_code) {
      root.destination_airport_country_code = await getCountryFromIATA(root.destination_airport_code);
    }

    // 3. Deterministic Guard
    if (Array.isArray(root.packs) && root.packs.length > 0) {
      if (root.packs.length > 1) {
        console.warn(`[Business Rules] AWB ${root.awb_num || 'N/A'}: LLM Hallucination (packs > 1). Forcing truncation.`);
        root.packs = [root.packs[0]];
      }

      const topLevelPack = root.packs[0];
      if (root.box_num) topLevelPack.no_pieces = String(root.box_num);
      if (root.weight) topLevelPack.weight = String(root.weight);
    }

  }
};

/**
 * Eksekutor Business Rules
 * Memanggil fungsi spesifik dari registry berdasarkan docCode.
 */
export const applyBusinessRules = async (docCode, data) => {
  // Guard clause: Cegah eksekusi jika data invalid
  if (!data || typeof data !== 'object') return data;

  // O(1) Lookup
  const applyRule = rulesRegistry[docCode];

  if (applyRule) {
    // Mutasi di-pass by reference, aman sebelum divalidasi Schema Enforcer
    await applyRule(data);
  } else {
    // Log di level debug/warn agar tidak menjadi blindspot saat tracking anomaly
    console.warn(`[Business Rules] No specific rules registered or triggered for docCode: ${docCode}`);
  }

  return data;
};