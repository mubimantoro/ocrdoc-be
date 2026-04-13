/* eslint-disable camelcase */
import { readFile, unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ai, { FLAGSHIP_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';
import { calculatePrice } from '../../utils/token-pricing.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── Config concurrency ─────────────────────────────────────────────────────
const CONCURRENCY    = parseInt(process.env.AI_PAGE_CONCURRENCY);
const BATCH_DELAY_MS = parseInt(process.env.AI_BATCH_DELAY_MS);

// ── Load schema ────────────────────────────────────────────────────────────
const loadSchema = async (schemaPath) => {
  const fullPath = path.join(PROJECT_ROOT, schemaPath);
  try {
    const content = await readFile(fullPath, 'utf-8');
    const raw = JSON.parse(content);

    const topFields  = raw.fields ?? [];
    const listKeys = ['invoice_list', 'pl_list', 'details_list'];
    const subListFields = listKeys.flatMap((key) => raw[key]?.fields ?? []);
    const allFields = [...new Set([...topFields, ...subListFields])];

    const itemSources = [
      ...(raw.invoice_list?.items ?? []),
      ...(raw.pl_list?.items ?? []),
      ...(raw.details_list?.items ?? []),
      ...(raw.items ?? []),
      ...(raw.packs ?? []),
      ...(raw.packaging ?? []),
      ...(raw.containers ?? []),
      ...(raw.banks ?? []),
    ];
    const allItems = [...new Set(itemSources)];

    return { fields: allFields, items: allItems };
  } catch (err) {
    console.error(`[Phase2] loadSchema FAILED — fullPath: "${fullPath}": ${err.message}`);
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
    ? schema.fields.map((f) => `- ${f}`).join('\n')
    : '(extract all relevant header fields)';

  const itemsDesc = schema.items?.length
    ? schema.items.map((i) => `- ${i}`).join('\n')
    : '(extract all table rows as dynamic objects)';

  const contextNote = headerContext
    ? `\nDOCUMENT HEADER CONTEXT (page 1 reference — do NOT re-extract, use only as reference):\n${headerContext}\n`
    : '';

  const prompt = `You are a precise data extraction specialist for freight forwarding documents.
Document type: ${docCode} | Page: ${pageNum}/${totalPages}
${contextNote}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT OUTPUT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Output MUST be 1 valid minified JSON object. No markdown, no explanation, no comments.
- ALL schema keys MUST exist. If not found: null (or [] for lists).
- Do NOT guess or infer. If uncertain: null.
- Dates only if explicitly written: "YYYY-MM-DD", otherwise null.
- Numbers: number type, no thousand separators, decimal with dot. If uncertain: null.
- Strings: keep as-is (replace line breaks with 1 space, do not add punctuation).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-DRIFT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Extract ONLY data explicitly visible on THIS page — do not invent data.
- If this is NOT page 1: header fields (seller, buyer, etc) are likely null — focus on table items only.
- Do NOT copy data from header context into fields or items.
- item number (row number) MUST be the exact string printed — never auto-generate a sequence.
- Do NOT mix address tokens into name field or vice versa.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HEADER FIELDS TO EXTRACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${fieldsDesc}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TABLE/LINE ITEM COLUMNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${itemsDesc}
Note: vendor-specific columns are allowed as additional fields.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ITEMS OUTPUT FORMAT (columnar — token efficient)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return items in columnar format — more efficient than array of objects:
{
  "columns": ${JSON.stringify(schema.items ?? [])},
  "rows": []
}
- Each row MUST be an array with length = columns.length
- Use null for missing values — do NOT skip cells
- If no items on this page: rows = []

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE FORMAT — Return ONLY valid minified JSON:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{"fields":[{"key":"field_name","value":"..."}],"items":{"columns":${JSON.stringify(schema.items ?? [])},"rows":[]}}`;

  const response = await ai.models.generateContent({
    model: FLAGSHIP_MODEL,
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
      ],
    }],
    config: {
      maxOutputTokens:  65536,
      responseMimeType: 'application/json',
    },
  });

  const usage = {
    prompt_tokens: response.usageMetadata?.promptTokenCount     ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: response.usageMetadata?.totalTokenCount      ?? 0,
    duration_ms: Date.now() - startTime,
  };

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);

    // Expand columnar items → array of {columns:[{key,value}]}
    const expandRows = (itemsData) => {
      if (!itemsData || !Array.isArray(itemsData.columns) || !Array.isArray(itemsData.rows)) return [];
      const { columns, rows } = itemsData;
      return rows.map((row) => ({
        columns: columns.map((col, i) => ({
          key:   col,
          value: (Array.isArray(row) ? row[i] : null) ?? null,
        })),
      }));
    };

    return {
      pageNum,
      fields: Array.isArray(parsed.fields) ? parsed.fields : [],
      items:  expandRows(parsed.items),
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

    // Delay antar batch — kurangi/hapus saat upgrade tier
    if (i + concurrency < tasks.length) {
      console.info(`[Phase2] Waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
};

// ── Merge hasil dari semua halaman ─────────────────────────────────────────
const mergePageResults = (pageResults) => {
  const sorted      = [...pageResults].sort((a, b) => a.pageNum - b.pageNum);
  const mergedFields = [];
  const seenKeys    = new Set();

  // Fields: ambil nilai pertama yang tidak null per key (prioritas halaman awal)
  for (const page of sorted) {
    for (const field of page.fields) {
      if (!seenKeys.has(field.key) && field.value !== null) {
        mergedFields.push(field);
        seenKeys.add(field.key);
      }
    }
  }

  // Items: gabung semua rows, re-index row_index
  let rowIndex      = 1;
  const mergedItems = [];
  for (const page of sorted) {
    for (const item of page.items) {
      mergedItems.push({ ...item, row_index: rowIndex++ });
    }
  }

  // Akumulasi total token usage
  const usage = pageResults.reduce((acc, page) => ({
    prompt_tokens: acc.prompt_tokens + (page.usage?.prompt_tokens ?? 0),
    output_tokens: acc.output_tokens + (page.usage?.output_tokens ?? 0),
    total_tokens:  acc.total_tokens  + (page.usage?.total_tokens  ?? 0),
    duration_ms:   acc.duration_ms   + (page.usage?.duration_ms   ?? 0),
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

  // ── 1 halaman: langsung extract tanpa split ──────────────────────────
  if (totalPages === 1) {
    const result = await extractSinglePage({
      pageFilePath:  docFilePath,
      pageNum:       1,
      totalPages:    1,
      schema,
      docCode,
      headerContext: null,
    });

    const { fields, items, usage } = mergePageResults([result]);
    const pricing = calculatePrice(FLAGSHIP_MODEL, usage.prompt_tokens, usage.output_tokens);
    const wallClockMs = Date.now() - wallStart;

    console.info(
      `[Phase2] Done — ${fields.length} fields, ${items.length} items | ` +
      `tokens: ${usage.total_tokens} (in=${usage.prompt_tokens} out=${usage.output_tokens}) | ` +
      `price: $${pricing.total_price} | ${wallClockMs}ms`
    );

    return {
      fields,
      items,
      usage:   { ...usage, total_pages: totalPages, wall_clock_ms: wallClockMs },
      pricing,
    };
  }

  // ── Multi halaman: split → paralel ──────────────────────────────────
  const pageFiles = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageFilePath = await splitPdf(docFilePath, pageNum, pageNum, uploadDir);
    pageFiles.push({ pageNum, pageFilePath });
  }

  try {
    // Ekstrak halaman 1 dulu untuk dapat header context
    console.info('[Phase2] Extracting page 1 for header context...');
    const firstResult = await extractSinglePage({
      pageFilePath:  pageFiles[0].pageFilePath,
      pageNum:       1,
      totalPages,
      schema,
      docCode,
      headerContext: null,
    });

    // Ringkasan fields hal 1 sebagai context untuk halaman berikutnya
    const headerContext = firstResult.fields
      .filter((f) => f.value !== null)
      .map((f) => `${f.key}: ${f.value}`)
      .slice(0, 10)
      .join('\n');

    // Buat tasks untuk sisa halaman
    const remainingTasks = pageFiles.slice(1).map(({ pageNum, pageFilePath }) => () =>
      extractSinglePage({ pageFilePath, pageNum, totalPages, schema, docCode, headerContext })
    );

    // Jalankan paralel dengan concurrency limit
    const remainingResults = await runWithConcurrency(remainingTasks, CONCURRENCY);

    const { fields, items, usage } = mergePageResults([firstResult, ...remainingResults]);
    const pricing     = calculatePrice(FLAGSHIP_MODEL, usage.prompt_tokens, usage.output_tokens);
    const wallClockMs = Date.now() - wallStart;

    console.info(
      `[Phase2] Done — ${fields.length} fields, ${items.length} items | ` +
      `pages: ${totalPages} | ` +
      `tokens: ${usage.total_tokens} (in=${usage.prompt_tokens} out=${usage.output_tokens}) | ` +
      `price: $${pricing.total_price} | ${wallClockMs}ms`
    );

    return {
      fields,
      items,
      usage:   { ...usage, total_pages: totalPages, wall_clock_ms: wallClockMs },
      pricing,
    };

  } finally {
    // Cleanup temp page files — selalu jalan meski ada error
    await Promise.all(
      pageFiles.map(({ pageFilePath: pf }) => unlink(pf).catch(() => {}))
    );
  }
};

export default extractDocument;