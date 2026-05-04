import 'dotenv/config';
import { boundaryWorker } from './queues/boundary-queue.js';
import { extractionWorker } from './queues/extraction-queue.js';
import { webhookQueue } from './queues/webhook.queue.js';
import { maintenanceWorker, initMaintenanceJobs } from './queues/maintenance-queue.js';
import logger from './config/logger.js';

logger.info({
  event: 'worker_starting',
  nodeEnv: process.env.NODE_ENV || 'development',
}, 'Enterprise Background Worker starting');

const workers = [boundaryWorker, extractionWorker, webhookQueue, maintenanceWorker];

logger.info({
  event: 'workers_ready',
  workerCount: workers.length,
}, 'Semua worker aktif memantau antrean Redis');

/**
 * =========================================================
 * GRACEFUL SHUTDOWN & RESILIENCY
 * =========================================================
 * Fungsi ini memastikan tidak ada data yang korup (terputus di tengah jalan)
 * saat server di-restart atau di-deploy ulang.
 */
const gracefulShutdown = async (signal) => {
  logger.info({ event: 'shutdown_initiated', signal }, `Menerima sinyal ${signal} — memulai Graceful Shutdown`);


  // 1. Safety Net: Timeout 20 detik
  // Jika ada job yang nyangkut (stuck) dan tidak mau selesai,
  // kita paksa matikan agar container/server tidak hang selamanya.
  const forceExit = setTimeout(() => {
    logger.fatal({ event: 'shutdown_timeout' }, 'Shutdown menggantung >20 detik — Force Exit');
    process.exit(1);
  }, 20000);

  try {
    // 2. Tutup Koneksi Worker secara Paralel (O(1) Time Complexity blocking)
    // worker.close() akan:
    // - Berhenti mengambil job baru dari Redis
    // - Menunggu job yang berstatus 'active' selesai dieksekusi
    await Promise.all(workers.map((worker) => worker.close()));

    // 3. Clear timeout dan keluar dengan status sukses (0)
    clearTimeout(forceExit);

    logger.info({ event: 'shutdown_completed' }, 'Semua worker diputus dari Redis dengan aman');

    process.exit(0);

  } catch (error) {
    logger.error({ event: 'shutdown_error', err: error }, `Error saat shutdown: ${error.message}`);

    clearTimeout(forceExit);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C di terminal
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Sinyal kill dari Docker/OS

/**
 * =========================================================
 * GLOBAL ERROR HANDLERS
 * =========================================================
 * Mencegah aplikasi mati diam-diam (Silent Failure) jika ada error di luar try-catch.
 */
process.on('uncaughtException', (error) => {
  logger.fatal({ event: 'uncaught_exception', err: error }, `Uncaught Exception: ${error.message}`);

  // Karena state aplikasi mungkin sudah tidak stabil, lakukan shutdown yang aman
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ event: 'unhandled_rejection', reason }, 'Unhandled Promise Rejection');

  gracefulShutdown('UNHANDLED_REJECTION');
});

// Jalankan Scheduler Maintenance
initMaintenanceJobs();
