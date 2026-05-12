/* eslint-disable camelcase */
import { standardizePackagingUnit } from '../../utils/mapper/uom-mapper.js';

/**
 * Business Rules for Packing List (217)
 */
export const applyPlRules = async (data) => {
  const root = data.data || data;

  // 1. Normalisasi Unit Kemasan di Root
  if (root.packaging) {
    root.packaging = standardizePackagingUnit(root.packaging);
  } else if (root.packaging_type) {
    root.packaging_type = standardizePackagingUnit(root.packaging_type);
  }

  // 2. Normalisasi Route & Address
  const addressFields = ['ship_by_address', 'sold_by_address', 'sold_to_address', 'ship_to_address', 'route'];
  addressFields.forEach((field) => {
    if (root[field] && typeof root[field] === 'string') {
      root[field] = root[field]
        .replace(/,([^\s])/g, ', $1')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .toUpperCase();
    }
  });

  // 3. Dimension Guard (Mencegah casting angka pada format 120*100*180)
  const isDimension = (val) => {
    if (typeof val !== 'string') return false;
    return val.includes('*') || val.toLowerCase().includes('x');
  };

  if (root.total_measurements && isDimension(root.total_measurements)) {
    // Biarkan sebagai string jika itu dimensi
    root.total_measurements = String(root.total_measurements).toUpperCase().trim();
  }

  // 4. Processing PL List Items
  if (Array.isArray(root.pl_list)) {
    root.pl_list.forEach((pl) => {
      if (Array.isArray(pl.items)) {
        // Filter out boilerplate/summary rows
        const boilerplateKeywords = ['TOTAL', 'SUBTOTAL', 'GRAND TOTAL', 'DESCRIPTION OF', 'SHIPPER\'S LOAD'];

        pl.items = pl.items.filter((item) => {
          const desc = (item.description || '').toUpperCase();
          const isBoilerplate = boilerplateKeywords.some((kw) => desc.includes(kw) && desc.length < 20);
          return !isBoilerplate;
        });

        pl.items.forEach((item) => {
          // A. Unit Standardization
          if (item.packaging_unit) {
            item.packaging_unit = standardizePackagingUnit(item.packaging_unit);
          }
          if (item.quantity_unit) {
            item.quantity_unit = standardizePackagingUnit(item.quantity_unit);
          }

          // B. Numeric Casting Guard
          // Hanya cast ke number jika BUKAN dimensi
          ['quantity', 'net_weight', 'gross_weight', 'amount', 'unit_price', 'packaging_qty'].forEach((field) => {
            if (item[field] && typeof item[field] === 'string') {
              const cleanNum = item[field].replace(/[^\d.-]/g, '');
              item[field] = cleanNum !== '' ? Number(cleanNum) : null;
            }
          });

          // C. Measurement Dimension Guard (Item Level)
          if (item.measurement && isDimension(item.measurement)) {
            item.measurement = String(item.measurement).toUpperCase().trim();
          } else if (item.measurement && typeof item.measurement === 'string') {
            const cleanMeasure = item.measurement.replace(/[^\d.]/g, '');
            item.measurement = cleanMeasure !== '' ? Number(cleanMeasure) : null;
          }

          // D. Origin Normalization
          if (item.origin) {
            item.origin = item.origin.replace(/MADE IN/i, '').replace(/ORIGIN:?/i, '').trim().toUpperCase();
          }
        });
      }
    });
  }

  return data;
};
