import * as xlsx from 'xlsx';
import { callGeminiWithRetry, mergeArraysDeep } from '../helpers.js';

/**
 * HANDLER: EXCEL MAP-REDUCE
 */
export const processExcelExtraction = async (fileBuffer, sheetName, prompt, tokenUsage) => {
  console.log('\n[AI-SERVICE] [EXCEL MODE] Menerapkan Map-Reduce Batching...');
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const targetSheetName = sheetName || workbook.SheetNames[0];
  const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[targetSheetName]);
  const csvLines = csvData.split('\n').filter((line) => line.replace(/,/g, '').trim() !== '');

  const ANCHOR_LINES_COUNT = Math.min(20, csvLines.length);
  const anchorCsv = csvLines.slice(0, ANCHOR_LINES_COUNT).join('\n');
  const dataCsvLines = csvLines.slice(ANCHOR_LINES_COUNT);

  const BATCH_SIZE = 50;
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

    tokenUsage.inputTotal += usageMetadata.promptTokenCount || 0;
    tokenUsage.output += usageMetadata.candidatesTokenCount || 0;
    tokenUsage.total += usageMetadata.totalTokenCount || 0;

    if (i === 0) masterJson = batchJson;
    else mergeArraysDeep(masterJson, batchJson);
  }
  return masterJson;
};
