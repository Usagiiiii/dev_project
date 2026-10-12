import { log } from './logger.js';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || '服务器内部错误';
  log('error', 'request_failed', {
    method: req.method,
    path: req.url,
    code,
    message,
  });
  res.status(status).json({
    ok: false,
    error: { code, message },
  });
}
