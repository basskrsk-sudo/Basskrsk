// Own Telegram contact sharing can prove the phone only when contact.user_id
// equals the sender's Telegram id. Typed or forwarded numbers are not proof.
'use strict';

const db = require('./db');
const { signToken } = require('./auth');

const PHONE_PROOF_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCOUNT_TABLES = Object.freeze({
  customer: 'customers', partner: 'partners',
  manager: 'managers', owner: 'salon_owners',
});

db.exec([
  'CREATE TABLE IF NOT EXISTS telegram_verified_phones (',
  'telegram_user_id TEXT PRIMARY KEY,',
  'phone TEXT NOT NULL,',
  'verified_at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_telegram_verified_phones_time',
  'ON telegram_verified_phones(verified_at);',
].join('\n'));

function normalizeRussianPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) return '7' + digits;
  if (digits.length === 11 && digits.startsWith('8')) return '7' + digits.slice(1);
  if (digits.length === 11 && digits.startsWith('7')) return digits;
  return null;
}
function phoneMasked(phone) {
  return phone ? '+7 (***) ***-**-' + String(phone).slice(-2) : '';
}
function telegramId(value) {
  const id = String(value == null ? '' : value);
  return /^[1-9]\d{0,18}$/.test(id) ? id : null;
}
function registeredPhoneMatch(saved, verified) {
  return !!verified && normalizeRussianPhone(saved) === verified;
}
function recordVerifiedTelegramContact(message, now = Math.floor(Date.now() / 1000)) {
  if (!message || !message.contact || !message.from || !message.chat ||
      message.chat.type !== 'private') return { verified: false };
  const fromId = telegramId(message.from.id);
  const chatId = telegramId(message.chat.id);
  const contactId = telegramId(message.contact.user_id);
  // An address-book or forwarded contact is not proof of account ownership.
  if (!fromId || fromId !== chatId || contactId !== fromId) return { verified: false };
  const phone = normalizeRussianPhone(message.contact.phone_number);
  if (!phone || !Number.isSafeInteger(now) || now < 1000000000) return { verified: false };
  db.prepare(
    'INSERT INTO telegram_verified_phones (telegram_user_id, phone, verified_at) ' +
    'VALUES (?, ?, ?) ON CONFLICT(telegram_user_id) DO UPDATE SET ' +
    'phone = excluded.phone, verified_at = excluded.verified_at'
  ).run(fromId, phone, now);
  return { verified: true, phoneMasked: phoneMasked(phone) };
}
function verifiedPhoneForUser(userId, now = Math.floor(Date.now() / 1000)) {
  const id = telegramId(userId);
  if (!id) return null;
  const row = db.prepare(
    'SELECT phone, verified_at FROM telegram_verified_phones WHERE telegram_user_id = ?'
  ).get(id);
  if (!row || !Number.isSafeInteger(Number(row.verified_at)) ||
      row.verified_at > now + 60 || row.verified_at + PHONE_PROOF_TTL_SECONDS < now) return null;
  return normalizeRussianPhone(row.phone);
}

function accountMatchesForRole(role, phone, userId) {
  if (role === 'admin') {
    // Admins have no phone column. Prior connection must have been made from
    // the authenticated admin website account; phone alone never grants admin.
    return db.prepare(
      'SELECT id, login, full_name, role FROM admins WHERE active = 1 AND telegram_chat_id = ?'
    ).all(String(userId)).map(row => ({
      role, id: row.id, login: row.login, name: row.full_name || row.login,
      adminRole: row.role,
    }));
  }
  const table = ACCOUNT_TABLES[role];
  if (!table || !phone) return [];
  const select = role === 'customer'
    ? 'SELECT id, name, lname, phone, telegram_chat_id FROM customers'
    : 'SELECT id, login, full_name, phone, telegram_chat_id FROM ' + table + ' WHERE active = 1';
  return db.prepare(select).all()
    .filter(row =>
      registeredPhoneMatch(row.phone, phone) &&
      // Never silently take over an existing account tied to another
      // Telegram user, even if that number was later reassigned.
      (!row.telegram_chat_id || String(row.telegram_chat_id) === String(userId))
    )
    .map(row => ({
      role, id: row.id, login: row.login || null,
      name: (role === 'customer'
        ? [row.name, row.lname].filter(Boolean).join(' ')
        : row.full_name) || (role === 'customer' ? 'Покупатель' : 'Сотрудник'),
    }));
}

function availableTelegramAccounts(userId, now = Math.floor(Date.now() / 1000)) {
  const phone = verifiedPhoneForUser(userId, now);
  if (!phone) return { verified: false, phoneMasked: '', accounts: [], ambiguousRoles: [] };
  const accounts = [];
  const ambiguousRoles = [];
  for (const role of ['customer', 'partner', 'manager', 'owner', 'admin']) {
    const matches = accountMatchesForRole(role, phone, userId);
    if (matches.length === 1) {
      accounts.push(matches[0]);
    } else if (matches.length > 1) {
      // Multiple same-role profiles with one phone can cover distinct salons.
      // Never pick one arbitrarily or grant both on the basis of a phone.
      ambiguousRoles.push(role);
    }
  }
  return { verified: true, phoneMasked: phoneMasked(phone), phone, accounts, ambiguousRoles };
}

function issueTelegramAccountSession(userId, role, now = Math.floor(Date.now() / 1000)) {
  if (!['customer', 'partner', 'manager', 'owner', 'admin'].includes(role)) return null;
  const matched = availableTelegramAccounts(userId, now);
  if (!matched.verified) return null;
  const account = matched.accounts.find(a => a.role === role);
  if (!account) return null;
  const token = signToken({
    role: account.role,
    id: account.id,
    ...(account.login ? { login: account.login } : {}),
    ...(role === 'admin' ? { adminRole: account.adminRole } : {}),
  });
  // Keep service notifications directed to the verified registered phone's
  // Telegram owner. Admin links remain password-authenticated and unchanged.
  if (role !== 'admin') {
    db.prepare('UPDATE ' + ACCOUNT_TABLES[role] + ' SET telegram_chat_id = ? WHERE id = ?')
      .run(String(userId), account.id);
  }
  return {
    token, role,
    account: { name: account.name, login: account.login, adminRole: account.adminRole || null },
  };
}

module.exports = {
  PHONE_PROOF_TTL_SECONDS,
  normalizeRussianPhone,
  recordVerifiedTelegramContact,
  verifiedPhoneForUser,
  availableTelegramAccounts,
  issueTelegramAccountSession,
};
