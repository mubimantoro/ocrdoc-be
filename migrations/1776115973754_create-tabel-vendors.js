exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE vendors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
exports.down = (pgm) => pgm.sql('DROP TABLE IF EXISTS vendors CASCADE;');