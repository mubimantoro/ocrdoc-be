/* eslint-disable no-unused-vars */
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { AuthenticationError } from '../exceptions/index.js';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

let io;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // 1. Inisialisasi Koneksi Redis untuk Socket Adapter
  const pubClient = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  });

  // subClient wajib menggunakan koneksi terpisah (duplicate)
  const subClient = pubClient.duplicate();

  // 2. Pasang Adapter ke Socket.IO
  io.adapter(createAdapter(pubClient, subClient));

  // Middleware Autentikasi
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) throw new AuthenticationError('Token tidak ditemukan');

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Client terkoneksi via Socket: ${socket.id}`);

    // Bergabung ke room spesifik berdasarkan ID user
    socket.join(socket.user.id);

    socket.on('disconnect', () => {
      console.log(`Client terputus: ${socket.id}`);
    });
  });

  return io;
};