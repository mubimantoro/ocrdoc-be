import 'dotenv/config';
import Redis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';

const redisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
});

// Buat instance Emitter
export const socketEmitter = new Emitter(redisClient);