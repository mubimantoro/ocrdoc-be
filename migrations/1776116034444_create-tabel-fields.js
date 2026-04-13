exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE fields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value TEXT,
        UNIQUE (extraction_result_id, key)
    );
    CREATE INDEX idx_fields_extraction_result_id ON fields(extraction_result_id);
  `);
};
exports.down = (pgm) => pgm.sql('DROP TABLE IF EXISTS fields CASCADE;');