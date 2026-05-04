import { Queue, Worker } from 'bullmq';
import CleanupService from '../services/maintenance/cleanup-service.js';
import logger from '../config/logger.js';

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

// 1. Definisi Queue
export const maintenanceQueue = new Queue('maintenance-jobs', { connection });

// 2. Definisi Worker
export const maintenanceWorker = new Worker('maintenance-jobs', async (job) => {
  const log = logger.child({
    jobId: job.id,
    jobName: job.name,
    module: 'maintenance-worker',
  });

  log.info({ event: 'job_started' }, `Maintenance job dimulai: ${job.name}`);

  if (job.name === 'daily-cleanup') {
    await CleanupService.runCleanup();
  }

  log.info({ event: 'job_completed' }, `Maintenance job selesai: ${job.name}`);
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

  logger.info({
    event: 'maintenance_scheduler_ready',
    cronPattern: '0 0 * * *',
  }, 'Maintenance scheduler aktif: daily-cleanup berjalan setiap jam 00:00');
};
