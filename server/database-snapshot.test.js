'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDatabaseSnapshot } = require('./database-snapshot');

test('snapshot is consistent and does not block the HTTP event loop', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-snapshot-'));
  try {
    const original = path.join(directory, 'site.db');
    const snapshot = path.join(directory, 'backup.db');
    const db = new DatabaseSync(original);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO orders(amount) VALUES(250),(360)');
    let timerTriggered = false;
    setTimeout(() => { timerTriggered = true; }, 0);
    await createDatabaseSnapshot(original, snapshot);
    assert.equal(timerTriggered, true, 'backup must yield to unrelated HTTP timers');
    const check = new DatabaseSync(snapshot, { readOnly: true });
    assert.deepEqual(check.prepare('SELECT amount FROM orders ORDER BY id').all().map(x => x.amount), [250, 360]);
    assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    check.close();
    db.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed snapshot does not prevent the next backup; concurrent snapshots queue', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-snapshot-'));
  try {
    const original = path.join(directory, 'site.db');
    const db = new DatabaseSync(original);
    db.exec('CREATE TABLE a(n INTEGER); INSERT INTO a VALUES(42)');
    await assert.rejects(createDatabaseSnapshot(path.join(directory, 'missing.db'), path.join(directory, 'bad.db')));
    const a = path.join(directory, 'a.db');
    const b = path.join(directory, 'b.db');
    await Promise.all([createDatabaseSnapshot(original, a), createDatabaseSnapshot(original, b)]);
    for (const name of [a, b]) {
      const check = new DatabaseSync(name, { readOnly: true });
      assert.equal(check.prepare('SELECT n FROM a').get().n, 42);
      check.close();
    }
    db.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
