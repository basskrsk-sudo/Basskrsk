// http-utils.js — минимальный роутер и хелперы поверх node:http.
// Заменяет Express: путь + метод + параметры + JSON-тело.
'use strict';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    // Base64 примерно на треть больше исходного файла. 22 МБ позволяют
    // принять фото до 15 МБ, не ослабляя лимит для произвольных запросов.
    const MAX = 22 * 1024 * 1024;
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

module.exports = { readBody, readBinaryBody, parseJsonBody, sendJson, Router };
