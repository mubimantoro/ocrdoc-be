const PACKAGING_MAP = {
  'CARTON': 'CT',
  'CARTONS': 'CT',
  'CTN': 'CT',
  'BOX': 'BX',
  'BOXES': 'BX',
  'PALLET': 'PLT',
  'PALLETS': 'PLT',
  'PIECE': 'PCE',
  'PIECES': 'PCE',
  'PC': 'PCE',
  'PCS': 'PCE',
  'PACKAGE': 'PK',
  'PACKAGES': 'PK'
};

const WEIGHT_CODES = {
  '001': 'KG',
  'KGS': 'KG',
  'MTS': 'MT',
  'LBS': 'LB'
};

export const standardizePackagingUnit = (unitStr) => {
  if (!unitStr || typeof unitStr !== 'string') return unitStr;

  const sanitized = unitStr.trim().toUpperCase();

  // Exact Lookup
  if (PACKAGING_MAP[sanitized]) {
    return PACKAGING_MAP[sanitized];
  }

  // Fuzzy Fallback
  if (sanitized.includes('CARTON') || sanitized.includes('CTN')) return 'CT';
  if (sanitized.includes('PALLET')) return 'PLT';
  if (sanitized.includes('PIECE') || sanitized === 'PC') return 'PCE';

  return unitStr;
};

export const isWeightUnit = (unitStr) => {
  if (!unitStr) return false;
  const sanitized = String(unitStr).trim().toUpperCase();
  return WEIGHT_CODES[sanitized] !== undefined || sanitized.includes('KG') || sanitized.includes('TON');
};