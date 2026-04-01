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
      ORDER BY d.start_page ASC
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
      ej.id AS job_id,
      ej.started_at, ej.completed_at 
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
        `SELECT er.id, er.ai_model, er.prompt_tokens, er.output_tokens, er.total_tokens, er.input_price, er.output_price, er.total_price,
        er.total_pages, er.duration_ms
        FROM extraction_results er
        WHERE er.extraction_job_id = $1
        ORDER BY er.created_at DESC LIMIT 1`,
        [rows[0].job_id]
      );

      if (resultRows.length) {
        const result = resultRows[0];
        const resultId = resultRows[0].id;

        const { rows: fields } = await pool.query(
          'SELECT key, value FROM fields WHERE extraction_result_id = $1',
          [resultId]
        );

        const { rows: itemData } = await pool.query(
          `SELECT i.id AS item_id, i.row_index, itf.key, itf.value 
           FROM items i
           LEFT JOIN item_fields itf ON itf.item_id = i.id
           WHERE i.extraction_result_id = $1
           ORDER BY i.row_index`,
          [resultId]
        );

        const itemsMap = new Map();

        for (const row of itemData) {
          if (!itemsMap.has(row.item_id)) {
            itemsMap.set(row.item_id, { row_index: row.row_index });
          }

          if (row.key) {
            itemsMap.get(row.item_id)[row.key] = row.value;
          }
        }

        doc.fields = fields;
        doc.items  = Array.from(itemsMap.values());
        doc.ai_usage = {
          model:         result.ai_model,
          prompt_tokens: result.prompt_tokens,
          output_tokens: result.output_tokens,
          total_tokens:  result.total_tokens,
          input_price:   result.input_price,
          output_price:  result.output_price,
          total_price:   result.total_price,
          total_pages:   result.total_pages,
          duration_ms:   result.duration_ms,
          duration_sec:  result.duration_ms
            ? parseFloat((result.duration_ms / 1000).toFixed(2))
            : null,
        };
      }
    }

    return doc;
  }

  #mapRow(row) {
    const durationMs = row.started_at && row.completed_at
      ? new Date(row.completed_at) - new Date(row.started_at)
      : null;

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
      processing_time: durationMs !== null ? {
        started_at:   row.started_at,
        completed_at: row.completed_at,
        duration_ms:  durationMs,
        duration_sec: parseFloat((durationMs / 1000).toFixed(2)),
      } : null,
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