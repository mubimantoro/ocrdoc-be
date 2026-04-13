export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE extraction_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_job_id UUID NOT NULL UNIQUE REFERENCES extraction_jobs(id) ON DELETE CASCADE,
        raw_data JSONB,                             
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_er_raw_data_gin ON extraction_results USING GIN (raw_data);
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS extraction_results CASCADE;');
};