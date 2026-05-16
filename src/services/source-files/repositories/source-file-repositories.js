import pool from '../../../config/database.js';
import { NotFoundError } from '../../../exceptions/index.js';

class SourceFileRepositories {

  /**
   * Menyimpan metadata file yang diunggah oleh user
   */
  async create(fileName, filePath, mimeType, pageCount, uploadedBy, status = 'uploaded', targetDocType = null) {
    const query = `
    INSERT INTO source_files (file_name, file_path, mime_type, page_count, uploaded_by, status, target_doc_type) 
    VALUES ($1, $2, $3, $4, $5, $6, $7) 
    RETURNING *;
  `;
    const result = await pool.query(query, [fileName, filePath, mimeType, pageCount, uploadedBy, status, targetDocType]);
    return result.rows[0];
  }

  /**
   * Dynamic Query Builder untuk Pagination Source Files
   */
  async countAll(filters = {}) {
    let query = 'SELECT COUNT(*) FROM source_files WHERE 1=1';
    const values = [];

    if (filters.status) {
      values.push(filters.status);
      query += ` AND status = $${values.length}`;
    }

    if (filters.search) {
      values.push(`%${filters.search}%`);
      query += ` AND file_name ILIKE $${values.length}`;
    }
    if (filters.startDate) {
      values.push(filters.startDate);
      query += ` AND created_at >= $${values.length}::TIMESTAMPTZ`;
    }
    if (filters.endDate) {
      values.push(filters.endDate);
      query += ` AND created_at <= $${values.length}::TIMESTAMPTZ`;
    }
    if (filters.targetDocType) {
      values.push(filters.targetDocType);
      query += ` AND target_doc_type = $${values.length}`;
    }

    const result = await pool.query(query, values);
    return parseInt(result.rows[0].count, 10);
  }

  async findAll(limit, offset, filters = {}) {
    let query = `
      SELECT sf.*, u.name AS uploaded_by_name 
      FROM source_files sf
      LEFT JOIN users u ON sf.uploaded_by = u.id
      WHERE 1=1
    `;
    const values = [];

    if (filters.status) {
      values.push(filters.status);
      query += ` AND sf.status = $${values.length}`;
    }

    if (filters.search) {
      values.push(`%${filters.search}%`);
      query += ` AND sf.file_name ILIKE $${values.length}`;
    }
    if (filters.startDate) {
      values.push(filters.startDate);
      query += ` AND sf.created_at >= $${values.length}::TIMESTAMPTZ`;
    }
    if (filters.endDate) {
      values.push(filters.endDate);
      query += ` AND sf.created_at <= $${values.length}::TIMESTAMPTZ`;
    }
    if (filters.targetDocType) {
      values.push(filters.targetDocType);
      query += ` AND sf.target_doc_type = $${values.length}`;
    }

    values.push(limit, offset);
    query += ` ORDER BY sf.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`;

    const result = await pool.query(query, values);
    return result.rows;
  }
  /**
   * Mencari file berdasarkan ID
   */
  async findById(id) {
    const query = `
      SELECT sf.*, u.name as uploaded_by_name 
      FROM source_files sf
      LEFT JOIN users u ON sf.uploaded_by = u.id
      WHERE sf.id = $1
    `;
    const result = await pool.query(query, [id]);

    if (!result.rows.length) {
      throw new NotFoundError(`Source file dengan ID ${id} tidak ditemukan.`);
    }

    return result.rows[0];
  }

  /**
   * Mengupdate status pemrosesan file (misal: 'processing', 'completed', 'error')
   */
  async updateStatus(id, status, errorMessage = null) {
    const query = `
      UPDATE source_files 
      SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $3 
      RETURNING id;
    `;
    const result = await pool.query(query, [status, errorMessage, id]);

    if (!result.rows.length) {
      throw new NotFoundError(`Gagal update status: Source file dengan ID ${id} tidak ditemukan.`);
    }

    return result.rows[0];
  }

  /**
   * Mengupdate progress pemrosesan (0-100%) untuk ditampilkan di UI
   */
  async updateProgress(id, progress) {
    const query = `
      UPDATE source_files 
      SET progress = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING id;
    `;
    const result = await pool.query(query, [progress, id]);

    if (!result.rows.length) {
      throw new NotFoundError(`Gagal update progress: Source file dengan ID ${id} tidak ditemukan.`);
    }
  }

  /**
   * Menyimpan metrik Boundary Detection (Model Cheap) dan hasil segmentasi
   */
  async updateInitialMetrics(id, metrics) {
    const { input, output, ocr, price, startedAt, modelUsed, boundaryResults } = metrics;
    const query = `
      UPDATE source_files 
      SET cheap_token_input = $1, cheap_token_output = $2, cheap_token_ocr = $3, 
          cheap_price = $4, started_at = $5, ai_model = $6, boundary_results = $7, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $8 RETURNING *;
    `;
    const result = await pool.query(query, [input, output, ocr, price, startedAt, modelUsed, JSON.stringify(boundaryResults), id]);
    return result.rows[0];
  }

  /**
   * Agregasi harga dari tabel documents
   */
  async finalizeMetrics(id) {
    const query = `
      UPDATE source_files 
      SET 
        total_flagship_price = COALESCE((SELECT SUM(price) FROM documents WHERE source_file_id = $1), 0),
        total_price_all = cheap_price + COALESCE((SELECT SUM(price) FROM documents WHERE source_file_id = $1), 0),
        completed_at = CURRENT_TIMESTAMP,
        status = 'completed', progress = 100, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING *;
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  async resetForRetry(id) {
    const { rowCount } = await pool.query(
      'UPDATE source_files SET status=\'uploaded\', progress=0, error_message=NULL WHERE id=$1', [id]
    );
    if (!rowCount) throw new NotFoundError('Source file tidak ditemukan');
  }


}

export default new SourceFileRepositories();