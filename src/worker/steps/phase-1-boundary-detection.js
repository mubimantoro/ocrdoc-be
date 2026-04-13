
/* eslint-disable camelcase */
import { readFile, unlink } from 'fs/promises';
import path from 'path';
import ai, { CHEAP_MODEL } from '../../config/gemini.js';
import { getPdfPageCount, splitPdf } from '../../utils/pdf-helper.js';


const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP);

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Document type registry.
 * Format: "<code>: <name> — <discriminating visual/structural features>"
 *
 * MAINTENANCE NOTE:
 *  - Keep descriptions focused on OBSERVABLE features (header text, field names,
 *    number formats, issuing party). Avoid vague descriptions.
 *  - When adding a new type, also add a disambiguation rule below if it shares
 *    visual characteristics with an existing type.
 */
const TYPE_LIST = `
380: Invoice — commercial invoice; ada kolom unit price/amount, seller name, buyer name, total amount, payment terms
001: CIPL — gabungan invoice + packing list dalam 1 dokumen; ada line items dengan price DAN packaging dimension/weight sekaligus
217: Packing List — hanya packaging; TIDAK ADA unit price per item maupun total invoice amount
705: Bill of Lading — HOUSE B/L atau Sea Waybill dari freight forwarder; moda transportasi LAUT; ada vessel name, voyage number, port of loading/discharge, container number; shipper = actual exporter
704: Master Bill of Lading — MBL atau Sea Waybill (SWB/Non-Negotiable Waybill) diterbitkan langsung oleh SHIPPING LINE (Maersk, MSC, Evergreen, COSCO, WAN HAI, dll); header bertuliskan nama shipping line atau SCAC code mereka (MAEU=Maersk, MSCU=MSC, dll); ada vessel name, voyage, container; PENTING: meski header bertuliskan "WAYBILL" atau "NON-NEGOTIABLE WAYBILL", jika moda transportasi adalah LAUT (ada vessel/voyage/container/port) maka kode WAJIB 704 atau 705, BUKAN 740/741
740: Air Way Bill — HAWB (House Air Waybill); header bertuliskan "HOUSE AIR WAYBILL" / "HOUSE AIRWAY BILL" / "HAB",
     ATAU header "AIR WAYBILL" biasa tapi ada field "HAWB NO" terisi, ATAU issued by perusahaan forwarder/logistics
     (bukan maskapai); shipper = actual exporter; moda UDARA
741: Master AWB — MAWB; header bertuliskan "AIR WAYBILL" / "AIRWAY BILL" tanpa kata "HOUSE",
     DAN tidak ada field "HAWB NO"; issued by / carrier = maskapai penerbangan (nama mengandung
     "AIR", "AIRLINES", "AIRWAYS", atau nama maskapai dikenal); nomor format "XXX-XXXXXXXX"
     dengan 3 digit pertama adalah IATA airline prefix; moda UDARA
860: ECOO — Certificate of Origin form ATIGA/ECOO; ada kolom "Preference Criterion" atau label "FTA"; diterbitkan lembaga penerbit COO
861: COO — Certificate of Origin standar non-FTA; ada official stamp/tanda tangan otoritas; tidak ada kolom FTA/ATIGA
958: Lartas — Laporan Surveyor (LS) dari lembaga survei RESMI (Sucofindo, Surveyor Indonesia, PT SCCI); header "LAPORAN SURVEYOR" atau "LS"; ada ls_number/vo_number, data importir, hs_code per item, tanda tangan surveyor
457: SKB PPh — Surat Keterangan Bebas Pajak Penghasilan; kop surat Dirjen Pajak / KPP
800: POSTEL — Sertifikat SDPPI/POSTEL untuk perangkat telekomunikasi/elektronik; ada nomor sertifikat SDPPI
813: CK — Dokumen Cukai; ada pita cukai; kop surat DJBC
846: SKEM — Sertifikat Kesesuaian Efisiensi Energi; ada logo ESDM/BSN
854: BPOM — Izin edar BPOM; ada nomor izin format "BPOM RI MD/ML/TR/SD"
871: AKL — Alat Kesehatan Dalam Negeri; ada nomor AKL Kemenkes
888: AKD — Alat Kesehatan Dalam Negeri variant; ada nomor AKD Kemenkes
957: SNI — Sertifikat SNI; ada nomor SNI dan logo BSN
959: PI — Persetujuan Impor dari Kementerian Perdagangan/BKPM; header "PERSETUJUAN IMPOR"; BUKAN dari lembaga survei
000: Cukai — Dokumen pita cukai/DJBC lainnya
999: Lainnya — tidak dapat diidentifikasi dengan kode di atas
`.trim();

