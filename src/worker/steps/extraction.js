import path from 'path';
import { readFile } from 'fs/promises';
import pdfParser from 'pdf-parser';
import getProvider from '../../config/ai-provider';

const loadSchema = async (schemaPath) => {
  try {
    const content = await readFile(path.resolve(schemaPath), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      fields: ['document_number', 'document_date', 'issuer', 'recipient', 'total_amount'],
      items:  ['no', 'description', 'quantity', 'unit', 'amount'],
    };
  }
};

const buildPrompt = (docCode, fieldsDesc, itemsDesc, text) => `
You are extracting data from a logistics document (type: ${docCode}).
${fieldsDesc}
${itemsDesc}
${text ? `Document text:\n${text}` : 'Extract from the attached document.'}
Rules: Return ONLY valid JSON, null for missing fields, extract ALL rows.
{
  "fields": [{ "key": "invoice_number", "value": "INV-001" }],
  "items": [{ "row_index": 1, "columns": [{ "key": "description", "value": "..." }] }]
}`.trim();

const extractDocument = async (docFilePath, schemaPath, docCode) => {
  console.info(`[Phase2] Extracting: ${docFilePath} (type: ${docCode})`);

  const schema     = await loadSchema(schemaPath);
  const fieldsDesc = schema.fields?.length
    ? `Header fields:\n${schema.fields.map((f) => `- ${f}`).join('\n')}`
    : 'Extract all relevant header fields.';
  const itemsDesc  = schema.items?.length
    ? `Table columns:\n${schema.items.map((i) => `- ${i}`).join('\n')}`
    : 'Extract all table rows.';

  const pdfBuffer = await readFile(docFilePath);

  let extractedText = '';
  try {
    const pdfData = await pdfParser(pdfBuffer);
    extractedText = pdfData.text?.trim() || '';
  } catch { extractedText = ''; }

  const isScanned = extractedText.length < 100;
  console.info(`[Phase2] PDF type: ${isScanned ? 'scanned' : 'digital'}`);

  const ai = getProvider();
  let result;

  if (isScanned) {
    // — use file
    result = await ai.generateWithFile(
      buildPrompt(docCode, fieldsDesc, itemsDesc, ''),
      docFilePath,
      'application/pdf',
      { model: process.env.GEMINI_SMART_MODEL || 'gemini-2.5-flash' }
    );
  } else {
    // — use text
    result = await ai.generateText(
      buildPrompt(docCode, fieldsDesc, itemsDesc, extractedText),
      { model: process.env.GEMINI_SMART_MODEL || 'gemini-2.5-flash' }
    );
  }

  const { text, usage } = result;
  console.info(`[Phase2] Token usage: ${JSON.stringify(usage)}`);

  const rawText = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    const items = Array.isArray(parsed.items)  ? parsed.items  : [];
    console.info(`[Phase2] Extracted ${fields.length} fields, ${items.length} items`);
    return { fields, items, usage };
  } catch (e) {
    console.error(`[Phase2] Parse failed: ${e.message}`);
    return {
      fields: [{ key: '_raw', value: text }],
      items: [],
      parseError: true,
      usage,
    };
  }
};

export default extractDocument;