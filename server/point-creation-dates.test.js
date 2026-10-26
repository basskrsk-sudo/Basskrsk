'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-point-creation-'));
process.env.DATA_DIR = dir;

// Имитируем БД прежней версии, в которой нет points.created_at,
// зато сохранился журнал реальных созданий точек менеджерами.
const original = new DatabaseSync(path.join(dir, 'taiga.db'));
original.exec(`
  CREATE TABLE points (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    addr TEXT NOT NULL,
    icon TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE manager_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO points(id,name,addr,icon)
    VALUES ('created-by-manager','Manager salon','Address 1','paw'),
           ('created-by-admin','Admin salon','Address 2','paw');
  INSERT INTO manager_action_log(manager_id,action,target_type,target_id,created_at)
    VALUES (1, 'Создание точки','point','created-by-manager','2026-01-04 13:15:00'),
           (1, 'Назначение менеджера','point','created-by-admin','2026-01-03 10:00:00');
`);
original.close();

const db = require('./db');
const business = require('./business-year-report');

test('historical manager creation is recovered with original UTC timestamp', () => {
  const saved = db.prepare('SELECT created_at, created_at_source FROM points WHERE id=?')
    .get('created-by-manager');
  assert.equal(saved.created_at, '2026-01-04 13:15:00');
  assert.equal(saved.created_at_source, 'manager_action_log');
});

test('admin-created historical point is unknown, NOT set to migration day', () => {
  const saved = db.prepare('SELECT created_at, created_at_source FROM points WHERE id=?')
    .get('created-by-admin');
  assert.equal(saved.created_at, null);
  assert.equal(saved.created_at_source, null);
});

test('new point receives a recorded creation date immediately on INSERT', () => {
  db.prepare('INSERT INTO points(id,name,addr,icon) VALUES (?,?,?,?)')
    .run('created-now','New salon','Address 3','paw');
  const saved = db.prepare('SELECT created_at, created_at_source FROM points WHERE id=?')
    .get('created-now');
  assert.match(saved.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(saved.created_at_source, 'recorded');
});

test('business reporting counts manager-created point without any sales', () => {
  const report = business.collectBusinessYearReport(2026,new Date('2026-10-26T08:00:00Z'));
  assert.equal(report.months[0].new_points, 1);
  assert.equal(report.months[0].sales, 0);
  assert.equal(report.totals.revenue, 0);
  assert.equal(report.unknown_creation_dates, 1);
});

test('repeated migration does not rewrite recovered or unknown dates', () => {
  // This SQL mirrors the idempotent backfill filter from db.js.
  db.exec(`
    UPDATE points SET created_at = (
      SELECT MIN(m.created_at) FROM manager_action_log m
      WHERE m.action = 'Создание точки' AND m.target_type = 'point'
        AND m.target_id = points.id AND m.created_at IS NOT NULL
    ), created_at_source = 'manager_action_log'
    WHERE (created_at IS NULL OR TRIM(created_at) = '')
      AND EXISTS (
        SELECT 1 FROM manager_action_log m WHERE m.action = 'Создание точки'
          AND m.target_type = 'point' AND m.target_id = points.id
          AND m.created_at IS NOT NULL
      );
  `);
  assert.equal(db.prepare('SELECT created_at FROM points WHERE id=?')
    .get('created-by-admin').created_at,null);
  assert.equal(db.prepare('SELECT created_at FROM points WHERE id=?')
    .get('created-by-manager').created_at,'2026-01-04 13:15:00');
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
});
