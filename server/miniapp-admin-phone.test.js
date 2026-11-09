'use strict';

// Regression coverage: the super-admin assigns a real phone, Telegram proves
// ownership, and only that active administrator receives a Mini App session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-admin-miniapp-phone-'));
delete process.env.TG_TOKEN;
delete process.env.TG_CHAT_ID;

const db = require('./db');
const { hashPassword, signToken, verifyToken } = require('./auth');
const { registerAuthRoutes } = require('./routes-auth');
const {
  recordVerifiedTelegramContact, availableTelegramAccounts,
  issueTelegramAccountSession,
} = require('./miniapp-phone-identity');

const handlers = { get: new Map(), post: new Map(), put: new Map() };
registerAuthRoutes({
  get(route, handler) { handlers.get.set(route, handler); },
  post(route, handler) { handlers.post.set(route, handler); },
  put(route, handler) { handlers.put.set(route, handler); },
});

function testUser(role = 'admin', phone = null) {
  const login = role + '-' + crypto.randomBytes(5).toString('hex');
  const id = db.prepare(
    'INSERT INTO admins(login,password_hash,full_name,phone,role,active) VALUES(?,?,?,?,?,1)'
  ).run(login, hashPassword('test-password'), 'Тест ' + login, phone, role).lastInsertRowid;
  return {
    id: Number(id),
    login,
    token: signToken({ role: 'admin', id: Number(id), login, adminRole: role }),
  };
}
function invoke(method, route, { token = '', body = {}, params = {} } = {}) {
  const handler = handlers[method].get(route);
  assert.equal(typeof handler, 'function', route + ' missing handler');
  const res = {
    status: 0,
    writeHead(code) { this.status = code; },
    end(content) { this.result = JSON.parse(content); },
  };
  const req = { headers: { authorization: token ? 'Bearer ' + token : '' } };
  return Promise.resolve(handler(req, res, { body, params, query: {} })).then(() => res);
}
function telegramContact(userId, phone, contactId = userId) {
  return {
    from: { id: userId },
    chat: { id: userId, type: 'private' },
    contact: { user_id: contactId, phone_number: phone },
  };
}

const superAdmin = testUser('super');
const staff = testUser('admin');
const phoneA = '79135550021';
const phoneB = '79135550022';
const userA = 788880021;
const userB = 788880022;

test('only a current super-admin may assign a normalized, unique phone', async () => {
  const forbidden = await invoke('put', '/api/admins/:id', {
    token: staff.token, params: { id: String(staff.id) }, body: { phone: phoneA },
  });
  assert.equal(forbidden.status, 403);
  const unauth = await invoke('put', '/api/admins/:id', {
    params: { id: String(staff.id) }, body: { phone: phoneA },
  });
  assert.equal(unauth.status, 401);

  const invalid = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { phone: '1234567' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(db.prepare('SELECT phone FROM admins WHERE id = ?').get(staff.id).phone, null);

  const assigned = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) },
    body: { phone: '8 (913) 555-00-21' },
  });
  assert.equal(assigned.status, 200);
  assert.equal(db.prepare('SELECT phone FROM admins WHERE id = ?').get(staff.id).phone, phoneA);

  const other = testUser('admin');
  const duplicate = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(other.id) }, body: { phone: '+7 913 555 00 21' },
  });
  assert.equal(duplicate.status, 409);
  const list = await invoke('get', '/api/admins', { token: superAdmin.token });
  assert.equal(list.status, 200);
  const item = list.result.admins.find(a => a.id === staff.id);
  assert.equal(item.phone, phoneA);
  assert.equal(item.telegram_connected, 0);
  assert.equal(Object.hasOwn(item, 'telegram_chat_id'), false);
});

test('creation accepts a mobile phone and rejects duplicates', async () => {
  const created = await invoke('post', '/api/admins', {
    token: superAdmin.token,
    body: { login: 'phone-created-admin', password: 'strong-password', full_name: 'Админ телефон',
      role: 'admin', phone: '8 913 555 00 23' },
  });
  assert.equal(created.status, 201);
  assert.equal(db.prepare('SELECT phone FROM admins WHERE id = ?').get(created.result.id).phone, '79135550023');
  const second = await invoke('post', '/api/admins', {
    token: superAdmin.token,
    body: { login: 'phone-duplicate-admin', password: 'strong-password', phone: '79135550023' },
  });
  assert.equal(second.status, 409);
});

