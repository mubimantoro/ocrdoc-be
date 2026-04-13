export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE source_files (
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
    CREATE INDEX idx_source_files_uploaded_by ON source_files(uploaded_by);
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS source_files CASCADE;');
};