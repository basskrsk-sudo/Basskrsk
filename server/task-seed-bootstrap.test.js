'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LEGACY_TASK_SEEDS, runPendingTaskSeeds } = require('./task-seed-bootstrap');
const main = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function setup(doneVersions) {
  const loaded = [];
  const all = new Set(doneVersions);
  let reads = 0;
  const database = {
    prepare(sql) {
      assert.equal(sql, 'SELECT version FROM task_seed_versions');
      reads++;
      return { all: () => [...all].map(version => ({ version })) };
    },
  };
  function load(module) {
    loaded.push(module);
    const seed = LEGACY_TASK_SEEDS.find(item => item.module === module);
    assert.ok(seed);
    return { [seed.method]() {} };
  }
  return { database, load, loaded, reads: () => reads };
}

test('completed old imports cause one DB read and zero imports', () => {
  const done = LEGACY_TASK_SEEDS.flatMap(item => item.versions);
  const h = setup(done);
  runPendingTaskSeeds(h.database, h.load);
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.loaded, []);
});

test('empty database imports all four original meetings in order', () => {
  const h = setup([]);
  runPendingTaskSeeds(h.database, h.load);
  assert.deepEqual(h.loaded, LEGACY_TASK_SEEDS.map(item => item.module));
  assert.equal(h.reads(), 1);
});

test('partially migrated database imports only unfinished meeting groups', () => {
  const done = LEGACY_TASK_SEEDS.slice(0, 2).flatMap(item => item.versions);
  const h = setup(done);
  runPendingTaskSeeds(h.database, h.load);
  assert.deepEqual(h.loaded, LEGACY_TASK_SEEDS.slice(2).map(item => item.module));
});

test('a missing September follow-up version still runs its original importer', () => {
  const done = LEGACY_TASK_SEEDS.flatMap(item => item.versions)
    .filter(version => version !== 'task-2026-09-28-price-list-angelina-due-2026-10-02-v1');
  const h = setup(done);
  runPendingTaskSeeds(h.database, h.load);
  assert.deepEqual(h.loaded, ['./task-seed']);
});

test('bootstrap marker list matches every legacy importer version', () => {
  for (const item of LEGACY_TASK_SEEDS) {
    const moduleSource = fs.readFileSync(path.join(__dirname, item.module.slice(2) + '.js'), 'utf8');
    const defined = [...moduleSource.matchAll(/const\s+[A-Z_]*VERSION\s*=\s*'([^']+)'/g)]
      .map(match => match[1]);
    assert.deepEqual([...item.versions].sort(), defined.sort(), item.module);
  }
  assert.match(main, /require\('\.\/task-seed-bootstrap'\)\.runPendingTaskSeeds\(\)/);
  for (const item of LEGACY_TASK_SEEDS) {
    assert.equal(main.includes("require('" + item.module + "')"), false, item.module);
  }
});
