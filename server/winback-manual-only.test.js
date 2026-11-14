'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('winback is no longer scheduled by the server', () => {
  const main = read('server/server.js');
  const winback = read('server/winback.js');
  assert.doesNotMatch(main, /\.scheduleWinback\s*\(/);
  assert.doesNotMatch(winback, /function scheduleWinback|setInterval\(|setTimeout\(/);
  assert.doesNotMatch(winback, /createSingleFlightJob|trackAsync/);
});

test('protected manual Win-back workflow and its admin UI are preserved', () => {
  const main = read('server/server.js');
  const winback = read('server/winback.js');
  const admin = read('public/taiga-admin.html');
  assert.match(main, /registerWinbackRoutes\(router\)/);
  assert.match(winback, /router\.get\('\/api\/admin\/winback\/candidates'/);
  assert.match(winback, /router\.post\('\/api\/admin\/winback\/run'/);
  assert.match(winback, /requireAuth\(\['admin'\]\)/);
  assert.match(winback, /await sendToChat\(/);
  assert.match(winback, /awardBones\(/);
  assert.match(admin, /Автоматическая рассылка отключена/);
  assert.match(admin, /id="winback-run-btn"/);
  assert.match(admin, /authFetch\('\/api\/admin\/winback\/run'/);
});
