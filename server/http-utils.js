// http-utils.js — минимальный роутер и хелперы поверх node:http.
// Заменяет Express: путь + метод + параметры + JSON-тело.
'use strict';

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Accumulate raw chunks once rather than repeatedly concatenating strings.
    // This avoids quadratic copying and transient UTF-8 decoding overhead.
    const chunks = [];
    let size = 0;
    let settled = false;
    const MAX = 22 * 1024 * 1024;
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > MAX) {
      const err = new Error('Тело запроса слишком большое');
      err.statusCode = 413;
      req.resume();
      reject(err);
      return;
    }
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX) {
        settled = true;
        const err = new Error('Тело запроса слишком большое');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, size).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
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

// Бинарные загрузки читаем отдельно от JSON. Сейчас это используется для
// восстановления базы из админки. Лимит передаётся вызывающим кодом, чтобы
// обычные API-запросы не получили неоправданно большой допустимый размер.
function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBytes) {
      const err = new Error('Файл слишком большой');
      err.statusCode = 413;
      reject(err);
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const err = new Error('Файл слишком большой');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
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
    this.routes = []; // Keep registration order for compatibility.
    this.routesByMethod = new Map();
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
    const route = { method, pattern, keys, handler };
    this.routes.push(route);
    if (!this.routesByMethod.has(method)) this.routesByMethod.set(method, []);
    this.routesByMethod.get(method).push(route);
  }

  get(path, handler) { this.add('GET', path, handler); }
  post(path, handler) { this.add('POST', path, handler); }
  put(path, handler) { this.add('PUT', path, handler); }
  delete(path, handler) { this.add('DELETE', path, handler); }

  match(method, pathname) {
    for (const r of this.routesByMethod.get(method) || []) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

module.exports = { readBody, readBinaryBody, parseJsonBody, sendJson, Router };
