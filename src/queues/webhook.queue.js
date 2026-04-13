/* eslint-disable no-unused-vars */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import { Queue, Worker } from 'bullmq';
import axios from 'axios';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
};

export const webhookQueue = new Queue('webhook-jobs', { connection });

export const webhookWorker = new Worker('webhook-jobs', async (job) => {
  const { documentId, sourceFileId, event, payload } = job.data;

  const targetUrl = process.env.CLIENT_WEBHOOK_URL;
  const secretKey = process.env.WEBHOOK_SECRET;

  if (!targetUrl) {
    console.warn(`[WEBHOOK] CLIENT_WEBHOOK_URL tidak diset. Melewati pengiriman untuk Job ${job.id}`);
    return { status: 'skipped' };
  }

  console.log(`\n[WEBHOOK] Mengirim event '${event}' ke ${targetUrl}...`);

  try {
    // 1. Amankan Payload dengan Timestamp & HMAC Signature (Enterprise Standard)
    const timestamp = Date.now().toString();
    const stringifiedPayload = JSON.stringify(payload);

    // Mencegah serangan Replay Attack dengan menggabungkan timestamp dan payload
    const signatureData = `${timestamp}.${stringifiedPayload}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signatureData)
      .digest('hex');

    // 2. Eksekusi HTTP POST ke Server Klien
    const response = await axios.post(targetUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': `sha256=${signature}`
      },
      timeout: 10000 // Maksimal nunggu 10 detik. Jika klien servernya mati, paksa error.
    });

    console.log(`[WEBHOOK] Berhasil dikirim! Klien membalas dengan HTTP Status ${response.status}`);
    return { status: 'success', responseData: response.data };

  } catch (error) {
    console.error(`[WEBHOOK] Gagal mengirim: ${error.message}`);

    // BullMQ akan otomatis menjalankan flowchart RetryCheck -> Retry.
    throw new Error(`Koneksi Webhook Gagal: ${error.message}`);
  }
}, {
  connection,
  concurrency: 10
});