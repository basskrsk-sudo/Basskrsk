'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-approved-tasks-'));
const { seedMeeting20261101, SEED_VERSION, TASKS } = require('./task-seed-2026-11-01');

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE task_assignees (id INTEGER PRIMARY KEY, code TEXT UNIQUE, full_name TEXT, active INTEGER DEFAULT 1);',
    'CREATE TABLE meeting_tasks (id INTEGER PRIMARY KEY, source_key TEXT UNIQUE, meeting_date TEXT, title TEXT NOT NULL,',
    'description TEXT, assignee_id INTEGER REFERENCES task_assignees(id), due_date TEXT, priority TEXT DEFAULT "normal",',
    'status TEXT DEFAULT "new", reminder_enabled INTEGER DEFAULT 1, recurrence_rule TEXT, created_by TEXT, completed_at TEXT,',
    'created_at TEXT DEFAULT (datetime("now")), updated_at TEXT DEFAULT (datetime("now")));',
    'CREATE TABLE meeting_task_history (id INTEGER PRIMARY KEY, task_id INTEGER, action TEXT, old_value TEXT,',
    'new_value TEXT, actor TEXT, created_at TEXT DEFAULT (datetime("now")));',
    'CREATE TABLE task_seed_versions (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime("now")));',
  ].join(' '));
  for (const code of ['alexey', 'vitaly', 'nikolay', 'angelina']) {
    database.prepare('INSERT INTO task_assignees(code,full_name) VALUES (?,?)').run(code, code);
  }
  function add(source, title, code, due = null, status = 'new', meetingDate = '2026-10-25') {
    const assignee = code && database.prepare('SELECT id FROM task_assignees WHERE code=?').get(code);
    return Number(database.prepare(
      'INSERT INTO meeting_tasks(source_key,meeting_date,title,assignee_id,due_date,status) VALUES (?,?,?,?,?,?)'
    ).run(source, meetingDate, title, assignee ? assignee.id : null, due, status).lastInsertRowid);
  }
  return { database, add };
}

function task(database, key) {
  return database.prepare(
    'SELECT t.*,a.code AS assignee_code FROM meeting_tasks t ' +
    'LEFT JOIN task_assignees a ON a.id=t.assignee_id WHERE t.source_key=?'
  ).get(key);
}

test('imports exactly ten tasks, retains source IDs, skips #7, and is idempotent', () => {
  const { database, add } = fixture();
  const mercId = add('2009-07', 'Оформить работу с расфасовкой через «Меркурий»', 'vitaly');
  const purchaseAlexey = add('2510-10a', 'Заказать следующую поставку товаров для фасовки — Алексей', 'alexey');
  const purchaseVitaly = add('2510-10b', 'Заказать следующую поставку товаров для фасовки — Виталий', 'vitaly');
  const result = seedMeeting20261101(database);
  assert.equal(result.inserted, 8);
  assert.equal(result.updated, 2);
  assert.equal(result.linked.length, 10);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM meeting_tasks').get().count, 11);
  assert.equal(task(database, '2009-07').id, mercId);
  assert.equal(task(database, '2009-07').assignee_code, 'alexey');
  assert.equal(task(database, '2009-07').due_date, '2026-11-08');
  assert.equal(task(database, '2510-10b').id, purchaseVitaly);
  assert.equal(task(database, '2510-10b').assignee_code, 'vitaly');
  assert.equal(task(database, '2510-10b').due_date, '2026-11-08');
  assert.match(task(database, '2510-10b').title, /новыми лакомствами/);
  assert.equal(task(database, '2510-10a').id, purchaseAlexey);
  assert.equal(task(database, '2510-10a').due_date, null);
  assert.equal(task(database, '0111-07'), undefined);
  assert.deepEqual(TASKS.map((row) => row.key),
    ['0111-01', '0111-02', '0111-03', '0111-04', '0111-05',
      '0111-06', '0111-08', '0111-09', '0111-10', '0111-11']);
  assert.deepEqual(TASKS.map((row) => row.due),
    ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-06', '2026-11-20',
      '2026-12-31', '2026-11-08', '2026-11-08', '2026-11-08', '2026-11-08']);
  assert.deepEqual(TASKS.map((row) => row.code),
    ['nikolay', 'alexey', 'alexey', 'alexey', 'nikolay',
      'angelina', 'angelina', 'vitaly', 'alexey', 'angelina']);
  assert.ok(database.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(SEED_VERSION));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meeting_task_history').get().n, 10);
  // Later manual completion and removal must not be undone by a deploy.
  database.prepare("UPDATE meeting_tasks SET status='done' WHERE source_key='0111-01'").run();
  database.prepare("DELETE FROM meeting_tasks WHERE source_key='0111-08'").run();
  assert.equal(seedMeeting20261101(database).already_applied, true);
  assert.equal(task(database, '0111-08'), undefined);
  assert.equal(task(database, '0111-01').status, 'done');
  database.close();
});

