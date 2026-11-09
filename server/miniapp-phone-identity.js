// Own Telegram contact sharing can prove the phone only when contact.user_id
// equals the sender's Telegram id. Typed or forwarded numbers are not proof.
'use strict';

const db = require('./db');
const { signToken } = require('./auth');
require('./business-founders'); // ensure independently registered founders exist before phone matching
const { bindTelegramAccount } = require('./telegram-connection-alerts');

const PHONE_PROOF_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCOUNT_TABLES = Object.freeze({
  customer: 'customers', partner: 'partners',
  manager: 'managers', owner: 'salon_owners', founder: 'business_founders',
});

db.exec([
  'CREATE TABLE IF NOT EXISTS telegram_verified_phones (',
  'telegram_user_id TEXT PRIMARY KEY,',
  'phone TEXT NOT NULL,',
  'verified_at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_telegram_verified_phones_time',
  'ON telegram_verified_phones(verified_at);',
  'CREATE TABLE IF NOT EXISTS telegram_miniapp_last_role (',
  'telegram_user_id TEXT PRIMARY KEY,',
  "role TEXT NOT NULL CHECK(role IN ('customer','partner','manager','owner','founder','admin','salon','shop')),",
  'updated_at INTEGER NOT NULL',
  ');',
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
    // Super-admin grants Mini App eligibility by storing the administrator's
    // phone. Telegram must independently verify ownership of that number.
    // Preserve password-authenticated legacy Telegram links without a phone.
    return db.prepare(
      'SELECT id, login, full_name, role, phone, telegram_chat_id FROM admins WHERE active = 1'
    ).all().filter(row => {
      const linked = String(row.telegram_chat_id || '') === String(userId);
      return row.phone
        ? registeredPhoneMatch(row.phone, phone) && (!row.telegram_chat_id || linked)
        : linked;
    }).map(row => ({
      role, id: row.id, login: row.login, name: row.full_name || row.login,
      phone: row.phone || null, adminRole: row.role,
    }));
  }
  const table = ACCOUNT_TABLES[role];
  if (!table || !phone) return [];
  const select = role === 'customer'
    ? 'SELECT id, name, lname, phone, telegram_chat_id FROM customers'
    : 'SELECT id, login, full_name, phone, telegram_chat_id FROM ' + table +
      (role === 'founder' ? ' WHERE active = 1 AND login IS NOT NULL AND password_hash IS NOT NULL' : ' WHERE active = 1');
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

// The combined panel is a PRESENTATION rule, not a new privileged role.
// Both existing roles must independently match the Telegram-verified phone.
// Never merge a different salon, an inactive groomer, or a deliberately
// linked groomer account other than the current Telegram user.
function hasLinkedGroomerOwner(accounts) {
  const partnerAccount = accounts.find(a => a.role === 'partner');
  const ownerAccount = accounts.find(a => a.role === 'owner');
  if (!partnerAccount || !ownerAccount) return false;
  const partner = db.prepare(
    'SELECT id,point_id,phone,active FROM partners WHERE id = ?'
  ).get(partnerAccount.id);
  const owner = db.prepare(
    'SELECT id,point_id,phone,active,groomer_partner_id FROM salon_owners WHERE id = ?'
  ).get(ownerAccount.id);
  if (!partner || !owner || partner.active !== 1 || owner.active !== 1 ||
      !partner.point_id || !owner.point_id ||
      String(partner.point_id) !== String(owner.point_id) ||
      !normalizeRussianPhone(partner.phone) ||
      normalizeRussianPhone(partner.phone) !== normalizeRussianPhone(owner.phone)) {
    return false;
  }
  // An explicit link takes precedence and must not be silently overruled.
  if (owner.groomer_partner_id != null) {
    return Number(owner.groomer_partner_id) === Number(partner.id);
  }
  // Backward compatibility for salons created before explicit owner links.
  return true;
}

// The home-screen shortcut can use a different WebView storage container
// from the chat. Save only the chosen role, not a token or a raw phone.
const PREFERRED_ROLE_ORDER = Object.freeze(['founder','salon','manager','admin','owner','partner','customer']);
function allowedPreferredRole(role, accounts, combinedSalon) {
  if (role === 'shop') return true;
  if (role === 'salon') return combinedSalon === true;
  return accounts.some(a => a.role === role);
}
function preferredRoleForUser(userId,accounts,combinedSalon) {
  const id = telegramId(userId);
  if (!id) return null;
  const row = db.prepare(
    'SELECT role FROM telegram_miniapp_last_role WHERE telegram_user_id=?'
  ).get(id);
  if (row && allowedPreferredRole(row.role,accounts,combinedSalon)) return row.role;
  const eligible = PREFERRED_ROLE_ORDER.filter(role =>
    allowedPreferredRole(role,accounts,combinedSalon));
  return eligible[0] || 'shop';
}
// Accept only a CURRENT, server-verified, unique role for this Telegram user.
// A different Telegram profile cannot overwrite this user's preference.
function rememberTelegramRole(userId, role, now = Math.floor(Date.now() / 1000)) {
  const id=telegramId(userId);
  if (!id || typeof role !== 'string' ||
      !['shop',...PREFERRED_ROLE_ORDER].includes(role)) return false;
  const state=availableTelegramAccounts(id,now);
  if (!state.verified || !allowedPreferredRole(role,state.accounts,state.combinedSalon))
    return false;
  db.prepare(
    'INSERT INTO telegram_miniapp_last_role(telegram_user_id,role,updated_at) '+
    'VALUES(?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET '+
    'role=excluded.role,updated_at=excluded.updated_at'
  ).run(id,role,now);
  return true;
}

function availableTelegramAccounts(userId, now = Math.floor(Date.now() / 1000)) {
  const phone = verifiedPhoneForUser(userId, now);
  if (!phone) return { verified: false, phoneMasked: '', accounts: [], ambiguousRoles: [] };
  const accounts = [];
  const ambiguousRoles = [];
  for (const role of ['customer', 'partner', 'manager', 'owner', 'founder', 'admin']) {
    const matches = accountMatchesForRole(role, phone, userId);
    if (matches.length === 1) {
      accounts.push(matches[0]);
    } else if (matches.length > 1) {
      // Multiple same-role profiles with one phone can cover distinct salons.
      // Never pick one arbitrarily or grant both on the basis of a phone.
      ambiguousRoles.push(role);
    }
  }
  const combinedSalon=hasLinkedGroomerOwner(accounts);
  return { verified: true, phoneMasked: phoneMasked(phone), phone, accounts, ambiguousRoles,
    combinedSalon, preferredRole: preferredRoleForUser(userId,accounts,combinedSalon) };
}

function issueTelegramAccountSession(userId, role, now = Math.floor(Date.now() / 1000)) {
  if (!['customer', 'partner', 'manager', 'owner', 'founder', 'admin'].includes(role)) return null;
  const matched = availableTelegramAccounts(userId, now);
  if (!matched.verified) return null;
  const account = matched.accounts.find(a => a.role === role);
  if (!account) return null;
  let adminAuthVersion = null;
  if (role === 'admin') {
    // Recheck the live record before granting the privileged session. A
    // changed number, deactivation or conflicting Telegram binding denies it.
    const current = db.prepare(
      'SELECT role, active, phone, telegram_chat_id, miniapp_auth_version FROM admins WHERE id = ?'
    ).get(account.id);
    if (!current || Number(current.active) !== 1) return null;
    const linked = String(current.telegram_chat_id || '') === String(userId);
    if (current.phone) {
      if (!registeredPhoneMatch(current.phone, matched.phone) ||
          (current.telegram_chat_id && !linked)) return null;
      if (!linked) {
        // First verified Telegram owner claims the admin binding atomically.
        // Another Telegram profile cannot take over this account silently.
        const result = db.prepare(
          "UPDATE admins SET telegram_chat_id = ? WHERE id = ? AND active = 1 " +
          "AND phone = ? AND (telegram_chat_id IS NULL OR telegram_chat_id = '')"
        ).run(String(userId), account.id, current.phone);
        if (result.changes !== 1) return null;
      }
    } else if (!linked) {
      return null; // Legacy administrator linked on the authenticated website.
    }
    account.adminRole = current.role;
    adminAuthVersion = Number(current.miniapp_auth_version || 0);
  }
  const token = signToken({
    role: account.role,
    id: account.id,
    ...(account.login ? { login: account.login } : {}),
    ...(role === 'admin' ? { adminRole: account.adminRole, miniappAuthVersion: adminAuthVersion } : {}),
  });
  // Passwordless staff roles are linked only after proof of Telegram ownership.
  if (role !== 'admin') {
    bindTelegramAccount(role,account.id,userId);
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
  preferredRoleForUser, rememberTelegramRole,
  hasLinkedGroomerOwner,
  issueTelegramAccountSession,
};
