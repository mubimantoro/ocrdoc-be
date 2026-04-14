import pool from '../../../config/database.js';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';

class ExtractionJobRepositories {
  /**
   * Membuat rekaman antrean baru saat file PDF dipotong dan dimasukkan ke BullMQ
   */
  async create(documentId, bullmqJobId = null, status = 'queued') {
    const query = `
      INSERT INTO extraction_jobs (document_id, bullmq_job_id, status) 
      VALUES ($1, $2, $3) 
      RETURNING *;
    `;
    const result = await pool.query(query, [documentId, bullmqJobId, status]);

    if (!result.rows[0]) {
      throw new InvariantError('Gagal membuat Extraction Job.');
    }

    return result.rows[0];
  }

  /**
   * Memperbarui status, progress, dan pesan error dari dalam Worker
   */
  async updateStatusAndProgress(id, status, progress = 0, errorMessage = null) {
    const query = `
      UPDATE extraction_jobs 
      SET 
        status = $1, 
        progress = $2, 
        error_message = $3, 
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = $4 
      RETURNING *;
    `;
    const result = await pool.query(query, [status, progress, errorMessage, id]);

    if (!result.rows.length) {
      throw new NotFoundError(`Gagal update: Extraction Job ID ${id} tidak ditemukan.`);
    }

    return result.rows[0];
  }

  async findByDocumentId(documentId) {
    const query = {
      text: `SELECT * FROM extraction_jobs 
             WHERE document_id = $1 
             ORDER BY created_at DESC 
             LIMIT 1`,
      values: [documentId],
    };

    const result = await pool.query(query);
    return result.rows[0];
  }

  /**
   * Memperbarui BullMQ Job ID setelah job berhasil dimasukkan ke antrean
   */
  async updateBullmqId(id, bullmqJobId) {
    const query = `
      UPDATE extraction_jobs 
      SET bullmq_job_id = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [bullmqJobId, id]);
    if (!result.rows.length) {
      throw new NotFoundError(`Gagal update: Extraction Job ID ${id} tidak ditemukan.`);
    }
    return result.rows[0];
  }
}

export default new ExtractionJobRepositories();