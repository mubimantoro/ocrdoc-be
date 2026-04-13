export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE item_fields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value TEXT,
        UNIQUE (item_id, key)
    );
    CREATE INDEX idx_item_fields_item_id ON item_fields(item_id);
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS item_fields CASCADE;');
};