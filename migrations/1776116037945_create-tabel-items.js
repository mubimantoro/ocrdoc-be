export const up= (pgm) => {
  pgm.sql(`
    CREATE TABLE items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        extraction_result_id UUID NOT NULL REFERENCES extraction_results(id) ON DELETE CASCADE,
        row_index INT NOT NULL
    );
    CREATE INDEX idx_items_extraction_result_id ON items(extraction_result_id);
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS items CASCADE;');
};