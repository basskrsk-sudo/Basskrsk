'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('network map is available in admin, manager and both staff Mini App dashboards', () => {
  const admin = read('taiga-admin.html');
  const manager = read('taiga-manager.html');
  const adminNav = read('admin-navigation.js');
  const mini = read('miniapp.html');
  const miniWork = read('miniapp-work.js');
  for (const file of [admin, manager, mini]) {
    assert.match(file, /partner-network-map\.js/);
    assert.match(file, /partner-network-map\.css/);
  }
  assert.match(admin, /id="sec-network-map"/);
  assert.match(manager, /id="sec-network-map"/);
  assert.match(adminNav, /'network-map':'network'/);
  assert.match(manager, /data-group="map"/);
  assert.match(miniWork, /data-work-action="network-map-open"/);
  assert.match(miniWork, /role === 'admin' && adminRegisterAuthorized\(\)/);
  assert.match(miniWork, /role === 'manager' && phoneRoleAvailable\('manager'\)/);
});

test('network map statuses and popup actions are anchored to actual CRM data', () => {
  const script = read('partner-network-map.js');
  assert.match(script, /\/api\/partner-leads\/network-map/);
  for (const status of ['active','to_call','no_answer','in_progress','declined']) {
    assert.match(script, new RegExp(status));
  }
  assert.match(script, /new window\.ymaps\.Placemark/);
  assert.match(script, /network-map\/coordinates/);
  assert.match(script, /data-map-attention/);
  assert.match(script, /unplacedReason/);
  assert.match(script, /lead_ids/);
  assert.match(script, /onOpenLead/);
  assert.match(script, /escapeHtml/);
  assert.match(script, /window\.TAIGA_CONFIG\.YANDEX_MAPS_API_KEY/);
  assert.doesNotThrow(() => new Function(script));
});
