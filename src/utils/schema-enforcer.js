/* eslint-disable camelcase */

/**
 * Universal Schema Strictness Enforcer (O(N) Time Complexity)
 * Menjamin API Contract Client terpenuhi dengan memaksa key yang hilang menjadi null,
 * ATAU menjadi array kosong [] untuk tipe data tabel/list (Sesuai arahan PM).
 */
export const enforceSchemaStrictness = (parsedData, schema) => {
  // Guard: jika parsedData null/undefined/bukan object, kembalikan struktur kosong
  // tanpa memproses lebih lanjut. Ini mencegah enforcer mengosongkan semua list
  // ketika Phase 1 extraction gagal total (MAX_TOKENS, parse error, dll).
  if (!parsedData || typeof parsedData !== 'object') {
    console.warn('[SCHEMA-ENFORCER] parsedData kosong atau bukan object — melewati enforcement.');
    parsedData = {};
  }

  const result = {};

  // HELPER: Membuang instruksi dari nama key.
  const extractKey = (rawKey) => {
    if (typeof rawKey !== 'string') return rawKey;
    return rawKey.split(' ')[0].trim();
  };

  // 1. Enforce Root Meta (Wajib ada di kontrak API)
  result.doc_code = schema.doc_code || parsedData?.doc_code || null;
  result.doc_name = schema.doc_name || parsedData?.doc_name || null;
  result.confidence_score = parsedData?.confidence_score || 0;

  // 2. Enforce Root Fields
  if (Array.isArray(schema.fields)) {
    schema.fields.forEach((rawKey) => {
      const key = extractKey(rawKey);
      result[key] = parsedData?.[key] !== undefined ? parsedData[key] : null;
    });
  }

  // 3. Enforce Root Items (Tabel Utama)
  if (Array.isArray(schema.items)) {
    if (!Array.isArray(parsedData?.items)) {
      result.items = [];
    } else {
      result.items = parsedData.items.map((item) => {
        const safeItem = {};
        schema.items.forEach((rawKey) => {
          const key = extractKey(rawKey);
          safeItem[key] = item[key] !== undefined ? item[key] : null;
        });
        return safeItem;
      });
    }
  }

  // 4. Enforce Custom Wrappers & Nested Lists
  Object.keys(schema).forEach((schemaKey) => {
    // Lewati yang sudah diproses di atas
    if (['doc_code', 'doc_name', 'confidence_score', 'fields', 'items'].includes(schemaKey)) return;

    const schemaVal = schema[schemaKey];

    // Deteksi format "Array of Objects" murni (tanpa fields/items internal)
    if (Array.isArray(schemaVal)) {
      if (!Array.isArray(parsedData?.[schemaKey])) {
        result[schemaKey] = [];
      } else if (schemaVal.length > 0 && typeof schemaVal[0] === 'object') {
        result[schemaKey] = parsedData[schemaKey].map((obj) => {
          const safeObj = {};
          Object.keys(schemaVal[0]).forEach((rawKey) => {
            const key = extractKey(rawKey);
            safeObj[key] = obj[key] !== undefined ? obj[key] : null;
          });
          return safeObj;
        });
      } else {
        result[schemaKey] = parsedData[schemaKey];
      }
      return;
    }

    // Deteksi Custom Wrapper dinamis (Contoh: "pl_list", "invoice_list")
    const isCustomWrapper = schemaVal && typeof schemaVal === 'object' && !Array.isArray(schemaVal) && (schemaVal.fields || schemaVal.items);

    if (isCustomWrapper) {
      const rawList = parsedData?.[schemaKey];

      // Guard: jika data bukan array, kembalikan array kosong.
      // Ini bisa terjadi jika AI mengembalikan object bukan array,
      // atau Phase 1 gagal sehingga field tidak ada di parsedData.
      // Catatan: array kosong [] tetap valid dan tidak akan diisi ulang —
      // items dari Phase 2 sudah di-route via routeItemToList di pdf.js
      // sebelum enforcer ini dipanggil.
      if (!Array.isArray(rawList)) {
        result[schemaKey] = [];
        if (rawList !== undefined && rawList !== null) {
          // Ada data tapi formatnya salah — log untuk investigasi
          console.warn(`[SCHEMA-ENFORCER] "${schemaKey}" bukan array (${typeof rawList}), direset ke [].`);
        }
        return;
      }

      result[schemaKey] = rawList.map((wrapperObj) => {
        const safeWrapper = {};

        // Guard per entry: pastikan wrapperObj adalah object
        if (!wrapperObj || typeof wrapperObj !== 'object') return safeWrapper;

        // Enforce fields di dalam wrapper
        if (Array.isArray(schemaVal.fields)) {
          schemaVal.fields.forEach((rawKey) => {
            const key = extractKey(rawKey);
            safeWrapper[key] = wrapperObj[key] !== undefined ? wrapperObj[key] : null;
          });
        }

        // Enforce items di dalam wrapper
        if (Array.isArray(schemaVal.items)) {
          if (!Array.isArray(wrapperObj.items)) {
            safeWrapper.items = [];
          } else {
            safeWrapper.items = wrapperObj.items.map((subItem) => {
              const safeSubItem = {};
              // Guard per sub-item
              if (!subItem || typeof subItem !== 'object') return safeSubItem;
              schemaVal.items.forEach((rawKey) => {
                const key = extractKey(rawKey);
                safeSubItem[key] = subItem[key] !== undefined ? subItem[key] : null;
              });
              return safeSubItem;
            });
          }
        }

        return safeWrapper;
      });
    }
  });

  return result;
};