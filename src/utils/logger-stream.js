import logger from '../config/logger.js';

/**
 * Stream adapter untuk library yang butuh Node.js stream (bukan Pino langsung).
 * Pakai level 'info' agar tidak tercampur dengan log debug.
 */
const loggerStream = {
  write: (message) => {
    logger.info(message.trimEnd());
  },
};

export default loggerStream;