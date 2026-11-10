// auth.js — хэширование паролей и лёгкие подписанные токены на встроенном node:crypto.
// Аналог bcrypt + jsonwebtoken, но без единой внешней зависимости.
'use strict';

const crypto = require('node:crypto');

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-in-production';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

// ── Пароли: scrypt с случайной солью, формат "salt:hash" (обе части в hex) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}


// Keep password verification outside the main HTTP event loop. Limit libuv
// scrypt concurrency so a login burst cannot exhaust a small Amvera container.
const MAX_PARALLEL_CHECKS = 2;
const MAX_WAITING_CHECKS = 8;
let activeChecks = 0;
const waitingChecks = [];

function acquireCheckSlot() {
  if (activeChecks < MAX_PARALLEL_CHECKS) {
    activeChecks++;
    return Promise.resolve();
  }
  if (waitingChecks.length >= MAX_WAITING_CHECKS) {
    const err = new Error('Вход временно занят. Повторите попытку через несколько секунд.');
    err.statusCode = 503;
    return Promise.reject(err);
  }
  return new Promise((resolve) => waitingChecks.push(resolve));
}

function releaseCheckSlot() {
  const next = waitingChecks.shift();
  if (next) next(); // Slot transfers to the oldest queued verification.
  else activeChecks--;
}

async function verifyPasswordAsync(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0 ||
      !/^[0-9a-f]{128}$/i.test(hashHex)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  await acquireCheckSlot();
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(String(password), salt, 64, (error, actual) => {
        if (error) return reject(error);
        resolve(crypto.timingSafeEqual(actual, expected));
      });
    });
  } finally {
    releaseCheckSlot();
  }
}

// ── Токены: base64url(payload).base64url(hmac-sha256(payload)) ──────────
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  return payloadB64 + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig || '');
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync, signToken, verifyToken };
