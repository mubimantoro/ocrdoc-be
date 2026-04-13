/* eslint-disable camelcase */
import { readFile, unlink } from 'fs/promises';
import ai, { CHEAP_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';
import path from 'path';

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP);

// ── Constants ──────────────────────────────────────────────────────────────
const TYPE_LIST = `
380: Invoice — commercial invoice; ada unit price, seller/buyer name, total amount, payment terms
001: CIPL — gabungan invoice + packing list; ada line items dengan price DAN packaging dimension/weight sekaligus
217: Packing List — hanya packaging; TIDAK ADA unit price per item maupun total invoice amount
705: Bill of Lading — diterbitkan freight forwarder/NVOCC; moda LAUT; ada vessel, voyage, container, port
704: Master Bill of Lading — diterbitkan langsung shipping line (Maersk, MSC, Evergreen, COSCO, WAN HAI); moda LAUT
740: Air Way Bill (HAWB) — SALAH SATU terpenuhi: (a) header mengandung "HOUSE"/"HAB"/"HAWB", ATAU (b) diterbitkan forwarder/logistics yang bukan maskapai; moda UDARA
741: Master AWB (MAWB) — KEDUA syarat terpenuhi: (a) header "AIR WAYBILL"/"AIRWAY BILL" tanpa kata "HOUSE"/"HAB"/"HAWB", DAN (b) diterbitkan maskapai penerbangan (nama mengandung "AIR"/"AIRLINES"/"AIRWAYS", atau maskapai dikenal: Lion Air, Garuda, Singapore Airlines, Emirates, K-Mile Air, China Eastern, Korean Air, EVA Air, dll.); moda UDARA
860: ECOO — Certificate of Origin form ATIGA/FTA; ada kolom "Preference Criterion" atau label FTA
861: COO — Certificate of Origin standar non-FTA; ada official stamp otoritas
958: Lartas — Laporan Surveyor dari Sucofindo/Surveyor Indonesia/SCCI; header "LAPORAN SURVEYOR"; ada ls_number
457: SKB PPh — Surat Keterangan Bebas PPh; kop surat Dirjen Pajak/KPP
800: POSTEL — Sertifikat SDPPI untuk perangkat telekomunikasi/elektronik
813: CK — Dokumen Cukai DJBC
846: SKEM — Sertifikat Kesesuaian Efisiensi Energi; logo ESDM/BSN
854: BPOM — Izin edar BPOM; nomor format "BPOM RI MD/ML/TR/SD"
871: AKL — Alat Kesehatan; nomor AKL Kemenkes
888: Pengecualian Perijinan — nomor AKD Kemenkes
957: SNI/SPB — Sertifikat SNI; nomor SNI dan logo BSN
959: PI — Persetujuan Impor Kementerian Perdagangan/BKPM; header "PERSETUJUAN IMPOR"
999: Lainnya — tidak dapat diidentifikasi
`.trim();

const DISAMBIGUATION_RULES = `
CRITICAL — baca sebelum mengklasifikasikan:

1. HAWB (740) vs MAWB (741):
   Cek BERURUTAN, berhenti di sinyal pertama yang konklusif:
   - Header mengandung "HOUSE", "HAB", atau "HAWB" → WAJIB 740
   - Header "AIR WAYBILL" tanpa kata di atas:
     * Penerbit/carrier adalah maskapai (nama mengandung "AIR", "AIRLINES", "AIRWAYS",
       atau: Lion Air, Garuda, Singapore Airlines, Emirates, K-Mile Air,
       China Eastern, Korean Air, EVA Air, Cathay Pacific, Lufthansa, dll.) → WAJIB 741
     * Penerbit adalah forwarder/logistics (bukan maskapai) → 740

2. Sea Waybill / Non-Negotiable Waybill:
   Header "WAYBILL" atau "SEA WAYBILL" + ada vessel/port/container → LAUT → 704 atau 705
   BUKAN kode 740/741 meski ada kata "WAYBILL"

3. Lartas (958) vs PI (959):
   - Diterbitkan Sucofindo/Surveyor Indonesia/SCCI → 958
   - Diterbitkan Kemendag/BKPM → 959
`.trim();


// ── Prompt Builder ─────────────────────────────────────────────────────────

