import pool from '../../../config/database.js';
import InvariantError from '../../../exceptions/invariant-error.js';

class EavRepositories {
  /**
   * Menyimpan Key-Value tunggal (Header) ke tabel 'fields'
   */
  async createField(extractionResultId, key, value) {
    const query = `
      INSERT INTO fields (extraction_result_id, key, value) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (extraction_result_id, key) DO UPDATE SET value = EXCLUDED.value
      RETURNING *;
    `;
    const result = await pool.query(query, [extractionResultId, key, String(value)]);

    if (!result.rows[0]) {
      throw new InvariantError(`Gagal menyimpan Field dengan key: ${key}`);
    }

    return result.rows[0];
  }

  /**
   * Menyimpan indeks baris baru ke tabel 'items'
   */
  async createItem(extractionResultId, rowIndex) {
    const query = `
      INSERT INTO items (extraction_result_id, row_index) 
      VALUES ($1, $2) 
      RETURNING *;
    `;
    const result = await pool.query(query, [extractionResultId, rowIndex]);

    if (!result.rows[0]) {
      throw new InvariantError(`Gagal menyimpan Item pada baris ke-${rowIndex}`);
    }

    return result.rows[0];
  }

  /**
   * Menyimpan Key-Value ke tabel 'item_fields' untuk item tertentu
   */
  async createItemField(itemId, key, value) {
    const query = `
      INSERT INTO item_fields (item_id, key, value) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (item_id, key) DO UPDATE SET value = EXCLUDED.value
      RETURNING *;
    `;
    const result = await pool.query(query, [itemId, key, String(value)]);

    if (!result.rows[0]) {
      throw new InvariantError(`Gagal menyimpan ItemField dengan key: ${key}`);
    }

    return result.rows[0];
  }

  /**
   * BULK INSERT: Menyimpan puluhan/ratusan Fields hanya dengan 1 Koneksi Database
   * @param {Array<{extractionResultId: string, key: string, value: string}>} dataArray
   */
  async bulkCreateFields(dataArray) {
    if (!dataArray || dataArray.length === 0) return [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const row of dataArray) {
      placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(row.extractionResultId, row.key, String(row.value));
    }

    const query = `
      INSERT INTO fields (extraction_result_id, key, value) 
      VALUES ${placeholders.join(', ')} 
      ON CONFLICT (extraction_result_id, key) DO UPDATE SET value = EXCLUDED.value
      RETURNING *;
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }

  /**
   * BULK INSERT: Menyimpan Parent Items
   * @param {Array<{extractionResultId: string, rowIndex: number}>} dataArray
   */
  async bulkCreateItems(dataArray) {
    if (!dataArray || dataArray.length === 0) return [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const row of dataArray) {
      placeholders.push(`($${paramIndex++}, $${paramIndex++})`);
      values.push(row.extractionResultId, row.rowIndex);
    }

    const query = `
      INSERT INTO items (extraction_result_id, row_index) 
      VALUES ${placeholders.join(', ')} 
      RETURNING *;
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }

  /**
   * BULK INSERT: Menyimpan Item Fields (Kolom Tabel)
   * @param {Array<{itemId: string, key: string, value: string}>} dataArray
   */
  async bulkCreateItemFields(dataArray) {
    if (!dataArray || dataArray.length === 0) return [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const row of dataArray) {
      placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(row.itemId, row.key, String(row.value));
    }

    const query = `
      INSERT INTO item_fields (item_id, key, value) 
      VALUES ${placeholders.join(', ')} 
      ON CONFLICT (item_id, key) DO UPDATE SET value = EXCLUDED.value
      RETURNING *;
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }
}

export default new EavRepositories();