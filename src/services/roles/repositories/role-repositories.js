import { NotFoundError } from '../../../exceptions/index.js';
import pool from '../../../config/database.js';

class RoleRepositories {

  async findByName(name) {
    const { rows } = await pool.query(
      'SELECT id, name FROM roles WHERE name = $1 LIMIT 1',
      [name]
    );
    if (!rows.length) throw new NotFoundError(`Role '${name}' tidak ditemukan`);
    return rows[0];
  }

  async findAll() {
    const { rows } = await pool.query(
      'SELECT id, name FROM roles ORDER BY name'
    );
    return rows;
  }
}

export default new RoleRepositories();