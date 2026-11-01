'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-miniapp-phone-'));
const db = require('./db');
const { verifyToken } = require('./auth');
const {
  normalizeRussianPhone, recordVerifiedTelegramContact,
  verifiedPhoneForUser, availableTelegramAccounts, issueTelegramAccountSession,
  PHONE_PROOF_TTL_SECONDS,
} = require('./miniapp-phone-identity');
const { registerMiniAppRoutes } = require('./routes-miniapp');

const NOW = Math.floor(Date.now() / 1000);
const USER = 926341211;
const PHONE = '79135678901';
function msg(sender, phone = PHONE, fromContact = sender, type = 'private') {
  return {
    from: { id: sender },
    chat: { id: sender, type },
    contact: { user_id: fromContact, phone_number: phone },
  };
}
function addCustomer(phone) {
  return db.prepare('INSERT INTO customers (phone, name) VALUES (?, ?)').run(phone, 'Покупатель').lastInsertRowid;
}
function addPartner(phone, telegramChat = null, active = 1) {
  return db.prepare(
    'INSERT INTO partners (partner_code, login, password_hash, full_name, phone, point_name, telegram_chat_id, active) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('GR-' + crypto.randomBytes(5).toString('hex'), 'g-' + crypto.randomBytes(5).toString('hex'),
    'fakehash', 'Грумер', phone, 'БаркЛай', telegramChat, active).lastInsertRowid;
}
function addManager(phone) {
  return db.prepare(
    'INSERT INTO managers (mgr_code, login, password_hash, full_name, phone) VALUES (?, ?, ?, ?, ?)'
  ).run('M-' + crypto.randomBytes(5).toString('hex'), 'm-' + crypto.randomBytes(5).toString('hex'),
    'fakehash', 'Менеджер', phone).lastInsertRowid;
}
function addOwner(phone) {
  return db.prepare(
    'INSERT INTO salon_owners (login, password_hash, full_name, phone) VALUES (?, ?, ?, ?)'
  ).run('o-' + crypto.randomBytes(5).toString('hex'), 'fakehash', 'Владелец', phone).lastInsertRowid;
}
function addAdmin(chatId, adminRole = 'super') {
  return db.prepare(
    'INSERT INTO admins (login, password_hash, full_name, telegram_chat_id, role) VALUES (?, ?, ?, ?, ?)'
  ).run('a-' + crypto.randomBytes(5).toString('hex'), 'fakehash', 'Админ', String(chatId), adminRole).lastInsertRowid;
}

test('phone normalization handles registered 8, +7 and ten-digit mobiles only', () => {
  assert.equal(normalizeRussianPhone('8 (913) 567-89-01'), PHONE);
  assert.equal(normalizeRussianPhone('+7 913 567 89 01'), PHONE);
  assert.equal(normalizeRussianPhone('9135678901'), PHONE);
  for (const x of ['123456', '+1 202-555-1234', '0000000000', 'abc']) {
    assert.equal(normalizeRussianPhone(x), null);
  }
});

test('manual, foreign, group and forwarded contacts cannot confirm a phone', () => {
  assert.equal(recordVerifiedTelegramContact(msg(USER, PHONE, USER + 1)).verified, false);
  assert.equal(recordVerifiedTelegramContact(msg(USER, PHONE, USER, 'group')).verified, false);
  assert.equal(recordVerifiedTelegramContact({ from: { id: USER }, chat: { id: USER, type: 'private' },
    contact: { phone_number: PHONE } }).verified, false);
  assert.equal(recordVerifiedTelegramContact({ from: { id: USER }, chat: { id: USER + 1, type: 'private' },
    contact: { user_id: USER, phone_number: PHONE } }).verified, false);
  assert.equal(verifiedPhoneForUser(USER), null);
});

test('self-consented Telegram contact unlocks each existing registered account role', () => {
  const customer = addCustomer('89135678901');
  const partner = addPartner('+7 (913) 567-89-01');
  const manager = addManager('9135678901');
  const owner = addOwner(PHONE);
  const verified = recordVerifiedTelegramContact(msg(USER), NOW);
  assert.deepEqual(verified, { verified: true, phoneMasked: '+7 (***) ***-**-01' });
  const accounts = availableTelegramAccounts(USER, NOW);
  assert.equal(accounts.verified, true);
  assert.deepEqual(accounts.accounts.map(a => a.role), ['customer', 'partner', 'manager', 'owner']);
  assert.equal(accounts.accounts.some(a => a.role === 'admin'), false);
  for (const [role, expectedId] of Object.entries({ customer, partner, manager, owner })) {
    const session = issueTelegramAccountSession(USER, role, NOW);
    assert.ok(session.token);
    const claims = verifyToken(session.token);
    assert.equal(claims.role, role);
    assert.equal(Number(claims.id), Number(expectedId));
    const table = { customer: 'customers', partner: 'partners', manager: 'managers', owner: 'salon_owners' }[role];
    assert.equal(db.prepare('SELECT telegram_chat_id FROM ' + table + ' WHERE id = ?').get(expectedId).telegram_chat_id, String(USER));
  }
});

