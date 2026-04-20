import { PDFDocument } from 'pdf-lib';
import { getSequentialExtractionPrompt } from '../../../../prompts/extraction.js';
import { callGeminiWithRetry, mergeArraysDeep, extractOcrTokens, debugLog } from '../helpers.js';

/**
 * HANDLER: PDF EXTRACTION (One-Shot vs Sequential)
 */
export const processPdfExtraction = async (fileBuffer, docCode, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  // 🚀 OPTIMIZATION 1: SAFE ONE-SHOT (UP TO 8 PAGES)
  // Threshold diturunkan dari 15 ke 8 hal untuk mencegah JSON Truncation pada data yang sangat padat.
  if (docCode === '001' && numPages <= 8) {
    console.log(`\n[AI-SERVICE] [PDF MODE] Safe One-Shot untuk CIPL ${numPages} halaman (Akurasi Maksimal)...`);
    const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ]);
    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;
    await debugLog(docCode, 'one_shot_pdf_output', pdfJson);
    return pdfJson;
  }

  // 🚀 OPTIMIZATION 2: CONTEXT-AWARE SEQUENTIAL EXTRACTION (> 15 PAGES)
  console.log(`\n[AI-SERVICE] [PDF MODE] Menerapkan Context-Aware Sequential Extraction (${numPages} hal)...`);
  let masterJson = null;

  for (let i = 0; i < numPages; i++) {
    console.log(`[AI-SERVICE] Memproses PDF Halaman ${i + 1}/${numPages}...`);

    const singlePdf = await PDFDocument.create();
    const [copiedPage] = await singlePdf.copyPages(pdfDoc, [i]);
    singlePdf.addPage(copiedPage);
    const singlePdfBytes = await singlePdf.save();

    const contextSummary = masterJson
      ? `\nPREVIOUS DATA CONTEXT (Sudah diekstrak):\n- Invoice/PL Number: ${masterJson.invoice_number || masterJson.packing_list_number}\n- Last Extracted Items Count: ${masterJson.invoice_list?.[0]?.items?.length || 0}\n`
      : '';

    const pagePrompt = i === 0 ? prompt : getSequentialExtractionPrompt(prompt, contextSummary);

    const { parsedData: pageJson, usageMetadata } = await callGeminiWithRetry([
      pagePrompt,
      { inlineData: { data: Buffer.from(singlePdfBytes).toString('base64'), mimeType: 'application/pdf' } }
    ]);
    await debugLog(docCode, `raw_pdf_page_${i + 1}`, pageJson);

    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.ocr += extractOcrTokens(usageMetadata);
    tokenUsage.total += usageMetadata.totalTokenCount || 0;

    if (i === 0) masterJson = pageJson;
    else mergeArraysDeep(masterJson, pageJson);
  }
  await debugLog(docCode, 'merged_pdf_output', masterJson);
  return masterJson;
};
/**
 * HANDLER: LIGHT PDF EXTRACTION (Page 1 & Last Page Only)
 * Dioptimalkan untuk dokumen perizinan/regulasi (BPOM, AKL, POSTEL, dll)
 * yang hanya butuh doc_number & doc_date.
 */
export const processLightPdfExtraction = async (fileBuffer, prompt, tokenUsage) => {
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const numPages = pdfDoc.getPageCount();

  console.log('\n[AI-SERVICE] [LIGHT PDF MODE] Mencoba Ekstraksi Cepat (Halaman 1 & Terakhir)...');

  const lightPdf = await PDFDocument.create();
  const pagesToCopy = numPages === 1 ? [0] : [0, numPages - 1];
  const copiedPages = await lightPdf.copyPages(pdfDoc, pagesToCopy);
  copiedPages.forEach((page) => lightPdf.addPage(page));

  const lightPdfBytes = await lightPdf.save();

  const { parsedData, usageMetadata } = await callGeminiWithRetry([
    prompt,
    { inlineData: { data: Buffer.from(lightPdfBytes).toString('base64'), mimeType: 'application/pdf' } }
  ]);

  tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
  tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
  tokenUsage.ocr += extractOcrTokens(usageMetadata);
  tokenUsage.total += usageMetadata.totalTokenCount || 0;

  return parsedData;
};
