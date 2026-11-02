// One-time entry: approved supply strategy assignment for Krasnoyarsk.
// Imported into persistent /data SQLite on the first server start with this code.
'use strict';

const defaultDb = require('./db');

const SEED_VERSION = 'task-2026-11-02-krasnoyarsk-supply-strategy-v1';
const SOURCE_KEY = '0211-01-supply-strategy';
const TASK_DATE = '2026-11-02';
const TASK_TITLE = 'Разработать стратегию снабжения точек ХвостМаркета в Красноярске';
const TASK_DESCRIPTION = 'Подготовить стратегию снабжения партнёрских точек в г. Красноярске: ' +
  'закупка и хранение товаров, контроль остатков, порядок и периодичность пополнения, ' +
  'маршруты доставки, распределение ответственности и ориентировочные затраты. ' +
  'Результат — оформленная стратегия с предложением по внедрению.';
const DUE_DATE = '2026-12-31';
const ACTOR = 'Согласовано 02.11.2026';

function normalize(text) {
  return String(text || '').toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isSameTask(row) {
  if (row.source_key === SOURCE_KEY) return true;
  const text = normalize(row.title);
  return text === normalize(TASK_TITLE) ||
    (/(стратег|схем|план)/u.test(text) &&
     /снабжен/u.test(text) &&
     /красноярск/u.test(text));
}

function seedKrasnoyarskSupplyStrategy(database = defaultDb) {
  if (database.prepare('SELECT 1 FROM task_seed_versions WHERE version = ?').get(SEED_VERSION)) {
    return { already_applied: true, created: 0, updated: 0, unchanged: 0 };
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const vitaly = database.prepare(
      "SELECT id FROM task_assignees WHERE code = 'vitaly' AND active = 1"
    ).get();
    if (!vitaly) {
      throw new Error('Не найден активный исполнитель Соколов Виталий');
    }

    // The task may already exist if it was added manually through the bot/admin.
    // Procurement and delivery tasks from previous meetings are NOT equivalent
    // to a city-wide supply strategy, so they are not overwritten.
    const matches = database.prepare(
      'SELECT id,source_key,meeting_date,title,description,assignee_id,due_date,status ' +
      'FROM meeting_tasks'
    ).all().filter(isSameTask);

    if (matches.length > 1) {
      const error = new Error('Несколько похожих поручений по стратегии снабжения: ' +
        matches.map(row => row.id).join(', '));
      error.code = 'AMBIGUOUS_TASK';
      throw error;
    }

    const result = { already_applied: false, created: 0, updated: 0, unchanged: 0 };
    const existing = matches[0];
    if (!existing) {
      const info = database.prepare(
        'INSERT INTO meeting_tasks ' +
        '(source_key,meeting_date,title,description,assignee_id,due_date,' +
        'priority,status,reminder_enabled,recurrence_rule,created_by) ' +
        "VALUES (?,?,?,?,?,?,'normal','new',1,NULL,?)"
      ).run(SOURCE_KEY, TASK_DATE, TASK_TITLE, TASK_DESCRIPTION,
        vitaly.id, DUE_DATE, ACTOR);
      database.prepare(
        'INSERT INTO meeting_task_history (task_id,action,old_value,new_value,actor) ' +
        "VALUES (?,'created',NULL,?,?)"
      ).run(Number(info.lastInsertRowid), JSON.stringify({
        source_key: SOURCE_KEY, title: TASK_TITLE,
        assignee_code: 'vitaly', due_date: DUE_DATE,
      }), ACTOR);
      result.created = 1;
      result.id = Number(info.lastInsertRowid);
    } else {
      result.id = existing.id;
      if (existing.status === 'done' || existing.status === 'cancelled') {
        // Do not undo completion/cancellation or reinsert an identical task.
        result.unchanged = 1;
      } else if (existing.assignee_id === vitaly.id && existing.due_date === DUE_DATE) {
        // Keep the creator's title, description, and status as-is.
        result.unchanged = 1;
      } else {
        database.prepare(
          "UPDATE meeting_tasks SET assignee_id=?,due_date=?,updated_at=datetime('now') WHERE id=?"
        ).run(vitaly.id, DUE_DATE, existing.id);
        database.prepare(
          'INSERT INTO meeting_task_history (task_id,action,old_value,new_value,actor) ' +
          "VALUES (?,'meeting_2026_11_02_reassigned',?,?,?)"
        ).run(existing.id,
          JSON.stringify({
            assignee_id: existing.assignee_id, due_date: existing.due_date,
          }),
          JSON.stringify({
            assignee_id: vitaly.id, assignee_code: 'vitaly',
            due_date: DUE_DATE, approved_source_key: SOURCE_KEY,
          }),
          ACTOR);
        result.updated = 1;
      }
    }
    database.prepare('INSERT INTO task_seed_versions(version) VALUES (?)').run(SEED_VERSION);
    database.exec('COMMIT');
    console.log('Стратегия снабжения Красноярска: создано ' +
      result.created + ', обновлено ' + result.updated + ', без изменений ' + result.unchanged);
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    // Ambiguous production data should not block the shop startup.
    if (error.code === 'AMBIGUOUS_TASK' ||
        error.message.includes('Не найден активный исполнитель')) {
      console.error('Стратегия снабжения Красноярска: не удалось импортировать:', error.message);
      return { already_applied: false, created: 0, updated: 0,
        unchanged: 0, conflict: error.message };
    }
    throw error;
  }
}

module.exports = {
  seedKrasnoyarskSupplyStrategy, SEED_VERSION, SOURCE_KEY, TASK_DATE,
  TASK_TITLE, TASK_DESCRIPTION, DUE_DATE,
};
