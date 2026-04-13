import { AuthenticationError, InvariantError } from '../../../exceptions/index.js';
import pool from '../../../config/database.js';

class AuthenticationRepositories {

  async saveRefreshToken(token, userId) {
    await pool.query(
      'INSERT INTO authentications (token, user_id) VALUES ($1, $2)',
      [token, userId]
    );
  }

  async verifyRefreshToken(token) {
    const { rows } = await pool.query(
      'SELECT token FROM authentications WHERE token = $1',
      [token]
    );

    if (!rows.length) {
      throw new AuthenticationError('Refresh token tidak valid.');
    }
  }

  async deleteRefreshToken(token) {
    const { rowCount } = await pool.query(
      'DELETE FROM authentications WHERE token = $1',
      [token]
    );

    if (!rowCount) {
      throw new InvariantError('Refresh token tidak ditemukan');
    }
  }
}

export default new AuthenticationRepositories();