test('only the owner of Telegram-confirmed phone enters the admin cabinet without a password', async () => {
  assert.equal(availableTelegramAccounts(userA).verified, false);
  assert.equal(recordVerifiedTelegramContact(telegramContact(userA, phoneA, userA + 1)).verified, false);
  assert.equal(issueTelegramAccountSession(userA, 'admin'), null);
  const proved = recordVerifiedTelegramContact(telegramContact(userA, phoneA));
  assert.equal(proved.verified, true);
  const accounts = availableTelegramAccounts(userA);
  assert.equal(accounts.accounts.filter(a => a.role === 'admin').length, 1);
  const session = issueTelegramAccountSession(userA, 'admin');
  assert.ok(session && session.token);
  const payload = verifyToken(session.token);
  assert.equal(payload.role, 'admin');
  assert.equal(payload.adminRole, 'admin');
  assert.equal(payload.id, staff.id);
  assert.equal(payload.miniappAuthVersion, 1);
  assert.equal(db.prepare('SELECT telegram_chat_id FROM admins WHERE id = ?').get(staff.id).telegram_chat_id, String(userA));
  const me = await invoke('get', '/api/admin/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal(me.result.admin.login, staff.login);
  assert.equal(issueTelegramAccountSession(userB, 'admin'), null);
});

test('changed phone revokes old Mini App tokens and Telegram link immediately', async () => {
  const before = issueTelegramAccountSession(userA, 'admin');
  assert.ok(before && before.token);
  const response = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { phone: phoneB },
  });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT telegram_chat_id FROM admins WHERE id = ?').get(staff.id).telegram_chat_id, null);
  assert.equal(issueTelegramAccountSession(userA, 'admin'), null);
  assert.equal(availableTelegramAccounts(userA).accounts.some(a => a.role === 'admin'), false);
  const oldToken = await invoke('get', '/api/admin/me', { token: before.token });
  assert.equal(oldToken.status, 401);

  recordVerifiedTelegramContact(telegramContact(userB, phoneB));
  const after = issueTelegramAccountSession(userB, 'admin');
  assert.ok(after && after.token);
  assert.equal(db.prepare('SELECT telegram_chat_id FROM admins WHERE id = ?').get(staff.id).telegram_chat_id, String(userB));
  assert.equal((await invoke('get', '/api/admin/me', { token: after.token })).status, 200);
});

test('role changes revoke previous privileges and inactive admins have no access', async () => {
  const activeSession = issueTelegramAccountSession(userB, 'admin');
  assert.ok(activeSession && activeSession.token);
  const promote = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { role: 'super' },
  });
  assert.equal(promote.status, 200);
  assert.equal((await invoke('get', '/api/admin/me', { token: activeSession.token })).status, 401);
  const promoted = issueTelegramAccountSession(userB, 'admin');
  assert.equal(verifyToken(promoted.token).adminRole, 'super');

  const disabled = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { active: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(issueTelegramAccountSession(userB, 'admin'), null);
  assert.equal(availableTelegramAccounts(userB).accounts.some(a => a.role === 'admin'), false);
  assert.equal((await invoke('get', '/api/admin/me', { token: promoted.token })).status, 401);
  assert.equal((await invoke('get', '/api/admins', { token: promoted.token })).status, 401);
});

test('clearing assigned phone resets binding instead of retaining a legacy backdoor', async () => {
  const restored = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { active: true, role: 'admin' },
  });
  assert.equal(restored.status, 200);
  const removed = await invoke('put', '/api/admins/:id', {
    token: superAdmin.token, params: { id: String(staff.id) }, body: { phone: '' },
  });
  assert.equal(removed.status, 200);
  const saved = db.prepare('SELECT phone,telegram_chat_id FROM admins WHERE id = ?').get(staff.id);
  assert.equal(saved.phone, null);
  assert.equal(saved.telegram_chat_id, null);
  assert.equal(issueTelegramAccountSession(userB, 'admin'), null);
});
