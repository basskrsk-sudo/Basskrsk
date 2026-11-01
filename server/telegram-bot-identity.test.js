'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-telegram-identity-'));
process.env.TOKEN_SECRET = 'isolated-telegram-identity-test';
process.env.TG_TOKEN = 'test-token-only-not-used-for-real-requests';
// Even if Amvera still has a stale bot name, invitations must use the real one.
process.env.TG_BOT_USERNAME = 'irrelevant_previous_username';

const db = require('./db');
require('./business-founders');
const { signToken } = require('./auth');
const { registerAuthRoutes } = require('./routes-auth');
const { TELEGRAM_BOT_USERNAME, TELEGRAM_BOT_URL, telegramStartLink } =
  require('./telegram-bot-identity');

const handlers = new Map();
const router = Object.fromEntries(['get', 'post', 'put'].map(method => [
  method, (url, callback) => handlers.set(method.toUpperCase() + ' ' + url, callback),
]));
registerAuthRoutes(router);

function call(pathname, body, signedToken) {
  const response = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(json) { this.body = JSON.parse(json); },
  };
  const callback = handlers.get('POST ' + pathname);
  assert.ok(callback, pathname + ' route should exist');
  callback({
    headers: signedToken ? { authorization: 'Bearer ' + signedToken } : {},
  }, response, { body: body || {}, query: {}, params: {} });
  return response;
}

const phone = '79135556677';
const partnerId = db.prepare(
  'INSERT INTO partners (partner_code,login,password_hash,full_name,phone,point_name,active) VALUES (?,?,?,?,?,?,1)'
).run('GR-URL','partner-url','hash','Тестовый грумер',phone,'Салон').lastInsertRowid;
const managerId = db.prepare(
  'INSERT INTO managers (mgr_code,login,password_hash,full_name,phone,active) VALUES (?,?,?,?,?,1)'
).run('M-URL','manager-url','hash','Тестовый менеджер',phone).lastInsertRowid;
const ownerId = db.prepare(
  'INSERT INTO salon_owners (login,password_hash,full_name,phone,active) VALUES (?,?,?,?,1)'
).run('owner-url','hash','Тестовый владелец',phone).lastInsertRowid;
const adminId = db.prepare(
  'INSERT INTO admins (login,password_hash,full_name,role,active) VALUES (?,?,?,?,1)'
).run('admin-url','hash','Тестовый администратор','super').lastInsertRowid;
const founderId = db.prepare('SELECT id FROM business_founders ORDER BY id LIMIT 1').get().id;
db.prepare('UPDATE business_founders SET active=1,phone=? WHERE id=?').run(phone,founderId);

function verifyInvitation(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.body.token, /^[0-9a-f]+$/);
  const link = new URL(response.body.deep_link);
  assert.equal(link.origin, 'https://t.me');
  assert.equal(link.pathname, '/' + TELEGRAM_BOT_USERNAME);
  assert.equal(link.searchParams.get('start'), response.body.token);
  assert.equal(response.body.deep_link, telegramStartLink(response.body.token));
}

test('one current bot URL is used instead of runtime username overrides', () => {
  assert.equal(TELEGRAM_BOT_USERNAME, 'HvostMarketRusBot');
  assert.equal(TELEGRAM_BOT_URL, 'https://t.me/HvostMarketRusBot');
  assert.equal(telegramStartLink('a+b'), 'https://t.me/HvostMarketRusBot?start=a%2Bb');
});

test('customer, groomer and manager login invitations use current Telegram bot', () => {
  for (const pathname of ['/api/customer/telegram/start',
    '/api/partners/telegram/start', '/api/managers/telegram/start']) {
    verifyInvitation(call(pathname, { phone }));
  }
});

test('connected cabinet invitations use current bot in all five staff roles', () => {
  const accounts = [
    ['admin', adminId], ['partner', partnerId], ['manager', managerId],
    ['owner', ownerId], ['founder', founderId],
  ];
  for (const [role, id] of accounts) {
    verifyInvitation(call('/api/telegram/connect/start', {}, signToken({
      role, id, ...(role === 'admin' ? { adminRole: 'super' } : {}),
    })));
  }
});

test('old environment username cannot change invite target', () => {
  process.env.TG_BOT_USERNAME = 'unused_stale_environment_value';
  verifyInvitation(call('/api/customer/telegram/start', { phone }));
  delete process.env.TG_BOT_USERNAME;
  verifyInvitation(call('/api/partners/telegram/start', { phone }));
  const source = fs.readFileSync(path.join(__dirname, 'routes-auth.js'), 'utf8');
  assert.doesNotMatch(source, /process\.env\.TG_BOT_USERNAME/);
});