test('matches existing manually-created tasks, preferring Nikolai Mercury assignment', () => {
  const { database, add } = fixture();
  const initialMercury = add('2009-07', 'Оформить работу с расфасовкой через «Меркурий»', 'vitaly');
  const nikolaiMercury = add(null, 'Меркурий — разобраться с регистрацией', 'nikolay');
  const manualBanner = add(null, 'Подготовить рекламный баннер для ХвостМаркета', 'alexey', '2026-12-01');
  const result = seedMeeting20261101(database);
  assert.equal(result.inserted, 8);
  assert.equal(result.updated, 2);
  assert.equal(task(database, '2009-07').id, initialMercury);
  assert.equal(task(database, '2009-07').assignee_code, 'vitaly');
  assert.equal(database.prepare('SELECT assignee_id FROM meeting_tasks WHERE id=?').get(nikolaiMercury)
    .assignee_id, database.prepare("SELECT id FROM task_assignees WHERE code='alexey'").get().id);
  assert.equal(database.prepare('SELECT due_date FROM meeting_tasks WHERE id=?').get(nikolaiMercury)
    .due_date, '2026-11-08');
  const banner = database.prepare('SELECT * FROM meeting_tasks WHERE id=?').get(manualBanner);
  assert.equal(banner.due_date, '2026-11-08');
  assert.equal(banner.assignee_id,
    database.prepare("SELECT id FROM task_assignees WHERE code='angelina'").get().id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n, 11);
  database.close();
});

test('ambiguous Mercury assignments roll back atomically instead of creating duplicates', () => {
  const { database, add } = fixture();
  add(null, 'Меркурий — задача Николая 1', 'nikolay');
  const second = add(null, 'Меркурий — задача Николая 2', 'nikolay');
  const countBefore = database.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n;
  const blocked = seedMeeting20261101(database);
  assert.equal(blocked.conflict_key, '0111-02');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n, countBefore);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM task_seed_versions').get().n, 0);
  database.prepare("UPDATE meeting_tasks SET status='done' WHERE id=?").run(second);
  assert.equal(seedMeeting20261101(database).inserted, 9);
  assert.ok(database.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(SEED_VERSION));
  database.close();
});

test('honors a manually completed same-meeting task and leaves it closed', () => {
  const { database, add } = fixture();
  const closed = add(null, 'Подготовить рекламный баннер для ХвостМаркета',
    'angelina', '2026-11-08', 'done', '2026-11-01');
  const result = seedMeeting20261101(database);
  assert.equal(result.inserted, 9);
  assert.equal(result.unchanged, 1);
  assert.equal(database.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(closed).status, 'done');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM meeting_tasks WHERE title LIKE '%баннер%'").get().n, 1);
  database.close();
});

test.after(() => {
  const defaultDb = require('./db');
  try { defaultDb.close(); } catch (_) {}
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
