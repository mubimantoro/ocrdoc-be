import pool from '../../../config/database.js';
import { extractionQueue } from '../../../config/queue.js';
import InvariantError from '../../../exceptions/invariant-error.js';
import response from '../../../utils/response.js';
import JobRepositories from '../repositories/job-repositories.js';

export const getById = async (req, res, next) => {
  try {
    const job = await JobRepositories.findById(req.params.id);
    return response(res, 200, 'Berhasil mengambil detail job', job);
  } catch (err) { next(err); }
};

export const retry = async (req, res, next) => {
  try {
    const job = await JobRepositories.findById(req.params.id);
    if (job.status !== 'failed')
      return next(new InvariantError('Hanya job \'failed\' yang bisa di-retry'));

    await JobRepositories.resetForRetry(job.id);
    await pool.query(
      'UPDATE documents SET status=\'queued\', error_message=NULL WHERE id=$1',
      [job.document.id]
    );

    await extractionQueue.add(
      'retry-document',
      {
        jobId: job.id,
        documentId: job.document.id,
        filePath: job.document.file_path,
        schemaPath: `schemas/${job.document.document_type?.code || '999'}.json`,
        docCode: job.document.document_type?.code || '999',
        isRetry: true,
      }
    );

    const updated = await JobRepositories.findById(job.id);
    return response(res, 200, 'Retry job berhasil dimasukkan ke antrian', updated);
  } catch (err) {
    next(err);
  }
};