/**
 * Disambiguation rules injected into prompt for pairs that are visually similar.
 *
 * MAINTENANCE NOTE:
 *  - One rule block per ambiguous pair.
 *  - Each rule must reference a VERIFIABLE feature visible in the document.
 *  - Order from most common confusion to least.
 */
const DISAMBIGUATION_RULES = `
CRITICAL DISAMBIGUATION — baca sebelum mengklasifikasikan:
1. Master AWB (741) vs House AWB (740) — DUA SINYAL SAJA, URUTAN KETAT:

   SINYAL 1 — HEADER DOKUMEN (paling kuat, cek ini dulu):
   - Header mengandung kata "HOUSE", "HAB", atau "HAWB" → WAJIB kode 740
   - Header hanya "AIR WAYBILL" atau "AIRWAY BILL" tanpa kata "HOUSE" → lanjut ke Sinyal 2

   SINYAL 2 — NAMA PENERBIT / VENDOR (nama maskapai atau forwarder):
   - Nama vendor/issuer mengandung kata "AIR", "AIRLINES", "AIRWAYS", atau nama maskapai
     dikenal (Garuda, Emirates, Cathay, Lufthansa, Qatar, Korean, Singapore, China Eastern,
     China Southern, EVA, Turkish, Qantas, Japan Airlines, Thai Airways, dll.)
     → WAJIB kode 741
   - Nama vendor adalah perusahaan logistik/forwarder biasa (tidak ada unsur maskapai)
     → kode 740

   CONTOH:
   - Header "Air Waybill" + vendor "EVA AIRWAYS CORPORATION" → kode 741 (Sinyal 2: ada "AIRWAYS")
   - Header "House Air Waybill" + vendor apapun → kode 740 (Sinyal 1: ada "HOUSE")
   - Header "Air Waybill" + vendor "UPS SUPPLY CHAIN SOLUTIONS" → kode 740 (Sinyal 2: bukan maskapai)
   - Header "Air Waybill" + vendor "CHINA EASTERN AIRLINES" → kode 741 (Sinyal 2: ada "AIRLINES")


2. Lartas (958) vs PI (959):
   - Diterbitkan oleh Sucofindo, Surveyor Indonesia, atau PT SCCI; ada header "LAPORAN SURVEYOR"
     atau nomor "LS-XXXX" → WAJIB kode 958
   - Diterbitkan oleh Kementerian Perdagangan / BKPM; header "PERSETUJUAN IMPOR" → kode 959
3. BL (705/704) vs AWB (740/741) — MODAL TRANSPORT IS THE PRIMARY SIGNAL:
   - Dokumen memiliki "Vessel", "Voyage", "Container", "Port of Loading/Discharge"
     → WAJIB kode 704 atau 705 (moda LAUT)
   - Dokumen memiliki "Flight No", "Airport of Departure/Destination"
     → kode 740 atau 741 (moda UDARA)
   - Header "WAYBILL", "SEA WAYBILL", atau "NON-NEGOTIABLE WAYBILL" TIDAK BERARTI kode AWB (740/741)
     Sea Waybill adalah dokumen LAUT — jika ada vessel/port/container, gunakan kode 704 atau 705
   - Cara membedakan 704 vs 705 setelah dikonfirmasi moda laut:
     * Diterbitkan oleh shipping line (Maersk/MAEU, MSC/MSCU, Evergreen, COSCO, WAN HAI) → kode 704
     * Diterbitkan oleh freight forwarder / NVOCC → kode 705
4. CIPL (001) vs Invoice (380) vs Packing List (217):
   - Ada BOTH unit price AND packaging dimension per item → kode 001
   - Ada unit price, tidak ada packaging data → kode 380
   - Ada packaging data, tidak ada unit price → kode 217
`.trim();
// ── Prompt Builder ────────────────────────────────────────────────────────────

