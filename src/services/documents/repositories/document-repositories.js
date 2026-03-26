/* eslint-disable camelcase */
import pool from '../../../config/database.js';
import { NotFoundError } from '../../../exceptions/index.js';

class DocumentRepositories {
  async findAll({ page = 1, limit = 10, sourceFileId = null } = {}) {
    const offset = (page - 1) * limit;
    const params = [];
    const where  = sourceFileId
      ? (params.push(sourceFileId), 'WHERE d.source_file_id = $1') : '';

    const { rows: cr } = await pool.query(
      `SELECT COUNT(*) AS total FROM documents d ${where}`, params
    );
    const total = parseInt(cr[0].total);
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT d.id, d.start_page, d.end_page, d.status,
      d.confidence, d.needs_review, d.error_message,
      d.created_at, d.updated_at,
      dt.id AS dt_id, dt.code AS dt_code, dt.name AS dt_name,
      v.id  AS vendor_id, v.name AS vendor_name,
      sf.id AS sf_id, sf.file_name AS sf_file_name,
      ej.id AS job_id
      FROM documents d
      LEFT JOIN document_types dt  ON dt.id = d.document_type_id
      LEFT JOIN vendors v ON v.id  = d.vendor_id
      LEFT JOIN source_files sf ON sf.id = d.source_file_id
      LEFT JOIN extraction_jobs ej ON ej.document_id = d.id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      data: rows.map((r) => this.#mapRow(r)),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT d.id, d.start_page, d.end_page, d.status,
      d.confidence, d.needs_review, d.error_message,
      d.created_at, d.updated_at,
      dt.id AS dt_id, dt.code AS dt_code, dt.name AS dt_name,
      v.id  AS vendor_id, v.name AS vendor_name,
      sf.id AS sf_id, sf.file_name AS sf_file_name,
      ej.id AS job_id
      FROM documents d
      LEFT JOIN document_types dt  ON dt.id = d.document_type_id
      LEFT JOIN vendors v ON v.id  = d.vendor_id
      LEFT JOIN source_files sf ON sf.id = d.source_file_id
      LEFT JOIN extraction_jobs ej ON ej.document_id = d.id
      WHERE d.id = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) throw new NotFoundError('Document tidak ditemukan');

    const doc = this.#mapRow(rows[0]);

    if (rows[0].job_id) {
      const { rows: resultRows } = await pool.query(
        `SELECT er.id FROM extraction_results er
         WHERE er.extraction_job_id = $1
         ORDER BY er.created_at DESC LIMIT 1`,
        [rows[0].job_id]
      );

      if (resultRows.length) {
        const resultId = resultRows[0].id;

        const { rows: fields } = await pool.query(
          'SELECT key, value FROM fields WHERE extraction_result_id = $1',
          [resultId]
        );

        const { rows: itemRows } = await pool.query(
          `SELECT id, row_index FROM items
           WHERE extraction_result_id = $1
           ORDER BY row_index`,
          [resultId]
        );

        const items = [];
        for (const item of itemRows) {
          const { rows: colRows } = await pool.query(
            'SELECT key, value FROM item_fields WHERE item_id = $1',
            [item.id]
          );

          const itemObj = { row_index: item.row_index };
          for (const col of colRows) {
            itemObj[col.key] = col.value;
          }

          items.push(itemObj);
        }

        doc.fields = fields;
        doc.items  = items;
      }
    }

    return doc;
  }

  #mapRow(row) {
    return {
      id: row.id,
      start_page: row.start_page,
      end_page: row.end_page,
      status: row.status,
      confidence: row.confidence,
      needs_review: row.needs_review,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
      job_id: row.job_id,
      document_type: row.dt_id
        ? { id: row.dt_id, code: row.dt_code, name: row.dt_name }
        : null,
      vendor: row.vendor_id
        ? { id: row.vendor_id, name: row.vendor_name }
        : null,
      source_file: row.sf_id
        ? { id: row.sf_id, file_name: row.sf_file_name }
        : null,
    };
  }
}

export default new DocumentRepositories();