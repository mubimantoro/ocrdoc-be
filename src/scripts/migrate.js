import 'dotenv/config';
import pool from '../config/database.js';

const migrateDatabase = async () => {
  console.log('=========================================');
  console.log('MEMULAI DATABASE MIGRATION');
  console.log('=========================================');

  try {
    // Memulai Transaksi: Jika satu gagal, semua dibatalkan (Data Integrity)
    await pool.query('BEGIN');

    // --- TAHAP 1: MASTER & AUTH ---
    console.log('[1/5] Membuat tabel master & autentikasi...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) UNIQUE NOT NULL, 
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS authentications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  
        token TEXT UNIQUE NOT NULL,                     
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vendors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS document_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(10) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // --- TAHAP 2: CORE DOCUMENT FLOW ---
    console.log('[2/5] Membuat tabel core document flow...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS source_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100),
        page_count INTEGER,
        progress INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'uploaded',
        error_message TEXT,
        ai_model VARCHAR(100),
        cheap_token_input INTEGER DEFAULT 0,
        cheap_token_output INTEGER DEFAULT 0,
        cheap_token_ocr INTEGER DEFAULT 0,
        cheap_price NUMERIC(14, 8) DEFAULT 0,
        total_flagship_price NUMERIC(14, 8) DEFAULT 0,
        total_price_all NUMERIC(14, 8) DEFAULT 0,
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_file_id UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
        vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
        document_type_id UUID REFERENCES document_types(id) ON DELETE SET NULL,
        file_path VARCHAR(255),
        start_page INTEGER NOT NULL,
        end_page INTEGER NOT NULL,
        document_number VARCHAR(255),               
        status VARCHAR(50) DEFAULT 'queued',
        confidence NUMERIC(5, 4) DEFAULT 0,         
        needs_review BOOLEAN DEFAULT false,
        error_message TEXT,
        ai_model VARCHAR(100),
        token_input INTEGER DEFAULT 0,
        token_output INTEGER DEFAULT 0,
        token_ocr INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        price NUMERIC(14, 8) DEFAULT 0,
        processing_duration_ms INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // --- TAHAP 3: JOBS & EAV PATTERN ---
    console.log('[3/5] Membuat tabel extraction jobs & EAV structure...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS extraction_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        bullmq_job_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'queued', 
        progress INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS extraction_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_job_id UUID NOT NULL UNIQUE REFERENCES extraction_jobs(id) ON DELETE CASCADE,
        raw_data JSONB,                             
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS fields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value TEXT,
        UNIQUE (extraction_result_id, key)
      );

      CREATE TABLE IF NOT EXISTS items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
        row_index INT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_fields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value TEXT,
        UNIQUE (item_id, key)
      );
    `);

    // --- TAHAP 4: INDEXING (PERFORMANCE) ---
    console.log('[4/5] Mengoptimalkan indexing...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);
      CREATE INDEX IF NOT EXISTS idx_source_files_uploaded_by ON source_files(uploaded_by);
      CREATE INDEX IF NOT EXISTS idx_documents_source_file_id ON documents(source_file_id);
      CREATE INDEX IF NOT EXISTS idx_documents_vendor_id ON documents(vendor_id);
      CREATE INDEX IF NOT EXISTS idx_documents_document_type_id ON documents(document_type_id);
      CREATE INDEX IF NOT EXISTS idx_extraction_jobs_document_id ON extraction_jobs(document_id);
      CREATE INDEX IF NOT EXISTS idx_fields_extraction_result_id ON fields(extraction_result_id);
      CREATE INDEX IF NOT EXISTS idx_items_extraction_result_id ON items(extraction_result_id);
      CREATE INDEX IF NOT EXISTS idx_item_fields_item_id ON item_fields(item_id);
      
      -- GIN Index untuk performa query JSONB
      CREATE INDEX IF NOT EXISTS idx_er_raw_data_gin ON extraction_results USING GIN (raw_data);

      -- Unique Partial Index untuk Queue Safety
      -- Perhatian: Postgres tidak mendukung 'IF NOT EXISTS' untuk indeks unik bersyarat di beberapa versi lama, 
      -- namun di Postgres 18 (Coolify) ini sangat aman.
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_one_active_job_per_doc') THEN
              CREATE UNIQUE INDEX idx_one_active_job_per_doc
              ON extraction_jobs (document_id)
              WHERE status IN ('queued', 'extracting');
          END IF;
      END $$;
    `);

    await pool.query('COMMIT');
    console.log('[5/5] DATABASE MIGRATION SELESAI.');

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('MIGRASI GAGAL (Sistem di-Rollback):', error.message);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('=========================================');
  }
};

migrateDatabase();