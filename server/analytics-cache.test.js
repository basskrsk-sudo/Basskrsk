'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyticsCache } = require('./analytics-cache');

test('short-lived analytics cache reuses a result and expires at TTL', () => {
  let now = 1000, rev = 7, loads = 0;
  const cache = createAnalyticsCache(() => rev, { ttlMs: 30000, clock: () => now, maxEntries: 2 });
  function load() { loads++; return { score: loads }; }
  const a = cache.get('2026-11-02', load);
  assert.strictEqual(cache.get('2026-11-02', load), a);
  assert.equal(loads, 1);
  now += 30001;
  assert.equal(cache.get('2026-11-02', load).score, 2);
  assert.equal(loads, 2);
});

test('changes in SQLite invalidate cache immediately, even inside TTL', () => {
  let rev = '3:1', loads = 0;
  const cache = createAnalyticsCache(() => rev, { ttlMs: 30000 });
  const load = () => ({ score: ++loads });
  assert.equal(cache.get('same-week', load).score, 1);
  rev = '4:1';
  assert.equal(cache.get('same-week', load).score, 2);
  rev = '4:2';
  assert.equal(cache.get('same-week', load).score, 3);
  assert.equal(cache.get('same-week', load).score, 3);
  cache.invalidate();
  assert.equal(cache.get('same-week', load).score, 4);
});

test('analytics cache bounds its size, separates periods and never returns stale-on-error', () => {
  let calls = 0;
  const cache = createAnalyticsCache(() => 0, { maxEntries: 2, ttlMs: 30000 });
  cache.get('week1', () => ++calls);
  cache.get('week2', () => ++calls);
  cache.get('week3', () => ++calls);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('week1', () => ++calls), 4, 'oldest week must be evicted');
  cache.invalidate();
  assert.throws(() => cache.get('week1', () => { throw new Error('SQLite unavailable'); }),
    /SQLite unavailable/);
  assert.equal(cache.size, 0, 'failed loads must never enter cache');
});
