import pool from './src/config/database.js';

const run = async () => {
  try {
    console.log('Adding target_doc_type to source_files...');
    await pool.query('ALTER TABLE source_files ADD COLUMN target_doc_type VARCHAR(10);');
    console.log('Success!');
  } catch (err) {
    if (err.code === '42701') {
      console.log('Column already exists, ignoring.');
    } else {
      console.error('Error:', err.message);
    }
  } finally {
    process.exit();
  }
};

run();
