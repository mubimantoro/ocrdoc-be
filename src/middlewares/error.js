/* eslint-disable no-unused-vars */
import logger from '../config/logger.js';
import { ClientError } from '../exceptions/index.js';
import response from '../utils/response.js';

const ErrorHandler = (err, req, res, next) => {
  if (err instanceof ClientError) {
    logger.warn({
      requestId: req.requestId ?? null,
      userId: req.user?.id ?? null,
      event: 'client_error',
      statusCode: err.statusCode,
      message: err.message,
    }, `ClientError: ${err.message}`);
    return response(res, err.statusCode, err.message);
  }

  if (err.isJoi) {
    logger.warn({
      requestId: req.requestId ?? null,
      userId: req.user?.id ?? null,
      event: 'validation_error',
      message: err.details[0].message,
    }, `ValidationError: ${err.details[0].message}`);
    return response(res, 400, err.details[0].message);
  }

  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error({
    requestId: req.requestId ?? null,
    userId: req.user?.id ?? null,
    event: 'unhandled_error',
    statusCode: status,
    err,
  }, `UnhandledError: ${message}`);
  return response(res, status, message);

};

export default ErrorHandler;