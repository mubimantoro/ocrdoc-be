
/* eslint-disable camelcase */
import { readFile } from 'fs/promises';
import path from 'path';
import ai, { CHEAP_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';


const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP);

const DOC_TYPES = {
  '380':'Invoice', '217':'Packing List', '001':'CIPL',
  '705':'Bill of Lading', '706':'Sea Waybill', '740':'Air Way Bill', '860':'ECOO',
  '861':'COO', '704':'Master Bill of Lading', '741':'Master AWB',
  '958':'Lartas', '457':'SKB PPh', '800':'POSTEL', '813':'CK',
  '846':'SKEM', '854':'BPOM', '871':'AKL', '888':'Pengecualian Perijinan',
  '957':'SNI', '959':'PI', '999':'Lainnya', '000':'Cukai',
};

const TYPE_LIST = Object.entries(DOC_TYPES)
  .map(([code, name]) => `${code}: ${name}`).join('\n');

// ── Detect boundaries untuk satu chunk PDF ────────────────────────────────
const detectChunk = async (chunkPath, physicalStart) => {
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
- If you can see ANY content on the page, you MUST return at least one document entry
- If document type is uncertain, use code 999
- NEVER return empty documents array if pages contain visible content

PAGE RANGE INTEGRITY RULES (CRITICAL):
- Each page can only belong to ONE document — page ranges must NEVER overlap
- CRITICAL ANTI-DRIFT: You MUST account for EVERY SINGLE PAGE in this chunk. Do not skip any pages visually. Count the pages sequentially.
- If a document spans pages 2 to 4, and the next starts at 5, explicitly list them. Do not jump page numbers arbitrarily.
- Example INVALID: doc A pages 1-5, doc B pages 4-7 (pages 4-5 overlap)
- Example VALID:  doc A pages 1-5, doc B pages 6-9 (no overlap)
- If a new document header appears mid-page, assign the new document starting from the NEXT page
- If you are uncertain where a document ends, extend it until the next clear document header
- NEVER assign the same start_page to two different documents

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
    config: { maxOutputTokens: 65536, responseMimeType: 'application/json' },
  });

  const usage = {
    prompt_tokens: response.usageMetadata?.promptTokenCount     ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens:  response.usageMetadata?.totalTokenCount      ?? 0,
  };

  const jsonMatch = response.text.match(/\{[\s\S]*\}/);
  const rawText   = jsonMatch ? jsonMatch[0].trim() : '{}';

  try {
    const parsed    = JSON.parse(rawText);
    const documents = parsed.documents || [];

    if (documents.length === 0) {
      console.warn(`[Phase1] Chunk offset ${physicalStart}: 0 docs detected — fallback to needs_review`);
      return {
        documents: [{
          doc_code:'999',
          vendor: null,
          invoice_number: null,
          start_page: physicalStart,
          end_page: physicalStart + CHUNK_SIZE - 1,
          confidence: 0,
          needs_review:   true,
        }],
        usage,
      };
    }

    return {
      documents: documents.map((doc) => ({
        ...doc,
        invoice_number: doc.invoice_number ?? null,
        start_page:     doc.start_page + physicalStart - 1,
        end_page:       doc.end_page   + physicalStart - 1,
        needs_review:   doc.confidence < CONFIDENCE_THRESHOLD,
      })),
      usage,
    };
  } catch (e) {
    console.error(`[Phase1] Chunk parse failed (offset ${physicalStart}): ${e.message}`);
    return {
      documents: [{
        doc_code:       '999',
        vendor:         null,
        invoice_number: null,
        start_page:     physicalStart,
        end_page:       physicalStart + CHUNK_SIZE - 1,
        confidence:     0,
        needs_review:   true,
      }],
      usage,
    };
  }
};

// ── Resolve overlapping boundaries setelah grouping ───────────────────────
const resolveOverlaps = (sorted) => {
  const result = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = { ...sorted[i] };

    if (result.length === 0) {
      result.push(current);
      continue;
    }

    const prev = result[result.length - 1];

    // Jika terjadi overlap halaman
    if (current.start_page <= prev.end_page) {
      // Kasus 1: Fully contained (Duplikat identik di invoice yang sama)
      if (current.end_page <= prev.end_page && current.invoice_number === prev.invoice_number) {
        console.warn(`[Phase1] Skip fully contained duplicate: invoice=${current.invoice_number}`);
        continue;
      }

      // Kasus 2: Partial overlap akibat Index Drift AI
      // JANGAN memotong start_page! Memotong halaman secara buta akan menghilangkan data items.
      // Biarkan halamannya overlap (splitPdf akan mengekstrak halaman yang sama untuk 2 dokumen berbeda),
      // TAPI kita paksa sistem untuk melemparnya ke Manual Review agar diverifikasi manusia.
      console.warn(
        `[Phase1] OVERLAP DRIFT DETECTED: prev(${prev.invoice_number} p.${prev.start_page}-${prev.end_page}) ` +
        `vs current(${current.invoice_number} p.${current.start_page}-${current.end_page}). Flagging both for review.`
      );

      current.needs_review = true;

      prev.needs_review = true;
    }

    result.push(current);
  }

  return result;
};

