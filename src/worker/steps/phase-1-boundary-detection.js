
/* eslint-disable camelcase */
import { readFile } from 'fs/promises';
import path from 'path';
import ai, { CHEAP_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';


const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '50');

const DOC_TYPES = {
  '380':'Invoice', '217':'Packing List', '001':'CIPL',
  '705':'Bill of Lading', '740':'Air Way Bill', '860':'ECOO',
  '861':'COO', '704':'Master Bill of Lading', '741':'Master AWB',
  '958':'Lartas', '457':'SKB PPh', '800':'POSTEL', '813':'CK',
  '846':'SKEM', '854':'BPOM', '871':'AKL', '888':'Pengecualian Perijinan',
  '957':'SNI', '959':'PI', '999':'Lainnya', '000':'Cukai',
};

const TYPE_LIST = Object.entries(DOC_TYPES)
  .map(([code, name]) => `${code}: ${name}`).join('\n');

// ── Detect boundaries untuk satu chunk PDF ────────────────────────────────
const detectChunk = async (chunkPath, chunkStartPage) => {
  const pdfBuffer = await readFile(chunkPath);
  const base64Pdf = pdfBuffer.toString('base64');

  const prompt = `You are analyzing a PDF document for a freight forwarding company.
This PDF may contain multiple separate logical documents combined into one file.

Your task:
1. Identify each separate logical document in this PDF
2. Determine the page range for each document
3. Identify the document type using the codes below
4. Identify the vendor/company name if visible
5. Extract the invoice/document number if visible
6. Provide a confidence score (0.0 - 1.0) for each detection

Available document type codes:
${TYPE_LIST}

Rules:
- Pages are 1-based and relative to THIS chunk only
- A document starts when you see a new document header or title
- Different vendors = different document instances even if same type
- IMPORTANT: Pages with the SAME vendor AND the SAME invoice/document number MUST be grouped as ONE document
- Do NOT create separate entries for continuation pages of the same invoice/document
- Continuation pages usually have: no new invoice number, continued table rows, same header info
- Confidence < ${CONFIDENCE_THRESHOLD} means uncertain boundary

Return ONLY valid JSON, no explanation:
{
  "documents": [
    {
      "doc_code": "380",
      "vendor": "PT. ABC SUPPLIER",
      "invoice_number": "INV-2024-001",
      "start_page": 1,
      "end_page": 5,
      "confidence": 0.95
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model: CHEAP_MODEL,
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
      ],
    }],
    config: { maxOutputTokens: 65536 },
  });

  const usage = {
    prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens:  response.usageMetadata?.totalTokenCount ?? 0,
  };

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed    = JSON.parse(rawText);
    const documents = parsed.documents || [];

    // Offset page numbers sesuai posisi chunk dalam PDF asli
    return {
      documents: documents.map((doc) => ({
        ...doc,
        invoice_number: doc.invoice_number ?? null,
        start_page: doc.start_page + chunkStartPage - 1,
        end_page: doc.end_page + chunkStartPage - 1,
        needs_review: doc.confidence < CONFIDENCE_THRESHOLD,
      })),
      usage,
    };
  } catch (e) {
    console.error(`[Phase1] Chunk parse failed (offset ${chunkStartPage}): ${e.message}`);
    // Fallback: tandai seluruh chunk sebagai satu dokumen unknown
    return {
      documents: [{
        doc_code: '999',
        vendor: null,
        invoice_number: null,
        start_page: chunkStartPage,
        end_page: chunkStartPage + CHUNK_SIZE - 1,
        confidence: 0,
        needs_review: true,
      }],
      usage,
    };

  }
};

// ── Main export ────────────────────────────────────────────────────────────
const detectBoundaries = async (filePath) => {
  console.info(`[Phase1] Detecting boundaries: ${filePath}`);

  const pdfBuffer  = await readFile(filePath);
  const sizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(2);
  const totalPages = await getPdfPageCount(filePath);

  console.info(`[Phase1] File size: ${sizeMB}MB — ${totalPages} pages — chunk size: ${CHUNK_SIZE}`);

  const uploadDir = path.dirname(filePath);
  const allDocs   = [];
  const chunks    = [];

  // ── Buat chunk PDF ───────────────────────────────────────────────────────
  for (let start = 1; start <= totalPages; start += CHUNK_SIZE) {
    const end       = Math.min(start + CHUNK_SIZE - 1, totalPages);
    const chunkPath = await splitPdf(filePath, start, end, uploadDir);
    chunks.push({ chunkPath, start, end });
  }

  console.info(`[Phase1] Processing ${chunks.length} chunk(s)...`);

  const totalUsage = { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 };

  try {
    // ── Proses setiap chunk secara parraler ────────────────────────────
    const chunkResults = await Promise.all(
      chunks.map(async ({ chunkPath, start, end }) => {
        console.info(`[Phase1] Chunk pages ${start}-${end}...`);
        const chunkStart = Date.now();
        const { documents, usage } = await detectChunk(chunkPath, start);
        console.info(`[Phase1] Chunk ${start}-${end}: found ${documents.length} doc(s) — ${Date.now() - chunkStart}ms`);
        return { documents, usage };
      })
    );

    for (const { documents, usage } of chunkResults) {
      allDocs.push(...documents);
      totalUsage.prompt_tokens += usage.prompt_tokens;
      totalUsage.output_tokens += usage.output_tokens;
      totalUsage.total_tokens  += usage.total_tokens;
    }
  } finally {
    // Cleanup semua chunk files
    await Promise.all(
      chunks.map(({ chunkPath }) =>
        import('fs/promises').then(({ unlink }) => unlink(chunkPath).catch(() => {}))
      )
    );
  }

  // ── Grouping cross-chunk: merge dokumen dengan vendor+invoice sama ──────
  const groupMap = new Map();

  for (const doc of allDocs) {
    const key = doc.invoice_number
      ? `${doc.doc_code}|${doc.vendor ?? ''}|${doc.invoice_number}`
      : `${doc.doc_code}|${doc.vendor ?? ''}|page_${doc.start_page}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, { ...doc });
    } else {
      const existing    = groupMap.get(key);
      existing.start_page = Math.min(existing.start_page, doc.start_page);
      existing.end_page   = Math.max(existing.end_page,   doc.end_page);
      existing.confidence = Math.min(existing.confidence, doc.confidence);
    }
  }

  const result = [...groupMap.values()].sort((a, b) => a.start_page - b.start_page);

  console.info(`[Phase1] Total: ${allDocs.length} raw → ${result.length} grouped`);
  result.forEach((d, i) =>
    console.info(`  [${i+1}] code=${d.doc_code} invoice=${d.invoice_number} pages=${d.start_page}-${d.end_page} confidence=${d.confidence} review=${d.needs_review}`)
  );

  return { boundaries: result, usage: totalUsage };
};

export default detectBoundaries;