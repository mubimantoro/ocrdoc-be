import 'dotenv/config';
import axios from 'axios';
import pool from '../config/database.js';
import { Worker } from 'bullmq';

const connection = {
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD
};

const worker = new Worker(
  'webhook',

  async (job) => {
    const { deliveryId, url, payload } = job.data;
    console.info(`[Webhook] Delivering to: ${url}`);

    await pool.query(
      'UPDATE webhook_deliveries SET attempt = attempt + 1 WHERE id = $1',
      [deliveryId]
    );

    try {
      const response = await axios.post(url, payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      await pool.query(
        `UPDATE webhook_deliveries
         SET status='success', response_code=$1, delivered_at=NOW()
         WHERE id=$2`,
        [response.status, deliveryId]
      );

      console.info(`[Webhook] Delivered successfully (${response.status})`);
    } catch (err) {
      const responseCode = err.response?.status || null;

      await pool.query(
        `UPDATE webhook_deliveries
         SET status='failed', response_code=$1, error_message=$2
         WHERE id=$3`,
        [responseCode, err.message, deliveryId]
      );

      console.error(`[Webhook] Delivery failed: ${err.message}`);
      throw err; // BullMQ retry otomatis
    }
  },

  {
    connection,
    concurrency: 5,
  }
);

worker.on('failed', (job, err) =>
  console.error(`Webhook job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
);
worker.on('error', (err) =>
  console.error(`Webhook worker error: ${err.message}`)
);

console.info('Webhook worker started');
