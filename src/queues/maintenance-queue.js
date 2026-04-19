import { Queue, Worker } from 'bullmq';
import CleanupService from '../services/maintenance/cleanup-service.js';

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

// 1. Definisi Queue
export const maintenanceQueue = new Queue('maintenance-jobs', { connection });

// 2. Definisi Worker
export const maintenanceWorker = new Worker('maintenance-jobs', async (job) => {
  if (job.name === 'daily-cleanup') {
    await CleanupService.runCleanup();
  }
}, { connection });

// 3. Registrasi Repeatable Job (Sekali sehari jam 00:00)
export const initMaintenanceJobs = async () => {
  // Hapus job lama yang mungkin punya schedule berbeda (Clean start)
  const repeatableJobs = await maintenanceQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await maintenanceQueue.removeRepeatableByKey(job.key);
  }

  // Tambahkan job baru: Jalan setiap jam 12 malam
  await maintenanceQueue.add('daily-cleanup', {}, {
    repeat: {
      pattern: '0 0 * * *' // Cron format: Jam 00:00 setiap hari
    },
    removeOnComplete: true
  });

  console.log('[MAINTENANCE] Scheduler aktif: Pembersihan file otomatis berjalan setiap jam 00:00.');
};
