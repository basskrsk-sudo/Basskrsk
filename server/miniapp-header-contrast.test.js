'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'miniapp.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
assert.ok(script, 'Mini App inline JS must exist');

function runTelegramUi() {
  const headerColors = [];
  const events = {};
  const elements = {};
  const createElement = (id) => {
    if (!elements[id]) elements[id] = {
      value: '',
      textContent: '',
      innerHTML: '',
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
    };
    return elements[id];
  };
  const document = {
    getElementById: createElement,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { style: {} },
  };
  const telegram = {
    initData: 'valid-signature-fixture',
    ready() {},
    expand() {},
    setHeaderColor(value) { headerColors.push(value); },
    setBackgroundColor() {},
    onEvent(type, fn) { events[type] = fn; },
  };
  const fixtures = {
    '/api/miniapp/auth': { ok: true, user: { id: 1, first_name: 'Test' } },
    '/api/points': { points: [] },
    '/api/products': { products: [] },
  };
  const fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => fixtures[url] || {},
  });
  const window = { Telegram: { WebApp: telegram }, scrollTo() {} };
  vm.runInNewContext(script[1], {
    window, document, fetch,
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { search: '' },
    URLSearchParams,
    setTimeout,
    clearTimeout,
  }, { filename: 'public/miniapp.html', timeout: 3000 });
  return { headerColors, events };
}

test('Telegram header and browser theme are light enough for dark native control glyphs', () => {
  assert.match(html, /<meta name="theme-color" content="#d5eadb">/);
  assert.match(html, /\.top\{background:var\(--green\)/, 'Storefront remains dark green');
  const { headerColors, events } = runTelegramUi();
  assert.deepEqual(headerColors, ['#d5eadb']);
  assert.equal(typeof events.themeChanged, 'function');
  events.themeChanged();
  assert.deepEqual(headerColors, ['#d5eadb', '#d5eadb']);
  assert.ok(!headerColors.includes('#0b4b39'), 'Native controls must not use dark green header');
});
