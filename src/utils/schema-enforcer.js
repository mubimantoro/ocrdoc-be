

/**
 * Universal Schema Strictness Enforcer (O(N) Time Complexity)
 * Menjamin API Contract Client terpenuhi dengan memaksa key yang hilang menjadi null,
 * ATAU menjadi array kosong [] untuk tipe data tabel/list (Sesuai arahan PM).
 */
export const enforceSchemaStrictness = (parsedData, schema) => {
  const result = parsedData ? { ...parsedData } : {};

  // HELPER: Membuang instruksi dari nama key.
  const extractKey = (rawKey) => {
    if (typeof rawKey !== 'string') return rawKey;
    return rawKey.split(' ')[0].trim();
  };

  // 1. Enforce Root Meta
  ['doc_code', 'doc_name', 'confidence_score'].forEach((key) => {
    if (result[key] === undefined) result[key] = null;
  });

  // 2. Enforce Root Fields
  if (Array.isArray(schema.fields)) {
    schema.fields.forEach((rawKey) => {
      const key = extractKey(rawKey);
      if (result[key] === undefined) result[key] = null;
    });
  }

  // 3. Enforce Root Items (Untuk schema seperti COO, ECOO, CIPL)
  if (Array.isArray(schema.items)) {
    if (result.items === undefined || result.items === null) {
      result.items = []; // 🚀 PM REQUEST: Jadikan array kosong
    } else if (Array.isArray(result.items)) {
      result.items = result.items.map((item) => {
        const safeItem = { ...item };
        schema.items.forEach((rawKey) => {
          const key = extractKey(rawKey);
          if (safeItem[key] === undefined) safeItem[key] = null;
        });
        return safeItem;
      });
    }
  }

  // 4. Enforce Custom Wrappers & Array of Objects
  Object.keys(schema).forEach((schemaKey) => {
    const schemaVal = schema[schemaKey];

    // Deteksi format "Array of Objects" murni (Contoh: "details_list", "banks")
    if (Array.isArray(schemaVal) && schemaKey !== 'fields' && schemaKey !== 'items') {
      if (result[schemaKey] === undefined || result[schemaKey] === null) {
        // 🚀 PM REQUEST: Jadikan array kosong [] jika data tidak ada di AI
        result[schemaKey] = [];
      } else if (Array.isArray(result[schemaKey]) && schemaVal.length > 0 && typeof schemaVal[0] === 'object') {
        result[schemaKey] = result[schemaKey].map((obj) => {
          const safeObj = { ...obj };
          Object.keys(schemaVal[0]).forEach((rawKey) => {
            const key = extractKey(rawKey);
            if (safeObj[key] === undefined) safeObj[key] = null;
          });
          return safeObj;
        });
      }
      return;
    }

    // Deteksi Custom Wrapper dinamis (Contoh: "invoice_list")
    const isCustomWrapper = schemaVal && typeof schemaVal === 'object' && !Array.isArray(schemaVal) && (schemaVal.fields || schemaVal.items);

    if (isCustomWrapper) {
      if (result[schemaKey] === undefined || result[schemaKey] === null) {
        result[schemaKey] = []; // 🚀 PM REQUEST: Wrapper yang hilang jadi array kosong
      } else if (Array.isArray(result[schemaKey])) {
        result[schemaKey] = result[schemaKey].map((wrapperObj) => {
          const safeWrapper = { ...wrapperObj };

          // Enforce fields di dalam wrapper
          if (Array.isArray(schemaVal.fields)) {
            schemaVal.fields.forEach((rawKey) => {
              const key = extractKey(rawKey);
              if (safeWrapper[key] === undefined) safeWrapper[key] = null;
            });
          }

          // Enforce items di dalam wrapper
          if (Array.isArray(schemaVal.items)) {
            if (safeWrapper.items === undefined || safeWrapper.items === null) {
              safeWrapper.items = []; // 🚀 PM REQUEST: Items di dalam wrapper jadi array kosong
            } else if (Array.isArray(safeWrapper.items)) {
              safeWrapper.items = safeWrapper.items.map((subItem) => {
                const safeSubItem = { ...subItem };
                schemaVal.items.forEach((rawKey) => {
                  const key = extractKey(rawKey);
                  if (safeSubItem[key] === undefined) safeSubItem[key] = null;
                });
                return safeSubItem;
              });
            }
          }

          return safeWrapper;
        });
      }
    }
  });

  return result;
};