import 'dotenv/config';
import pool from '../config/database.js';

const resetDatabase = async () => {
  console.log('=========================================');
  console.log('MELAKUKAN HARD RESET DATABASE...');
  console.log('=========================================');

  try {
    await pool.query('DROP SCHEMA public CASCADE;');
    await pool.query('CREATE SCHEMA public;');

    console.log('Seluruh tabel berhasil dihapus!');
  } catch (error) {
    console.error('Gagal mereset database:', error.message);
  } finally {
    await pool.end();
    console.log('=========================================');
  }
};

resetDatabase();