import { AuthenticationError, InvariantError } from '../../../exceptions/index.js';
import pool from '../../../config/database.js';

class AuthenticationRepositories {

  async saveRefreshToken(token) {
    await pool.query(
      'INSERT INTO authentications (token) VALUES ($1)',
      [token]
    );
  }

  async verifyRefreshToken(token) {
    const { rows } = await pool.query(
      'SELECT token FROM authentications WHERE token = $1 LIMIT 1',
      [token]
    );
    if (!rows.length) throw new AuthenticationError('Refresh token tidak ditemukan');
  }

  async deleteRefreshToken(token) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM authentications WHERE token = $1',
      [token]
    );
    if (!rowCount) throw new InvariantError('Refresh token tidak ditemukan');
  }
}

export default new AuthenticationRepositories();