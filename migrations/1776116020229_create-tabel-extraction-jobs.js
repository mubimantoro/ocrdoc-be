export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE extraction_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        bullmq_job_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'queued', 
        progress INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_extraction_jobs_document_id ON extraction_jobs(document_id);
    
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_one_active_job_per_doc') THEN
            CREATE UNIQUE INDEX idx_one_active_job_per_doc
            ON extraction_jobs (document_id)
            WHERE status IN ('queued', 'extracting');
        END IF;
    END $$;
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS extraction_jobs CASCADE;');
};