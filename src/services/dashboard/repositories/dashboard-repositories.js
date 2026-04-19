/* eslint-disable camelcase */
import pool from '../../../config/database.js';

class DashboardRepositories {

  async getStats() {
    const { rows } = await pool.query(`
      SELECT
        -- 1. Files yang mulai diproses hari ini (Base Kolom: started_at)
        COUNT(*) FILTER (
          WHERE DATE(started_at AT TIME ZONE 'Asia/Jakarta') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date
        ) AS processed_today,

        -- 2. Files yang mulai diproses kemarin (untuk persentase)
        COUNT(*) FILTER (
          WHERE DATE(started_at AT TIME ZONE 'Asia/Jakarta') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 day'
        ) AS processed_yesterday,

        -- 3. Files yang sedang diproses saat ini
        COUNT(*) FILTER (
          WHERE status = 'processing'
        ) AS currently_processing,

        -- 4. Files yang BERHASIL selesai hari ini
        COUNT(*) FILTER (
          WHERE status = 'completed'
            AND DATE(completed_at AT TIME ZONE 'Asia/Jakarta') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date
        ) AS completed_today,

        -- 5. Files yang GAGAL hari ini
        COUNT(*) FILTER (
          WHERE status = 'failed'
            AND DATE(updated_at AT TIME ZONE 'Asia/Jakarta') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date
        ) AS failed_today

      FROM source_files
    `);

    // Mapping hasil query ke struktur yang diharapkan controller
    const stats = rows[0];

    return {
      source_files: {
        processed_today: stats.processed_today,
        processed_yesterday: stats.processed_yesterday,
        currently_processing: stats.currently_processing
      },
      jobs: {
        completed_today: stats.completed_today,
        failed_today: stats.failed_today
      }
    };
  }
}

export default new DashboardRepositories();