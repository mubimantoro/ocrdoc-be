import logger from '../config/logger.js';

/**
 * Buat child logger yang sudah membawa context req.
 * Pakai ini di dalam controller, bukan logger langsung.
 *
 * @param {import('express').Request} req
 * @param {string} [module] - nama modul/controller untuk context tambahan
 * @returns {import('pino').Logger}
 */
const createChildLogger = (req, module) => {
  return logger.child({
    requestId: req.requestId ?? null,
    userId: req.user?.id ?? null,
    ...(module ? { module } : {}),
  });
};

export default createChildLogger;