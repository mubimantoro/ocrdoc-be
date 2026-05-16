import pool from '../../../config/database.js';
import logger from '../../../config/logger.js';
import { InvariantError } from '../../../exceptions/index.js';

class ExtractionResultRepositories {
  /**
   * Membuat rekaman hasil ekstraksi yang terikat pada suatu Job
   */
  async create(extractionJobId, rawData) {
    const safeJsonString = JSON.stringify(rawData);

    const insertQuery = `
      INSERT INTO extraction_results (extraction_job_id, raw_data) 
      VALUES ($1, $2) 
      RETURNING *;
    `;

    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await pool.query(insertQuery, [extractionJobId, safeJsonString]);

        if (!result.rows[0]) {
          throw new InvariantError('Gagal membuat Extraction Result');
        }

        return result.rows[0];
      } catch (error) {
        // A. Deteksi Error Jaringan (TCP Drop / Connection Reset)
        const isConnectionError = error.message && (
          error.message.includes('Connection terminated') ||
          error.message.includes('connection error') ||
          error.code === 'ECONNRESET' ||
          error.code === '57P01' ||
          error.code === '08P01'
        );

        if (isConnectionError) {
          logger.warn(
            { event: 'db_connection_retry', attempt, extractionJobId, err: error.message },
            `[DB WARNING] Koneksi DB terputus. Mencoba ulang (${attempt}/${maxRetries})...`
          );

          if (attempt >= maxRetries) throw error;

          // [FIX] Resolusi Typo sebelumnya. Jeda eksponensial.
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        // Jika terjadi konflik UNIQUE constraint (23505), ini berarti Worker sedang melakukan RETRY
        if (error.code === '23505') {
          logger.warn(`[RETRY DETECTED] Membersihkan sisa data EAV lama untuk Job ${extractionJobId}...`);
          await pool.query('DELETE FROM extraction_results WHERE extraction_job_id = $1', [extractionJobId]);

          // REPLACE: Masukkan kembali sebagai lembaran baru yang bersih
          const retryResult = await pool.query(insertQuery, [extractionJobId, safeJsonString]);
          return retryResult.rows[0];
        }

        throw error;
      }
    }
  }
  /**
   * (Opsional) Mengambil ID hasil ekstraksi berdasarkan Job ID
   */
  async findByJobId(extractionJobId) {
    const query = 'SELECT * FROM extraction_results WHERE extraction_job_id = $1';
    const result = await pool.query(query, [extractionJobId]);
    return result.rows[0] || null;
  }
}

export default new ExtractionResultRepositories();