test('admin role requires prior authenticated Telegram linking, not only phone match', () => {
  const other = addAdmin(USER + 1, 'super');
  assert.ok(other);
  assert.equal(issueTelegramAccountSession(USER, 'admin', NOW), null);
  const adminId = addAdmin(USER, 'super');
  const data = issueTelegramAccountSession(USER, 'admin', NOW);
  assert.ok(data && data.token);
  const claims = verifyToken(data.token);
  assert.equal(Number(claims.id), Number(adminId));
  assert.equal(claims.role, 'admin');
  assert.equal(claims.adminRole, 'super');
});

test('existing link to another Telegram account cannot be hijacked by phone reassignment', () => {
  const victim = addPartner('79135556677', '888888888');
  const newTelegram = 555666777;
  recordVerifiedTelegramContact(msg(newTelegram, '79135556677'), NOW);
  assert.equal(availableTelegramAccounts(newTelegram, NOW).accounts.some(a => a.role === 'partner'), false);
  assert.equal(issueTelegramAccountSession(newTelegram, 'partner', NOW), null);
  assert.equal(db.prepare('SELECT telegram_chat_id FROM partners WHERE id = ?').get(victim).telegram_chat_id, '888888888');
});

test('expired phone proof cannot mint a new staff or customer session', () => {
  assert.equal(verifiedPhoneForUser(USER, NOW + PHONE_PROOF_TTL_SECONDS + 1), null);
  assert.equal(issueTelegramAccountSession(USER, 'customer', NOW + PHONE_PROOF_TTL_SECONDS + 1), null);
});

test('duplicate groomer accounts sharing a phone are not arbitrarily selected', () => {
  const phone = '79132225566', user = 555123444;
  addPartner(phone);
  addPartner(phone);
  recordVerifiedTelegramContact(msg(user, phone), NOW);
  const result = availableTelegramAccounts(user, NOW);
  assert.ok(result.ambiguousRoles.includes('partner'));
  assert.equal(result.accounts.some(a => a.role === 'partner'), false);
  assert.equal(issueTelegramAccountSession(user, 'partner', NOW), null);
});

test('inactive staff are never eligible, and unverified strangers cannot see accounts', () => {
  const phone = '79136667788', user = 777111444;
  addPartner(phone, null, 0);
  recordVerifiedTelegramContact(msg(user, phone), NOW);
  assert.equal(availableTelegramAccounts(user, NOW).accounts.some(a => a.role === 'partner'), false);
  assert.equal(availableTelegramAccounts(999999999, NOW).verified, false);
  assert.equal(issueTelegramAccountSession(999999999, 'customer', NOW), null);
});

function initData(token, userId) {
  const params = new URLSearchParams({
    user: JSON.stringify({ id: userId, first_name: 'Тест' }),
    auth_date: String(NOW),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}
function invoke(path, body) {
  const routes = {};
  registerMiniAppRoutes({
    post(route, handler) { routes[route] = handler; },
  });
  const response = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(value) { this.result = JSON.parse(value); },
  };
  routes[path]({}, response, { body });
  return response;
}

test('signed Telegram initData gates role discovery and passwordless sessions', () => {
  const before = process.env.TG_TOKEN;
  try {
    process.env.TG_TOKEN = '777777:test-telegram-identity';
    const signed = initData(process.env.TG_TOKEN, USER);
    const profiles = invoke('/api/miniapp/accounts', { initData: signed });
    assert.equal(profiles.status, 200);
    assert.equal(profiles.result.verified, true);
    assert.ok(profiles.result.accounts.some(a => a.role === 'manager'));
    assert.equal(JSON.stringify(profiles.result).includes(PHONE), false, 'no raw phone leakage');

    const forged = invoke('/api/miniapp/session', { initData: signed, phone: '79130001122', role: 'manager' });
    assert.equal(forged.status, 200);
    assert.equal(verifyToken(forged.result.token).role, 'manager');

    assert.equal(invoke('/api/miniapp/session', {
      initData: signed.replace('auth_date=', 'auth_date=2'), role: 'manager',
    }).status, 401);
    assert.equal(invoke('/api/miniapp/session', {
      initData: initData(process.env.TG_TOKEN, 999444111), role: 'admin',
    }).status, 403);
    assert.equal(invoke('/api/miniapp/session', { initData: signed, role: 'arbitrary-admin' }).status, 400);
  } finally {
    if (before === undefined) delete process.env.TG_TOKEN;
    else process.env.TG_TOKEN = before;
  }
});
