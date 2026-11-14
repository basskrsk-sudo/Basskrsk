'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { seedVersion, runVersionedSeed } = require('./seed-bootstrap');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-seed-once-'));
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE task_seed_versions(version TEXT PRIMARY KEY); ' +
    'CREATE TABLE initial_products(name TEXT NOT NULL UNIQUE)');
  const sourcePath = path.join(dir, 'seed-source.js');
  fs.writeFileSync(sourcePath, "module.exports = () => 'v1';");
  return {
    dir, database, sourcePath,
    end() { database.close(); fs.rmSync(dir, { recursive:true, force:true }); },
  };
}

test('same seed source revision runs exactly once across app restarts', () => {
  const f = fixture();
  try {
    let calls = 0;
    const run = () => {
      calls++;
      f.database.prepare('INSERT INTO initial_products(name) VALUES(?)').run('Товар');
    };
    const once = runVersionedSeed({ database:f.database, sourcePath:f.sourcePath, run });
    const twice = runVersionedSeed({ database:f.database, sourcePath:f.sourcePath, run });
    assert.equal(once.skipped, false);
    assert.equal(twice.skipped, true);
    assert.equal(once.version, twice.version);
    assert.equal(calls, 1);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM initial_products').get().n, 1);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM task_seed_versions').get().n, 1);
  } finally { f.end(); }
});

test('changing source automatically reruns seed after a deployment', () => {
  const f = fixture();
  try {
    let calls = 0;
    const run = () => { calls++; };
    runVersionedSeed({ database:f.database, sourcePath:f.sourcePath, run });
    fs.writeFileSync(f.sourcePath, "module.exports = () => 'v2';");
    const second=runVersionedSeed({ database:f.database, sourcePath:f.sourcePath, run });
    assert.equal(second.skipped,false);
    assert.equal(calls,2);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM task_seed_versions').get().n,2);
  } finally { f.end(); }
});

test('failed importer is fully rolled back and safe to retry', () => {
  const f = fixture();
  try {
    assert.throws(() => runVersionedSeed({
      database:f.database, sourcePath:f.sourcePath,
      run:() => {
        f.database.prepare('INSERT INTO initial_products(name) VALUES(?)').run('Промежуточный');
        throw new Error('seed failed');
      },
    }), /seed failed/);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM initial_products').get().n,0);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM task_seed_versions').get().n,0);
    const second=runVersionedSeed({
      database:f.database, sourcePath:f.sourcePath,
      run:() => { f.database.prepare('INSERT INTO initial_products(name) VALUES(?)').run('Товар'); },
    });
    assert.equal(second.skipped,false);
    assert.deepEqual(f.database.prepare('SELECT name FROM initial_products').all().map(x=>x.name),['Товар']);
  } finally { f.end(); }
});

test('startup uses versioned seed while historical meeting migrations remain', () => {
  const src=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  assert.match(src,/require\('\.\/seed-bootstrap'\)\.runVersionedSeed\(\)/);
  assert.doesNotMatch(src,/require\('\.\/seed'\)\(\)/);
  assert.match(src,/require\('\.\/task-seed-bootstrap'\)\.runPendingTaskSeeds\(\)/);
  assert.equal(seedVersion('same'),seedVersion('same'));
  assert.notEqual(seedVersion('same'),seedVersion('different'));
});
