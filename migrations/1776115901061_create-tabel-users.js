export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_users_role_id ON users(role_id);
  `);
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS users CASCADE;');
};