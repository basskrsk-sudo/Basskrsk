'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

process.env.DATA_DIR = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'hm-supply-task-'));
const {
  seedKrasnoyarskSupplyStrategy, SEED_VERSION, SOURCE_KEY, TASK_TITLE, DUE_DATE,
} = require('./task-seed-2026-11-02');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE task_assignees (id INTEGER PRIMARY KEY, code TEXT UNIQUE, active INTEGER DEFAULT 1);',
    'CREATE TABLE meeting_tasks (id INTEGER PRIMARY KEY, source_key TEXT UNIQUE, meeting_date TEXT,',
    'title TEXT NOT NULL, description TEXT, assignee_id INTEGER REFERENCES task_assignees(id),',
    'due_date TEXT, priority TEXT DEFAULT "normal", status TEXT DEFAULT "new",',
    'reminder_enabled INTEGER DEFAULT 1, recurrence_rule TEXT, created_by TEXT, completed_at TEXT,',
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);',
    'CREATE TABLE meeting_task_history (id INTEGER PRIMARY KEY, task_id INTEGER, action TEXT,',
    'old_value TEXT, new_value TEXT, actor TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);',
    'CREATE TABLE task_seed_versions (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);',
    "INSERT INTO task_assignees(code) VALUES ('alexey'),('vitaly'),('nikolay'),('angelina');",
  ].join(' '));
  function add(title, code, status='new', sourceKey=null, dueDate=null) {
    const person = db.prepare('SELECT id FROM task_assignees WHERE code=?').get(code);
    return Number(db.prepare(
      'INSERT INTO meeting_tasks(source_key,title,assignee_id,status,due_date) VALUES (?,?,?,?,?)'
    ).run(sourceKey,title,person.id,status,dueDate).lastInsertRowid);
  }
  return { db, add };
}

function entry(db) {
  return db.prepare(
    'SELECT t.*,a.code AS assignee_code FROM meeting_tasks t ' +
    'LEFT JOIN task_assignees a ON t.assignee_id=a.id WHERE t.source_key=?'
  ).get(SOURCE_KEY);
}

test('adds supply strategy for Vitaly due 31 December 2026 and keeps prior procurement separate', () => {
  const { db, add } = fixture();
  const old = add('Заказать следующую поставку товаров для фасовки — Виталий', 'vitaly',
    'new', '2510-10b');
  const result = seedKrasnoyarskSupplyStrategy(db);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  const row = entry(db);
  assert.equal(row.title,TASK_TITLE);
  assert.equal(row.assignee_code,'vitaly');
  assert.equal(row.due_date,DUE_DATE);
  assert.equal(row.meeting_date,'2026-11-02');
  assert.equal(row.status,'new');
  assert.equal(row.reminder_enabled,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n,2);
  assert.equal(db.prepare('SELECT due_date FROM meeting_tasks WHERE id=?').get(old).due_date,null);
  assert.ok(db.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(SEED_VERSION));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meeting_task_history').get().n,1);
  // Operator edits must survive future restarts.
  db.prepare("UPDATE meeting_tasks SET status='done',due_date='2026-12-20' WHERE id=?").run(row.id);
  assert.equal(seedKrasnoyarskSupplyStrategy(db).already_applied,true);
  assert.equal(entry(db).status,'done');
  assert.equal(entry(db).due_date,'2026-12-20');
  db.close();
});

test('updates an existing matching active task instead of duplicating it', () => {
  const { db, add } = fixture();
  const prior = add('Стратегия снабжения точек Красноярска','alexey','in_progress',null,'2026-11-30');
  const result = seedKrasnoyarskSupplyStrategy(db);
  assert.equal(result.updated,1);
  assert.equal(result.id,prior);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n,1);
  const row = db.prepare('SELECT * FROM meeting_tasks WHERE id=?').get(prior);
  assert.equal(row.assignee_id,db.prepare("SELECT id FROM task_assignees WHERE code='vitaly'").get().id);
  assert.equal(row.due_date,DUE_DATE);
  assert.equal(row.title,'Стратегия снабжения точек Красноярска');
  assert.equal(row.status,'in_progress');
  assert.match(db.prepare('SELECT action FROM meeting_task_history').get().action,/reassigned/);
  db.close();
});

test('a completed matching task is neither reopened nor recreated', () => {
  const { db, add } = fixture();
  const prior = add(TASK_TITLE,'vitaly','done',null,'2026-12-10');
  const result = seedKrasnoyarskSupplyStrategy(db);
  assert.equal(result.unchanged,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n,1);
  const row=db.prepare('SELECT * FROM meeting_tasks WHERE id=?').get(prior);
  assert.equal(row.status,'done');
  assert.equal(row.due_date,'2026-12-10');
  assert.equal(seedKrasnoyarskSupplyStrategy(db).already_applied,true);
  db.close();
});

test('ambiguous manually-created supply strategy records cause no partial write', () => {
  const { db, add } = fixture();
  add('Стратегия снабжения точек Красноярска','alexey');
  const other=add('План снабжения грумерских точек в Красноярске','nikolay');
  const result = seedKrasnoyarskSupplyStrategy(db);
  assert.match(result.conflict,/Несколько похожих/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meeting_tasks').get().n,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_seed_versions').get().n,0);
  db.prepare("UPDATE meeting_tasks SET title='Другой документ' WHERE id=?").run(other);
  assert.equal(seedKrasnoyarskSupplyStrategy(db).updated,1);
  db.close();
});

test('missing Vitaly does not take the shop down and does not mark migration applied', () => {
  const { db } = fixture();
  db.prepare("UPDATE task_assignees SET active=0 WHERE code='vitaly'").run();
  const blocked=seedKrasnoyarskSupplyStrategy(db);
  assert.match(blocked.conflict,/Не найден активный исполнитель/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_seed_versions').get().n,0);
  db.close();
});

test.after(() => {
  const db=require('./db');
  try { db.close(); } catch(_) {}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});
