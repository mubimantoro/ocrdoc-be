exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE authentications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),  
        token TEXT UNIQUE NOT NULL,                     
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
exports.down = (pgm) => pgm.sql('DROP TABLE IF EXISTS authentications CASCADE;');