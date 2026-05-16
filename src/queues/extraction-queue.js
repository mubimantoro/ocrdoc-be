/* eslint-disable camelcase */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { Queue, Worker } from 'bullmq';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import DocumentRepositories from '../services/documents/repositories/document-repositories.js';
import { extractSmartData } from '../services/integrations/ai-service.js';
import { socketEmitter } from '../config/socket-emitter.js';
import SourceFileRepositories from '../services/source-files/repositories/source-file-repositories.js';
import ExtractionJobRepositories from '../services/documents/repositories/extraction-job-repositories.js';
import EavRepositories from '../services/eav/repositories/eav-repositories.js';
import ExtractionResultRepositories from '../services/documents/repositories/extraction-result-repositories.js';
import logger from '../config/logger.js';
import pool from '../config/database.js';
// import { webhookQueue } from './webhook.queue.js';

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

export const extractionQueue = new Queue('extraction-jobs', { connection });

export const extractionWorker = new Worker('extraction-jobs', async (job) => {
  const log = logger.child({
    jobId: job.id,
    documentId: job.data.documentId,
    docCode: job.data.docCode,
    module: 'extraction-worker',
  });

  const {
    documentId,
    sourceFileId,
    splitFilePath,
    docCode,
    mimeType,
    sheetName = null,
    isExcelToPdf = false
  } = job.data;
  let extractionJobRecord;

  try {
    // ==============================================================
    // 1. VALIDASI & INIT STATUS
    // ==============================================================
    extractionJobRecord = await ExtractionJobRepositories.findByDocumentId(documentId);
    if (!extractionJobRecord) throw new Error('Tracking Extraction Job tidak ditemukan.');

    await ExtractionJobRepositories.updateStatusAndProgress(extractionJobRecord.id, 'extracting', 10);
    await DocumentRepositories.updateStatus(documentId, 'extracting');

    socketEmitter.emit('document-status-update', { document_id: documentId, status: 'extracting', message: 'Membaca dokumen kecil...' });

    // ==============================================================
    // 2. DISK I/O & EKSTRAKSI AI
    // ==============================================================
    const absoluteFilePath = path.resolve(splitFilePath);
    const splitPdfBuffer = await fs.readFile(absoluteFilePath);

    await ExtractionJobRepositories.updateStatusAndProgress(extractionJobRecord.id, 'extracting', 30);
    socketEmitter.emit('document-status-update', { document_id: documentId, status: 'extracting', message: 'Menganalisis data via AI...' });

    const startProcessTime = Date.now();

    let actualMimeType = mimeType;
    if (!actualMimeType) {
      const lowerPath = splitFilePath.toLowerCase();
      if (lowerPath.endsWith('.png')) actualMimeType = 'image/png';
      else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) actualMimeType = 'image/jpeg';
      else if (lowerPath.endsWith('.xlsx') || lowerPath.endsWith('.xls')) actualMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      else actualMimeType = 'application/pdf';
    }

    const keepAliveInterval = setInterval(() => {
      pool.query('SELECT 1').catch(() => {});
      log.debug({ event: 'db_heartbeat' }, 'Mencegah DB idle timeout...');
    }, 45000); // Ping TCP setiap 45 detik

    let extracted;
    try {
      extracted = await extractSmartData(splitPdfBuffer, actualMimeType, docCode, sheetName, isExcelToPdf, log);
    } finally {
      // WAJIB matikan interval saat AI selesai agar tidak memory leak
      clearInterval(keepAliveInterval);
    }

    const durationMs = Date.now() - startProcessTime;

    log.info({
      event: 'ai_extraction_completed',
      durationMs,
      modelUsed: extracted.modelUsed,
      tokenInput: extracted.usage.inputTotal,
      tokenOutput: extracted.usage.output,
      tokenOcr: extracted.usage.ocr,
    }, `AI selesai dalam ${durationMs}ms`);

    // ==============================================================
    // 3. KALKULASI BILLING & METRIK (WAJIB AWAIT)
    // ==============================================================
    let rootData = extracted.data;
    if (Array.isArray(rootData) && rootData.length > 0) rootData = rootData[0];
    else if (rootData?.data) rootData = rootData.data;

    const rateInput = parseFloat(process.env.GEMINI_FLAGSHIP_INPUT_RATE);
    const rateOutput = parseFloat(process.env.GEMINI_FLAGSHIP_OUTPUT_RATE);
    const flagshipPrice = (extracted.usage.inputTotal * rateInput) + (extracted.usage.output * rateOutput);

    let rawRoot = extracted.data;
    if (Array.isArray(rawRoot) && rawRoot.length > 0) rawRoot = rawRoot[0];
    const confScore = rawRoot?.confidence_score || rawRoot?.data?.confidence_score;
    const parsedConfidence = (!isNaN(parseFloat(confScore))) ? parseFloat(confScore) : 0;

    await DocumentRepositories.updateMetrics(documentId, {
      tokenInput: extracted.usage.inputText,
      tokenOutput: extracted.usage.output,
      tokenOcr: extracted.usage.ocr,
      totalTokens: extracted.usage.total,
      price: isNaN(flagshipPrice) ? 0 : flagshipPrice,
      durationMs: durationMs,
      modelUsed: extracted.modelUsed,
      confidence: parsedConfidence
    });

    await ExtractionJobRepositories.updateStatusAndProgress(extractionJobRecord.id, 'extracting', 70);

    // ==============================================================
    // 4. PENYIMPANAN EAV (BULK INSERT + HASH MAP SAFETY)
    // ==============================================================
    const rawDataSnapshot = extracted.data;
    const resultRecord = await ExtractionResultRepositories.create(extractionJobRecord.id, rawDataSnapshot);
    let workingData = extracted.data;
    if (Array.isArray(workingData) && workingData.length > 0) workingData = workingData[0];

    const rootKeys = Object.keys(workingData);
    if (rootKeys.length === 1 && workingData[rootKeys[0]]?.data) {
      workingData = workingData[rootKeys[0]].data;
    } else if (workingData.data) {
      workingData = workingData.data;
    }

    const headerFields = {};
    const itemsBulkData = [];
    const itemFieldsMapping = [];
    let rowIndex = 1;

    const clientWrappers = [
      'invoice_list', 'details_list', 'pl_list', 'packaging',
      'containers', 'packs', 'packages', 'invoice_list_number',
      'awb_details', 'mawb', 'hawb', 'shipment'
    ];

    if (workingData && typeof workingData === 'object') {
      for (const [key, value] of Object.entries(workingData)) {
        if (value == null) continue;

        if (key === 'items' && Array.isArray(value)) {
          // Kasus 1: Array items langsung ada di root (Seperti dokumen BL, AWB, dll)
          for (const row of value) {
            if (row && typeof row === 'object') {
              itemsBulkData.push({ row_index: rowIndex });
              itemFieldsMapping.push({ rowIndex, fields: row });
              rowIndex++;
            }
          }
        } else if (clientWrappers.includes(key) && Array.isArray(value)) {
          // Kasus 2: Data dibungkus dalam Wrapper Klien (Seperti invoice_list)
          for (const wrapperObj of value) {
            if (wrapperObj && typeof wrapperObj === 'object') {
              for (const [wKey, wVal] of Object.entries(wrapperObj)) {
                if (wKey === 'items' && Array.isArray(wVal)) {
                  // Ekstrak items dari dalam wrapper
                  for (const row of wVal) {
                    if (row && typeof row === 'object') {
                      itemsBulkData.push({ row_index: rowIndex });
                      itemFieldsMapping.push({ rowIndex, fields: row });
                      rowIndex++;
                    }
                  }
                } else if (Array.isArray(wVal)) {
                  // Array lain di dalam wrapper di-stringify ke header
                  headerFields[`${key}_${wKey}`] = JSON.stringify(wVal);
                } else if (wVal != null) {
                  // Ekstrak header (seperti invoice_number) yang ada di dalam wrapper ke root
                  headerFields[wKey] = String(wVal);
                }
              }
            }
          }
        } else if (Array.isArray(value)) {
          headerFields[key] = JSON.stringify(value);
        } else if (typeof value === 'object') {
          // Flattening bersarang dengan menyambung key
          for (const [subKey, subVal] of Object.entries(value)) {
            if (subVal != null && typeof subVal !== 'object') {
              headerFields[`${key}_${subKey}`] = String(subVal);
            } else if (subVal != null && typeof subVal === 'object') {
              headerFields[`${key}_${subKey}`] = JSON.stringify(subVal);
            }
          }
        } else {
          // Kasus primitive biasa
          headerFields[key] = String(value);
        }
      }


      // A. Bulk Insert Header Fields
      const excludedKeys = ['doc_code', 'doc_name', 'confidence_score', '_reasoning'];

      const fieldsPayload = Object.entries(headerFields)
        .filter(([key, val]) => val != null && typeof val !== 'object' && !excludedKeys.includes(key))
        .map(([key, val]) => ({
          extractionResultId: resultRecord.id,
          key: key,
          value: String(val)
        }));

      if (fieldsPayload.length > 0) {
        await EavRepositories.bulkCreateFields(fieldsPayload);
      }

      // B. Bulk Insert Items & Item Fields
      if (itemsBulkData.length > 0) {
        const itemsPayload = itemsBulkData.map((item) => ({
          extractionResultId: resultRecord.id,
          rowIndex: item.row_index
        }));

        const insertedItems = await EavRepositories.bulkCreateItems(itemsPayload);

        // Map ID dari DB ke rowIndex untuk keamanan relasi data
        const indexToIdMap = {};
        for (const itemDb of insertedItems) {
          const dbRowIndex = itemDb.row_index || itemDb.rowIndex;
          indexToIdMap[dbRowIndex] = itemDb.id;
        }

        const itemFieldsPayload = [];
        for (const mapping of itemFieldsMapping) {
          const actualItemId = indexToIdMap[mapping.rowIndex];
          if (!actualItemId) continue;

          for (const [colKey, colVal] of Object.entries(mapping.fields)) {
            if (colVal != null) {
              itemFieldsPayload.push({
                itemId: actualItemId,
                key: colKey,
                value: typeof colVal === 'object' ? JSON.stringify(colVal) : String(colVal)
              });
            }
          }
        }

        if (itemFieldsPayload.length > 0) {
          await EavRepositories.bulkCreateItemFields(itemFieldsPayload);
        }
      }
    }

    // ==============================================================
    // 5. STATUS AGGREGATION & FINALIZATION
    // ==============================================================
    await ExtractionJobRepositories.updateStatusAndProgress(extractionJobRecord.id, 'completed', 100);
    await DocumentRepositories.updateStatus(documentId, 'completed');

    const allDocs = await DocumentRepositories.findAllBySourceFileId(sourceFileId);
    const finishedCount = allDocs.filter((doc) => ['completed', 'failed'].includes(doc.status)).length;
    const isAllFinished = finishedCount === allDocs.length;

    if (isAllFinished) {
      await SourceFileRepositories.finalizeMetrics(sourceFileId);
      socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'completed' });
    } else {
      await SourceFileRepositories.updateProgress(sourceFileId, Math.round((finishedCount / allDocs.length) * 100));
    }

    socketEmitter.emit('document-status-update', { document_id: documentId, status: 'completed' });

    log.info({ event: 'job_completed' }, 'Job selesai');
    return { status: 'success', documentId };

  } catch (error) {
    log.error({
      event: 'job_failed',
      err: error, // Pino otomatis serialize err.message + err.stack
    }, `Job gagal: ${error.message}`);

    if (extractionJobRecord) {
      await ExtractionJobRepositories.updateStatusAndProgress(extractionJobRecord.id, 'failed', 0, error.message)
        .catch((e) => log.warn({ event: 'fallback_db_error', err: e }, 'Gagal update extraction job status'));
    }
    await DocumentRepositories.updateStatus(documentId, 'failed', error.message)
      .catch((e) => log.warn({ event: 'fallback_db_error', err: e }, 'Gagal update document status'));

    socketEmitter.emit('document-status-update', { document_id: documentId, status: 'failed', message: error.message });

    try {
      const allDocs = await DocumentRepositories.findAllBySourceFileId(sourceFileId);
      if (allDocs.length > 0 && allDocs.every((doc) => ['completed', 'failed'].includes(doc.status))) {
        await SourceFileRepositories.finalizeMetrics(sourceFileId);
        socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'completed' });
      }
    } catch (parentCheckError) {
      log.warn({ event: 'parent_status_check_failed', err: parentCheckError },
        'Gagal mengevaluasi parent source file status');
    }

    throw error;
  }
}, { connection,
  concurrency: 20,
  lockDuration: 5 * 60 * 1000 });