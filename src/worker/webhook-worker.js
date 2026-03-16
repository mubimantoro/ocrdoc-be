import axios from 'axios';
import pool from '../config/database.js';
import { webhookQueue } from '../config/queue.js';

webhookQueue.process(5, async (job) => {
  const { deliveryId, url, payload } = job.data;
  console.info(`[Webhook] Delivering to: ${url}`);

  // Update attempt count
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
    throw err; // Bull akan retry otomatis
  }
});

webhookQueue.on('failed', (job, err) =>
  console.error(`Webhook job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`)
);

console.info('Webhook worker started');
