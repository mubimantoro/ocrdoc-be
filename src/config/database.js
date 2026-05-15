import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: false,
  idleTimeoutMillis: 30000,
});

export default pool;