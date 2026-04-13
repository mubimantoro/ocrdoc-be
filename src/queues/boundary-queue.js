/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { Queue, Worker } from 'bullmq';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import SourceFileRepositories from '../services/source-files/repositories/source-file-repositories.js';
import { socketEmitter } from '../config/socket-emitter.js';
import DocumentTypeRepositories from '../services/documents/repositories/document-type-repositories.js';
import VendorRepositories from '../services/documents/repositories/vendor-repositories.js';
import DocumentRepositories from '../services/documents/repositories/document-repositories.js';
import { extractionQueue } from './extraction-queue.js';
import ExtractionJobRepositories from '../services/documents/repositories/extraction-job-repositories.js';
import { detectBoundariesChunked } from '../services/integrations/ai-service.js';
import { uploadToStorage } from '../services/integrations/storage-service.js';

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

export const boundaryQueue = new Queue('boundary-jobs', { connection });

export const boundaryWorker = new Worker('boundary-jobs', async (job) => {
  console.log('\n===========================================');
  console.log(`[BOUNDARY WORKER] Memulai Job ID: ${job.id}`);

  const { sourceFileId, absoluteFilePath, fileName, mimeType, pageCount } = job.data;
  const startTime = new Date();

  try {
    await SourceFileRepositories.updateStatus(sourceFileId, 'processing');
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 5 });

    // ==============================================================
    // 1. FASE AI CHUNKING
    // ==============================================================
    console.log('[BOUNDARY WORKER] Mengirim file ke AI untuk pemetaan halaman...');
    const boundaryResult = await detectBoundariesChunked(absoluteFilePath, mimeType, 30);

    const rateInput = parseFloat(process.env.GEMINI_CHEAP_INPUT_RATE);
    const rateOutput = parseFloat(process.env.GEMINI_CHEAP_OUTPUT_RATE);
    const cheapPrice = (boundaryResult.usage.input_total * rateInput) + (boundaryResult.usage.output * rateOutput);

    await SourceFileRepositories.updateInitialMetrics(sourceFileId, {
      input: boundaryResult.usage.input_text,
      output: boundaryResult.usage.output,
      ocr: boundaryResult.usage.ocr,
      price: cheapPrice,
      startedAt: startTime,
      modelUsed: boundaryResult.model_used
    });

    const documents = boundaryResult.documents || [];
    console.log(`[BOUNDARY WORKER] Ditemukan ${documents.length} sub-dokumen.`);

    // ==============================================================
    // 2. FASE SPLITTING & BATCHING I/O
    // ==============================================================
    let masterPdfBuffer = await fs.readFile(absoluteFilePath);
    let masterPdfDoc = await PDFDocument.load(masterPdfBuffer, { ignoreEncryption: true });
    const maxPages = masterPdfDoc.getPageCount(); // Diperlukan untuk validasi AI

    const BATCH_SIZE = 10;

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batchDocs = documents.slice(i, i + BATCH_SIZE);

      const batchPromises = batchDocs.map(async (doc) => {
        // A. Operasi Database
        const documentTypeId = await DocumentTypeRepositories.findIdByCode(doc.doc_code);
        let vendorId = null;
        if (doc.vendor && doc.vendor.trim() !== '') {
          vendorId = await VendorRepositories.findOrCreateByName(doc.vendor);
        }

        const docRecord = await DocumentRepositories.create(
          sourceFileId,
          vendorId,
          documentTypeId,
          null,
          doc.start_page,
          doc.end_page,
          doc.document_number,
          'queued'
        );

        // B. Validasi Boundary & Manipulasi PDF
        const safeStart = Math.max(1, doc.start_page);
        const safeEnd = Math.min(maxPages, doc.end_page);

        const newPdf = await PDFDocument.create();
        const pageIndices = Array.from(
          { length: (safeEnd - safeStart) + 1 },
          (_, idx) => safeStart - 1 + idx // Base-0 index
        );

        const copiedPages = await newPdf.copyPages(masterPdfDoc, pageIndices);
        copiedPages.forEach((page) => newPdf.addPage(page));

        const splitPdfBuffer = Buffer.from(await newPdf.save());
        const splitFileName = `split-${docRecord.id}-${Date.now()}.pdf`;

        // C. Operasi I/O
        const splitFilePath = await uploadToStorage(splitFileName, splitPdfBuffer, 'application/pdf');
        await DocumentRepositories.updateFilePath(docRecord.id, splitFilePath);

        const jobTracking = await ExtractionJobRepositories.create(docRecord.id, null, 'queued');

        const extractJob = await extractionQueue.add('extract-data', {
          documentId: docRecord.id,
          sourceFileId,
          splitFilePath,
          docCode: doc.doc_code
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true
        });

        await ExtractionJobRepositories.updateBullmqId(jobTracking.id, extractJob.id);
      });

      await Promise.all(batchPromises);
      console.log(`[BOUNDARY WORKER] Batch memproses dokumen ${i + 1} s/d ${Math.min(i + BATCH_SIZE, documents.length)} selesai.`);
    }

    // ==============================================================
    // 3. CLEANUP
    // ==============================================================
    masterPdfDoc = null;
    masterPdfBuffer = null;

    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 10 });
    console.log(`[BOUNDARY WORKER] Job ${job.id} SELESAI.`);
    console.log('===========================================\n');
    return { status: 'success', sourceFileId };

  } catch (error) {
    console.error(`\n[BOUNDARY WORKER] FATAL ERROR PADA JOB ${job.id}:`, error.message);

    await SourceFileRepositories.updateStatus(sourceFileId, 'failed');
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'failed' });
    throw error;
  }
}, {
  connection,
  concurrency: 1,
  lockDuration: 15 * 60 * 1000
});