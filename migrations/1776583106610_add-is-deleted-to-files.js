/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- Tabel source_files
    ALTER TABLE source_files ALTER COLUMN file_path DROP NOT NULL;
    ALTER TABLE source_files ADD COLUMN is_deleted BOOLEAN DEFAULT false;

    -- Tabel documents
    ALTER TABLE documents ALTER COLUMN file_path DROP NOT NULL;
    ALTER TABLE documents ADD COLUMN is_deleted BOOLEAN DEFAULT false;
    
    CREATE INDEX idx_source_files_is_deleted ON source_files(is_deleted);
    CREATE INDEX idx_documents_is_deleted ON documents(is_deleted);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE source_files DROP COLUMN IF EXISTS is_deleted;
    ALTER TABLE source_files ALTER COLUMN file_path SET NOT NULL;

    ALTER TABLE documents DROP COLUMN IF EXISTS is_deleted;
    -- documents.file_path aslinya nullable, jadi tidak perlu SET NOT NULL
  `);
};
