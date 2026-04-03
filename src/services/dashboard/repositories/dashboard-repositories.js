/* eslint-disable camelcase */
import pool from '../../../config/database.js';

class DashboardRepositories {

  async getStats() {
    const { rows } = await pool.query(`
      SELECT
        -- Processed today (source files)
        COUNT(*) FILTER (
          WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE
            AND status != 'uploaded'
        ) AS processed_today,

        -- Processed yesterday (untuk hitung persentase)
        COUNT(*) FILTER (
          WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE - INTERVAL '1 day'
            AND status != 'uploaded'
        ) AS processed_yesterday,

        -- Currently processing
        COUNT(*) FILTER (
          WHERE status = 'processing'
        ) AS currently_processing

      FROM source_files
    `);

    const { rows: jobRows } = await pool.query(`
      SELECT
        -- Completed jobs today
        COUNT(*) FILTER (
          WHERE status = 'completed'
            AND DATE(completed_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE
        ) AS completed_today,

        -- Failed jobs today
        COUNT(*) FILTER (
          WHERE status = 'failed'
            AND DATE(updated_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE
        ) AS failed_today

      FROM extraction_jobs
    `);

    return {
      source_files: rows[0],
      jobs: jobRows[0],
    };
  }
}

export default new DashboardRepositories();