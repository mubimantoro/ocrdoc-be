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
  '957':'SNI', '959':'PI', '999':'Lainnya', '000': 'Cukai',
};

const TYPE_LIST = Object.entries(DOC_TYPES)
  .map(([code, name]) => `${code}: ${name}`).join('\n');

const detectBoundaries = async (filePath) => {
  console.info(`[Phase1] Detecting boundaries: ${filePath}`);

  const pdfBuffer = await readFile(filePath);
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
- Pages are 1-based
- A document starts when you see a new document header or title
- Different vendors = different document instances even if same type
- IMPORTANT: Pages with the SAME vendor AND the SAME invoice/document number MUST be grouped as ONE document with a single page range (start_page to end_page)
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
  });

  const rawText = response.text.replace(/```json|```/g, '').trim();

  try {
    const parsed    = JSON.parse(rawText);
    const documents = parsed.documents || [];

    const result = documents.map((doc) => ({
      ...doc,
      invoice_number: doc.invoice_number ?? null,
      needs_review:   doc.confidence < CONFIDENCE_THRESHOLD,
    }));

    console.info(`[Phase1] Found ${result.length} document(s)`);
    result.forEach((d, i) =>
      console.info(`  [${i+1}] code=${d.doc_code} invoice=${d.invoice_number} pages=${d.start_page}-${d.end_page} confidence=${d.confidence} review=${d.needs_review}`)
    );

    return result;
  } catch (e) {
    console.error(`[Phase1] Parse failed: ${e.message}`);
    return [{
      doc_code: '999',
      vendor: null,
      invoice_number: null,
      start_page: 1,
      end_page: 999,
      confidence: 0,
      needs_review: true,
    }];
  }
};


export default detectBoundaries;