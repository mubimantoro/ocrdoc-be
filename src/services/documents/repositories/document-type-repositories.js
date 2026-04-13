import pool from '../../../config/database.js';

class DocumentTypeRepositories {
  async findIdByCode(code) {
    const query = 'SELECT id FROM document_types WHERE code = $1';
    const result = await pool.query(query, [code]);
    return result.rows[0] ? result.rows[0].id : null;
  }
}

export default new DocumentTypeRepositories();