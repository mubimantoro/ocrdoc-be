/* eslint-disable camelcase */
import { Server } from 'socket.io';
import TokenManager from './security/token-manager.js';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

let io;

/**
 * Inisialisasi Socket.IO — dipanggil dari server.js
 */
export const initSocket = async (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
    },
  });

  const pubClient = createClient({
    socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT) || 6379 },
    password: process.env.REDIS_PASSWORD,
  });
  const subClient = pubClient.duplicate();

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  console.info('[Socket] Redis adapter connected');

  // ── Subscribe ke event dari worker process ─────────────────────────
  const workerSub = createClient({
    socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT) || 6379 },
    password: process.env.REDIS_PASSWORD,
  });
  await workerSub.connect();

  await workerSub.pSubscribe('socket:file:*', (message, channel) => {
    const sourceFileId = channel.replace('socket:file:', '');
    const { event, payload } = JSON.parse(message);
    io.to(`file:${sourceFileId}`).emit(event, payload);
  });

  console.info('[Socket] Subscribed to worker Redis channels');

  // ── Middleware auth ──────────────────────────────────────────────────
  io.use((socket, next) => {
    try {
      // Token dikirim dari FE saat connect:
      // socket = io('http://...', { auth: { token: 'Bearer eyJ...' } })
      const token = socket.handshake.auth?.token?.replace('Bearer ', '');
      if (!token) return next(new Error('Token tidak ditemukan'));

      const decoded  = TokenManager.verifyAccessToken(token);
      socket.user = decoded; // inject user ke socket
      next();
    } catch {
      next(new Error('Token tidak valid'));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────
  io.on('connection', (socket) => {
    console.info(`[Socket] Connected: ${socket.id} (user: ${socket.user?.email})`);

    // FE subscribe ke status update file tertentu
    // Emit dari FE: socket.emit('subscribe', { source_file_id: '...' })
    socket.on('subscribe', ({ source_file_id }) => {
      if (!source_file_id) return;
      socket.join(`file:${source_file_id}`);
      console.info(`[Socket] ${socket.id} subscribed to file:${source_file_id}`);
    });

    // FE unsubscribe
    socket.on('unsubscribe', ({ source_file_id }) => {
      if (!source_file_id) return;
      socket.leave(`file:${source_file_id}`);
      console.info(`[Socket] ${socket.id} unsubscribed from file:${source_file_id}`);
    });

    socket.on('disconnect', (reason) => {
      console.info(`[Socket] Disconnected: ${socket.id} — ${reason}`);
    });
  });

  console.info('[Socket] Socket.IO initialized');
  return io;
};

/**
 * Push status update ke semua client yang subscribe ke sourceFileId
 * Dipanggil dari document-worker.js
 */
export const emitStatusUpdate = (sourceFileId, status, progress) => {
  if (!io) return;
  io.to(`file:${sourceFileId}`).emit('status_update', { status, progress });
};

export const emitCompleted = (sourceFileId) => {
  if (!io) return;
  io.to(`file:${sourceFileId}`).emit('completed', {
    status:   'completed',
    progress: 100,
  });
};

export const emitFailed = (sourceFileId, errorMessage) => {
  if (!io) return;
  io.to(`file:${sourceFileId}`).emit('failed', {
    status:        'failed',
    error_message: errorMessage,
  });
};

export const emitPendingReview = (sourceFileId) => {
  if (!io) return;
  io.to(`file:${sourceFileId}`).emit('pending_review', {
    status: 'pending_review',
  });
};

export default { initSocket, emitStatusUpdate, emitCompleted, emitFailed, emitPendingReview };