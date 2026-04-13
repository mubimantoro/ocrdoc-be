/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import 'dotenv/config';
import fs from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import { InvariantError } from '../../../exceptions/index.js';
import { extractionQueue } from '../../../queues/extraction-queue.js';
import response from '../../../utils/response.js';
import SourceFileRepositories from '../repositories/source-file-repositories.js';
import { formatSourceFileResponse } from '../../../utils/mapper/source-file.mapper.js';
import { boundaryQueue } from '../../../queues/boundary-queue.js';

/* export const upload = async (req, res, next) => {
  try {
    if (!req.file) return next(new InvariantError('File wajib diupload'));

    const pageCount = await getPdfPageCount(req.file.path);
    const sourceFileId = await SourceFileRepositories.create({
      fileName: req.file.originalname,
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      pageCount,
      uploadedBy: req.user.id,
    });

    await extractionQueue.add(
      'process-document',
      { sourceFileId, filePath: req.file.path }
    );

    const sourceFile = await SourceFileRepositories.findById(sourceFileId);
    return response(res, 200, 'File berhasil diupload dan dimasukkan ke antrian', sourceFile);
  } catch (err) {
    next(err);
  }
}; */

/**
 * ==========================================
 * UPLOAD FILE (Asynchronous Pipeline)
 * ==========================================
 */
export const uploadFile = async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) return next(new InvariantError('File PDF wajib diunggah.'));

    // Mengambil metadata dari diskStorage Multer
    const fileName = file.filename;
    const absoluteFilePath = file.path;
    const mimeType = file.mimetype;

    const relativeFilePath = `uploads/${fileName}`;

    // 1. Ekstrak Total Halaman (Secara efisien)
    let pageCount;
    try {
      // Buffer ini akan langsung dibersihkan oleh Garbage Collector (V8)
      // segera setelah blok try ini selesai, sehingga RAM tetap aman.
      const fileBuffer = await fs.readFile(absoluteFilePath);
      const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      pageCount = pdfDoc.getPageCount();
    } catch (err) {
      return next(new InvariantError('Dokumen PDF rusak, terenkripsi, atau dilindungi kata sandi.'));
    }

    // 2. Buat Rekaman Induk
    const sourceFileRecord = await SourceFileRepositories.create(
      fileName,
      relativeFilePath,
      mimeType,
      pageCount,
      req.user.id,
      'queued'
    );

    // 3. LEMPAR KE BACKGROUND WORKER (O(1) Non-Blocking Network I/O)
    await boundaryQueue.add('detect-boundary', {
      sourceFileId: sourceFileRecord.id,
      absoluteFilePath: absoluteFilePath,
      fileName: fileName,
      mimeType: mimeType,
      pageCount: pageCount
    }, {
      removeOnComplete: true, // Jaga RAM Redis tetap bersih dari job yang sukses
      attempts: 3, // Resiliensi: Jika worker gagal baca file, otomatis coba lagi
      backoff: { type: 'exponential', delay: 5000 }
    });

    // 4. Susun Format Response
    const recordForMapper = {
      ...sourceFileRecord,
      uploaded_by_name: req.user.name
    };

    const formattedData = formatSourceFileResponse(recordForMapper);

    return response(res, 200, 'File berhasil diunggah dan masuk antrean pemrosesan', formattedData);

  } catch (error) {
    next(error);
  }
};

export const getAll = async (req, res, next) => {
  try {
    // 1. Parsing Query Params untuk Pagination (Default: Page 1, Limit 10)
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const offset = (page - 1) * limit;

    const filters = {};
    if (req.query.status) filters.status = req.query.status;

    // 2. Eksekusi Query Paralel (Optimasi Performa)
    const [totalItems, rawData] = await Promise.all([
      SourceFileRepositories.countAll(),
      SourceFileRepositories.findAll(limit, offset)
    ]);

    const formattedData = rawData.map((record) => formatSourceFileResponse(record));

    const totalPages = Math.ceil(totalItems / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return res.status(200).json({
      meta: {
        success: true,
        message: 'Berhasil mengambil daftar file',
      },
      data: formattedData,
      pagination: {
        page,
        limit,
        total_items: totalItems,
        total_pages: totalPages,
        has_next_page: hasNextPage,
        has_prev_page: hasPrevPage
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getById = async (req, res, next) => {
  try {
    const sourceFile = await SourceFileRepositories.findById(req.params.id);
    const formattedData = formatSourceFileResponse(sourceFile);
    return response(res, 200, 'Berhasil mengambil detail file', formattedData);
  } catch (err) { next(err); }
};

export const retry = async (req, res, next) => {
  try {
    const sf = await SourceFileRepositories.findById(req.params.id);
    if (!['failed', 'pending_review'].includes(sf.status))
      return next(new InvariantError('Hanya file \'failed\' atau \'pending_review\' yang bisa di-retry'));

    await SourceFileRepositories.resetForRetry(req.params.id);


    await extractionQueue.add(
      'process-document',
      { sourceFileId: sf.id, filePath: sf.file_path, isRetry: true }
    );

    const updated = await SourceFileRepositories.findById(req.params.id);
    return response(res, 200, 'Retry berhasil dimasukkan ke antrian', updated);
  } catch (err) { next(err); }
};

/* export const stream = async (req, res) => {
  const { id } = req.params;

  try {
    await SourceFileRepositories.findById(id);
  } catch {
    return res.status(404).json({
      meta: { success: false, message: 'Source file tidak ditemukan' },
    });
  }

  res.setHeader('Access-Control-Allow-Origin',  process.env.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials',  'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sourceFile = await SourceFileRepositories.findById(id);
  res.write(`event: connected\ndata: ${JSON.stringify({
    source_file_id: id,
    status: sourceFile.status,
    progress: sourceFile.progress,
  })}\n\n`);

  addClient(id, res);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(id, res);
  });
}; */