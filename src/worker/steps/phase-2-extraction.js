/* eslint-disable camelcase */
import path from 'path';
import { readFile, unlink } from 'fs/promises';
import ai, { SMART_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';
import { calculatePrice } from '../../utils/token-pricing.js';

// ── Config concurrency
// Tier 1: 3 | Tier 2: 5 | Tier 3: 10
const CONCURRENCY = parseInt(process.env.AI_PAGE_CONCURRENCY || '3');
const BATCH_DELAY_MS = parseInt(process.env.AI_BATCH_DELAY_MS || '2000');


// ── Load schema ────────────────────────────────────────────────────────────
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

// ── Extract satu halaman ───────────────────────────────────────────────────
const extractSinglePage = async ({ pageFilePath, pageNum, totalPages, schema, docCode, headerContext }) => {
  const startTime = Date.now();
  const pdfBuffer = await readFile(pageFilePath);
  const base64Pdf = pdfBuffer.toString('base64');

  const fieldsDesc = schema.fields?.length
    ? `Header fields to extract:\n${schema.fields.map((f) => `- ${f}`).join('\n')}`
    : 'Extract all relevant header fields.';

  const itemsDesc = schema.items?.length
    ? `Table/line item columns:\n${schema.items.map((i) => `- ${i}`).join('\n')}\nNote: vendor-specific columns are allowed as additional fields.`
    : 'Extract all table rows as dynamic objects.';

  const contextNote = headerContext
    ? `\nDocument header context (from page 1):\n${headerContext}\n`
    : '';

  const prompt = `You are a precise data extraction specialist for freight forwarding documents.
Document type: ${docCode}
This is page ${pageNum} of ${totalPages}.
${contextNote}
${fieldsDesc}

${itemsDesc}

Extraction rules:
- Extract ALL data visible on THIS page only
- If this is NOT page 1, header fields (seller, buyer, etc) are likely null — focus on table items
- Use null for fields not found on this page
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
        { "key": "quantity", "value": "10" },
        { "key": "unit_price", "value": "250000" }
      ]
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model:    SMART_MODEL,
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
      ],
    }],
  });

  const usage = {
    prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens:  response.usageMetadata?.totalTokenCount ?? 0,
    duration_ms: Date.now() - startTime,
  };

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);
    return {
      pageNum,
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      items:  Array.isArray(parsed.items)  ? parsed.items  : [],
      usage,
    };
  } catch (e) {
    console.error(`[Phase2] Page ${pageNum} parse failed: ${e.message}`);
    return { pageNum, fields: [], items: [], parseError: true, usage };
  }
};


// ── Batch parallel runner ──────────────────────────────────────────────────
const runWithConcurrency = async (tasks, concurrency) => {
  const results = [];

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch      = tasks.slice(i, i + concurrency);
    const batchNum   = Math.floor(i / concurrency) + 1;
    const totalBatch = Math.ceil(tasks.length / concurrency);

    console.info(`[Phase2] Batch ${batchNum}/${totalBatch} — ${batch.length} page(s) parallel`);

    const batchResults = await Promise.all(batch.map((task) => task()));
    results.push(...batchResults);

    if (i + concurrency < tasks.length) {
      console.info(`[Phase2] Waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
};

// ── Merge hasil dari semua halaman ─────────────────────────────────────────
const mergePageResults = (pageResults) => {
  const sorted = [...pageResults].sort((a, b) => a.pageNum - b.pageNum);
  const mergedFields = [];
  const seenKeys = new Set();

  for (const page of sorted) {
    for (const field of page.fields) {
      if (!seenKeys.has(field.key) && field.value !== null) {
        mergedFields.push(field);
        seenKeys.add(field.key);
      }
    }
  }

  let rowIndex = 1;
  const mergedItems = [];
  for (const page of sorted) {
    for (const item of page.items) {
      mergedItems.push({ ...item, row_index: rowIndex++ });
    }
  }

  // ── Aggregate usage dari semua halaman ──────────────────────────────────
  const usage = pageResults.reduce((acc, page) => ({
    prompt_tokens: acc.prompt_tokens + (page.usage?.prompt_tokens ?? 0),
    output_tokens: acc.output_tokens + (page.usage?.output_tokens ?? 0),
    total_tokens:  acc.total_tokens  + (page.usage?.total_tokens ?? 0),
    duration_ms:   acc.duration_ms + (page.usage?.duration_ms ?? 0),
  }), { prompt_tokens: 0, output_tokens: 0, total_tokens: 0, duration_ms: 0 });

  return { fields: mergedFields, items: mergedItems, usage };
};

// ── Main export ────────────────────────────────────────────────────────────
const extractDocument = async (docFilePath, schemaPath, docCode) => {
  const wallStart = Date.now();
  console.info(`[Phase2] Extracting: ${docFilePath} (type: ${docCode})`);

  const schema     = await loadSchema(schemaPath);
  const uploadDir  = path.dirname(docFilePath);
  const totalPages = await getPdfPageCount(docFilePath);

  console.info(`[Phase2] ${totalPages} page(s) — concurrency: ${CONCURRENCY}`);

  // ── 1 halaman: langsung extract tanpa split ────────────────────────────
  if (totalPages === 1) {
    const result           = await extractSinglePage({
      pageFilePath:  docFilePath,
      pageNum:       1,
      totalPages:    1,
      schema,
      docCode,
      headerContext: null,
    });

    const { fields, items, usage } = mergePageResults([result]);
    const pricing                  = calculatePrice(SMART_MODEL, usage.prompt_tokens, usage.output_tokens);
    const wallClockMs              = Date.now() - wallStart;

    console.info(
      `[Phase2] Done — ${fields.length} fields, ${items.length} items | ` +
      `tokens: ${usage.total_tokens} (in=${usage.prompt_tokens} out=${usage.output_tokens}) | ` +
      `price: $${pricing.total_price} | ${wallClockMs}ms`
    );

    return {
      fields,
      items,
      usage: { ...usage, total_pages: totalPages, wall_clock_ms: wallClockMs },
      pricing,
    };
  }

  // ── Multi halaman: split → paralel ────────────────────────────────────
  const pageFiles = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageFilePath = await splitPdf(docFilePath, pageNum, pageNum, uploadDir);
    pageFiles.push({ pageNum, pageFilePath });
  }

  try {
    console.info('[Phase2] Extracting page 1 for header context...');
    const firstResult = await extractSinglePage({
      pageFilePath:  pageFiles[0].pageFilePath,
      pageNum:       1,
      totalPages,
      schema,
      docCode,
      headerContext: null,
    });

    const headerContext = firstResult.fields
      .filter((f) => f.value !== null)
      .map((f) => `${f.key}: ${f.value}`)
      .slice(0, 10)
      .join('\n');

    const remainingTasks = pageFiles.slice(1).map(({ pageNum, pageFilePath }) => () =>
      extractSinglePage({ pageFilePath, pageNum, totalPages, schema, docCode, headerContext })
    );

    const remainingResults = await runWithConcurrency(remainingTasks, CONCURRENCY);

    const { fields, items, usage } = mergePageResults([firstResult, ...remainingResults]);
    const pricing                  = calculatePrice(SMART_MODEL, usage.prompt_tokens, usage.output_tokens);
    const wallClockMs              = Date.now() - wallStart;

    console.info(
      `[Phase2] Done — ${fields.length} fields, ${items.length} items | ` +
      `pages: ${totalPages} | ` +
      `tokens: ${usage.total_tokens} (in=${usage.prompt_tokens} out=${usage.output_tokens}) | ` +
      `price: $${pricing.total_price} | ${wallClockMs}ms`
    );

    return {
      fields,
      items,
      usage: { ...usage, total_pages: totalPages, wall_clock_ms: wallClockMs },
      pricing,
    };

  } finally {
    await Promise.all(
      pageFiles.map(({ pageFilePath: pf }) => unlink(pf).catch(() => {}))
    );
  }
};

export default extractDocument;