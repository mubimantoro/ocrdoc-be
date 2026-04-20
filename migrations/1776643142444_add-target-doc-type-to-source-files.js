export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE source_files 
    ADD COLUMN target_doc_type VARCHAR(10);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE source_files 
    DROP COLUMN target_doc_type;
  `);
};
