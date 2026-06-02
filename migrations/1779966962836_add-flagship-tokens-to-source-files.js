/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE source_files
      ADD COLUMN IF NOT EXISTS total_flagship_token_input  BIGINT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_flagship_token_output BIGINT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_flagship_token_ocr    BIGINT DEFAULT 0;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE source_files
      DROP COLUMN IF EXISTS total_flagship_token_input,
      DROP COLUMN IF EXISTS total_flagship_token_output,
      DROP COLUMN IF EXISTS total_flagship_token_ocr;
  `);
};