// ── Main export ────────────────────────────────────────────────────────────
const detectBoundaries = async (filePath) => {
  console.info(`[Phase1] Detecting boundaries: ${filePath}`);

  const pdfBuffer  = await readFile(filePath);
  const sizeMB     = (pdfBuffer.length / 1024 / 1024).toFixed(2);
  const totalPages = await getPdfPageCount(filePath);

  console.info(
    `[Phase1] File size: ${sizeMB}MB — ${totalPages} pages — ` +
    `chunk size: ${CHUNK_SIZE} overlap: ${CHUNK_OVERLAP}`
  );

  const uploadDir = path.dirname(filePath);
  const allDocs   = [];
  const chunks    = [];

  // ── Buat chunk PDF dengan overlap ────────────────────────────────────────
  for (let logicalStart = 1; logicalStart <= totalPages; logicalStart += CHUNK_SIZE) {
    const end           = Math.min(logicalStart + CHUNK_SIZE - 1, totalPages);
    const physicalStart = logicalStart === 1 ? 1 : Math.max(1, logicalStart - CHUNK_OVERLAP);
    const chunkPath     = await splitPdf(filePath, physicalStart, end, uploadDir);
    chunks.push({ chunkPath, physicalStart, logicalStart, end });
  }

  console.info(`[Phase1] Processing ${chunks.length} chunk(s)...`);

  const totalUsage = { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 };

  try {
    // ── Proses semua chunk secara parallel ───────────────────────────────
    const chunkResults = await Promise.all(
      chunks.map(async ({ chunkPath, physicalStart, logicalStart, end }) => {
        console.info(
          `[Phase1] Chunk pages ${logicalStart}-${end} (physical: ${physicalStart}-${end})...`
        );
        const chunkStart = Date.now();
        const { documents, usage } = await detectChunk(chunkPath, physicalStart);

        console.info(
          `[Phase1] Chunk ${logicalStart}-${end}: found ${documents.length} doc(s) — ` +
      `${Date.now() - chunkStart}ms`
        );
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
    await Promise.all(
      chunks.map(({ chunkPath }) =>
        import('fs/promises').then(({ unlink }) => unlink(chunkPath).catch(() => {}))
      )
    );
  }

  const groupMap = new Map();

  for (const doc of allDocs) {
    const key = doc.invoice_number
      ? `${doc.doc_code}|${doc.vendor ?? ''}|${doc.invoice_number}`
      : `${doc.doc_code}|${doc.vendor ?? ''}|page_${doc.start_page}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, { ...doc });
    } else {
      const existing = groupMap.get(key);
      const gap      = doc.start_page - existing.end_page;

      if (gap <= 1) {
        existing.start_page = Math.min(existing.start_page, doc.start_page);
        existing.end_page   = Math.max(existing.end_page,   doc.end_page);
        existing.confidence = Math.min(existing.confidence, doc.confidence);
      } else {
        // Gap terlalu jauh — invoice sama tapi dokumen berbeda
        const uniqueKey = `${key}|page_${doc.start_page}`;
        groupMap.set(uniqueKey, { ...doc });
        console.warn(
          `[Phase1] Duplicate invoice ${doc.invoice_number} with page gap ${gap} — treated as separate doc`
        );
      }
    }
  }

  // ── Sort → resolve overlaps → final result ───────────────────────────────
  const sorted = [...groupMap.values()].sort((a, b) => a.start_page - b.start_page);
  const result = resolveOverlaps(sorted);

  console.info(
    `[Phase1] Total: ${allDocs.length} raw → ${sorted.length} grouped → ${result.length} after overlap resolve`
  );
  result.forEach((d, i) =>
    console.info(
      `  [${i + 1}] code=${d.doc_code} invoice=${d.invoice_number} ` +
      `pages=${d.start_page}-${d.end_page} confidence=${d.confidence} review=${d.needs_review}`
    )
  );

  return { boundaries: result, usage: totalUsage };
};

export default detectBoundaries;