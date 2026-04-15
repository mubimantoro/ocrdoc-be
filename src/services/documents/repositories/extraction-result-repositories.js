import pool from '../../../config/database.js';
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

    try {
      const result = await pool.query(insertQuery, [extractionJobId, safeJsonString]);

      if (!result.rows[0]) {
        throw new InvariantError('Gagal membuat Extraction Result');
      }

      return result.rows[0];
    } catch (error) {
      // Jika terjadi konflik UNIQUE constraint (23505), ini berarti Worker sedang melakukan RETRY
      if (error.code === '23505') {
        console.warn(`[RETRY DETECTED] Membersihkan sisa data EAV lama untuk Job ${extractionJobId}...`);

        // WIPE: Hapus induknya.
        await pool.query('DELETE FROM extraction_results WHERE extraction_job_id = $1', [extractionJobId]);

        // REPLACE: Masukkan kembali sebagai lembaran baru yang bersih
        const retryResult = await pool.query(insertQuery, [extractionJobId]);
        return retryResult.rows[0];
      }

      throw error;
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