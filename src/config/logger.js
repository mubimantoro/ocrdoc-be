import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  ...(isProduction
    ? {}
    : {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    }),

  // Level minimum yang di-log:
  // production → 'info' (buang debug & trace)
  // development → 'debug' (semua level tampil)
  level: isProduction ? 'info' : 'debug',

  // Base fields yang muncul di setiap log line
  base: {
    env: process.env.NODE_ENV || 'development',
    service: 'doc-ocr-api',
  },

  // Format timestamp sebagai ISO string (mudah di-parse oleh log aggregator)
  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact field sensitif agar tidak bocor ke log storage
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.access_token',
      'req.body.refresh_token',
    ],
    censor: '[REDACTED]',
  },
});

export default logger;