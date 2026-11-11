'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const folder = path.join(__dirname, '..', 'public');
const read = name => fs.readFileSync(path.join(folder, name), 'utf8');

test('mini-app has a standalone role-gated bottom map tab using the same site map', () => {
  const html = read('miniapp.html');
  const work = read('miniapp-work.js');
  const css = read('miniapp-network-map.css');
  assert.match(html, /id="mapPage" class="hide"/);
  assert.match(html, /class="tab hide" type="button" data-view="map"/);
  assert.match(html, /miniapp-network-map\.js\?v=1/);
  assert.match(html, /miniapp-network-map\.css\?v=1/);
  assert.match(html, /partner-network-map\.js\?v=8/);
  assert.ok(html.indexOf('src="/config.js"') < html.indexOf('src="/partner-network-map.js?v=8"'));
  assert.ok(html.indexOf('src="/partner-network-map.js?v=8"') < html.indexOf('src="/miniapp-network-map.js?v=1"'));
  assert.match(html, /HvostMiniAppNetworkMap\.available\(\)/);
  assert.match(html, /HvostMiniAppNetworkMap\.close\(\)/);
  assert.match(html, /HvostMiniAppNetworkMap\.open\(target\)/);
  assert.match(html, /HvostMiniAppNetworkMap\.refresh\(\)/);
  assert.match(html, /state\.view==='map'/);
  assert.match(html, /window\.HvostMiniAppOpenLeadFromMap/);
  assert.match(work, /window\.HvostMiniAppGoMap\(role\)/);
  assert.match(css, /#mapPage \.hm-map-canvas/);
  assert.doesNotThrow(() => new Function(read('miniapp-network-map.js')));
  assert.doesNotThrow(() => new Function(read('partner-network-map.js')));
});

function makeHarness() {
  const status = {verified: false, accounts: []};
  const events = {}, sessions = [], widgets = [], visited = [];
  const mountNode = {};
  const root = {
    innerHTML: '',
    replaceChildren() { this.innerHTML = ''; },
    addEventListener(name, callback) { events[name] = callback; },
    querySelector(query) { return query === '[data-mini-map-mount]' ? mountNode : null; }
  };
  const identity = {
    getStatus() { return status; },
    async session(role) { sessions.push(role); return {role, token: 'token-for-' + role}; }
  };
  const window = {
    HvostMiniAppIdentity: identity,
    TAIGA_CONFIG: {YANDEX_MAPS_API_KEY: 'test-public-map-key'},
    HvostMiniAppOpenLeadFromMap(id, role) { visited.push([id, role]); },
    HvostPartnerNetworkMap: {
      mount(node, options) {
        const widget = {node, options, destroyed: false, destroy() { this.destroyed = true; }};
        widgets.push(widget);
        return widget;
      }
    }
  };
  const document = {getElementById(id) { return id === 'mapPage' ? root : null; }};
  vm.runInNewContext(read('miniapp-network-map.js'), {window, document});
  return {api: window.HvostMiniAppNetworkMap, status, events, sessions, widgets,
    visited, window, root, mountNode};
}

test('non-staff, unverified Telegram accounts never receive a map session or token', async () => {
  const h = makeHarness();
  assert.equal(h.api.available(), false);
  await h.api.open();
  assert.equal(h.sessions.length, 0);
  h.status.verified = true;
  h.status.accounts = [{role: 'customer'}, {role: 'partner'}, {role: 'owner'}];
  assert.equal(h.api.available(), false);
  await h.api.open();
  assert.equal(h.sessions.length, 0);
  assert.equal(h.widgets.length, 0);
});

test('verified staff mini-app map loads on demand, reuses role scope, and releases resources on exit', async () => {
  const h = makeHarness();
  h.status.verified = true;
  h.status.accounts = [{role: 'customer'}, {role: 'manager'}];
  assert.equal(h.api.available(), true);
  await h.api.open();
  assert.deepEqual(h.sessions, ['manager']);
  assert.equal(h.widgets.length, 1);
  const first = h.widgets[0];
  assert.equal(first.node, h.mountNode);
  assert.equal(first.options.token(), 'token-for-manager');
  assert.equal(first.options.maxInitialGeocode, 35);
  first.options.onOpenLead(13);
  assert.equal(h.visited.length, 1);
  assert.equal(h.visited[0][0], 13);
  assert.equal(h.visited[0][1], 'manager');

  h.api.close();
  assert.equal(first.destroyed, true);
  assert.equal(first.options.token(), '');
  first.options.onOpenLead(17);
  assert.equal(h.visited.length, 1, 'old callbacks cannot navigate after map is closed');
  assert.equal(h.root.innerHTML, '');
});

test('verified administrator can use admin scope, never silently escalates manager-only account', async () => {
  const h = makeHarness();
  h.status.verified = true;
  h.status.accounts = [{role: 'manager'}];
  await h.api.open('admin');
  assert.equal(h.sessions[0], 'manager', 'requested unavailable role cannot elevate permissions');
  h.api.close();
  h.status.accounts = [{role: 'manager'}, {role: 'admin'}];
  h.status.preferredRole = 'manager';
  await h.api.open('admin');
  assert.equal(h.sessions[1], 'admin');
  assert.equal(h.widgets[1].options.token(), 'token-for-admin');
  h.status.accounts = [{role: 'customer'}];
  assert.equal(h.widgets[1].options.token(), '');
  h.api.close();
});

test('map widget supports small initial geocoding batch on mobile and full map remains available on site', () => {
  const script = read('partner-network-map.js');
  assert.match(script, /var initialLimit = Number\(options\.maxInitialGeocode\)/);
  assert.match(script, /initialLimit = Number\.isFinite\(initialLimit\)/);
  assert.match(script, /limit: initialLimit/);
  assert.match(script, /state\.limit \+= initialLimit/);
  assert.match(script, /candidate_ids/);
  assert.match(script, /colorKey/);
});
