'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loginPage = fs.readFileSync(path.join(__dirname, '..', 'public/taiga-groomer.html'),'utf8');
const bot = fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');

test('groomer site clearly offers Telegram mini app or website Telegram verification',()=>{
  assert.match(loginPage,/href="https:\/\/t\.me\/HvostMarketRusBot\?start=app"/);
  assert.match(loginPage,/Открыть мини-приложение/);
  assert.match(loginPage,/Войти на этом сайте через Telegram/);
  assert.match(loginPage,/id="tg-login-block"/);
  assert.match(loginPage,/id="tg-login-phone"/);
  assert.match(loginPage,/\/api\/partners\/telegram\/start/);
  assert.match(loginPage,/\/api\/partners\/telegram\/check/);
  assert.match(bot,/token === 'app'/);
});
test('website password login remains accessible and independent of Telegram',()=>{
  assert.match(loginPage,/id="l-login"/);
  assert.match(loginPage,/id="l-pass"/);
  assert.match(loginPage,/onclick="doLogin\(\)"/);
  assert.match(loginPage,/role: 'partner', login: l, password: p/);
  assert.match(loginPage,/Вход на сайте по логину и паролю/);
  assert.doesNotMatch(loginPage,/\/api\/sms|отправить смс|Получить SMS/i);
});
test('groomer dashboard remains unavailable until successful authentication',()=>{
  assert.match(loginPage,/#app\{display:none;\}/);
  assert.match(loginPage,/await onPartnerLoginSuccess\(data\)/);
  assert.match(loginPage,/await onPartnerLoginSuccess\(result\)/);
  assert.match(loginPage,/function toggleTgLogin\(\)/);
  assert.match(loginPage,/aria-expanded="false"/);
});
