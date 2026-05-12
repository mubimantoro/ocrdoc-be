/* eslint-disable quotes */
/* eslint-disable camelcase */

/**
 * Business Rules untuk Bill of Lading (705)
 * Memisahkan logika dari main registry untuk maintainability.
 */
export const applyBlRules = async (data) => {
  const root = data.data || data;
  const notifyName = (root.notify_party_name || '').toUpperCase().trim();
  const consigneeName = (root.consignee_name || '').toUpperCase().trim();

  // 1. Expanded Address Normalization
  const locationFields = [
    'shipper_address',
    'consignee_address',
    'on_behalf_of_address',
    'notify_party_address',
    'port_of_discharge',
    'place_of_receipt',
    'port_of_loading',
  ];
  locationFields.forEach((field) => {
    if (root[field] && typeof root[field] === 'string') {
      root[field] = root[field]
        .replace(/,([^\s])/g, ', $1') // Tambahkan spasi jika koma berdempetan
        .replace(/\.[\s]+(\d+)/g, '.$1') // Hapus spasi setelah titik jika diikuti angka (misal: H. 10 -> H.10)
        .replace(/JL\.([^\s])/gi, 'JL. $1') // Pastikan spasi setelah JL.
        .replace(/\s{2,}/g, ' ') // Bersihkan double spasi
        .trim()
        .toUpperCase();
    }
  });

  // 1b. Country Auto-Inference (USA Guard)
  if (!root.shipper_country || root.shipper_country === '') {
    const addr = (root.shipper_address || '').toUpperCase();
    if (addr.includes('USA') || addr.includes('UNITED STATES') || / [A-Z]{2} \d{5}/.test(addr)) {
      root.shipper_country = 'USA';
      root.shipper_country_code = 'US';
    }
  }

  // 2. Numeric Enforcement (Root)
  if (root.weight && typeof root.weight === 'string') {
    const cleanWeight = root.weight.replace(/[^\d.]/g, '');
    root.weight = cleanWeight !== '' ? Number(cleanWeight) : null;
  }

  if (root.measurement && typeof root.measurement === 'string') {
    const cleanMeasure = root.measurement.replace(/[^\d.]/g, '');
    root.measurement = cleanMeasure !== '' ? Number(cleanMeasure) : null;
  }

  // 2b. Date Fallback (Anti-Drift)
  if (!root.date_of_loading && root.date_of_issue) {
    root.date_of_loading = root.date_of_issue;
  } else if (!root.date_of_issue && root.date_of_loading) {
    root.date_of_issue = root.date_of_loading;
  }

  // 3. UoM Guard (Redirect packaging units in UOM to packaging_unit)
  const packagingUnits = ['CASES', 'CARTONS', 'PKGS', 'PALLETS', 'PCS', 'UNITS', 'BAGS'];
  const volumeUnits = ['CBM', 'CFT', 'M3'];

  if (root.uom) {
    const uomUpper = String(root.uom).toUpperCase().trim();
    if (packagingUnits.includes(uomUpper)) {
      // Jika UOM berisi unit kemasan, pindahkan ke packaging root jika belum ada
      if (Array.isArray(root.packaging) && root.packaging[0] && !root.packaging[0].packaging_unit) {
        root.packaging[0].packaging_unit = uomUpper;
      }
      root.uom = null; // Kosongkan UOM karena itu bukan unit volume
    } else if (!volumeUnits.includes(uomUpper) && uomUpper.length > 5) {
      // Noise cleanup
      root.uom = null;
    }
  }

  // 4. Notify Party Logic
  if (notifyName.includes('SAME AS') || (notifyName === consigneeName && consigneeName !== '')) {
    root.notify_party_name = root.consignee_name;
    if (root.consignee_address) {
      root.notify_party_address = root.consignee_address;
    }
    if (!root.notify_party_tax_id && root.consignee_tax_id) {
      root.notify_party_tax_id = root.consignee_tax_id;
    }
  }

  // 5. Items & Packaging Refinement
  if (Array.isArray(root.items)) {
    const boilerplateKeywords = [
      "SHIPPER'S LOAD",
      "STOW AND COUNT",
      "SAID TO CONTAIN",
      "FREIGHT PREPAID",
      "EXPRESS RELEASE",
      "DAYS FREE TIME",
      "DEMURRAGE",
      "DESTINATION",
      "DESCRIPTION OF PACKAGES",
    ];

    root.items = root.items.filter((item) => {
      const desc = (item.product_name || "").toUpperCase();
      const isBoilerplate = boilerplateKeywords.some((kw) => desc.includes(kw));
      // Jika item hanya angka atau sangat pendek (< 3 char), kemungkinan noise
      const isTooShort = desc.length < 3 && !item.hs_code;
      return !isBoilerplate && !isTooShort;
    });

    root.items.forEach((item) => {
      // A. Country of Origin Clean up
      if (item.c_o) {
        item.c_o = item.c_o.replace(/C\/O:?/i, '')
          .replace(/MADE IN/i, '')
          .replace(/[^a-zA-Z\s]/g, '')
          .trim().toUpperCase();
      }

      // B. Brand vs Product Name Deduplication
      if (item.brand && item.product_name) {
        const brand = item.brand.toUpperCase().trim();
        let productName = item.product_name.toUpperCase().trim();
        if (productName.startsWith(brand)) {
          productName = productName.replace(brand, '').trim();
          item.product_name = productName.replace(/^[:\-\s]+/, '').trim();
        }
      }

      // C. Ctn No Sanitizer
      if (item.ctn_no) {
        item.ctn_no = String(item.ctn_no)
          .replace(/CARTONS?/i, '')
          .replace(/PKGS?/i, '')
          .replace(/[^0-9-]/g, '') // Hanya sisakan angka dan dash
          .trim();
      }
    });
  }

  // 6. Packaging & Numeric Casting
  if (Array.isArray(root.packaging)) {
    // Hanya ambil Grand Total (qty terbesar)
    if (root.packaging.length > 1) {
      const mainPackage = root.packaging.reduce((prev, current) => {
        return (Number(prev.qty || 0) > Number(current.qty || 0)) ? prev : current;
      });
      root.packaging = [mainPackage];
    }

    // Force Numeric Qty
    root.packaging.forEach((pkg) => {
      if (pkg.qty && typeof pkg.qty === 'string') {
        const cleanQty = pkg.qty.replace(/[^\d]/g, '');
        pkg.qty = cleanQty !== '' ? Number(cleanQty) : null;
      }
    });
  }

  // 7. Container Uniqueness & Physical ID Validation
  if (Array.isArray(root.containers)) {
    const uniqueContainers = new Map();
    const filteredContainers = root.containers.filter((c) => {
      const code = (c.container_code || "").toUpperCase();
      // ID Fisik Kontainer biasanya 4 huruf + 7 angka.
      // Jika mengandung "X" (seperti 1 X 20) atau kata "CONTAINER", itu deskripsi bukan ID.
      const isDescription = code.includes('X') || code.includes('CONTAINER') || code.length < 4;
      return !isDescription;
    });

    filteredContainers.forEach((container) => {
      if (container.container_type_code) {
        container.container_type_code = container.container_type_code.replace(/['"\s]/g, '').toUpperCase();
      } else if (container.container_size) {
        container.container_type_code = container.container_size.replace(/['"\s]/g, '').toUpperCase();
        container.container_size = null;
      }

      if (container.container_code) {
        const cleanCode = container.container_code.replace(/[^A-Z0-9]/g, '').toUpperCase();
        if (!uniqueContainers.has(cleanCode)) {
          uniqueContainers.set(cleanCode, container);
        } else {
          const existing = uniqueContainers.get(cleanCode);
          if (!existing.seal_code && container.seal_code) {
            existing.seal_code = container.seal_code;
          }
        }
      }
    });
    root.containers = Array.from(uniqueContainers.values());
  }

  return data;
};
