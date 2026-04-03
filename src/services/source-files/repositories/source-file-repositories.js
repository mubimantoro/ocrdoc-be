/* eslint-disable camelcase */
import pool from '../../../config/database.js';
import { NotFoundError } from '../../../exceptions/index.js';

class SourceFileRepositories {
  #mapRow(row) {
    const durationMs = row.started_at && row.completed_at
      ? new Date(row.completed_at) - new Date(row.started_at)
      : null;

    return {
      id: row.id,
      file_name: row.file_name,
      file_path: row.file_path,
      mime_type: row.mime_type,
      page_count: row.page_count,
      status: row.status,
      progress: row.progress,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
      processing_time: durationMs !== null ? {
        started_at:   row.started_at,
        completed_at: row.completed_at,
        duration_ms:  durationMs,
        duration_sec: parseFloat((durationMs / 1000).toFixed(2)),
      } : null,
      pricing: {
        cheap_total_price: parseFloat(row.cheap_total_price  ?? 0),
        smart_total_price: parseFloat(row.flagship_total_price ?? 0),
        total_price: parseFloat(row.total_price ?? 0),
      },
      uploaded_by: row.uploader_id ? {
        id: row.uploader_id, name: row.uploader_name,
        email: row.uploader_email, role: row.uploader_role,
      } : null,
    };
  }

  #baseQuery() {
    return `SELECT sf.id, sf.file_name, sf.mime_type, sf.page_count,
  sf.status, sf.progress, sf.error_message, sf.file_path,
  sf.created_at, sf.updated_at, sf.started_at, sf.completed_at,
   sf.cheap_total_price, sf.flagship_total_price, sf.total_price,
  u.id AS uploader_id,
  u.name  AS uploader_name,
  u.email AS uploader_email,
  r.name  AS uploader_role
  FROM source_files sf
  LEFT JOIN users u ON u.id  = sf.uploaded_by
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id  = ur.role_id`;
  }

  async findAll({ page = 1, limit = 10, status = null } = {}) {
    const offset = (page - 1) * limit;
    const params = [];
    const where  = status ? (params.push(status), 'WHERE sf.status = $1') : '';
    const { rows: cr } = await pool.query(
      `SELECT COUNT(*) AS total FROM source_files sf ${where}`, params
    );
    const total = parseInt(cr[0].total);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `${this.#baseQuery()} ${where} ORDER BY sf.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    return { data: rows.map((r) => this.#mapRow(r)),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } };
  }

  async findById(id) {
    const { rows } = await pool.query(
      `${this.#baseQuery()} WHERE sf.id = $1 LIMIT 1`, [id]
    );
    if (!rows.length) throw new NotFoundError('Source file tidak ditemukan');
    return this.#mapRow(rows[0]);
  }

  async create({ fileName, filePath, mimeType, pageCount, uploadedBy }) {
    const { rows } = await pool.query(
      `INSERT INTO source_files (file_name, file_path, mime_type, page_count, uploaded_by, status)
       VALUES ($1,$2,$3,$4,$5,'uploaded') RETURNING id`,
      [fileName, filePath, mimeType, pageCount, uploadedBy]
    );
    return rows[0].id;
  }

  async resetForRetry(id) {
    const { rowCount } = await pool.query(
      'UPDATE source_files SET status=\'uploaded\', progress=0, error_message=NULL WHERE id=$1', [id]
    );
    if (!rowCount) throw new NotFoundError('Source file tidak ditemukan');
  }


}

export default new SourceFileRepositories();