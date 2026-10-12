import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.resolve(__dirname, '../../logs');
const logFile = path.join(logDir, 'app.log');

fs.mkdirSync(logDir, { recursive: true });

export function log(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  fs.appendFileSync(logFile, line + '\n', 'utf8');
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    log('info', 'http', {
      method: req.method,
      path: req.url,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
}

export function getLogPath() {
  return logFile;
}
