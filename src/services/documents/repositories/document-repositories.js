
import pool from '../../../config/database.js';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';

class DocumentRepositories {

  async create(sourceFileId, vendorId, documentTypeId, filePath, startPage, endPage, documentNumber, status = 'queued') {
    const query = `
      INSERT INTO documents (source_file_id, vendor_id, document_type_id, file_path, start_page, end_page, document_number, status) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *;
    `;
    const result = await pool.query(query, [sourceFileId, vendorId, documentTypeId, filePath, startPage, endPage, documentNumber, status]);

    if (!result.rows[0]) {
      throw new InvariantError('Gagal membuat record Document.');
    }

    return result.rows[0];
  }

  async findAllBySourceFileId(sourceFileId) {
    const query = 'SELECT * FROM documents WHERE source_file_id = $1 ORDER BY created_at ASC';
    const result = await pool.query(query, [sourceFileId]);
    return result.rows;
  }

  async findAll(limit, offset, filters = {}) {
    let query = `
      SELECT 
        d.*, 
        dt.id AS doc_type_id, dt.code AS doc_type_code, dt.name AS doc_type_name,
        v.id AS vendor_id, v.name AS vendor_name,
        sf.file_name AS source_file_name,
        ej.id AS job_id, ej.created_at AS job_started_at, ej.updated_at AS job_completed_at
      FROM documents d
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN source_files sf ON d.source_file_id = sf.id
      LEFT JOIN extraction_jobs ej ON ej.document_id = d.id
      WHERE 1=1
    `;
    const values = [];

    if (filters.sourceFileId) {
      values.push(filters.sourceFileId);
      query += ` AND d.source_file_id = $${values.length}`;
    }

    values.push(limit, offset);
    query += ` ORDER BY d.created_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`;

    const result = await pool.query(query, values);
    return result.rows;
  }

  /**
   * Menghitung total dokumen (Untuk Pagination)
   */
  async countAll(filters = {}) {
    let query = 'SELECT COUNT(*) FROM documents WHERE 1=1';
    const values = [];
    if (filters.sourceFileId) {
      values.push(filters.sourceFileId);
      query += ` AND source_file_id = $${values.length}`;
    }
    const result = await pool.query(query, values);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Mengambil 1 Dokumen Spesifik beserta relasi EAV-nya
   */
  async findById(id) {
    const docQuery = `
      SELECT 
        d.*, 
        dt.id AS doc_type_id, dt.code AS doc_type_code, dt.name AS doc_type_name,
        v.id AS vendor_id, v.name AS vendor_name,
        sf.file_name AS source_file_name,
        ej.id AS job_id, ej.created_at AS job_started_at, ej.updated_at AS job_completed_at,
        er.id AS extraction_result_id,
        er.raw_data
      FROM documents d
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      LEFT JOIN vendors v ON d.vendor_id = v.id
      LEFT JOIN source_files sf ON d.source_file_id = sf.id
      LEFT JOIN extraction_jobs ej ON ej.document_id = d.id
      LEFT JOIN extraction_results er ON er.extraction_job_id = ej.id
      WHERE d.id = $1;
    `;
    const docResult = await pool.query(docQuery, [id]);
    const document = docResult.rows[0];

    if (!document) throw new NotFoundError(`Dokumen dengan ID ${id} tidak ditemukan.`);

    let fields = [];
    let items = [];
    let rawData = null; //

    if (document.extraction_result_id) {
      // 1. Assign Raw Data
      rawData = document.raw_data;

      // 2. Ambil Header (EAV)
      const fieldQuery = 'SELECT key, value FROM fields WHERE extraction_result_id = $1';
      const fieldsResult = await pool.query(fieldQuery, [document.extraction_result_id]);
      fields = fieldsResult.rows;

      // 3. Ambil Items (EAV)
      const itemQuery = `
        SELECT i.row_index, col.key, col.value 
        FROM items i 
        JOIN item_fields col ON col.item_id = i.id 
        WHERE i.extraction_result_id = $1
      `;
      const itemsResult = await pool.query(itemQuery, [document.extraction_result_id]);
      items = itemsResult.rows;
    }

    return { document, fields, items, rawData };
  }

  async updateStatus(id, status, errorMessage = null) {
    // Jika di-retry (queued), kita bersihkan sampah dari kegagalan sebelumnya
    if (status === 'queued') {
      const query = `
        UPDATE documents 
        SET status = $1, error_message = $2, confidence = NULL, token_input = NULL, 
            token_output = NULL, total_tokens = NULL, price = NULL, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $3 
        RETURNING id;
      `;
      await pool.query(query, [status, errorMessage, id]);
    } else {
      const query = `
        UPDATE documents 
        SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $3 
        RETURNING id;
      `;
      await pool.query(query, [status, errorMessage, id]);
    }
  }

  async updateFilePath(id, filePath) {
    const query = `
      UPDATE documents 
      SET file_path = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [filePath, id]);

    if (!result.rows.length) {
      throw new NotFoundError(`Dokumen ID ${id} tidak ditemukan.`);
    }

    return result.rows[0];
  }

  async updateMetrics(id, metrics) {
    const { tokenInput, tokenOutput, tokenOcr, totalTokens, price, durationMs, modelUsed, confidence } = metrics;

    const query = `
      UPDATE documents 
      SET token_input = $1, token_output = $2, token_ocr = $3, 
          total_tokens = $4, price = $5, processing_duration_ms = $6,
          ai_model = $7, confidence = $8, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $9 RETURNING *;
    `;
    const result = await pool.query(query, [
      tokenInput, tokenOutput, tokenOcr, totalTokens, price, durationMs, modelUsed, confidence, id
    ]);

    if (!result.rows.length) {
      throw new InvariantError('Gagal memperbarui metrik dokumen');
    }
    return result.rows[0];
  }

}

export default new DocumentRepositories();