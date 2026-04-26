/**
 * src/utils/country-mapper.js
 * Adapter/Wrapper untuk i18n-iso-countries dengan Custom Dirty-Data Interceptor.
 */
import countries from 'i18n-iso-countries';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

// Interceptor untuk anomali dokumen Supply Chain
const customAliases = {
  'USA': 'US',
  'U.S.A': 'US',
  'U.S.A.': 'US',
  'UNITED STATES OF AMERICA': 'US',
  'UK': 'GB',
  'UNITED KINGDOM': 'GB',
  'GREAT BRITAIN': 'GB',
  'R.O.C': 'TW',
  'R.O.C.': 'TW',
  'TAIWAN, R.O.C.': 'TW',
  'TAIWAN (R.O.C.)': 'TW',
  'CHINA': 'CN',
  'PRC': 'CN',
  'P.R.C.': 'CN',
  'KOREA': 'KR',
  'SOUTH KOREA': 'KR',
  'REPUBLIC OF KOREA': 'KR',
  'UAE': 'AE',
  'U.A.E.': 'AE',
  'UNITED ARAB EMIRATES': 'AE'
};

export const getCountryCode = (countryName) => {
  if (!countryName || typeof countryName !== 'string') return null;

  // 1. Sanitization
  // Menghapus spasi ganda di tengah string (masalah umum OCR) dan menjadikan uppercase
  const sanitizedName = countryName.replace(/\s+/g, ' ').trim().toUpperCase();

  // 2. Cek Custom Aliases (Fast Return, O(1) Lookup)
  if (customAliases[sanitizedName]) {
    return customAliases[sanitizedName];
  }

  // 3. Fallback ke Standard ISO Library
  const code = countries.getAlpha2Code(sanitizedName, 'en');

  return code || null;
};