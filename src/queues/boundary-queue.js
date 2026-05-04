/* eslint-disable prefer-const */
/* eslint-disable camelcase */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { Queue, Worker } from 'bullmq';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import SourceFileRepositories from '../services/source-files/repositories/source-file-repositories.js';
import DocumentTypeRepositories from '../services/documents/repositories/document-type-repositories.js';
import VendorRepositories from '../services/documents/repositories/vendor-repositories.js';
import DocumentRepositories from '../services/documents/repositories/document-repositories.js';
import ExtractionJobRepositories from '../services/documents/repositories/extraction-job-repositories.js';
import { socketEmitter } from '../config/socket-emitter.js';
import { extractionQueue } from './extraction-queue.js';

import { processPdfBoundary } from './handlers/pdf-boundary.js';
import { processImageBoundary } from './handlers/image-boundary.js';
import { loadMasterPdf, splitAndUploadPdf, uploadNonPdfFile } from './handlers/pdf-splitter.js';
import { convertExcelToPdf } from '../services/integrations/gotenberg.js';
import logger from '../config/logger.js';

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

export const boundaryQueue = new Queue('boundary-jobs', { connection });

// ==============================================================
// WORKER: ORCHESTRATOR
// Tanggung jawab: Routing per tipe file, update DB & socket,
// dan delegasi logika ke handler yang tepat.
// ==============================================================
export const boundaryWorker = new Worker('boundary-jobs', async (job) => {
  const log = logger.child({
    jobId: job.id,
    sourceFileId: job.data.sourceFileId,
    module: 'boundary-worker',
  });

  let { sourceFileId, absoluteFilePath, fileName, mimeType, manualDocType } = job.data;
  const startTime = new Date();

  try {
    await SourceFileRepositories.updateStatus(sourceFileId, 'processing');
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 5 });

    let isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');
    const wasOriginallyExcel = isExcel;

    // ==============================================================
    //  GOTENBERG
    // ==============================================================
    if (isExcel) {
      log.info({ event: 'excel_conversion_start', fileName }, 'Excel diterima — konversi ke PDF via Gotenberg');

      const rawExcelBuffer = await fs.readFile(absoluteFilePath);

      const pdfBuffer = await convertExcelToPdf(rawExcelBuffer, fileName, log);

      const parsedPath = path.parse(absoluteFilePath);
      const newPdfPath = path.join(parsedPath.dir, `${parsedPath.name}_converted.pdf`);

      await fs.writeFile(newPdfPath, pdfBuffer);

      absoluteFilePath = newPdfPath;
      mimeType = 'application/pdf';
      isExcel = false;

      log.info({
        event: 'excel_conversion_completed',
        fileName,
        convertedPath: path.basename(newPdfPath),
      }, 'Excel berhasil dikonversi ke PDF');
    }

    // Identifikasi ulang mimeType setelah proses (mungkin) konversi
    const isPdf = mimeType === 'application/pdf';
    const isImage = mimeType.startsWith('image/');

    // -------------------------------------------------------
    // FASE 1: SEGMENTASI (Routing ke Handler)
    // -------------------------------------------------------
    let segmentationResult;
    let fileBuffer;

    if (wasOriginallyExcel) {
      log.info({ event: 'segmentation_mode', mode: 'excel_bypass', manualDocType }, 'Mode: Excel — bypass segmentasi AI');


      if (!manualDocType) {
        throw new Error('VALIDATION_ERROR: Doc Type WAJIB dikirim untuk memproses dokumen Excel.');
      }

      // Kita hitung total halamannya menggunakan utilitas yang sudah Anda punya
      const loadedPdf = await loadMasterPdf(absoluteFilePath, log);
      const totalPdfPages = loadedPdf.totalPages;

      segmentationResult = {
        documents: [{
          doc_code: manualDocType,
          start_page: 1,
          end_page: totalPdfPages,
          document_number: null,
          vendor: null
        }],
        usage: { inputTotal: 0, output: 0, ocr: 0, inputText: 0 },
        modelUsed: 'system-bypass'
      };

    } else if (isPdf) {
      log.info({ event: 'segmentation_mode', mode: 'pdf' }, 'Mode: PDF — deteksi boundary via AI');

      segmentationResult = await processPdfBoundary(absoluteFilePath, mimeType, manualDocType, log);
    } else if (isImage) {
      log.info({ event: 'segmentation_mode', mode: 'image' }, 'Mode: Image — deteksi boundary via AI');

      fileBuffer = await fs.readFile(absoluteFilePath);
      segmentationResult = await processImageBoundary(fileBuffer, mimeType, manualDocType);
    } else {
      // Karena isExcel sudah kita ubah menjadi false, jika sampai sini berarti benar-benar format lain.
      throw new Error(`UNSUPPORTED_MIME: Tipe file tidak didukung: ${mimeType}`);
    }

    const { documents, usage: boundaryUsage, modelUsed } = segmentationResult;

    // -------------------------------------------------------
    // Update metrik cost boundary ke DB
    // -------------------------------------------------------
    const rateInput = parseFloat(process.env.GEMINI_CHEAP_INPUT_RATE);
    const rateOutput = parseFloat(process.env.GEMINI_CHEAP_OUTPUT_RATE);
    const cheapPrice = (boundaryUsage.inputTotal * rateInput) + (boundaryUsage.output * rateOutput);

    await SourceFileRepositories.updateInitialMetrics(sourceFileId, {
      input: boundaryUsage.inputText,
      output: boundaryUsage.output,
      ocr: boundaryUsage.ocr,
      price: isNaN(cheapPrice) ? 0 : cheapPrice,
      startedAt: startTime,
      modelUsed
    });

    log.info({
      event: 'segmentation_completed',
      documentCount: documents.length,
      modelUsed,
    }, `Ditemukan ${documents.length} sub-dokumen`);

    if (documents.length === 0) {
      const typeMsg = manualDocType ? `tipe '${manualDocType}'` : 'dokumen yang valid';
      throw new Error(`NOT_FOUND: Sistem tidak menemukan ${typeMsg} di dalam file ini.`);
    }

    // -------------------------------------------------------
    // FASE 2: SPLITTING & DISPATCH KE EXTRACTION QUEUE
    // -------------------------------------------------------
    let masterPdfBuffer = null;
    let masterPdfDoc = null;
    let totalPages = 1;

    if (isPdf) {
      const loaded = await loadMasterPdf(absoluteFilePath, log);
      masterPdfBuffer = loaded.buffer;
      masterPdfDoc = loaded.doc;
      totalPages = loaded.totalPages;
    } else {
      // Untuk non-PDF, baca buffer sekali jika belum dibaca
      if (!fileBuffer) fileBuffer = await fs.readFile(absoluteFilePath);
    }

    const BATCH_SIZE = 10;

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batchDocs = documents.slice(i, i + BATCH_SIZE);
      const batchEnd = Math.min(i + BATCH_SIZE, documents.length);


      await Promise.all(batchDocs.map(async (doc) => {
        // A. Tulis ke Database
        const documentTypeId = await DocumentTypeRepositories.findIdByCode(doc.doc_code);
        let vendorId = null;
        if (doc.vendor?.trim()) {
          vendorId = await VendorRepositories.findOrCreateByName(doc.vendor);
        }

        const docRecord = await DocumentRepositories.create(
          sourceFileId, vendorId, documentTypeId, null,
          doc.start_page, doc.end_page, doc.document_number, 'queued'
        );

        // B. Split & Upload File
        let splitFilePath;
        if (isPdf) {
          splitFilePath = await splitAndUploadPdf(doc, docRecord.id, masterPdfBuffer, masterPdfDoc, totalPages, mimeType, log);
        } else {
          splitFilePath = await uploadNonPdfFile(fileBuffer, docRecord.id, mimeType, log);
        }

        // C. Dispatch ke Extraction Queue
        await DocumentRepositories.updateFilePath(docRecord.id, splitFilePath);
        const jobTracking = await ExtractionJobRepositories.create(docRecord.id, null, 'queued');

        const extractJob = await extractionQueue.add('extract-data', {
          documentId: docRecord.id,
          sourceFileId,
          splitFilePath,
          docCode: doc.doc_code,
          mimeType,
          sheetName: doc.sheetName ?? null,
          isExcelToPdf: wasOriginallyExcel
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true
        });

        await ExtractionJobRepositories.updateBullmqId(jobTracking.id, extractJob.id);

        log.debug({
          event: 'document_dispatched',
          documentId: docRecord.id,
          docCode: doc.doc_code,
          extractJobId: extractJob.id,
          pages: `${doc.start_page}-${doc.end_page}`,
        }, `Dokumen ${doc.doc_code} didispatch ke extraction queue`);
      }));

      log.info({
        event: 'batch_completed',
        batchStart: i + 1,
        batchEnd,
        totalDocuments: documents.length,
      }, `Batch ${i + 1}-${batchEnd} selesai`);
    }

    // -------------------------------------------------------
    // FASE 3: CLEANUP
    // -------------------------------------------------------
    masterPdfDoc = null;
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 10 });

    log.info({ event: 'job_completed' }, 'Boundary job selesai');

    return { status: 'success', sourceFileId };

  } catch (error) {
    log.error({
      event: 'job_failed',
      err: error,
    }, `Boundary job gagal: ${error.message}`);

    await SourceFileRepositories.updateStatus(sourceFileId, 'failed', error.message);
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'failed' });
    throw error;
  }
}, {
  connection,
  concurrency: 1, // Tetap 1 untuk antrean boundary.
  lockDuration: 15 * 60 * 1000
});
