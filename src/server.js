import { createServer } from 'http';
import app from './server/index.js';
import { initSocket } from './config/socket.js';
import logger from './config/logger.js';

const host = process.env.HOST;
const port = process.env.PORT;
const httpServer = createServer(app);

initSocket(httpServer);

httpServer.listen(port, () => {
  logger.info({
    event: 'server_started',
    host,
    port,
    nodeEnv: process.env.NODE_ENV || 'development',
  }, `Server running at http://${host}:${port}`);
});

// Tangkap unhandled error agar tidak crash diam-diam tanpa log
process.on('unhandledRejection', (reason) => {
  logger.fatal({ event: 'unhandled_rejection', reason }, 'Unhandled Promise Rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ event: 'uncaught_exception', err }, 'Uncaught Exception');
  process.exit(1);
});