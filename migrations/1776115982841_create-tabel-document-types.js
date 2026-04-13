exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE document_types (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(10) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
exports.down = (pgm) => pgm.sql('DROP TABLE IF EXISTS document_types CASCADE;');