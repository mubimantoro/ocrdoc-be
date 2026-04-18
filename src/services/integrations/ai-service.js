/* eslint-disable camelcase */
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import * as xlsx from 'xlsx';
import { getBoundaryPrompt } from '../../prompts/boundary.js';
import { ai, MODELS } from '../../config/gemini.js';
import { getExtractionPrompt } from '../../prompts/extraction.js';
import { PDFDocument } from 'pdf-lib';
import { cleanAIJson } from '../../utils/ai-sanitizer.js';
import { buildDocumentsFromPages } from '../../utils/boundary-resolver.js';
import { enforceSchemaStrictness } from '../../utils/schema-enforcer.js';
import { applyBusinessRules } from '../../utils/business-rules.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * DEBUGGER KHUSUS CIPL (001)
 * Akan menyimpan raw output AI ke folder debug_logs di root project
 */
const debugLog = async (docCode, stepName, data) => {
  if (docCode !== '001' && docCode !== 'debug') return; // Batasi hanya CIPL agar tidak spam
  try {
    const debugDir = path.join(process.cwd(), 'debug_logs');
    await fs.mkdir(debugDir, { recursive: true });

    // Auto-cleanup: Hapus log lama saat proses baru dimulai (halaman 1 atau one-shot)
    if (stepName.includes('page_1') || stepName === 'one_shot_pdf_output') {
      const files = await fs.readdir(debugDir);
      for (const file of files) {
        if (file.endsWith('.json')) await fs.unlink(path.join(debugDir, file));
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(debugDir, `cipl_${timestamp}_${stepName}.json`);
    await fs.writeFile(filename, JSON.stringify(data, null, 2));
    console.log(`[DEBUG] Log tersimpan: ${filename}`);
  } catch (err) {
    console.error('[DEBUG] Gagal save log:', err.message);
  }
};

/**
 * Ekstraksi token spesifik OCR dari metadata Gemini
 * Time Complexity: O(N) dimana N adalah jumlah modality details
 */
const extractOcrTokens = (metadata) => {
  let ocrTokens = 0;
  if (metadata.promptTokensDetails && Array.isArray(metadata.promptTokensDetails)) {
    const docOrImageDetail = metadata.promptTokensDetails.find(
      (detail) => detail.modality === 'IMAGE' || detail.modality === 'DOCUMENT'
    );
    if (docOrImageDetail) {
      ocrTokens = docOrImageDetail.tokenCount || 0;
    }
  }
  return ocrTokens;
};

/**
 * API Call Level Rendah ke Gemini (Tidak boleh dipanggil langsung untuk file masif)
 */
export const detectBoundaries = async (fileBuffer, mimeType, absoluteStartPage, totalPagesInChunk) => {
  const prompt = getBoundaryPrompt(absoluteStartPage, totalPagesInChunk);

  const response = await ai.models.generateContent({
    model: MODELS.CHEAP,
    contents: [
      prompt,
      {
        inlineData: {
          data: fileBuffer.toString('base64'),
          mimeType: mimeType
        }
      }
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  });

  const parsedResult = cleanAIJson(response.text);
  const usageMetadata = response.usageMetadata || {};

  const totalInput = usageMetadata.promptTokenCount || 0;
  const ocrTokens = extractOcrTokens(usageMetadata);
  const textInput = Math.max(0, totalInput - ocrTokens);

  return {
    pages: parsedResult.pages || [],
    usage: {
      input_total: usageMetadata.promptTokenCount,
      input_text: textInput,
      ocr: ocrTokens,
      output: usageMetadata.candidatesTokenCount || 0,
      total: usageMetadata.totalTokenCount || 0
    },
    model_used: MODELS.CHEAP,
  };
};

/**
 * ENTERPRISE ARCHITECTURE: Sequential Chunked Boundary Detection
 * O(N/K) Space Complexity. Menghindari Context Bleed pada Vision LLM.
 */
export const detectBoundariesChunked = async (absoluteFilePath, mimeType, maxPagesPerChunk = 15) => {
  const pdfBuffer = await fs.readFile(absoluteFilePath);
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  const allPagesRaw = [];
  const totalUsage = { input_total: 0, input_text: 0, ocr: 0, output: 0, total: 0 };

  for (let startPage = 1; startPage <= totalPages; startPage += maxPagesPerChunk) {
    const endPage = Math.min(startPage + maxPagesPerChunk - 1, totalPages);
    const pagesInThisChunk = (endPage - startPage) + 1;

    const newPdf = await PDFDocument.create();
    const pageIndices = Array.from({ length: pagesInThisChunk }, (_, i) => startPage - 1 + i);
    const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    const chunkBuffer = await newPdf.save();
    console.log(`[AI-SERVICE] Tagging Chunk: hal ${startPage} - ${endPage}`);

    const result = await detectBoundaries(Buffer.from(chunkBuffer), mimeType, startPage, pagesInThisChunk);
    const taggedPages = result.pages || [];

    // Defensive Loop: Mencegah hilangnya halaman akibat LLM Omission
    for (let p = startPage; p <= endPage; p++) {
      const foundPage = taggedPages.find((t) => t.absolute_page_number === p);
      if (foundPage) {
        allPagesRaw.push(foundPage);
      } else {
        console.warn(`[AI-SERVICE] Missing data for page ${p}, applying fallback tag.`);
        allPagesRaw.push({
          absolute_page_number: p,
          is_new_document: false,
          doc_code: '999',
          document_number: null,
          vendor: null,
          confidence: 0
        });
      }
    }

    totalUsage.input_total += result.usage.input_total;
    totalUsage.input_text += result.usage.input_text;
    totalUsage.ocr += result.usage.ocr;
    totalUsage.output += result.usage.output;
    totalUsage.total += result.usage.total;
  }

  // O(N) Deterministic Aggregation
  const finalDocuments = buildDocumentsFromPages(allPagesRaw);

  return {
    documents: finalDocuments,
    usage: totalUsage,
    model_used: MODELS.CHEAP,
    page_count: totalPages
  };
};
/**
 * Ekstraksi Data Spesifik (Fase 2)
 * Tidak memerlukan chunking karena inputnya adalah PDF yang sudah displit (1-5 halaman).
 */
/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Hybrid: Map-Reduce Batching (Excel) + Self-Healing Loop
 */
/**
 * FASE 2 - Ekstraksi Data Spesifik (Smart Data Extraction)
 * Arsitektur Master: Omni-Channel Map Reduce (PDF & Excel) + Self-Healing
 */
export const extractSmartData = async (fileBuffer, mimeType, docCode, sheetName = null) => {
  let jsonSchema;

  try {
    const schemaPath = path.join(__dirname, '../../schemas', `${docCode}.json`);
    const schemaFile = await fs.readFile(schemaPath, 'utf-8');
    jsonSchema = JSON.parse(schemaFile);
  } catch (error) {
    throw new Error(`Gagal memuat skema JSON untuk dokumen ${docCode}: ${error.message}`);
  }

  const basePrompt = getExtractionPrompt(jsonSchema);
  const prompt = `${basePrompt}
  ABSOLUTE DIRECTIVE (MANUAL OVERRIDE & UNIVERSAL EXTRACTION MODE):
  1. Terapkan teknik "Chain of Thought". Buat key "_reasoning" di baris paling atas pada output JSON.
  2. ATURAN REASONING: WAJIB SANGAT SINGKAT! Maksimal 2 kalimat pendek.
  3. CRITICAL WARNING: Pastikan output JSON tertutup sempurna ( } atau ] ) di bagian akhir.
  4. TOKEN ECONOMY (SANGAT PENTING): Untuk menghemat token dan mencegah truncation, JANGAN PERNAH menulis key yang nilainya kosong/null di dalam array. Jika data tidak ada di dokumen fisik, hapus/abaikan saja key tersebut. Sistem backend kami yang akan memformat ulang nanti.
  `;

  const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');
  const isPdf = mimeType === 'application/pdf';

  // ==============================================================
  // 🚀 HELPER 1: SHAPE-BASED ARRAY FINDER
  // ==============================================================
  const findTabularArray = (data) => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const value of Object.values(data)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') return value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const subValue of Object.values(value)) {
            if (Array.isArray(subValue) && subValue.length > 0 && typeof subValue[0] === 'object') return subValue;
          }
        }
      }
    }
    return null;
  };

  // ==============================================================
  // 🚀 HELPER 2: ENTERPRISE DEEP MERGER (Aman untuk Nested Invoice List)
  // ==============================================================
  const mergeArraysDeep = (master, batch) => {
    if (!master || typeof master !== 'object' || !batch || typeof batch !== 'object') return;

    Object.keys(batch).forEach((key) => {
      const batchVal = batch[key];

      if (Array.isArray(batchVal)) {
        if (!master[key]) master[key] = [];

        // Penanganan Khusus untuk Nested Wrapper (seperti invoice_list.items)
        if (key === 'invoice_list' && master[key].length > 0 && batchVal.length > 0) {
          if (batchVal[0].items && Array.isArray(batchVal[0].items)) {
            if (!master[key][0].items) master[key][0].items = [];
            master[key][0].items.push(...batchVal[0].items);
          }
        } else {
          // Merge Normal untuk Array murni seperti details_list atau banks
          master[key].push(...batchVal);
        }
      }
      else if (batchVal !== null && typeof batchVal === 'object') {
        if (!master[key] || typeof master[key] !== 'object') master[key] = {};
        mergeArraysDeep(master[key], batchVal);
      }
      // Jaga Header: Jangan timpa data header yang sudah ada di master dengan data null dari batch
      else if (batchVal !== null && batchVal !== '') {
        if (!master[key] || master[key] === '' || master[key] === null) {
          master[key] = batchVal;
        }
      }
    });
  };

  // ==============================================================
  // 🚀 HELPER 3: THE SELF-HEALING ENGINE
  // ==============================================================
  const callGeminiWithRetry = async (geminiContents, maxRetries = 3) => {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        attempt++;
        const response = await ai.models.generateContent({
          model: MODELS.FLAGSHIP,
          contents: geminiContents,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1 + (attempt * 0.1),
            maxOutputTokens: 8192
          }
        });
        return { parsedData: cleanAIJson(response.text), usageMetadata: response.usageMetadata || {} };
      } catch (error) {
        console.warn(`\n[AI-SERVICE] ⚠️ JSON Truncation Error pada Attempt ${attempt}/${maxRetries}: ${error.message}`);
        if (attempt >= maxRetries) throw new Error(`AI Gagal mereturn JSON valid: ${error.message}`);
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  };

  let finalParsedData = null;
  const totalUsage = { input_total: 0, input_text: 0, ocr: 0, output: 0, total: 0 };

  // ==============================================================
  // JALUR 1: EXCEL MAP-REDUCE PROCESSING
  // ==============================================================
  if (isExcel) {
    console.log('\n[AI-SERVICE] [EXCEL MODE] Menerapkan Map-Reduce Batching...');
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const targetSheetName = sheetName || workbook.SheetNames[0];
    const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[targetSheetName]);
    const csvLines = csvData.split('\n').filter((line) => line.replace(/,/g, '').trim() !== '');

    const ANCHOR_LINES_COUNT = Math.min(20, csvLines.length);
    const anchorCsv = csvLines.slice(0, ANCHOR_LINES_COUNT).join('\n');
    const dataCsvLines = csvLines.slice(ANCHOR_LINES_COUNT);

    const BATCH_SIZE = 15;
    const batches = [];

    if (dataCsvLines.length === 0) {
      batches.push(anchorCsv);
    } else {
      for (let i = 0; i < dataCsvLines.length; i += BATCH_SIZE) {
        const chunk = dataCsvLines.slice(i, i + BATCH_SIZE).join('\n');
        batches.push(`${anchorCsv}\n--- LANJUTAN DATA BARIS KE-${i + 1} ---\n${chunk}`);
      }
    }

    let masterJson = null;
    for (let i = 0; i < batches.length; i++) {
      console.log(`[AI-SERVICE] Memproses Excel Batch ${i + 1}/${batches.length}...`);
      const { parsedData: batchJson, usageMetadata } = await callGeminiWithRetry([prompt, `Berikut adalah data mentah Excel:\n${batches[i]}`]);

      totalUsage.input_total += usageMetadata.promptTokenCount || 0;
      totalUsage.output += usageMetadata.candidatesTokenCount || 0;
      totalUsage.total += usageMetadata.totalTokenCount || 0;

      if (i === 0) masterJson = batchJson;
      else mergeArraysDeep(masterJson, batchJson);
    }
    finalParsedData = masterJson;
  }
  // JALUR 2: PDF PROCESSING (OPTIMIZED FOR CIPL)
  // ==============================================================
  else if (isPdf) {
    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const numPages = pdfDoc.getPageCount();

    // 🚀 OPTIMIZATION 1: HIGH-CAP ONE-SHOT (UP TO 15 PAGES)
    // Gemini Flash sanggup handle 15 hal sekaligus. Lebih akurat karena konteks utuh.
    if (docCode === '001' && numPages <= 15) {
      console.log(`\n[AI-SERVICE] [PDF MODE] High-Cap One-Shot untuk CIPL ${numPages} halaman (Akurasi Maksimal)...`);
      const { parsedData: pdfJson, usageMetadata } = await callGeminiWithRetry([
        prompt,
        { inlineData: { data: fileBuffer.toString('base64'), mimeType: 'application/pdf' } }
      ]);
      finalParsedData = pdfJson;
      totalUsage.input_total = usageMetadata.promptTokenCount || 0;
      totalUsage.output = usageMetadata.candidatesTokenCount || 0;
      totalUsage.ocr = extractOcrTokens(usageMetadata);
      totalUsage.total = usageMetadata.totalTokenCount || 0;
      await debugLog(docCode, 'one_shot_pdf_output', finalParsedData);
    } 
    // 🚀 OPTIMIZATION 2: CONTEXT-AWARE SEQUENTIAL EXTRACTION (> 15 PAGES)
    else {
      console.log(`\n[AI-SERVICE] [PDF MODE] Menerapkan Context-Aware Sequential Extraction (${numPages} hal)...`);
      let masterJson = null;

      for (let i = 0; i < numPages; i++) {
        console.log(`[AI-SERVICE] Memproses PDF Halaman ${i + 1}/${numPages}...`);

        const singlePdf = await PDFDocument.create();
        const [copiedPage] = await singlePdf.copyPages(pdfDoc, [i]);
        singlePdf.addPage(copiedPage);
        const singlePdfBytes = await singlePdf.save();

        // JAHIT KONTEKS: Kirimkan hasil halaman sebelumnya agar AI tidak amnesia
        const contextSummary = masterJson 
          ? `\nPREVIOUS DATA CONTEXT (Sudah diekstrak):\n- Invoice/PL Number: ${masterJson.invoice_number || masterJson.packing_list_number}\n- Last Extracted Items Count: ${masterJson.invoice_list?.[0]?.items?.length || 0}\n`
          : '';

        const pagePrompt = i === 0
          ? prompt
          : `${prompt}\n${contextSummary}\nCRITICAL: Ini adalah HALAMAN LANJUTAN. Gunakan konteks di atas agar tidak menduplikasi data. FOKUS menjahit detail part number ke item yang relevan atau menambah baris baru jika berbeda.`;

        const { parsedData: pageJson, usageMetadata } = await callGeminiWithRetry([
          pagePrompt,
          { inlineData: { data: Buffer.from(singlePdfBytes).toString('base64'), mimeType: 'application/pdf' } }
        ]);
        await debugLog(docCode, `raw_pdf_page_${i + 1}`, pageJson);

        totalUsage.input_total += usageMetadata.promptTokenCount || 0;
        totalUsage.output += usageMetadata.candidatesTokenCount || 0;
        totalUsage.ocr += extractOcrTokens(usageMetadata);
        totalUsage.total += usageMetadata.totalTokenCount || 0;

        if (i === 0) masterJson = pageJson;
        else mergeArraysDeep(masterJson, pageJson);
      }
      finalParsedData = masterJson;
      await debugLog(docCode, 'merged_pdf_output', finalParsedData);
    }
    }
  }
  // ==============================================================
  // JALUR 3: IMAGE PROCESSING (Normal 1-Shot)
  // ==============================================================
  else {
    const { parsedData: imgJson, usageMetadata } = await callGeminiWithRetry([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType: mimeType } }
    ]);
    finalParsedData = imgJson;
    totalUsage.input_total = usageMetadata.promptTokenCount || 0;
    totalUsage.output = usageMetadata.candidatesTokenCount || 0;
    totalUsage.ocr = extractOcrTokens(usageMetadata);
    totalUsage.total = usageMetadata.totalTokenCount || 0;
  }

  totalUsage.input_text = Math.max(0, totalUsage.input_total - totalUsage.ocr);

  // =================================================================
  // 🚀 POST-PROCESSING 1: REASONING CLEANUP
  // =================================================================
  if (finalParsedData && finalParsedData._reasoning) console.log(`[AI-SERVICE] AI Reasoning: ${finalParsedData._reasoning}`);
  if (Array.isArray(finalParsedData)) finalParsedData.forEach((item) => delete item._reasoning);
  else if (finalParsedData && typeof finalParsedData === 'object') delete finalParsedData._reasoning;

  // =================================================================
  // 🚀 POST-PROCESSING 2: UNIVERSAL FORWARD-FILL (O(N))
  // =================================================================
  const fillableFields = ['date_of_invoice', 'invoice_number', 'hs_code', 'origin_criteria'];
  const targetArray = findTabularArray(finalParsedData);

  if (targetArray && targetArray.length > 0) {
    const memory = {};
    targetArray.forEach((row) => {
      if (row && typeof row === 'object') {
        fillableFields.forEach((field) => {
          if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
            memory[field] = row[field];
          } else if (memory[field] !== undefined) {
            row[field] = memory[field];
          }
        });
      }
    });
  }

  // =================================================================
  // 🚀 POST-PROCESSING 3: DOCUMENT-SPECIFIC BUSINESS RULES (RULE ENGINE)
  // =================================================================
  applyBusinessRules(docCode, finalParsedData);

  // =================================================================
  // 🚀 POST-PROCESSING 4: SCHEMA CONTRACT ENFORCER
  // =================================================================
  const strictParsedData = enforceSchemaStrictness(finalParsedData, jsonSchema);
  await debugLog(docCode, 'final_strict_schema_output', strictParsedData);

  return {
    data: strictParsedData,
    usage: totalUsage,
    model_used: MODELS.FLAGSHIP
  };
};