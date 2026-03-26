import path from 'path';
import { readFile } from 'fs/promises';
import ai, { SMART_MODEL } from '../../config/gemini.js';

/**
 * Load schema dari file JSON berdasarkan schema_path
 */
const loadSchema = async (schemaPath) => {
  try {
    const fullPath  = path.resolve(schemaPath);
    const content   = await readFile(fullPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Fallback ke schema generik
    return {
      fields: ['document_number', 'document_date', 'issuer', 'recipient', 'total_amount'],
      items:  ['no', 'description', 'quantity', 'unit', 'amount'],
    };
  }
};

/**
 * Fase 2 — Smart AI: ekstrak fields & items dari PDF dokumen
 * @param {string} docFilePath  - path PDF hasil split (1 dokumen)
 * @param {string} schemaPath   - path ke file JSON schema
 * @param {string} docCode      - kode tipe dokumen
 * @returns {Promise<{ fields: Array<{key,value}>, items: Array<{rowIndex, columns: {key,value}[]}> }>}
 */
const extractDocument = async (docFilePath, schemaPath, docCode) => {
  console.info(`[Phase2] Extracting: ${docFilePath} (type: ${docCode})`);

  const schema = await loadSchema(schemaPath);
  const pdfBuffer = await readFile(docFilePath);
  const base64Pdf = pdfBuffer.toString('base64');

  const fieldsDesc = schema.fields?.length
    ? `Header fields to extract:\n${schema.fields.map((f) => `- ${f}`).join('\n')}`
    : 'Extract all relevant header fields.';

  const itemsDesc = schema.items?.length
    ? `Table/line item columns:\n${schema.items.map((i) => `- ${i}`).join('\n')}\nNote: vendor-specific columns are allowed as additional fields.`
    : 'Extract all table rows as dynamic objects.';

  const prompt = `You are a precise data extraction specialist for freight forwarding documents.
Document type: ${docCode}

${fieldsDesc}

${itemsDesc}

Extraction rules:
- Extract ALL data visible in the document
- Use null for fields not found in the document
- For items/table rows, extract EVERY row without skipping
- Keep original values exactly as shown (do not convert or calculate)
- For vehicle documents: include VIN, motor number, color per unit

Return ONLY valid JSON in this exact format:
{
  "fields": [
    { "key": "invoice_number", "value": "INV-2024-001" },
    { "key": "invoice_date",   "value": "2024-01-15" }
  ],
  "items": [
    {
      "row_index": 1,
      "columns": [
        { "key": "description", "value": "Spare Part A" },
        { "key": "quantity",    "value": "10" },
        { "key": "unit_price",  "value": "250000" }
      ]
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model: SMART_MODEL,
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
      ],
    }],
  });

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    const items  = Array.isArray(parsed.items)  ? parsed.items  : [];

    console.info(`[Phase2] Extracted ${fields.length} fields, ${items.length} items`);
    return { fields, items };
  } catch (e) {
    console.error(`[Phase2] Parse failed: ${e.message}`);
    return {
      fields:     [{ key: '_raw', value: rawText }],
      items:      [],
      parseError: true,
    };
  }
};

export default extractDocument;
