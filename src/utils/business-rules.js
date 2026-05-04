
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
  // RULES UNTUK INVOICE (380) - UNIVERSAL MODE
  // ==========================================
  '380': (data) => {
    const root = data.data || data;

    // 1. Pewarisan Meta-Data Root (Master Currency)
    const masterCurrency = root.currency_code || null;

    // 2. Standarisasi Tipe Kemasan Global (Root Level)
    if (root.packaging_type) {
      root.packaging_type = standardizePackagingUnit(root.packaging_type);
    }

    if (Array.isArray(root.invoice_list)) {
      root.invoice_list.forEach((inv) => {
        if (Array.isArray(inv.items)) {

          // 🚀 THE UNIVERSAL INHERITANCE ENGINE
          let dominantPackagingType = root.packaging_type || null;

          if (!dominantPackagingType) {
            // Jika header null, cari petunjuk kemasan dari baris item mana pun
            const itemWithPack = inv.items.find((item) => item && item.packaging_type_item);
            if (itemWithPack) {
              dominantPackagingType = standardizePackagingUnit(itemWithPack.packaging_type_item);
              // 🚨 FIX 1: Suntikkan kembali ke Root agar UI Header klien tidak null!
              root.packaging_type = dominantPackagingType;
            }
          }

          // 3. Iterasi & Standarisasi Level Item
          inv.items.forEach((item) => {
            if (!item) return;

            // A. Pewarisan Mata Uang (Currency Cascading)
            if (!item.currency || String(item.currency).trim() === '') {
              item.currency = masterCurrency;
            }

            // B. Pewarisan Kemasan (Mengatasi "Context Loss" Multi-page)
            if (item.packaging_type_item) {
              item.packaging_type_item = standardizePackagingUnit(item.packaging_type_item);
            } else if (dominantPackagingType) {
              item.packaging_type_item = dominantPackagingType;
            }

            // C. 🚨 FIX 2: Numeric Sanitization Guard Keseluruhan (Termasuk Amount)
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
  '705': (data) => {
    const root = data.data || data;

    // 1. Relational Inference: "SAME AS CONSIGNEE" Resolver
    const notifyName = (root.notify_party_name || '').toUpperCase().trim();
    const consigneeName = (root.consignee_name || '').toUpperCase().trim();

    // Jika teks mengandung "SAME AS" ATAU namanya sama persis dengan consignee
    if (notifyName.includes('SAME AS') || (notifyName === consigneeName && consigneeName !== '')) {

      // A. Timpa/Salin Nama
      root.notify_party_name = root.consignee_name;

      // B. Timpa/Salin Alamat (Jika ada)
      if (root.consignee_address) {
        root.notify_party_address = root.consignee_address;
      }

      // C. Timpa/Salin Tax ID / NPWP
      if (!root.notify_party_tax_id && root.consignee_tax_id) {
        root.notify_party_tax_id = root.consignee_tax_id;
      }
    }

    // Data Sanitization: Country of Origin
    if (Array.isArray(root.items)) {
      root.items.forEach((item) => {
        if (item.c_o) {
          // biarkan huruf alfabet saja
          item.c_o = item.c_o.replace(/C\/O:?/i, '')
            .replace(/MADE IN/i, '')
            .replace(/[^a-zA-Z\s]/g, '')
            .trim().toUpperCase();
        }
      });
    }

    // Deduplikasi Array & Sanitization: Containers
    if (Array.isArray(root.containers)) {
      const uniqueContainers = new Map();
      root.containers.forEach((container) => {

        // Sanitasi container_type_code
        if (container.container_type_code) {
          // Hapus spasi, tanda kutip tunggal/ganda, dsb.
          container.container_type_code = container.container_type_code.replace(/['"\s]/g, '').toUpperCase();
        } else if (container.container_size) {
          // Fallback: Jika AI terlanjur memasukkan ke container_size, pindahkan dan sanitasi
          container.container_type_code = container.container_size.replace(/['"\s]/g, '').toUpperCase();
          container.container_size = null;
        }

        if (container.container_code) {
          if (!uniqueContainers.has(container.container_code)) {
            uniqueContainers.set(container.container_code, container);
          } else {
            const existing = uniqueContainers.get(container.container_code);
            if (!existing.seal_code && container.seal_code) {
              existing.seal_code = container.seal_code;
            }
          }
        }
      });
      root.containers = Array.from(uniqueContainers.values());
    }

    // 4. Force Single Summary: Packaging (Mengambil qty terbesar jika AI masih mem-breakdown data)
    if (Array.isArray(root.packaging) && root.packaging.length > 1) {
      const mainPackage = root.packaging.reduce((prev, current) => {
        return (Number(prev.qty) > Number(current.qty)) ? prev : current;
      });
      root.packaging = [mainPackage];
    }
  },
  // ==========================================
  // RULES UNTUK AIR WAYBILL (AWB 740)
  // ==========================================
  '740': async (data) => {
    const root = data.data || data;

    // 1. Shipper Country
    if (root.shipper_country && !root.shipper_country_code) {
      root.shipper_country_code = getCountryCode(root.shipper_country);
    }

    // 2. Airport Country Codes
    if (root.departure_airport_code && !root.departure_airport_country_code) {
      root.departure_airport_country_code = await getCountryFromIATA(root.departure_airport_code);
    }

    if (root.transit_airport_code && !root.transit_airport_country_code) {
      root.transit_airport_country_code = await getCountryFromIATA(root.transit_airport_code);
    }

    if (root.destination_airport_code && !root.destination_airport_country_code) {
      root.destination_airport_country_code = await getCountryFromIATA(root.destination_airport_code);
    }

    // 3. Deterministic Guard (Truncate Hallucinated Packs)
    if (Array.isArray(root.packs) && root.packs.length > 0) {
      if (root.packs.length > 1) {
        console.warn(`[Business Rules] AWB ${root.awb_num || 'N/A'}: LLM Hallucination (packs > 1). Forcing truncation.`);
        root.packs = [root.packs[0]];
      }

      const topLevelPack = root.packs[0];
      if (root.box_num) topLevelPack.no_pieces = String(root.box_num);
      if (root.weight) topLevelPack.weight = String(root.weight);
    }

    // 4. CROSS-FIELD DATE ASSEMBLER
    // Merakit departure_date jika LLM mengembalikan null, menggunakan kombinasi flight_num & doc_date
    if (!root.departure_date && root.flight_num && root.doc_date) {
      // Cek apakah ada garis miring diikuti angka 1-2 digit di akhir string (misal: "BR237/29")
      const dayMatch = String(root.flight_num).match(/\/(\d{1,2})$/);

      if (dayMatch) {
        const flightDay = parseInt(dayMatch[1], 10);
        const docDateParts = String(root.doc_date).split('-');

        if (docDateParts.length === 3) {
          let year = parseInt(docDateParts[0], 10);
          let month = parseInt(docDateParts[1], 10) - 1; // JavaScript Date month index (0-11)
          const docDay = parseInt(docDateParts[2], 10);

          // 🚨 SMART ROLLOVER PROTECTION
          // Jika hari penerbangan lebih kecil jauh dari hari eksekusi dokumen (misal Doc: Tgl 31, Flight: Tgl 1),
          // maka itu artinya penerbangannya di bulan berikutnya.
          if (flightDay < docDay - 10) {
            month += 1;
            if (month > 11) {
              month = 0; // Reset ke Januari
              year += 1; // Maju ke tahun depan
            }
          }

          // Bangun dan format tanggal kembali menjadi YYYY-MM-DD
          const finalDate = new Date(Date.UTC(year, month, flightDay));
          root.departure_date = finalDate.toISOString().split('T')[0];
        }
      }
    }

    // Pembersihan Akhir: Rapikan flight_num dari imbuhan hari (e.g. "BR237/29" menjadi "BR237")
    if (root.flight_num) {
      root.flight_num = String(root.flight_num).replace(/\/\d{1,2}$/, '').trim();
    }
  },
  // ==========================================
  // RULES UNTUK ELECTRONIC CERTIFICATE OF ORIGIN - ECOO (860)
  // ==========================================
  '860': (data) => {
    const root = data.data || data;

    if (Array.isArray(root.items)) {
      // 1. SMART-FILTER: The Anti-Attachment Guard
      root.items = root.items.filter((item) => {
        const prodStr = String(item.prod_number || '');
        const descStr = String(item.description || '');
        if (prodStr.includes('4M-') || descStr.includes('4M-')) return false;
        return true;
      });

      let currentItemNumber = 1;

      root.items.forEach((item) => {
        // A. Auto-fill Item Number
        if (!item.item_number || String(item.item_number).trim() === '') {
          item.item_number = String(currentItemNumber);
        } else {
          currentItemNumber = Number(item.item_number);
        }
        currentItemNumber++;

        // B. Sanitization: unit_value (Ekstrak float murni)
        if (typeof item.unit_value === 'string' || typeof item.unit_value === 'number') {
          const valStr = String(item.unit_value).replace(/,/g, '');
          const floatMatch = valStr.match(/[\d]+\.\d+/);
          item.unit_value = floatMatch ? Number(floatMatch[0]) : (Number(valStr) || null);
        }

        // C. Standarisasi UoM Packages
        if (item.type_package) {
          item.type_package = standardizePackagingUnit(item.type_package);
        }

        // D. The "Quantity vs Weight" Guard (SENSITIVE UPDATE)
        if (item.gross_weight !== null && item.gross_weight !== undefined) {
          const gwStr = String(item.gross_weight).toUpperCase();
          const weightCode = String(item.weight_code || item.quantity_code || '').trim();

          // Kunci: Jika weight_code adalah '001' atau satuan berat lainnya, JANGAN di-null-kan.
          const isActuallyWeight = weightCode === '001' || gwStr.includes('KG') || gwStr.includes('MT');

          if (!isActuallyWeight) {
            // Jika bukan satuan berat, baru cek apakah itu teks kuantitas (PCS/SETS)
            if (
              gwStr.includes('PIECE') || gwStr.includes('PCS') ||
              gwStr.includes('SET') || gwStr.includes('UNIT') ||
              gwStr.includes('N.W') || gwStr.includes('N. W') ||
              gwStr.includes('NET WEIGHT')
            ) {
              item.gross_weight = null;
            }
          } else {
            // Pastikan gross_weight kembali menjadi Number murni jika valid
            const numMatch = gwStr.replace(/,/g, '').match(/[\d.]+/);
            item.gross_weight = numMatch ? Number(numMatch[0]) : item.gross_weight;
          }
        }

        // E. Sanitization: description
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

    // ─── GROSS WEIGHT GUARD (Deterministik, Safety Net Layer 2) ───────────────
    // Kontrak: gross_weight diisi HANYA jika ada label berat eksplisit.
    // Jika prompt (Layer 1) masih meloloskan kuantitas murni, filter ini menangkapnya.
    const sanitizeGrossWeight = (item) => {
      const raw = item.gross_weight;
      if (raw === null || raw === undefined) return null;

      const rawStr = String(raw).trim().toUpperCase();

      // Jika nilai adalah Number murni dari prompt (sudah benar) → lewati validasi string
      // tapi tetap pastikan bukan 0 yang tidak bermakna
      if (typeof raw === 'number') {
      // Number murni dianggap valid hanya jika prompt sudah mengikuti aturan Layer 1.
      // Kita tidak bisa memvalidasi konteks Number tanpa label, jadi percayakan ke prompt.
        return raw > 0 ? raw : null;
      }

      // String: cek apakah mengandung label berat yang valid
      if (CONFIG.WEIGHT_LABEL_REGEX.test(rawStr)) {
      // Ekstrak angka murni dari string berat yang valid
      // Contoh: "75SETS 300KG G.W." → ambil angka SEBELUM label berat
        const weightMatch = rawStr.match(/(\d+(?:\.\d+)?)\s*(?:KGS?|LBS?|MT|TON|G\.?W)/i);
        if (weightMatch) return parseFloat(weightMatch[1]);

        // Fallback: ambil angka pertama yang ditemukan
        const numMatch = rawStr.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
        return numMatch ? parseFloat(numMatch[0]) : null;
      }

      // String hanya berisi satuan hitung → null
      if (CONFIG.COUNT_UNIT_REGEX.test(rawStr)) return null;

      // String ambigu tanpa label berat → null (sesuai kontrak client)
      return null;
    };

    // 1. GUILLOTINE FILTER & SANITIZATION
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

      // gross_weight menggunakan sanitizer khusus — BUKAN parseNum generik
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

    // 2. BACKWARD STITCHING & STRICT DEDUPLICATION (The Safe-Healing Engine)
    const processedItems = [];
    for (let i = 0; i < root.items.length; i++) {
      const curr = root.items[i];

      const isNullItemNumber = curr.item_number === null || String(curr.item_number).trim() === '';
      const isMissingPrice = curr.unit_value === null;
      const isMissingWeight = curr.gross_weight === null;
      const isMissingVitalData = isMissingPrice && isMissingWeight;

      if (processedItems.length > 0) {
        const prev = processedItems[processedItems.length - 1];

        const isPriceCollision = !isMissingPrice && prev.unit_value !== null;
        const isWeightCollision = !isMissingWeight && prev.gross_weight !== null;
        const prevIsIncomplete = prev.unit_value === null || prev.gross_weight === null;

        // 🛠️ LOGIKA 1: COMPLEMENTARY STITCHING (Menyembuhkan Item 12 & 13 yang terbelah)
        // Jahit JIKA: Tidak ada tabrakan pilar data, DAN (Instruksi eksplisit LLM ATAU prev cacat)
        if (!isPriceCollision && !isWeightCollision && (isNullItemNumber || prevIsIncomplete)) {
          prev.unit_value = prev.unit_value ?? curr.unit_value;
          prev.gross_weight = prev.gross_weight ?? curr.gross_weight;
          prev.number_package = prev.number_package ?? curr.number_package;
          prev.type_package = prev.type_package || curr.type_package;
          prev.origin_criteria = prev.origin_criteria || curr.origin_criteria;

          if (curr.prod_number && !prev.prod_number) prev.prod_number = curr.prod_number;

          const currDesc = String(curr.description || '').trim();
          if (currDesc && !String(prev.description || '').includes(currDesc)) {
            prev.description = `${prev.description || ''} ${currDesc}`.trim();
          }
          continue; // Penjahitan sukses, lewati!
        }

        // 🛠️ LOGIKA 2: STRICT DEDUPLICATION (Mencegah Data Loss Part Number & Membunuh Duplikat Page-Break)
        // Gabungkan duplikat HANYA JIKA Harga & Berat sama, dan Part Number TIDAK BERKONFLIK!
        if (!isMissingPrice && curr.unit_value === prev.unit_value && curr.gross_weight === prev.gross_weight) {

          // 🚨 THE SAFE-GUARD: Deteksi Konflik Produk (Melindungi TR-100BK)
          const hasProdConflict = curr.prod_number !== null && prev.prod_number !== null && curr.prod_number !== prev.prod_number;

          if (!hasProdConflict) {
            if (curr.prod_number && !prev.prod_number) prev.prod_number = curr.prod_number;
            const currDesc = String(curr.description || '').trim();
            if (currDesc && !String(prev.description || '').includes(currDesc)) {
              prev.description = `${prev.description || ''} ${currDesc}`.trim();
            }
            continue; // Aman untuk digabung! Duplikat dihancurkan.
          }
        }
      }

      // ☠️ THE KILL SWITCH
      // Jika murni teks tanpa harga/berat, BUKAN fragment eksplisit LLM, dan gagal dijahit
      if (isMissingVitalData && !isNullItemNumber) {
        continue;
      }

      // Baris Sah, daftarkan
      if (String(curr.description || '').trim() !== '' || curr.unit_value !== null || curr.gross_weight !== null) {
        processedItems.push(curr);
      }
    }

    // 3. FINAL POLISHING & ABSOLUTE RE-INDEXING
    root.items = processedItems.map((item, index) => {
      item.item_number = String(index + 1);

      if (!item.prod_number && item.description) {
        const prodMatch = item.description.match(/\(([^)]+)\)/);
        if (prodMatch) item.prod_number = prodMatch[1];
      }

      if (item.prod_number) {
        let pNum = String(item.prod_number)
          .replace(/\/\s*[A-Z0-9]{0,5}\s*(?:CTNS?|BOXES?|PKGS?|SETS?|PALLETS?|CTN|PCS|PIECES)\s*$/gi, '')
          .replace(/[()]/g, '').trim();
        if (pNum.includes('/')) pNum = pNum.split('/').pop();
        item.prod_number = pNum.trim();
      }

      if (item.description) {
        item.description = item.description
          .replace(/\([^)]+\)/g, '')
          .replace(/HS\s*CODE:?\s*\d+(?:\.\s*\d+)?/gi, '')
          .replace(/^\s*(?:[A-Z0-9\s]+)?\s*(?:\(\d+\))?\s*(?:CTNS?|BOXES?|PKGS?|SETS?|PALLETS?|CTN|PCS|PIECES)\s*(?:OF)?\s+/i, '')
          .replace(/^OF\s+/i, '') // 🛠️ FIX: Membunuh awalan "OF" yang menggantung
          .replace(/\s{2,}/g, ' ')
          .trim();
      }

      return item;
    });
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