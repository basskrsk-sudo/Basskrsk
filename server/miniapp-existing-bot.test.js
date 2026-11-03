'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SHOP_URL, SHOP_LAUNCH_URL, WORK_URL, miniAppInlineKeyboard, commandsMenuButton,
  miniAppDirectLinkMarkup,
} = require('./miniapp-bot-links');
const { registerMiniAppRoutes } = require('./routes-miniapp');

function signedInitData(botToken, now) {
  const fields = new URLSearchParams({
    auth_date: String(now),
    query_id: 'ExampleSigned',
    user: JSON.stringify({ id: 119000, first_name: 'Тестовый' }),
  });
  const check = [...fields.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  fields.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return fields.toString();
}

function callMiniAppAuth(body) {
  let handler;
  registerMiniAppRoutes({
    post(route, fn) {
      if (route === '/api/miniapp/auth') handler = fn;
    },
  });
  const response = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(json) { this.body = JSON.parse(json); },
  };
  handler({}, response, { body });
  return response;
}

test('same existing bot exposes one universal app launcher, with legacy command aliases', () => {
  assert.equal(SHOP_URL, 'https://хвостмаркет.рф/miniapp.html');
  assert.equal(WORK_URL, SHOP_URL + '?view=work');
  assert.equal(SHOP_LAUNCH_URL, SHOP_URL + '?view=shop');
  assert.deepEqual(commandsMenuButton(), { type: 'commands' });
  const launch = miniAppInlineKeyboard();
  assert.equal(launch.length, 1);
  assert.equal(launch[0].length, 1);
  assert.equal(launch[0][0].text, '🐾 Открыть ХвостМаркет');
  assert.equal(launch[0][0].web_app.url, SHOP_URL);
  for (const alias of ['app', 'shop', 'work']) {
    assert.deepEqual(miniAppDirectLinkMarkup(alias).inline_keyboard, launch);
  }
  const poller = fs.readFileSync(path.join(__dirname, 'telegram-login-poller.js'), 'utf8');
  assert.match(poller, /\{ command: 'app', description:/);
  assert.doesNotMatch(poller, /\{ command: 'shop', description:/);
  assert.doesNotMatch(poller, /\{ command: 'cabinet', description:/);
  assert.match(poller, /(?:app\|shop\|cabinet)/);
});

test('one fresh Telegram WebView link does not leak a phone, token or role', () => {
  const a = miniAppInlineKeyboard({ fresh: true });
  const b = miniAppInlineKeyboard({ fresh: true });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  const first = new URL(a[0][0].web_app.url);
  const second = new URL(b[0][0].web_app.url);
  assert.equal(first.origin, new URL(SHOP_URL).origin);
  assert.equal(first.pathname, '/miniapp.html');
  assert.match(first.searchParams.get('launch'), /^[0-9a-f]{24}$/);
  assert.notEqual(first.href, second.href);
  for (const key of ['phone', 'token', 'initData', 'view', 'role']) {
    assert.equal(first.searchParams.has(key), false);
  }
  for (const alias of ['app', 'shop', 'work']) {
    const direct = miniAppDirectLinkMarkup(alias, { fresh: true });
    assert.equal(direct.inline_keyboard.length, 1);
    assert.equal(direct.inline_keyboard[0].length, 1);
    assert.match(direct.inline_keyboard[0][0].web_app.url, /miniapp\.html\?launch=[0-9a-f]{24}$/);
  }
  const poller = fs.readFileSync(path.join(__dirname, 'telegram-login-poller.js'), 'utf8');
  assert.match(poller, /miniAppInlineKeyboard\(\{ fresh: true \}\)/);
  assert.match(poller, /miniAppDirectLinkMarkup\('app', \{ fresh: true \}\)/);
});

test('Mini App trusts ONLY the shared TG_TOKEN, never a second bot token', () => {
  const previous = { TG_TOKEN: process.env.TG_TOKEN, TG_SHOP_BOT_TOKEN: process.env.TG_SHOP_BOT_TOKEN };
  const now = Math.floor(Date.now() / 1000);
  try {
    process.env.TG_TOKEN = '900001:existing_bot_token';
    process.env.TG_SHOP_BOT_TOKEN = '900002:wrong_separate_bot_token';
    const signed = signedInitData(process.env.TG_TOKEN, now);
    const valid = callMiniAppAuth({ initData: signed });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.user.id, 119000);
    assert.equal(
      callMiniAppAuth({ initData: signedInitData(process.env.TG_SHOP_BOT_TOKEN, now) }).status,
      401
    );
    delete process.env.TG_TOKEN;
    assert.equal(callMiniAppAuth({ initData: signed }).status, 503);
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('only existing long-poller is started and Mini App routes are registered', () => {
  const dir = __dirname;
  const server = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  const poller = fs.readFileSync(path.join(dir, 'telegram-login-poller.js'), 'utf8');
  assert.match(server, /require\('\.\/telegram-login-poller'\)\.startPolling\(\)/);
  assert.doesNotMatch(server, /customer-miniapp-bot/);
  assert.match(server, /registerMiniAppRoutes\(router\)/);
  assert.match(poller, /\['setChatMenuButton', \{ menu_button: commandsMenuButton\(\) \}\]/);
  assert.doesNotMatch(poller, /\['setChatMenuButton', \{ menu_button: miniAppMenuButton\(\) \}\]/);
  assert.match(poller, /miniAppInlineKeyboard\(\{ fresh: true \}\)/);
  assert.match(poller, /\/cabinet/);
  assert.match(poller, /\/shop/);
  assert.ok(!fs.existsSync(path.join(dir, 'customer-miniapp-bot.js')));
});
