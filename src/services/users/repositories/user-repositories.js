/* eslint-disable camelcase */
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import pool from '../../../config/database.js';

class UserRepositories {

  #mapRow(row) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #baseQuery() {
    return `
      SELECT u.id, u.name, u.email, u.created_at, u.updated_at, r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id`;
  }

  async create({ name, email, hashedPassword, roleName }) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1', [email]
    );
    if (existing.length) throw new InvariantError('Email sudah digunakan');

    const { rows: roleRows } = await pool.query(
      'SELECT id FROM roles WHERE name = $1 LIMIT 1', [roleName]
    );
    if (!roleRows.length) throw new InvariantError(`Role '${roleName}' tidak ditemukan`);

    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password, role_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, email, hashedPassword, roleRows[0].id]
    );

    return rows[0].id;
  }

  async findAll() {
    const { rows } = await pool.query(
      `${this.#baseQuery()} ORDER BY u.created_at DESC`
    );
    return rows.map((r) => this.#mapRow(r));
  }

  async findById(id) {
    const { rows } = await pool.query(
      `${this.#baseQuery()} WHERE u.id = $1 LIMIT 1`, [id]
    );
    if (!rows.length) throw new NotFoundError('User tidak ditemukan');
    return this.#mapRow(rows[0]);
  }

  async findByEmail(email) {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.password, u.created_at, u.updated_at, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.email = $1 LIMIT 1`,
      [email]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      password: row.password,
      role: row.role_name,
    };
  }

  async update(id, { name, email, roleName }) {
    await this.findById(id);

    if (email) {
      const { rows } = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2 LIMIT 1', [email, id]
      );
      if (rows.length) throw new InvariantError('Email sudah digunakan');
    }

    const fields = [];
    const params = [];
    if (name  !== undefined) { params.push(name);  fields.push(`name  = $${params.length}`); }
    if (email !== undefined) { params.push(email); fields.push(`email = $${params.length}`); }

    if (roleName !== undefined) {
      const { rows: roleRows } = await pool.query(
        'SELECT id FROM roles WHERE name = $1 LIMIT 1', [roleName]
      );
      if (!roleRows.length) throw new InvariantError(`Role '${roleName}' tidak ditemukan`);
      params.push(roleRows[0].id);
      fields.push(`role_id = $${params.length}`);
    }

    if (!fields.length) throw new InvariantError('Minimal satu field harus diisi');

    params.push(id);
    await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}`,
      params
    );
  }

  async delete(id) {
    const { rowCount } = await pool.query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    if (!rowCount) throw new NotFoundError('User tidak ditemukan');
  };
}

export default new UserRepositories();