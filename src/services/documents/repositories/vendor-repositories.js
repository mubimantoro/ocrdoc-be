import pool from '../../../config/database.js';

class VendorRepositories {
  async findOrCreateByName(name) {
    if (!name) return null;

    let result = await pool.query('SELECT id FROM vendors WHERE name ILIKE $1', [name.trim()]);

    if (result.rows.length > 0) {
      return result.rows[0].id;
    }

    result = await pool.query('INSERT INTO vendors (name) VALUES ($1) RETURNING id', [name.trim()]);
    return result.rows[0].id;
  }
  async findIdByName(name) {
    const query = 'SELECT id FROM vendors WHERE name ILIKE $1';
    const result = await pool.query(query, [`%${name}%`]);
    return result.rows[0] ? result.rows[0].id : null;
  }
}

export default new VendorRepositories();