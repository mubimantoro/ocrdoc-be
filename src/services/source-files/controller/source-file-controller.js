/* eslint-disable camelcase */
import { extractionQueue } from '../../../config/queue.js';
import { InvariantError } from '../../../exceptions/index.js';
import { addClient, removeClient } from '../../../sse/index.js';
import { getPdfPageCount } from '../../../utils/pdf-helper.js';
import response from '../../../utils/response.js';
import SourceFileRepositories from '../repositories/source-file-repositories.js';

export const upload = async (req, res, next) => {
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
};

export const getAll = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 10;
    const status = req.query.status || null;
    const validStatuses = ['uploaded', 'processing', 'completed', 'failed', 'pending_review'];
    if (status && !validStatuses.includes(status))
      return next(new InvariantError(`Status tidak valid. Pilihan: ${validStatuses.join(', ')}`));
    const result = await SourceFileRepositories.findAll({ page, limit, status });
    return response(res, 200, 'Berhasil mengambil daftar file', result);
  } catch (err) { next(err); }
};

export const getById = async (req, res, next) => {
  try {
    const sourceFile = await SourceFileRepositories.findById(req.params.id);
    return response(res, 200, 'Berhasil mengambil detail file', sourceFile);
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

export const stream = async (req, res) => {
  const { id } = req.params;
  try {
    await SourceFileRepositories.findById(id);
  } catch {
    return res.status(404).json({ meta: { success: false, message: 'Source file tidak ditemukan' } });
  }

  // SSE headers
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
};