const buildDetectPrompt = (chunkPageCount) => `
You are analyzing a PDF document for a freight forwarding company.
This PDF may contain multiple separate logical documents combined into one file.

Your tasks:
1. Identify each separate logical document in this PDF
2. Determine the page range for each document (1-based, relative to THIS chunk only)
3. Classify the document type using the codes listed below
4. Extract the vendor/company name if visible
5. Extract the primary document number (invoice number, AWB number, LS number, B/L number, etc.)
6. Assign a confidence score (0.0 – 1.0) for each detection

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCUMENT TYPE CODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${TYPE_LIST}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${DISAMBIGUATION_RULES}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCUMENT NUMBER EXTRACTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Always populate "invoice_number" with the document's PRIMARY identifier:
- Invoice (380/001)  → invoice number
- AWB (740/741)      → AWB number (e.g. "126-12345678")
- BL (705/704)       → B/L number
- Lartas (958)       → LS number or PI number
- Certificates       → certificate number
- Unknown            → null

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GENERAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Page numbers are 1-based and relative to THIS chunk only (chunk has ${chunkPageCount} page(s))
- A document boundary starts when you see a NEW document header or title
- Different vendors = different document instances even if same type
- Pages with the SAME vendor AND the SAME document number MUST be grouped as ONE document
- Continuation pages (no new header, continued table rows, same header info) belong to the PREVIOUS document
- If document type is uncertain, use code 999
- If you can see ANY content on a page, you MUST return at least one document entry
- Confidence < ${CONFIDENCE_THRESHOLD} = uncertain boundary

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PAGE RANGE INTEGRITY (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Every page MUST belong to exactly ONE document — ranges must NEVER overlap
- You MUST account for EVERY page in this chunk sequentially — do not skip pages
- INVALID example: doc A pages 1–5, doc B pages 4–7   (pages 4–5 overlap)
- VALID example:   doc A pages 1–5, doc B pages 6–9   (no overlap)
- If a new document header appears mid-page, start the new document at the NEXT page
- If uncertain where a document ends, extend it until the next clear document header
- NEVER assign the same start_page to two different documents

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE FORMAT — Return ONLY valid JSON, no explanation:
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
}
`.trim();

// ── Gemini Caller ──────────────────────────────────────────────────────────

const makeFallbackDoc = (startPage, endPage) => ({
  doc_code: '999',
  vendor: null,
  invoice_number: null,
  start_page: startPage,
  end_page: endPage,
  confidence: 0,
  needs_review: true,
});

const detectChunk = async (chunkPath, physicalStart, physicalEnd) => {
  const chunkPageCount = physicalEnd - physicalStart + 1;
  const pdfBuffer = await readFile(chunkPath);
  const base64Pdf = pdfBuffer.toString('base64');

  const response = await ai.models.generateContent({
    model: CHEAP_MODEL,
    contents: [{
      parts: [
        { text: buildDetectPrompt(chunkPageCount) },
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
      ],
    }],
    config: { maxOutputTokens: 65536, responseMimeType: 'application/json' },
  });

  const usage = {
    prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens:  response.usageMetadata?.totalTokenCount ?? 0,
  };

  const jsonMatch = response.text?.match(/\{[\s\S]*\}/);
  const rawText = jsonMatch ? jsonMatch[0].trim() : '{}';

  let documents;
  try {
    const parsed = JSON.parse(rawText);
    documents = Array.isArray(parsed.documents) ? parsed.documents : [];
  } catch (err) {
    console.error(
      `[Phase1] JSON parse failed (chunk physical ${physicalStart}–${physicalEnd}): ${err.message}`
    );
    return { documents: [makeFallbackDoc(physicalStart, physicalEnd)], usage };
  }

  if (documents.length === 0) {
    console.warn(
      `[Phase1] 0 docs detected in chunk physical ${physicalStart}–${physicalEnd} — fallback to needs_review`
    );
    return { documents: [makeFallbackDoc(physicalStart, physicalEnd)], usage };
  }

  const mapped = documents.map((doc) => ({
    doc_code: String(doc.doc_code ?? '999'),
    vendor: doc.vendor ?? null,
    invoice_number: doc.invoice_number ?? null,
    start_page: doc.start_page + physicalStart - 1,
    end_page: doc.end_page + physicalStart - 1,
    confidence: doc.confidence ?? 0,
    needs_review: (doc.confidence ?? 0) < CONFIDENCE_THRESHOLD,
  }));

  console.info(
    `[Phase1] Raw AI response (chunk ${physicalStart}–${physicalEnd}): ${response.text?.substring(0, 300)}`
  );
  return { documents: mapped, usage };
};

// ── Post-processing ────────────────────────────────────────────────────────

const resolveOverlaps = (sorted) => {
  const result = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = { ...sorted[i] };
    const next    = sorted[i + 1];

    if (
      next &&
      next.start_page <= current.end_page &&
      current.invoice_number !== null &&
      current.invoice_number === next.invoice_number &&
      current.doc_code !== next.doc_code
    ) {
      console.warn(
        `[Phase1] Same invoice "${current.invoice_number}" detected as two codes: ` +
        `${current.doc_code} (p.${current.start_page}–${current.end_page}) ` +
        `vs ${next.doc_code} (p.${next.start_page}–${next.end_page})`
      );
    }

    if (result.length === 0) {
      result.push(current);
      continue;
    }

    const prev = result[result.length - 1];

    if (current.start_page <= prev.end_page) {
      if (
        current.end_page <= prev.end_page &&
        current.invoice_number !== null &&
        current.invoice_number === prev.invoice_number
      ) {
        console.warn(
          `[Phase1] Skipping fully-contained duplicate: invoice="${current.invoice_number}"`
        );
        continue;
      }

      console.warn(
        `[Phase1] Overlap drift: prev("${prev.invoice_number}" p.${prev.start_page}–${prev.end_page}) ` +
        `vs current("${current.invoice_number}" p.${current.start_page}–${current.end_page}) — flagging both`
      );
      current.needs_review = true;
      prev.needs_review    = true;
    }

    result.push(current);
  }

  return result;
};

