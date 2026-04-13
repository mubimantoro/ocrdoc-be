import 'dotenv/config';
import { boundaryWorker } from './queues/boundary-queue.js';
import { extractionWorker } from './queues/extraction-queue.js';
import { webhookQueue } from './queues/webhook.queue.js';

console.log('===================================================');
console.log('SYSTEM STARTING: Enterprise Background Worker');
console.log('===================================================');

const workers = [boundaryWorker, extractionWorker, webhookQueue];

console.log('[WORKER] Node.js terhubung ke Redis. Semua worker aktif memantau antrean...');

/**
 * =========================================================
 * GRACEFUL SHUTDOWN & RESILIENCY
 * =========================================================
 * Fungsi ini memastikan tidak ada data yang korup (terputus di tengah jalan)
 * saat server di-restart atau di-deploy ulang.
 */
const gracefulShutdown = async (signal) => {
  console.log(`\n[WORKER] Menerima sinyal ${signal}. Memulai Graceful Shutdown...`);
  console.log('[WORKER] Menunggu job yang sedang berjalan agar selesai dengan aman...');

  // 1. Safety Net: Timeout 20 detik
  // Jika ada job yang nyangkut (stuck) dan tidak mau selesai,
  // kita paksa matikan agar container/server tidak hang selamanya.
  const forceExit = setTimeout(() => {
    console.error('[WORKER] Shutdown menggantung lebih dari 20 detik. Force Exit diaktifkan!');
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
    console.log('[WORKER] Semua worker berhasil diputus dari Redis dengan aman.');
    process.exit(0);

  } catch (error) {
    console.error('[WORKER] Terjadi error saat melakukan shutdown:', error.message);
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
  console.error('\n[WORKER] FATAL UNCAUGHT EXCEPTION:', error.message);
  console.error(error.stack);

  // Karena state aplikasi mungkin sudah tidak stabil, lakukan shutdown yang aman
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('\n[WORKER] FATAL UNHANDLED REJECTION:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});
