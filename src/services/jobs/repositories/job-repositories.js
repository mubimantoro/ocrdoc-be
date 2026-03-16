/* eslint-disable camelcase */
import pool from '../../../config/database.js';
import { NotFoundError } from '../../../exceptions/index.js';

class JobRepositories {
  async findById(id) {
    const { rows } = await pool.query(
      `SELECT ej.id, ej.status, ej.progress, ej.attempt,
      ej.error_message, ej.created_at, ej.updated_at,
      d.id AS doc_id, d.start_page, d.end_page, d.status AS doc_status,
      d.file_path AS doc_file_path,
      dt.code AS dt_code, dt.name AS dt_name,
      sf.id AS sf_id, sf.file_name AS sf_file_name
       FROM extraction_jobs ej
       LEFT JOIN documents d ON d.id = ej.document_id
       LEFT JOIN document_types dt ON dt.id = d.document_type_id
       LEFT JOIN source_files sf ON sf.id = d.source_file_id
       WHERE ej.id = $1 LIMIT 1`, [id]
    );
    if (!rows.length) throw new NotFoundError('Job tidak ditemukan');
    const row = rows[0];
    return {
      id: row.id,
      status: row.status,
      progress: row.progress,
      attempt: row.attempt,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
      document: row.doc_id ? {
        id: row.doc_id,
        start_page: row.start_page,
        end_page: row.end_page,
        status: row.doc_status,
        file_path: row.doc_file_path,
        document_type: row.dt_code ? { code: row.dt_code, name: row.dt_name } : null,
        source_file: row.sf_id ? { id: row.sf_id, file_name: row.sf_file_name } : null,
      } : null,
    };
  }

  async resetForRetry(id) {
    const { rowCount } = await pool.query(
      `UPDATE extraction_jobs
       SET status='queued', progress=0, error_message=NULL, attempt=attempt+1
       WHERE id=$1`, [id]
    );
    if (!rowCount) throw new NotFoundError('Job tidak ditemukan');
  }
}

export default new JobRepositories();