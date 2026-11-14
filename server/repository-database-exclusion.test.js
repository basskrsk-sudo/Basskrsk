'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('checked-in source does not contain a SQLite runtime database', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.equal(fs.existsSync(path.join(root, 'data/taiga.db')), false);
  for (const suffix of ['', '-wal', '-shm']) {
    assert.ok(ignore.split(/\r?\n/).includes('data/taiga.db' + suffix));
  }
  assert.match(docker, /^ENV DATA_DIR=\/data$/m);
  assert.doesNotMatch(docker, /^\s*COPY\s+data(?:\/|\s)/m);
});

test('a clean runtime database is created in DATA_DIR, not from the repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-db-isolation-'));
  try {
    const script = [
      "const db = require('./server/db');",
      "const row = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='orders'\").get();",
      "if (!row) process.exit(2);",
      'db.close();',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.statSync(path.join(dir, 'taiga.db')).size > 0);
    assert.equal(fs.existsSync(path.join(root, 'data/taiga.db')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
