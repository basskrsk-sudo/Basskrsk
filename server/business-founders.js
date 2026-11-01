// The founders of ХвостМаркет are distinct from the OWNERS OF GROOMING SALONS.
// This registry deliberately does not grant admin or super-admin permissions.
'use strict';

const db = require('./db');
const { hashPassword } = require('./auth');

const FOUNDER_SLOTS = Object.freeze([
  { name: 'Лакомых Алексей', share: 45, responsibility: 'Операционное управление, маркетинг, продажи, финансы' },
  { name: 'Соколов Виталий', share: 35, responsibility: 'Продукт, поставщики, склад, логистика и качество' },
  { name: 'Кучкин Николай', share: 20, responsibility: 'Стратегия, бизнес-процессы, право и риски' },
]);
db.exec([
  'CREATE TABLE IF NOT EXISTS business_founders (',
  'id INTEGER PRIMARY KEY AUTOINCREMENT,',
  'full_name TEXT NOT NULL UNIQUE,',
  'share_percent REAL NOT NULL,',
  'responsibility TEXT,',
  'login TEXT UNIQUE,',
  'password_hash TEXT,',
  'phone TEXT,',
  'telegram_chat_id TEXT,',
  'active INTEGER NOT NULL DEFAULT 0,',
  'created_at TEXT NOT NULL DEFAULT (datetime(\'now\')),',
  'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_business_founders_phone ON business_founders(phone);',
].join('\n'));
const seed = db.prepare(
  'INSERT OR IGNORE INTO business_founders (full_name,share_percent,responsibility,active) VALUES (?,?,?,0)'
);
FOUNDER_SLOTS.forEach(f => seed.run(f.name, f.share, f.responsibility));

function normalizeRussianPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = '7' + digits;
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  return /^79\d{9}$/.test(digits) ? digits : null;
}
function safeFounder(founder) {
  if (!founder) return null;
  return {
    id: founder.id,
    full_name: founder.full_name,
    share_percent: founder.share_percent,
    responsibility: founder.responsibility,
    login: founder.login || null,
    active: founder.active === 1,
    configured: !!(founder.login && founder.password_hash && founder.phone),
    telegram_connected: !!founder.telegram_chat_id,
    phone_masked: founder.phone ? '+7 (***) ***-**-' + String(founder.phone).slice(-2) : '',
  };
}
function getFounder(id) {
  const key = Number(id);
  if (!Number.isSafeInteger(key) || key <= 0) return null;
  return db.prepare('SELECT * FROM business_founders WHERE id = ?').get(key);
}
function activeFounder(id) {
  const founder = getFounder(id);
  return founder && founder.active === 1 && founder.login && founder.password_hash && founder.phone ? founder : null;
}
function configureFounder(id, input) {
  const founder = getFounder(id);
  if (!founder) return { ok: false, status: 404, error: 'Собственник не найден' };
  const body = input || {};
  const login = String(body.login == null ? founder.login || '' : body.login).trim();
  const phone = normalizeRussianPhone(body.phone == null ? founder.phone : body.phone);
  const password = String(body.password || '');
  const enabled = body.active === undefined ? founder.active === 1 : body.active === true;
  if (!/^[a-zA-Z0-9._-]{4,50}$/.test(login)) {
    return { ok: false, status: 400, error: 'Логин: 4–50 латинских символов, цифр, точек или дефисов' };
  }
  if (!phone) return { ok: false, status: 400, error: 'Нужен подтверждаемый российский мобильный номер' };
  if (password && (password.length < 10 || password.length > 128)) {
    return { ok: false, status: 400, error: 'Пароль должен содержать от 10 до 128 символов' };
  }
  if (enabled && !founder.password_hash && !password) {
    return { ok: false, status: 400, error: 'Для активации задайте пароль собственника' };
  }
  const duplicate = db.prepare(
    'SELECT id FROM business_founders WHERE id != ? AND (login = ? OR phone = ?)'
  ).get(founder.id, login, phone);
  if (duplicate) return { ok: false, status: 409, error: 'Этот логин или телефон уже используется другим собственником' };
  const phoneChanged = founder.phone !== phone;
  db.prepare(
    'UPDATE business_founders SET login=?, phone=?, password_hash=?, active=?, ' +
    'telegram_chat_id=?, updated_at=datetime(\'now\') WHERE id=?'
  ).run(
    login, phone,
    password ? hashPassword(password) : founder.password_hash,
    enabled ? 1 : 0,
    !enabled || phoneChanged ? null : founder.telegram_chat_id,
    founder.id
  );
  return { ok: true, founder: safeFounder(getFounder(founder.id)), telegram_reconnect_required: !!phoneChanged };
}
module.exports = { FOUNDER_SLOTS, normalizeRussianPhone, safeFounder, getFounder, activeFounder, configureFounder };
