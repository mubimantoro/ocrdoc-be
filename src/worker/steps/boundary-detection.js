/* eslint-disable camelcase */
import { readFile } from 'fs/promises';
import getProvider from '../../config/ai-provider.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse  = require('pdf-parase');

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7');

const DOC_TYPES = {
  '380':'Invoice', '217':'Packing List', '001':'CIPL',
  '705':'Bill of Lading', '740':'Air Way Bill', '860':'ECOO',
  '861':'COO', '704':'Master Bill of Lading', '741':'Master AWB',
  '958':'Lartas', '457':'SKB PPh', '800':'POSTEL', '813':'CK',
  '846':'SKEM', '854':'BPOM', '871':'AKL', '888':'Pengecualian Perijinan',
  '957':'SNI/SPB', '959':'PI', '999':'Lainnya', '000':'Cukai',
};

const TYPE_LIST = Object.entries(DOC_TYPES)
  .map(([code, name]) => `${code}: ${name}`).join('\n');

const splitPages = (fullText, pageCount) => {
  const byFormFeed = fullText.split('\f').map((t) => t.trim()).filter(Boolean);
  if (byFormFeed.length >= pageCount) return byFormFeed.slice(0, pageCount);
  const chunkSize = Math.ceil(fullText.length / pageCount);
  return Array.from({ length: pageCount }, (_, i) =>
    fullText.slice(i * chunkSize, (i + 1) * chunkSize).trim()
  );
};

const extractKeyValues = (text) => {
  const pairs = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]{2,40}?)\s*:\s*(.+)$/);
    if (match && match[1].length < 40) {
      pairs[match[1].trim()] = match[2].trim();
    }
  }
  return pairs;
};

const parsePage = (pageText, pageNum) => ({
  page:    pageNum,
  headers: pageText.split('\n').map((l) => l.trim()).filter((l) => l.length > 2).slice(0, 8),
  pairs:   extractKeyValues(pageText),
});

const detectBoundaries = async (filePath) => {
  console.info(`[Phase1] Pre-parsing PDF: ${filePath}`);

  const pdfBuffer = await readFile(filePath);
  const pdfData   = await pdfParse(pdfBuffer);
  const pageCount = pdfData.numpages;
  const pages     = splitPages(pdfData.text, pageCount);
  const parsed    = pages.map((text, i) => parsePage(text, i + 1));

  const prompt = `You are a document boundary detector for freight forwarding documents.
Pre-parsed page data from PDF:
${JSON.stringify(parsed, null, 2)}
 
Available document type codes:
${TYPE_LIST}
 
Group pages into logical document instances.
Return ONLY valid JSON:
{
  "documents": [
    { "doc_code": "380", "vendor": "PT. ABC", "start_page": 1, "end_page": 2, "confidence": 0.95 }
  ]
}`;

  const ai = getProvider();
  const { text, usage } = await ai.generateText(prompt, {
    model: process.env.GEMINI_CHEAP_MODEL || 'gemini-2.5-flash-lite',
  });

  console.info(`[Phase1] Token usage: ${JSON.stringify(usage)}`);

  const rawText = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(rawText);
    const documents = (parsed.documents || []).map((doc) => ({
      ...doc,
      end_page: Math.min(doc.end_page, pageCount),
      needs_review: doc.confidence < CONFIDENCE_THRESHOLD,
    }));

    console.info(`[Phase1] Detected ${documents.length} document(s)`);

    return { documents, usage };
  } catch (e) {
    console.error(`[Phase1] Parse failed: ${e.message}`);
    return {
      documents: [{
        doc_code: '999', vendor: null,
        start_page: 1, end_page: pageCount,
        confidence: 0, needs_review: true,
      }],
      usage,
    };
  }
};

export default detectBoundaries;
