export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) UNIQUE NOT NULL, 
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS roles CASCADE;');
};