import { randomUUID } from 'crypto';
import logger from '../config/logger.js';

const requestLogger = (req, res, next) => {
  // Generate unique ID per request — dipakai untuk tracing di semua log downstream
  const requestId = randomUUID();
  req.requestId = requestId;

  // Ambil user ID jika sudah ada (diisi oleh auth middleware setelahnya).
  // Untuk request yang belum auth, ini null — akan di-log apa adanya.
  const startTime = Date.now();

  // Log request masuk
  logger.info({
    requestId,
    userId: req.user?.id ?? null,
    event: 'request_received',
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  }, `→ ${req.method} ${req.originalUrl}`);

  // Hook ke event 'finish' agar bisa log response setelah handler selesai
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const level = res.statusCode >= 500 ? 'error'
      : res.statusCode >= 400 ? 'warn'
        : 'info';

    logger[level]({
      requestId,
      userId: req.user?.id ?? null,
      event: 'request_completed',
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: duration,
    }, `← ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
  });

  next();
};

export default requestLogger;