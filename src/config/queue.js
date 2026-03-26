import { Queue } from 'bullmq';

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
};

const defaultJobOptions =  {
  attempts: 3,
  backoff: {
    type:  'exponential',
    delay: 5000,
  },
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 50  },
};

// Queue untuk ekstraksi dokumen
export const extractionQueue = new Queue('extraction', {
  connection,
  defaultJobOptions
});

// Queue untuk webhook delivery
export const webhookQueue = new Queue('webhook', {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: true,
    removeOnFail: { count: 20 }
  }
});