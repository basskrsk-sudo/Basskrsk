'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REFRESH_MS, createBotConfigSync, configFingerprint, retryAfterSeconds,
  planConfigSync } = require('./bot-config-sync');

test('unchanged configuration is not resent on each restart but refreshes after a day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bot-cache-'));
  let now = 1000;
  const gate = () => createBotConfigSync('telegram-profile', { name: 'ХвостМаркет', commands: ['start'] },
    { dataDir: dir, now: () => now });
  assert.equal(gate().check().sync, true);
  assert.equal(gate().succeeded(), true);
  assert.equal(gate().check().reason, 'unchanged');
  now += 10000;
  assert.equal(gate().check().sync, false);
  now += REFRESH_MS;
  assert.equal(gate().check().sync, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('changed configuration is sent even within cache TTL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bot-change-'));
  const opts = { dataDir: dir, now: () => 100000 };
  createBotConfigSync('max-commands', ['start'], opts).succeeded();
  assert.equal(createBotConfigSync('max-commands', ['start'], opts).check().sync, false);
  assert.equal(createBotConfigSync('max-commands', ['start', 'stock'], opts).check().sync, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('Telegram 429 retry_after is preserved across restarts and overrides transient retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bot-429-'));
  let now = 100000;
  const gate = () => createBotConfigSync('telegram-profile', { menu: ['help'] },
    { dataDir: dir, now: () => now });
  assert.equal(gate().failed([{ message: 'Too Many Requests: retry after 82631' }]), 82631000);
  now += 60 * 60 * 1000;
  assert.equal(gate().check().reason, 'cooldown');
  assert.equal(gate().check().sync, false);
  now += 82631000;
  assert.equal(gate().check().sync, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('cache fingerprints are stable without including token details', () => {
  assert.equal(configFingerprint({ a: 1 }), configFingerprint({ a: 1 }));
  assert.notEqual(configFingerprint({ a: 1 }), configFingerprint({ a: 2 }));
  assert.equal(retryAfterSeconds({ parameters: { retry_after: 12 } }), 12);
  assert.equal(planConfigSync({ fingerprint: 'a', success_at: 100 }, 'a', 200).reason, 'unchanged');
});
