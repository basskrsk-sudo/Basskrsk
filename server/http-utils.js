// http-utils.js — минимальный роутер и хелперы поверх node:http.
// Заменяет Express: путь + метод + параметры + JSON-тело.
'use strict';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 15 * 1024 * 1024; // 15 МБ — с запасом под фото товара в base64 (телефонные фото ~3-10 МБ)
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('Некорректный JSON в теле запроса');
    err.statusCode = 400;
    throw err;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Простой роутер: маршруты вида '/api/products/:id' с методом.
class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, keys: string[], handler }
  }

  add(method, path, handler) {
    const keys = [];
    const pattern = new RegExp(
      '^' +
        path
          .replace(/\/+$/, '')
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$'
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(path, handler) { this.add('GET', path, handler); }
  post(path, handler) { this.add('POST', path, handler); }
  put(path, handler) { this.add('PUT', path, handler); }
  delete(path, handler) { this.add('DELETE', path, handler); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

module.exports = { readBody, parseJsonBody, sendJson, Router };
