/* eslint-disable prefer-const */
/* eslint-disable camelcase */
import dotenv from 'dotenv';
import path from 'path';
import * as xlsx from 'xlsx';
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
  console.log('\n===========================================');
  console.log(`[BOUNDARY WORKER] Job ID: ${job.id} | Dimulai`);

  // Kita gunakan 'let' pada absoluteFilePath dan mimeType agar bisa diubah.
  let { sourceFileId, absoluteFilePath, fileName, mimeType, manualDocType } = job.data;
  const startTime = new Date();

  try {
    await SourceFileRepositories.updateStatus(sourceFileId, 'processing');
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 5 });

    let isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');

    // ==============================================================
    // 🪄 ILUSI GOTENBERG & SANITASI EXCEL
    // ==============================================================
    if (isExcel) {
      console.log('[BOUNDARY WORKER] Menerima Excel. Memulai sanitasi Hidden Sheets...');

        // 1. Baca Excel asli
        const rawExcelBuffer = await fs.readFile(absoluteFilePath);
        const workbook = xlsx.read(rawExcelBuffer, { type: 'buffer' });
      
        // Pastikan struktur Workbook ada
        workbook.Workbook = workbook.Workbook || {};
      
        const originalSheetNames = [...workbook.SheetNames];
        const sheetMetaList = workbook.Workbook.Sheets || [];
      
        // 2. Tentukan sheet mana yang visible
        const visibleSheets = originalSheetNames.filter((sheetName, idx) => {
          const meta = sheetMetaList[idx];
          const isHidden = meta && (meta.Hidden === 1 || meta.Hidden === 2);
      
          if (isHidden) {
            console.log(`[BOUNDARY WORKER] Sheet dibuang (Hidden): "${sheetName}"`);
          } else {
            console.log(`[BOUNDARY WORKER] Sheet dipertahankan: "${sheetName}"`);
          }
      
          return !isHidden;
        });
      
        if (visibleSheets.length === 0) {
          throw new Error('VALIDATION_ERROR: Semua sheet di Excel dalam kondisi hidden.');
        }
      
        // 3. Hapus sheet hidden dari Sheets (DATA)
        originalSheetNames.forEach((sheetName) => {
          if (!visibleSheets.includes(sheetName)) {
            delete workbook.Sheets[sheetName];
          }
        });
      
        // 4. Filter metadata
        if (sheetMetaList.length > 0) {
          workbook.Workbook.Sheets = sheetMetaList.filter((_, idx) => {
            const name = originalSheetNames[idx];
            return visibleSheets.includes(name);
          });
        }
      
        // 5. Update SheetNames
        workbook.SheetNames = visibleSheets;
      
        // 6. Set active sheet
        workbook.Workbook.Views = [{ activeTab: 0 }];
      
        console.log('[BOUNDARY WORKER] Hidden sheet berhasil dihapus. Mengirim ke Gotenberg...');
      
        // 7. Convert tanpa merusak layout
        const cleanExcelBuffer = xlsx.write(workbook, {
          type: 'buffer',
          bookType: 'xlsx',
          cellStyles: true
        });
      
        // 8. Convert ke PDF
        const pdfBuffer = await convertExcelToPdf(cleanExcelBuffer, fileName);
      
        // 9. Simpan
        const parsedPath = path.parse(absoluteFilePath);
        const newPdfPath = path.join(parsedPath.dir, `${parsedPath.name}_converted.pdf`);
      
        await fs.writeFile(newPdfPath, pdfBuffer);
        console.log(`[BOUNDARY WORKER] PDF URL: /${path.basename(newPdfPath)}`);
      
        // 10. Override pipeline
        absoluteFilePath = newPdfPath;
        mimeType = 'application/pdf';
        isExcel = false;

      console.log('[BOUNDARY WORKER] Excel kini diperlakukan sebagai PDF.');
    }

    // Identifikasi ulang mimeType setelah proses (mungkin) konversi
    const isPdf = mimeType === 'application/pdf';
    const isImage = mimeType.startsWith('image/');

    // -------------------------------------------------------
    // FASE 1: SEGMENTASI (Routing ke Handler)
    // -------------------------------------------------------
    let segmentationResult;
    let fileBuffer;

    if (isPdf) {
      console.log('[BOUNDARY WORKER] Mode: PDF');
      segmentationResult = await processPdfBoundary(absoluteFilePath, mimeType, manualDocType);
    } else if (isImage) {
      console.log('[BOUNDARY WORKER] Mode: Image');
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

    console.log(`[BOUNDARY WORKER] Ditemukan ${documents.length} sub-dokumen.`);

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
      const loaded = await loadMasterPdf(absoluteFilePath);
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
          splitFilePath = await splitAndUploadPdf(doc, docRecord.id, masterPdfBuffer, masterPdfDoc, totalPages, mimeType);
        } else {
          splitFilePath = await uploadNonPdfFile(fileBuffer, docRecord.id, mimeType);
        }

        // C. Dispatch ke Extraction Queue
        await DocumentRepositories.updateFilePath(docRecord.id, splitFilePath);
        const jobTracking = await ExtractionJobRepositories.create(docRecord.id, null, 'queued');

        const extractJob = await extractionQueue.add('extract-data', {
          documentId: docRecord.id,
          sourceFileId,
          splitFilePath,
          docCode: doc.doc_code, // 🚨 Dokumen ini sekarang akan di-ekstrak layaknya PDF.
          mimeType,
          sheetName: doc.sheetName ?? null
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true
        });

        await ExtractionJobRepositories.updateBullmqId(jobTracking.id, extractJob.id);
      }));

      console.log(`[BOUNDARY WORKER] Batch ${i + 1}-${Math.min(i + BATCH_SIZE, documents.length)} selesai.`);
    }

    // -------------------------------------------------------
    // FASE 3: CLEANUP
    // -------------------------------------------------------
    masterPdfDoc = null;
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'processing', progress: 10 });
    console.log(`[BOUNDARY WORKER] Job ID: ${job.id} | SELESAI`);
    console.log('===========================================\n');

    return { status: 'success', sourceFileId };

  } catch (error) {
    console.error(`\n[BOUNDARY WORKER] FATAL ERROR pada Job ${job.id}:`, error.message);
    await SourceFileRepositories.updateStatus(sourceFileId, 'failed', error.message);
    socketEmitter.emit('source-file-update', { source_file_id: sourceFileId, status: 'failed' });
    throw error;
  }
}, {
  connection,
  concurrency: 1, // Tetap 1 untuk antrean boundary.
  lockDuration: 15 * 60 * 1000
});
