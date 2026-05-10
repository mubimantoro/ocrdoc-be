/* eslint-disable camelcase */
import { getCountryFromIATA } from '../../utils/mapper/airport-mapper.js';
import { getCountryCode } from '../../utils/mapper/country-mapper.js';
import { standardizeWeightUnit } from '../../utils/mapper/uom-mapper.js';

/**
 * AIR WAYBILL (AWB / 740) - ISOLATED SERVICE LAYER
 * Seluruh logika bisnis, sanitasi, dan perakitan data khusus AWB berada di sini.
 */
export const applyAwbRules = async (data) => {
  const root = data.data || data;

  // 1. Shipper Country Code Resolver
  if (root.shipper_country && !root.shipper_country_code) {
    root.shipper_country_code = getCountryCode(root.shipper_country);
  }

  // 2. Sanitasi Nomor AWB (Anti-Airport Code & Space Injection)
  if (root.awb_num) {
    // Hapus spasi dan bersihkan kode bandara
    const cleanNum = String(root.awb_num).replace(/\s+/g, '');
    const parts = cleanNum.split('-');
    root.awb_num = parts
      .filter((p) => !(p.length === 3 && /^[A-Z]{3}$/.test(p)))
      .join('-')
      .trim();
  }

  // 3. Address & Airport Normalizer (Anti-Punctuation Drift)
  const textFields = [
    'shipper_address', 'consignee_address', 'carrier_address', 'notify_party_address',
    'departure_airport', 'destination_airport'
  ];
  textFields.forEach((field) => {
    if (root[field]) {
      // Ganti newline/tab dengan spasi, lalu bersihkan spasi ganda
      root[field] = String(root[field])
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  });

  // 4. Notify Party "SAME AS CONSIGNEE" Resolver
  const notifyName = String(root.consignee_notify_name || '').toUpperCase();
  if (notifyName.includes('CONSIGNEE') || notifyName.includes('SAME AS')) {
    root.consignee_notify_name = root.consignee_name || null;
  }

  // 4. Airport & Country Resolver
  if (root.departure_airport_code && !root.departure_airport_country_code) {
    root.departure_airport_country_code = await getCountryFromIATA(root.departure_airport_code);
  } else if (!root.departure_airport_code && root.awb_num) {
    // Fallback: Ambil kode bandara dari string original AWB jika ada
    const originalAwb = data.data?.awb_num || '';
    const codeMatch = originalAwb.match(/-([A-Z]{3})-/);
    if (codeMatch) {
      root.departure_airport_code = codeMatch[1];
      root.departure_airport_country_code = await getCountryFromIATA(codeMatch[1]);
    }
  }

  if (root.transit_airport_code && !root.transit_airport_country_code) {
    root.transit_airport_country_code = await getCountryFromIATA(root.transit_airport_code);
  }

  if (root.destination_airport_code && !root.destination_airport_country_code) {
    root.destination_airport_country_code = await getCountryFromIATA(root.destination_airport_code);
  }

  // 5. Deterministic Guard (Packs & Numeric Enforcement)
  if (Array.isArray(root.packs) && root.packs.length > 0) {
    if (root.packs.length > 1) {
      root.packs = [root.packs[0]];
    }

    const topLevelPack = root.packs[0];
    if (root.box_num) topLevelPack.no_pieces = String(root.box_num);
    if (root.weight) topLevelPack.weight = String(root.weight);

    topLevelPack.prod_number = null;
    topLevelPack.brand = null;

    // Numeric Enforcement
    ['weight', 'charger_weight', 'no_pieces', 'quantity'].forEach((field) => {
      if (topLevelPack[field] !== null && topLevelPack[field] !== undefined) {
        const val = String(topLevelPack[field]).replace(/[^\d.-]/g, '');
        topLevelPack[field] = val !== '' ? Number(val) : null;
      }
    });

    if (root.box_num) {
      const cleanBox = String(root.box_num).replace(/[^\d.-]/g, '');
      root.box_num = cleanBox !== '' ? Number(cleanBox) : null;
    }

    // UOM/UOW Sync & Normalization
    if (topLevelPack.uow || topLevelPack.uom) {
      const rawUnit = topLevelPack.uow || topLevelPack.uom;
      const cleanUnit = standardizeWeightUnit(rawUnit);
      topLevelPack.uow = cleanUnit;
      topLevelPack.uom = cleanUnit;
    }
  }

  // 6. CROSS-FIELD DATE ASSEMBLER
  if (!root.departure_date && root.flight_num && root.doc_date) {
    const dayMatch = String(root.flight_num).match(/\/(\d{1,2})/);

    if (dayMatch) {
      const flightDay = parseInt(dayMatch[1], 10);
      const docDateParts = String(root.doc_date).split('-');

      if (docDateParts.length === 3) {
        let year = parseInt(docDateParts[0], 10);
        let month = parseInt(docDateParts[1], 10) - 1;
        const docDay = parseInt(docDateParts[2], 10);

        if (flightDay < docDay - 10) {
          month += 1;
          if (month > 11) {
            month = 0;
            year += 1;
          }
        }

        const finalDate = new Date(Date.UTC(year, month, flightDay));
        root.departure_date = finalDate.toISOString().split('T')[0];
      }
    }
  }

  if (root.flight_num) {
    root.flight_num = String(root.flight_num).replace(/\/\d{1,2}.*$/, '').trim();
  }

  // 7. Legal Suffix Normalizer (Anti-Drift for Company Names)
  // Menghapus CO., LTD., PT., INC. agar nama perusahaan selalu konsisten antar Run
  const nameFields = ['shipper_name', 'consignee_name', 'carrier_name', 'consignee_notify_name'];
  const suffixRegex = /[\s,]+(CO\.?|LTD\.?|PT\.?|INC\.?|CORP\.?|TBK\.?|LIMITED|CORPORATION|INCORPORATED)[\s.]*$/i;

  nameFields.forEach((field) => {
    if (root[field]) {
      // Lakukan pembersihan berulang untuk menangani kombinasi (misal: CO., LTD.)
      let cleaned = String(root[field]).trim();
      let prev;
      do {
        prev = cleaned;
        cleaned = cleaned.replace(suffixRegex, '').trim();
      } while (cleaned !== prev);
      root[field] = cleaned;
    }
  });

  return root;
};
