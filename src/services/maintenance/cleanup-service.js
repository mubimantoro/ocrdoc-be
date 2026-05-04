import fs from 'fs/promises';
import path from 'path';
import pool from '../../config/database.js';
import logger from '../../config/logger.js';

/**
 * Maintenance Service: Membersihkan file fisik yang sudah kadaluarsa (> 30 hari)
 */
class CleanupService {
  constructor() {
    this.uploadDir = path.resolve('uploads');
  }

  async runCleanup(log = logger) {
    log.info({ event: 'cleanup_start' }, 'Memulai pembersihan file lama (> 30 hari)');

    try {
      // 1. Ambil data Source Files yang sudah > 30 hari dan belum ditandai is_deleted
      const { rows: sourceFiles } = await pool.query(`
        SELECT id, file_path FROM source_files 
        WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND is_deleted = false
        AND file_path IS NOT NULL
      `);

      // 2. Ambil data Documents (split results) yang sudah > 30 hari
      const { rows: documents } = await pool.query(`
        SELECT id, file_path FROM documents 
        WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND is_deleted = false
        AND file_path IS NOT NULL
      `);

      let deletedCount = 0;

      // Proses Source Files
      for (const sf of sourceFiles) {
        if (await this.deletePhysicalFile(sf.file_path)) {
          await pool.query('UPDATE source_files SET file_path = NULL, is_deleted = true WHERE id = $1', [sf.id]);
          deletedCount++;
        }
      }

      // Proses Documents
      for (const doc of documents) {
        if (await this.deletePhysicalFile(doc.file_path)) {
          await pool.query('UPDATE documents SET file_path = NULL, is_deleted = true WHERE id = $1', [doc.id]);
          deletedCount++;
        }
      }

      log.info({ event: 'cleanup_completed', deletedCount }, `Pembersihan selesai: ${deletedCount} file dihapus`);
      return deletedCount;

    } catch (error) {
      log.error({ event: 'cleanup_failed', err: error }, `Error saat cleanup: ${error.message}`);

      throw error;
    }
  }

  async deletePhysicalFile(relativePaths, log = logger) {
    if (!relativePaths) return false;

    try {
      const absolutePath = path.resolve(relativePaths);

      // Cek apakah file benar-benar ada sebelum dihapus
      await fs.access(absolutePath);
      await fs.unlink(absolutePath);
      return true;
    } catch (err) {
      // Jika file memang sudah tidak ada, tandai saja di DB sebagai sukses agar tidak diulang
      if (err.code === 'ENOENT') return true;
      log.warn({
        event: 'file_delete_failed',
        filePath: relativePaths,
        err,
      }, `Gagal menghapus file: ${relativePaths}`);
      return false;
    }
  }
}

export default new CleanupService();
