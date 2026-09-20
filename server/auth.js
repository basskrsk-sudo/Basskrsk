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

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
