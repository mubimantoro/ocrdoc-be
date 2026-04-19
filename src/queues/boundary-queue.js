/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { Queue, Worker } from 'bullmq';
import * as xlsx from 'xlsx';

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
import { detectBoundaries, detectBoundariesChunked } from '../services/integrations/ai-service.js';
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

  const { sourceFileId, absoluteFilePath, fileName, mimeType, manualDocType, pageCount } = job.data;
  const startTime = new Date();

  try {
    await SourceFileRepositories.updateStatus(sourceFileId, 'processing');
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 5 });

    const isPdf = mimeType === 'application/pdf';
    const isImage = mimeType.startsWith('image/');
    const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');

    let documents = [];
    let boundaryUsage = { inputText: 0, output: 0, ocr: 0, total: 0 };
    let modelUsed = null;

    // ==============================================================
    // 1. FASE AI SEGMENTATION & CLASSIFICATION
    // ==============================================================
    const fileBuffer = await fs.readFile(absoluteFilePath);

    if (isPdf) {
      console.log('[BOUNDARY WORKER] [PDF MODE] Memulai AI Segmentation...');

      // 1. AI SEGMENTATION: Selalu jalankan AI untuk memotong PDF (Berapapun tebalnya)
      const boundaryResult = await detectBoundariesChunked(absoluteFilePath, mimeType, 15);
      documents = boundaryResult.documents || [];

      // 2. HYBRID OVERRIDE: Jika user menentukan tipe dokumen manual, timpa hasil klasifikasi AI
      if (manualDocType) {
        console.log(`[BOUNDARY WORKER] [HYBRID MODE] Menerapkan Override Klasifikasi ke tipe '${manualDocType}' pada ${documents.length} dokumen.`);
        documents = documents.map((doc) => ({
          ...doc,
          doc_code: manualDocType
        }));
      }

      boundaryUsage = boundaryResult.usage;
      modelUsed = boundaryResult.modelUsed;

    } else if (isImage) {
      console.log('[BOUNDARY WORKER] [IMAGE MODE] Membaca gambar tunggal...');
      const boundaryResult = await detectBoundaries(fileBuffer, mimeType, 1, 1);

      documents = (boundaryResult.pages || []).map((doc) => ({
        ...doc,
        start_page: 1,
        end_page: 1,
        doc_code: manualDocType || doc.doc_code // Hybrid Override untuk Gambar
      }));

      boundaryUsage = boundaryResult.usage;
      modelUsed = boundaryResult.modelUsed;

    } else if (isExcel) {
      console.log('[BOUNDARY WORKER] [EXCEL MODE] Memecah Sheets menjadi dokumen terpisah');
      const workbook = xlsx.read(fileBuffer, { type: 'buffer' });

      documents = workbook.SheetNames.map((sheetName) => {
        let docCode = manualDocType; // Hybrid Override

        if (!docCode) {
          const n = sheetName.toUpperCase();
          if (n.includes('INV')) docCode = '380';
          else if (n.includes('PL')) docCode = '217';
          else if (n.includes('CIPL')) docCode = '001';
        }

        if (!docCode) return null;

        return {
          doc_code: docCode,
          sheetName: sheetName,
          start_page: 1,
          end_page: 1,
          document_number: `${fileName}_${sheetName}`,
          vendor: 'EXCEL_SHEET'
        };
      }).filter((doc) => doc !== null);
    }

    const rateInput = parseFloat(process.env.GEMINI_CHEAP_INPUT_RATE);
    const rateOutput = parseFloat(process.env.GEMINI_CHEAP_OUTPUT_RATE);
    const cheapPrice = (boundaryUsage.inputTotal * rateInput) + (boundaryUsage.output * rateOutput);

    await SourceFileRepositories.updateInitialMetrics(sourceFileId, {
      input: boundaryUsage.inputText,
      output: boundaryUsage.output,
      ocr: boundaryUsage.ocr,
      price: isNaN(cheapPrice) ? 0 : cheapPrice,
      startedAt: startTime,
      modelUsed: modelUsed
    });

    console.log(`[BOUNDARY WORKER] Ditemukan ${documents.length} sub-dokumen.`);

    // ==============================================================
    // 2. FASE SPLITTING & BATCHING I/O
    // ==============================================================
    let masterPdfDoc = null;
    let maxPages = 1;

    if (isPdf) {
      masterPdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      maxPages = masterPdfDoc.getPageCount();
    }


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

        // B. FILE MANIPULATION (BYPASS UNTUK NON-PDF)
        let splitFilePath;

        if (isPdf) {
          const safeStart = Math.max(1, doc.start_page);
          const safeEnd = Math.min(maxPages, doc.end_page);

          let splitPdfBuffer;

          // Gunakan buffer asli untuk menghindari "Blank Page Bug" pada layer gambar.
          if (safeStart === 1 && safeEnd === maxPages) {
            console.log(`[BOUNDARY WORKER] Bypass pdf-lib untuk dokumen utuh: ${doc.doc_code}`);
            splitPdfBuffer = fileBuffer;
          } else {
            // Hanya gunakan pdf-lib jika kita benar-benar harus memotong PDF (misal hal 2-3 dari 10 hal)
            const newPdf = await PDFDocument.create();
            const pageIndices = Array.from(
              { length: (safeEnd - safeStart) + 1 },
              (_, idx) => safeStart - 1 + idx // Base-0 index
            );

            const copiedPages = await newPdf.copyPages(masterPdfDoc, pageIndices);
            copiedPages.forEach((page) => newPdf.addPage(page));
            splitPdfBuffer = Buffer.from(await newPdf.save());
          }

          const splitFileName = `split-${docRecord.id}-${Date.now()}.pdf`;
          splitFilePath = await uploadToStorage(splitFileName, splitPdfBuffer, mimeType);
        } else {
          let ext = '.xlsx';
          if (isImage) {
            ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
          }
          const splitFileName = `file-${docRecord.id}-${Date.now()}${ext}`;
          splitFilePath = await uploadToStorage(splitFileName, fileBuffer, mimeType);
        }

        // C. Update dan Masukkan ke Extraction Queue
        await DocumentRepositories.updateFilePath(docRecord.id, splitFilePath);
        const jobTracking = await ExtractionJobRepositories.create(docRecord.id, null, 'queued');

        const extractJob = await extractionQueue.add('extract-data', {
          documentId: docRecord.id,
          sourceFileId,
          splitFilePath,
          docCode: doc.doc_code,
          mimeType: mimeType,
          sheetName: doc.sheetName
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
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 10 });
    console.log(`[BOUNDARY WORKER] Job ${job.id} SELESAI.`);
    console.log('===========================================\n');
    return { status: 'success', sourceFileId };

  } catch (error) {
    console.error(`\n[BOUNDARY WORKER] FATAL ERROR PADA JOB ${job.id}:`, error.message);

    await SourceFileRepositories.updateStatus(sourceFileId, 'failed', error.message);
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'failed' });
    throw error;
  }
}, {
  connection,
  concurrency: 1,
  lockDuration: 15 * 60 * 1000
});