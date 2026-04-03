/* eslint-disable camelcase */
import { createClient } from 'redis';

let redisClient;

const getClient = async () => {
  if (redisClient) return redisClient;

  redisClient = createClient({
    socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT) || 6379 },
    password: process.env.REDIS_PASSWORD,
  });

  await redisClient.connect();
  return redisClient;
};

const publish = async (sourceFileId, event, payload) => {
  const client = await getClient();
  const channel = `socket:file:${sourceFileId}`;
  await client.publish(channel, JSON.stringify({ event, payload }));
};

export const emitStatusUpdate = (sourceFileId, status, progress) =>
  publish(sourceFileId, 'status_update', { status, progress });

export const emitCompleted = (sourceFileId) =>
  publish(sourceFileId, 'completed', { status: 'completed', progress: 100 });

export const emitFailed = (sourceFileId, errorMessage) =>
  publish(sourceFileId, 'failed', { status: 'failed', error_message: errorMessage });

export const emitPendingReview = (sourceFileId) =>
  publish(sourceFileId, 'pending_review', { status: 'pending_review' });