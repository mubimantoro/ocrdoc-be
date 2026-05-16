/* eslint-disable no-unused-vars */
import 'dotenv/config';
import { Pool } from 'pg';
import logger from './logger.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: false,
});

pool.on('error', (err, client) => {
  logger.error(
    { event: 'db_pool_idle_error', err: err.message },
    'Koneksi idle ke database terputus tak terduga oleh jaringan.'
  );
});

export default pool;