/**
 * Builds the Phase 1 boundary detection prompt for a single PDF chunk.
 *
 * Separating the prompt into its own function makes it independently testable
 * and easy to iterate on without touching business logic.
 *
 * @param {number} chunkPageCount - Total pages in THIS chunk (1-based)
 * @returns {string}
 */
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
- "Air Waybill" header + issued by airline (contains "AIR"/"AIRLINES"/"AIRWAYS") → doc_code "741"
- "Air Waybill" header + issued by forwarder → doc_code "740"  
- Any header with "HOUSE" → doc_code "740"

Example output:
{
  "documents": [
    {
      "doc_code": "741",
      "vendor": "CHINA EASTERN AIRLINES",
      "invoice_number": "112-37912814",
      "start_page": 1,
      "end_page": 3,
      "confidence": 0.95
    }
  ]
}
`.trim();

// ── Gemini Caller ─────────────────────────────────────────────────────────────

/**
 * Fallback document used whenever a chunk returns 0 docs or fails to parse.
 * Marked needs_review so it always gets routed to manual queue.
 *
 * @param {number} startPage
 * @param {number} endPage
 * @returns {Object}
 */
const makeFallbackDoc = (startPage, endPage) => ({
  doc_code:       '999',
  vendor:         null,
  invoice_number: null,
  start_page:     startPage,
  end_page:       endPage,
  confidence:     0,
  needs_review:   true,
});

/**
 * Calls Gemini to detect document boundaries in a single PDF chunk.
 *
 * @param {string} chunkPath     - Absolute path to the temporary chunk PDF
 * @param {number} physicalStart - First physical page of this chunk in the full PDF (1-based)
 * @param {number} physicalEnd   - Last physical page of this chunk in the full PDF (1-based)
 * @returns {Promise<{ documents: Object[], usage: Object }>}
 */
const detectChunk = async (chunkPath, physicalStart, physicalEnd) => {
  const chunkPageCount = physicalEnd - physicalStart + 1;
  const pdfBuffer      = await readFile(chunkPath);
  const base64Pdf      = pdfBuffer.toString('base64');

  const response = await ai.models.generateContent({
    model:    CHEAP_MODEL,
    contents: [{
      parts: [
        { text: buildDetectPrompt(chunkPageCount) },
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

  // Extract JSON — responseMimeType should guarantee clean JSON, but we
  // apply a regex guard as a safety net against stray markdown fences.
  const jsonMatch = response.text?.match(/\{[\s\S]*\}/);
  const rawText   = jsonMatch ? jsonMatch[0].trim() : '{}';

  let documents;
  try {
    const parsed = JSON.parse(rawText);
    documents    = Array.isArray(parsed.documents) ? parsed.documents : [];
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

  // Re-map chunk-relative pages → absolute pages in the full PDF
  const mapped = documents.map((doc) => ({
    doc_code:       String(doc.doc_code ?? '999'),
    vendor:         doc.vendor         ?? null,
    invoice_number: doc.invoice_number ?? null,
    start_page:     doc.start_page + physicalStart - 1,
    end_page:       doc.end_page   + physicalStart - 1,
    confidence:     doc.confidence ?? 0,
    needs_review:   (doc.confidence ?? 0) < CONFIDENCE_THRESHOLD,
  }));

  return { documents: mapped, usage };
};

// ── Post-processing ───────────────────────────────────────────────────────────

/**
 * Resolves overlap/drift between adjacent document boundaries produced by the
 * AI across chunk boundaries.
 *
 * Strategy:
 *  - Fully contained duplicates (same invoice) → skip
 *  - Partial overlap (index drift) → flag BOTH for manual review, keep as-is
 *    (do NOT blindly truncate — it risks losing line items)
 *  - Same invoice_number detected as two different doc_codes → warn but keep both
 *    (human reviewer will consolidate)
 *
 * @param {Object[]} sorted - Documents sorted by start_page ascending
 * @returns {Object[]}
 */
const resolveOverlaps = (sorted) => {
  const result = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = { ...sorted[i] };
    const next    = sorted[i + 1];

    // Warn: same invoice number but two different doc_codes in adjacent entries
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
      // Case 1: Fully contained duplicate with same invoice → discard silently
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

      // Case 2: Partial overlap (AI index drift across chunk boundary)
      // Flag both for manual review — do NOT silently truncate page ranges
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

// ── Chunk Orchestrator ────────────────────────────────────────────────────────

/**
 * Splits a PDF into overlapping chunks and returns metadata for each chunk.
 * Overlap allows the AI to see context from the previous chunk's trailing pages,
 * reducing boundary drift at chunk edges.
 *
 * @param {string} filePath    - Absolute path to the source PDF
 * @param {number} totalPages  - Total page count of the source PDF
 * @param {string} uploadDir   - Directory where temp chunk files are written
 * @returns {Promise<Array<{ chunkPath, physicalStart, physicalEnd, logicalStart, logicalEnd }>>}
 */
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

/**
 * Processes all chunks in parallel and accumulates raw document results.
 *
 * @param {Array}  chunks
 * @returns {Promise<{ allDocs: Object[], totalUsage: Object }>}
 */
const runChunks = async (chunks) => {
  const totalUsage = { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const allDocs    = [];

  const results = await Promise.all(
    chunks.map(async ({ chunkPath, physicalStart, physicalEnd, logicalStart, logicalEnd }) => {
      console.info(
        `[Phase1] Chunk logical ${logicalStart}–${logicalEnd} ` +
        `(physical ${physicalStart}–${physicalEnd})...`
      );
      const t0                    = Date.now();
      const { documents, usage }  = await detectChunk(chunkPath, physicalStart, physicalEnd);
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

// ── Grouping & Dedup ──────────────────────────────────────────────────────────

/**
 * Groups raw documents from all chunks by their logical identity:
 *   (doc_code, vendor, invoice_number)
 *
 * Documents that overlap chunk boundaries produce duplicate entries that need
 * merging. A duplicate is valid for merging ONLY if the page gap is ≤ 1
 * (i.e., the two entries are directly adjacent or overlapping due to the
 * CHUNK_OVERLAP window). Larger gaps mean the same invoice number reappears in
 * a different physical shipment — treat as a separate document.
 *
 * @param {Object[]} allDocs - Flat array of documents from all chunks
 * @returns {Object[]} Sorted, grouped, overlap-resolved document list
 */
const groupAndDedup = (allDocs) => {
  const groupMap = new Map();

  for (const doc of allDocs) {
    // Use invoice_number as part of key so that the same doc_code + vendor
    // with a different document number is always treated as a separate document.
    // Fall back to start_page to guarantee uniqueness for unknown-number docs.
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
      // Merge: extend the page range, keep the lower confidence score
      existing.start_page = Math.min(existing.start_page, doc.start_page);
      existing.end_page   = Math.max(existing.end_page,   doc.end_page);
      existing.confidence = Math.min(existing.confidence, doc.confidence);
      // Propagate review flag if either side needs it
      existing.needs_review = existing.needs_review || doc.needs_review;
    } else {
      // Same identity but too far apart — treat as a distinct document
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

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * detectBoundaries — Phase 1 entry point.
 *
 * Orchestrates the full boundary detection pipeline:
 *   1. Build overlapping PDF chunks
 *   2. Run Gemini detection on all chunks in parallel
 *   3. Clean up temp chunk files (always, even on failure)
 *   4. Group + dedup + resolve overlaps
 *   5. Return structured boundary list + token usage
 *
 * @param {string} filePath - Absolute path to the source PDF
 * @returns {Promise<{ boundaries: Object[], usage: Object }>}
 */
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
    // Always clean up temp files regardless of success or failure
    await Promise.allSettled(
      chunks.map(({ chunkPath }) => unlink(chunkPath))
    );
  }

  const boundaries = groupAndDedup(allDocs);

  // ── Summary log ────────────────────────────────────────────────────────────
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