// ── Chunk Orchestrator ─────────────────────────────────────────────────────

const buildChunks = async (filePath, totalPages, uploadDir) => {
  const chunks = [];

  for (let logicalStart = 1; logicalStart <= totalPages; logicalStart += CHUNK_SIZE) {
    const logicalEnd    = Math.min(logicalStart + CHUNK_SIZE - 1, totalPages);
    const physicalStart = logicalStart === 1 ? 1 : Math.max(1, logicalStart - CHUNK_OVERLAP);
    const physicalEnd   = logicalEnd;
    const chunkPath     = await splitPdf(filePath, physicalStart, physicalEnd, uploadDir);

    chunks.push({ chunkPath, physicalStart, physicalEnd, logicalStart, logicalEnd });
  }

  return chunks;
};

const runChunks = async (chunks) => {
  const totalUsage = { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const allDocs    = [];

  const results = await Promise.all(
    chunks.map(async ({ chunkPath, physicalStart, physicalEnd, logicalStart, logicalEnd }) => {
      console.info(
        `[Phase1] Chunk logical ${logicalStart}–${logicalEnd} ` +
        `(physical ${physicalStart}–${physicalEnd})...`
      );
      const t0                   = Date.now();
      const { documents, usage } = await detectChunk(chunkPath, physicalStart, physicalEnd);
      console.info(
        `[Phase1] Chunk ${logicalStart}–${logicalEnd}: ` +
        `${documents.length} doc(s) — ${Date.now() - t0}ms`
      );
      return { documents, usage };
    })
  );

  for (const { documents, usage } of results) {
    allDocs.push(...documents);
    totalUsage.prompt_tokens += usage.prompt_tokens;
    totalUsage.output_tokens += usage.output_tokens;
    totalUsage.total_tokens  += usage.total_tokens;
  }

  return { allDocs, totalUsage };
};

// ── Grouping & Dedup ───────────────────────────────────────────────────────

const groupAndDedup = (allDocs) => {
  const groupMap = new Map();

  for (const doc of allDocs) {
    const key = doc.invoice_number
      ? `${doc.doc_code}|${doc.vendor ?? ''}|${doc.invoice_number}`
      : `${doc.doc_code}|${doc.vendor ?? ''}|page_${doc.start_page}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, { ...doc });
      continue;
    }

    const existing = groupMap.get(key);
    const pageGap  = doc.start_page - existing.end_page;

    if (pageGap <= 1) {
      existing.start_page   = Math.min(existing.start_page, doc.start_page);
      existing.end_page     = Math.max(existing.end_page,   doc.end_page);
      existing.confidence   = Math.min(existing.confidence, doc.confidence);
      existing.needs_review = existing.needs_review || doc.needs_review;
    } else {
      const uniqueKey = `${key}|page_${doc.start_page}`;
      groupMap.set(uniqueKey, { ...doc });
      console.warn(
        `[Phase1] Same invoice "${doc.invoice_number}" reappears with page gap ${pageGap} — ` +
        'treating as separate document'
      );
    }
  }

  const sorted = [...groupMap.values()].sort((a, b) => a.start_page - b.start_page);
  return resolveOverlaps(sorted);
};

// ── Main Export ────────────────────────────────────────────────────────────

const detectBoundaries = async (filePath) => {
  const uploadDir  = path.dirname(filePath);
  const pdfBuffer  = await readFile(filePath);
  const sizeMB     = (pdfBuffer.length / 1024 / 1024).toFixed(2);
  const totalPages = await getPdfPageCount(filePath);

  console.info(
    `[Phase1] Starting boundary detection: ${path.basename(filePath)} ` +
    `(${sizeMB}MB, ${totalPages} pages, chunk=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`
  );

  const chunks = await buildChunks(filePath, totalPages, uploadDir);
  console.info(`[Phase1] ${chunks.length} chunk(s) created — running parallel detection...`);

  let allDocs;
  let totalUsage;

  try {
    ({ allDocs, totalUsage } = await runChunks(chunks));
  } finally {
    await Promise.allSettled(
      chunks.map(({ chunkPath }) => unlink(chunkPath))
    );
  }

  const boundaries = groupAndDedup(allDocs);

  console.info(
    `[Phase1] Done: ${allDocs.length} raw → ${boundaries.length} final ` +
    `| tokens: ${totalUsage.total_tokens} ` +
    `(prompt: ${totalUsage.prompt_tokens}, output: ${totalUsage.output_tokens})`
  );
  boundaries.forEach((doc, idx) => {
    const reviewFlag = doc.needs_review ? ' ⚠ REVIEW' : '';
    console.info(
      `  [${String(idx + 1).padStart(2, '0')}] ` +
      `code=${doc.doc_code} | pages=${doc.start_page}–${doc.end_page} | ` +
      `conf=${doc.confidence.toFixed(2)} | inv="${doc.invoice_number ?? 'N/A'}" | ` +
      `vendor="${doc.vendor ?? 'N/A'}"${reviewFlag}`
    );
  });

  return { boundaries, usage: totalUsage };
};

export default detectBoundaries;
