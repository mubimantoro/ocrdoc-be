/* eslint-disable no-useless-escape */
/**
 * UoM Mapper — Single Source of Truth untuk Standarisasi Unit Kemasan & Satuan Barang
 *
 * Referensi: UN/EDIFACT Recommendation 20 (Satuan Barang Internasional)
 * sebagaimana diterapkan oleh INSW (Indonesia National Single Window) Bea Cukai.
 *
 * Arsitektur:
 * - LLM (prompt) hanya mengekstrak teks mentah dari dokumen apa adanya.
 * - Semua konversi teks → kode baku terjadi di sini (deterministik, bukan LLM).
 * - Berlaku untuk semua docCode: 001 (CIPL), 217 (PL), 380 (Invoice),
 *   705 (B/L), 740 (AWB), 860/861 (COO), dll.
 *

/**
 * PACKAGING_MAP — Exact match lookup (O(1)).
 *
 * Key  : teks kemasan dalam UPPERCASE setelah sanitasi.
 * Value: kode UN/EDIFACT Rec 20 resmi, atau konvensi internal jika tidak ada kode resmi.
 *
 * KODE YANG SERING TERTUKAR — PERHATIKAN PERBEDAANNYA:
 *   CT  = carton   ≠   BX  = box
 *   RO  = roll     ≠   RL  = reel
 *   SA  = sack/bag (tidak ada kode "BAG" di UN/EDIFACT)
 *   PA  = packet   ≠   PK  = pack
 *   CS  = case     ≠   CT  = carton
 */
const PACKAGING_MAP = {

  // ── Carton (CT) — UN/EDIFACT resmi ──
  'CT':      'CT',
  'CTN':     'CT',
  'CTNS':    'CT',
  'CARTON':  'CT',
  'CARTONS': 'CT',

  // ── Box (BX) — UN/EDIFACT resmi; berbeda dari CT ──
  'BX':    'BX',
  'BOX':   'BX',
  'BOXES': 'BX',

  // ── Case (CS) — UN/EDIFACT resmi ──
  'CS':    'CS',
  'CASE':  'CS',
  'CASES': 'CS',

  // ── Bale (BL) — UN/EDIFACT resmi ──
  'BL':    'BL',
  'BALE':  'BL',
  'BALES': 'BL',

  // ── Bag / Sack — kode resmi UN/EDIFACT adalah SA; tidak ada kode "BAG" ──
  'SA':    'SA',
  'BAG':   'SA',
  'BAGS':  'SA',
  'SACK':  'SA',
  'SACKS': 'SA',
  'SK':    'SA',

  // ── Pallet (PLT) ──
  'PLT':     'PLT',
  'PAL':     'PLT',
  'PALLET':  'PLT',
  'PALLETS': 'PLT',

  // ── Drum — tidak ada kode generik di UN/EDIFACT; DR = konvensi internal ──
  'DR':    'DR',
  'DRM':   'DR',
  'DRUM':  'DR',
  'DRUMS': 'DR',

  // ── Crate (CR) — UN/EDIFACT resmi ──
  'CR':     'CR',
  'CRATE':  'CR',
  'CRATES': 'CR',

  // ── Tin (TN) — UN/EDIFACT resmi ──
  'TN':   'TN',
  'TIN':  'TN',
  'TINS': 'TN',
  'CAN':  'TN',
  'CANS': 'TN',

  // ── Bottle (BO) — UN/EDIFACT resmi ──
  'BO':      'BO',
  'BTL':     'BO',
  'BOTTLE':  'BO',
  'BOTTLES': 'BO',

  // ── Vial (VI) — UN/EDIFACT resmi ──
  'VI':    'VI',
  'VIAL':  'VI',
  'VIALS': 'VI',

  // ── Tube (TU) — UN/EDIFACT resmi ──
  'TU':    'TU',
  'TUBE':  'TU',
  'TUBES': 'TU',

  // ── Tray (PU) — UN/EDIFACT resmi ──
  'PU':    'PU',
  'TRAY':  'PU',
  'TRAYS': 'PU',

  // ── Roll (RO) — UN/EDIFACT resmi; untuk kain, kertas, plastik ──
  'RO':    'RO',
  'ROLL':  'RO',
  'ROLLS': 'RO',

  // ── Reel (RL) — UN/EDIFACT resmi; untuk kabel, film, pita; berbeda dari RO ──
  'RL':    'RL',
  'REEL':  'RL',
  'REELS': 'RL',

  // ── Ream (RM) — UN/EDIFACT resmi; khusus kertas ──
  'RM':    'RM',
  'REAM':  'RM',
  'REAMS': 'RM',

  // ── Bundle — tidak ada kode resmi UN/EDIFACT; BE = konvensi internal ──
  'BE':      'BE',
  'BDL':     'BE',
  'BUNDLE':  'BE',
  'BUNDLES': 'BE',

  // ── Cylinder (CY) — UN/EDIFACT resmi ──
  'CY':        'CY',
  'CYL':       'CY',
  'CYLINDER':  'CY',
  'CYLINDERS': 'CY',

  // ── Pack (PK) — UN/EDIFACT resmi ──
  'PK':    'PK',
  'PKG':   'PK',
  'PKGS':  'PK',
  'PACK':  'PK',
  'PACKS': 'PK',

  // ── Packet (PA) — UN/EDIFACT resmi; berbeda dari PK ──
  'PA':      'PA',
  'PACKET':  'PA',
  'PACKETS': 'PA',

  // ── Package — generik; fallback ke PK ──
  'PACKAGE':  'PK',
  'PACKAGES': 'PK',

  // ── Satuan quantity barang (bukan kemasan fisik) ──
  // Dicantumkan eksplisit agar tidak jatuh ke fuzzy fallback yang salah.
  'PCE':    'PCE',
  'PIECE':  'PCE',
  'PIECES': 'PCE',
  'PCS':    'PCE',
  'PC':     'PCE',
  'EA':     'EA',
  'EACH':   'EA',
  'SET':    'SET',
  'SETS':   'SET',
  'UNIT':   'PCE',
  'UNITS':  'PCE',
  'NMB':    'NMB',
  'NO':     'NMB',
  'NOS':    'NMB',
  'NUMBER': 'NMB',
};

