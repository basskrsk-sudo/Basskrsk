// Legacy catalog, initial admins and lead records should be imported once per
// source revision, not queried/written on every app restart. SHA of seed.js
// automatically invalidates the marker whenever its contents change.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const db = require('./db');

function seedVersion(source) {
  return 'initial-seed-sha256-' + createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function runVersionedSeed({
  database = db,
  sourcePath = path.join(__dirname, 'seed.js'),
  run = require('./seed'),
} = {}) {
  const version = seedVersion(fs.readFileSync(sourcePath));
  if (database.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(version)) {
    return { skipped: true, version };
  }
  // Keep the seed and marker in the same transaction. If the seed fails,
  // the next restart can retry without partially modifying the catalog.
  database.exec('BEGIN IMMEDIATE');
  try {
    if (database.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(version)) {
      database.exec('COMMIT');
      return { skipped: true, version };
    }
    run();
    database.prepare('INSERT INTO task_seed_versions(version) VALUES (?)').run(version);
    database.exec('COMMIT');
    return { skipped: false, version };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = { seedVersion, runVersionedSeed };
