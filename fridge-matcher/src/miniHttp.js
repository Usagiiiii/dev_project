import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function createApp() {
  const routes = [];
  const app = {
    _errorHandler: null,
    _requestLogger: null,
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    useError(handler) {
      app._errorHandler = handler;
    },
    useRequest(handler) {
      app._requestLogger = handler;
    },
    listen(port, cb) {
      const server = http.createServer(async (req, res) => {
        const wrappedRes = wrapRes(res);
        try {
          const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
          const wrappedReq = wrapReq(req, url);

          if (app._requestLogger) {
            await new Promise((resolve) => app._requestLogger(wrappedReq, wrappedRes, resolve));
          }

          if (!url.pathname.startsWith('/api/')) {
            serveStatic(url.pathname, res);
            return;
          }

          for (const route of routes) {
            if (route.method !== req.method) continue;
            const m = url.pathname.match(route.regex);
            if (!m) continue;
            wrappedReq.params = {};
            route.keys.forEach((k, i) => {
              wrappedReq.params[k] = decodeURIComponent(m[i + 1]);
            });
            wrappedReq.query = Object.fromEntries(url.searchParams.entries());
            await route.handler(wrappedReq, wrappedRes);
            return;
          }
          wrappedRes.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: '接口不存在' },
          });
        } catch (err) {
          if (app._errorHandler) {
            app._errorHandler(err, req, wrappedRes, () => {});
          } else {
            wrappedRes.status(500).json({
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: err.message },
            });
          }
        }
      });
      server.listen(port, cb);
      return server;
    },
  };

  function add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/\/:([A-Za-z_]+)/g, (_, key) => {
            keys.push(key);
            return '/([^/]+)';
          })
          .replace(/\//g, '\\/') +
        '$'
    );
    routes.push({ method, regex, keys, handler });
  }

  return app;
}

function wrapReq(req, url) {
  return {
    method: req.method,
    url: url.pathname + url.search,
    headers: req.headers,
    params: {},
    query: {},
    async json() {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.status = 400;
        err.code = 'BAD_JSON';
        throw err;
      }
    },
  };
}

function wrapRes(res) {
  const api = {
    statusCode: 200,
    status(code) {
      api.statusCode = code;
      return api;
    },
    json(data) {
      if (res.writableEnded) return;
      res.statusCode = api.statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    },
    on(event, cb) {
      res.on(event, cb);
    },
  };
  return api;
}

function serveStatic(pathname, res) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(publicDir, filePath);
  if (!full.startsWith(publicDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
    return;
  }
  const ext = path.extname(full);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
}
