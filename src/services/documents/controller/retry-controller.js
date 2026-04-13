/* eslint-disable camelcase */
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import { extractionQueue } from '../../../queues/extraction-queue';
import response from '../../../utils/response';
import DocumentRepositories from '../repositories/document-repositories.js';

export const retryDocumentJob = async (req, res, next) => {
  try {
    const { id } = req.params;
    const doc = await DocumentRepositories.findById(id);

    if (!doc) {
      return next(new NotFoundError(`Dokumen dengan ID ${id} tidak ditemukan.`));
    }

    if (doc.status !== 'failed') {
      return next(new InvariantError(`Dokumen ini tidak dalam status gagal (Status saat ini: ${doc.status}). Tidak perlu di-retry.`));
    }

    // Ubah status kembali menjadi queued
    await DocumentRepositories.updateStatus(id, 'queued');

    // Masukkan kembali ke antrean
    await extractionQueue.add('extract-data', {
      documentId: doc.id,
      fileName: doc.original_file, // Didapat dari relasi JOIN di repository findById
      docCode: doc.document_code,
      startPage: doc.start_page,
      endPage: doc.end_page
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
    });

    return response(res, 200, 'Job berhasil di-retry dan dimasukkan ke antrean', { document_id: id });
  } catch (error) {
    next(error);
  }
};