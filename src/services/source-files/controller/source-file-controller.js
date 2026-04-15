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

/**
 * ==========================================
 * UPLOAD FILE (Asynchronous Pipeline)
 * ==========================================
 */
export const uploadFile = async (req, res, next) => {
  try {
    const file = req.file;
    const { doc_type } = req.body;
    if (!file) return next(new InvariantError('File PDF wajib diunggah.'));

    // Mengambil metadata dari diskStorage Multer
    const fileName = file.filename;
    const absoluteFilePath = file.path;
    const mimeType = file.mimetype;

    const relativeFilePath = `uploads/${fileName}`;

    const isPdf = mimeType === 'application/pdf';
    const isImage = mimeType.startsWith('image/');
    const isExcel = mimeType.includes('excel') || mimeType.includes('spreadsheetml');

    // Ekstrak Total Halaman
    let pageCount =  1;

    if (isPdf) {
      try {
        const fileBuffer = await fs.readFile(absoluteFilePath);
        const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        pageCount = pdfDoc.getPageCount();
      } catch (err) {
        return next(new InvariantError('Dokumen PDF rusak, terenkripsi, atau dilindungi kata sandi.'));
      }
    } else if (!isImage && !isExcel) {
      return next(new InvariantError(`Tipe file tidak didukung oleh sistem: ${mimeType}`));
    }

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
      pageCount: pageCount,
      manualDocType: doc_type,
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