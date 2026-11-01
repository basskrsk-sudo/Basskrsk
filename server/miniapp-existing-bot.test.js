'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SHOP_URL, WORK_URL, miniAppInlineKeyboard, commandsMenuButton,
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
      assert.equal(route, '/api/miniapp/auth');
      handler = fn;
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

test('same existing bot supplies a single menu and both Mini App destinations', () => {
  assert.equal(SHOP_URL, 'https://хвостмаркет.рф/miniapp.html');
  assert.equal(WORK_URL, SHOP_URL + '?view=work');
  assert.deepEqual(commandsMenuButton(), { type: 'commands' });
  assert.deepEqual(
    miniAppInlineKeyboard().map((row) => row[0].web_app.url),
    [SHOP_URL, WORK_URL]
  );
  assert.equal(miniAppDirectLinkMarkup('shop').inline_keyboard[0][0].web_app.url, SHOP_URL);
  assert.equal(miniAppDirectLinkMarkup('work').inline_keyboard[0][0].web_app.url, WORK_URL);
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
  assert.match(poller, /miniAppInlineKeyboard\(\)/);
  assert.match(poller, /\/cabinet/);
  assert.match(poller, /\/shop/);
  assert.ok(!fs.existsSync(path.join(dir, 'customer-miniapp-bot.js')));
});
