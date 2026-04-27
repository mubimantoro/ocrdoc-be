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

    if (Array.isArray(root.items)) {

      // 1. THE GUILLOTINE (Pemenggal Lampiran) - Bekerja Sempurna
      const attachmentIndex = root.items.findIndex((item) => {
        const prodStr = String(item.prod_number || '').toUpperCase();
        const pkgStr = String(item.type_package || '').toUpperCase();
        const ocStr = String(item.origin_criteria || '').toUpperCase();
        return prodStr.includes('4M-') || pkgStr.includes('C/NO') || ocStr === 'INDONESIA';
      });

      if (attachmentIndex !== -1) {
        root.items = root.items.slice(0, attachmentIndex);
      }

      // 2. PRE-CLEANSING
      root.items.forEach((item) => {
        // Ekstrak Harga Mutlak
        if (typeof item.unit_value === 'string') {
          const numBlocks = item.unit_value.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
          if (numBlocks && numBlocks.length > 0) {
            item.unit_value = Number(numBlocks[numBlocks.length - 1]);
          } else {
            item.unit_value = null;
          }
        }
        // Bersihkan kemasan
        if (typeof item.number_package === 'string') {
          const numMatch = item.number_package.match(/\d+/);
          item.number_package = numMatch ? Number(numMatch[0]) : item.number_package;
        }
        if (typeof item.gross_weight === 'string' && item.gross_weight.toUpperCase().includes('SET')) {
          item.gross_weight = null;
        }
      });

      // 3. STRICT ROW STITCHER (Penjahit Presisi Tinggi)
      const mergedItems = [];
      for (let i = 0; i < root.items.length; i++) {
        const currentItem = root.items[i];

        // HUKUM MUTLAK: Fragment HANYA valid jika tidak punya harga. Dilarang pakai regex deskripsi!
        const isFragment = !currentItem.unit_value;

        if (isFragment && i + 1 < root.items.length) {
          const nextItem = root.items[i + 1];

          const stitchedItem = {
            ...currentItem,
            unit_value: nextItem.unit_value,
            prod_number: (nextItem.prod_number && String(nextItem.prod_number).length > 2)
              ? nextItem.prod_number
              : currentItem.prod_number,
            // Gabungkan deskripsi
            description: (currentItem.description && !/^(OF|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)$/i.test(currentItem.description.trim()))
              ? `${currentItem.description} ${nextItem.description || ''}`.trim()
              : nextItem.description,
            gross_weight: currentItem.gross_weight || nextItem.gross_weight,
            type_package: currentItem.type_package || nextItem.type_package,
            number_package: currentItem.number_package || nextItem.number_package,
            origin_criteria: currentItem.origin_criteria || nextItem.origin_criteria
          };

          mergedItems.push(stitchedItem);
          i++; // Lompati item sebelahnya karena sudah disedot
        } else {
          mergedItems.push(currentItem);
        }
      }

      // 4. ABSOLUTE RE-INDEXING & FINAL BRACKET PARSING
      mergedItems.forEach((item, index) => {
        item.item_number = String(index + 1);

        // Membersihkan kurung dan sisa kemasan di prod_number
        if (item.prod_number) {
          item.prod_number = item.prod_number.replace(/\/\d*\s*[A-Z]*CTNS?/gi, '').trim();
          item.prod_number = item.prod_number.replace(/^\(/, '').replace(/\)$/, '').trim();
          item.prod_number = item.prod_number.replace(/,$/, '').trim();
        }

        // Membersihkan nama barang dari kurung
        if (item.description && item.description.includes('(')) {
          const descMatch = item.description.match(/^([^(]+)/);
          if (descMatch) item.description = descMatch[1].trim();
        }

        // [NEW] PREFIX STRIPPER: Membuang awalan kemasan (Contoh: "TWO (2) CTNS OF ") secara aman
        if (item.description) {
          item.description = item.description.replace(/^(?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|\d+)\s*(?:\(\d+\))?\s*(?:CTNS?|BOXES?|PKGS?|SETS?|PALLETS?|CTN)\s*OF\s+/i, '').trim();
        }
      });

      root.items = mergedItems;
    }
  },
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