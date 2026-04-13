export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE documents (
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
    CREATE INDEX idx_documents_source_file_id ON documents(source_file_id);
    CREATE INDEX idx_documents_vendor_id ON documents(vendor_id);
    CREATE INDEX idx_documents_document_type_id ON documents(document_type_id);
  `);
};
export const down= (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS documents CASCADE;');
};