/**
 * WEIGHT_CODES — Lookup kode satuan berat sesuai UN/EDIFACT Rec 20.
 * Digunakan oleh isWeightUnit() untuk membedakan berat vs kuantitas.
 */
const WEIGHT_CODES = {
  // Kilogram
  '001':       'KG',
  'KG':        'KG',
  'KGS':       'KG',
  'KGM':       'KG',
  'KILOGRAM':  'KG',
  'KILOGRAMS': 'KG',
  // Metric Ton
  'MT':      'MT',
  'MTS':     'MT',
  'TNE':     'MT',
  'TON':     'MT',
  'TONS':    'MT',
  'TONNE':   'MT',
  'TONNES':  'MT',
  // Pound
  'LB':      'LB',
  'LBS':     'LB',
  'LBR':     'LB',
  'POUND':   'LB',
  'POUNDS':  'LB',
  // Gram
  'G':       'G',
  'GR':      'G',
  'GRM':     'G',
  'GRS':     'G',
  'GRAM':    'G',
  'GRAMS':   'G',
  // Ounce
  'OZ':      'OZ',
  'OZA':     'OZ',
  'OUNCE':   'OZ',
  'OUNCES':  'OZ',
};

/**
 * sanitizePackagingText — Pre-processing sebelum lookup.
 *
 * Menangani format gabungan yang umum ditemukan di dokumen logistik internasional:
 *   "250boxes"       → "BOXES"
 *   "462bags"        → "BAGS"
 *   "Cartons$TP765"  → "CARTONS"
 *   "80bags"         → "BAGS"
 *   "9 Pallets"      → "PALLETS"
 *   "Cartons CW 60L" → "CARTONS"
 *
 * Strategi:
 * 1. Strip angka di awal string
 * 2. Split pada karakter pemisah ($, /, -, _, #, @) → ambil bagian pertama
 * 3. Trim dan ambil kata pertama saja
 * 4. Uppercase
 */
const sanitizePackagingText = (unitStr) => {
  let s = unitStr.trim();
  s = s.replace(/^\d+\s*/, '');
  s = s.split(/[$\/\-_#@]/)[0];
  s = s.trim().split(/\s+/)[0];
  return s.toUpperCase();
};

/**
 * standardizePackagingUnit — Main export.
 *
 * Pipeline: sanitasi teks → exact lookup → fuzzy fallback → return original.
 *
 * Input : teks mentah dari LLM (contoh: "boxes", "Cartons$TP765", "250bags")
 * Output: kode UN/EDIFACT resmi  (contoh: "BX",   "CT",            "SA")
 */
export const standardizePackagingUnit = (unitStr) => {
  if (!unitStr || typeof unitStr !== 'string') return unitStr;

  const sanitized = sanitizePackagingText(unitStr);

  // 1. Exact lookup setelah sanitasi (O(1))
  if (PACKAGING_MAP[sanitized]) {
    return PACKAGING_MAP[sanitized];
  }

  // 2. Fuzzy fallback — substring match untuk varian yang tidak terprediksi.
  // Urutan penting: lebih spesifik dahulu sebelum yang generik.
  if (sanitized.includes('CARTON') || sanitized.includes('CTN')) return 'CT';
  if (sanitized.includes('PALLET') || sanitized.includes('PAL')) return 'PLT';
  if (sanitized.includes('BOTTLE')) return 'BO';
  if (sanitized.includes('CYLINDER')) return 'CY';
  if (sanitized.includes('BUNDLE')) return 'BE';
  if (sanitized.includes('PACKET')) return 'PA';
  if (sanitized.includes('PACKAGE') || sanitized.includes('PKG')) return 'PK';
  if (sanitized.includes('REEL')) return 'RL';
  if (sanitized.includes('ROLL')) return 'RO';
  if (sanitized.includes('REAM')) return 'RM';
  if (sanitized.includes('CRATE')) return 'CR';
  if (sanitized.includes('DRUM')) return 'DR';
  if (sanitized.includes('SACK')) return 'SA';
  if (sanitized.includes('BAG')) return 'SA';
  if (sanitized.includes('BALE')) return 'BL';
  if (sanitized.includes('CASE')) return 'CS';
  if (sanitized.includes('BOX')) return 'BX';
  if (sanitized.includes('PIECE') || sanitized.includes('PCS')) return 'PCE';

  // 3. Tidak dikenali — kembalikan string asli agar tidak kehilangan data
  return unitStr;
};

/**
 * isWeightUnit — Cek apakah string adalah satuan berat.
 * Digunakan oleh business-rules.js untuk guard logika berat vs kuantitas.
 */
export const isWeightUnit = (unitStr) => {
  if (!unitStr) return false;
  const sanitized = String(unitStr).trim().toUpperCase();
  return (
    WEIGHT_CODES[sanitized] !== undefined ||
    sanitized.includes('KG') ||
    sanitized.includes('TON') ||
    sanitized.includes('LB') ||
    sanitized.includes('GRM')
  );
};