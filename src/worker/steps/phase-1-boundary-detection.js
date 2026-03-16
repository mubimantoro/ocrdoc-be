/* eslint-disable camelcase */
import { readFile } from 'fs/promises';
import ai, { CHEAP_MODEL } from '../../config/gemini.js';

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');

const DOC_TYPES = {
  '380':'Invoice', '217':'Packing List', '001':'CIPL',
  '705':'Bill of Lading', '740':'Air Way Bill', '860':'ECOO',
  '861':'COO', '704':'Master Bill of Lading', '741':'Master AWB',
  '958':'Lartas', '457':'SKB PPh', '800':'POSTEL', '813':'CK',
  '846':'SKEM', '854':'BPOM', '871':'AKL', '888':'Pengecualian Perijinan',
  '957':'SNI/SPB', '959':'PI', '999':'Lainnya', '000': 'Cukai',
};


const TYPE_LIST = Object.entries(DOC_TYPES)
  .map(([code, name]) => `${code}: ${name}`).join('\n');


/**
 * Fase 1 — Cheap AI: kirim PDF langsung, detect boundaries
 * @param {string} filePath - path PDF asli
 * @returns {Promise<Array<{ doc_code, vendor, start_page, end_page, confidence }>>}
 */
const detectBoundaries = async (filePath) => {
  console.info(`[Phase1] Detecting boundaries: ${filePath}`);

  const pdfBuffer  = await readFile(filePath);
  const base64Pdf  = pdfBuffer.toString('base64');

  const prompt = `You are analyzing a PDF document for a freight forwarding company.
This PDF may contain multiple separate logical documents combined into one file.

Your task:
1. Identify each separate logical document in this PDF
2. Determine the page range for each document
3. Identify the document type using the codes below
4. Identify the vendor/company name if visible
5. Provide a confidence score (0.0 - 1.0) for each detection

Available document type codes:
${TYPE_LIST}

Rules:
- Pages are 1-based
- A document starts when you see a new document header or title
- Different vendors = different document instances even if same type
- Confidence < ${CONFIDENCE_THRESHOLD} means uncertain boundary

Return ONLY valid JSON, no explanation:
{
  "documents": [
    {
      "doc_code": "380",
      "vendor": "PT. ABC SUPPLIER",
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
  });

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);
    const documents = parsed.documents || [];

    // Tandai dokumen yang confidence-nya rendah → perlu manual review
    const result = documents.map((doc) => ({
      ...doc,
      needs_review: doc.confidence < CONFIDENCE_THRESHOLD,
    }));

    console.info(`[Phase1] Found ${result.length} document(s)`);
    result.forEach((d, i) =>
      console.info(`  [${i+1}] code=${d.doc_code} pages=${d.start_page}-${d.end_page} confidence=${d.confidence} review=${d.needs_review}`)
    );

    return result;
  } catch (e) {
    console.error(`[Phase1] Parse failed: ${e.message}`);
    // Fallback: 1 dokumen = seluruh PDF
    return [{
      doc_code: '999',
      vendor: null,
      start_page: 1,
      end_page: 999, // akan di-clamp ke total halaman
      confidence: 0,
      needs_review: true,
    }];
  }
};

export default detectBoundaries;