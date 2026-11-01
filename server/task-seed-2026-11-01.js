// One-time import of the ten approved assignments from the 01.11.2026 meeting.
// Runs against the persistent SQLite ledger on application startup. Never
// re-creates tasks after a successfully applied import, even if later deleted.
'use strict';

const defaultDb = require('./db');

const MEETING_DATE = '2026-11-01';
const SEED_VERSION = 'meeting-2026-11-01-approved-v1';
const ACTOR = 'Согласованные поручения 01.11.2026';

// No entry for #7: the incomplete item was explicitly removed.
// The units of "6 for 90" / "10 for 120" were not supplied; do not guess.
const TASKS = [
  {
    key: '0111-01',
    title: 'Уточнить вопрос по самозанятым',
    description: 'Уточнить вопрос по самозанятым.',
    code: 'nikolay',
    due: '2026-11-08',
  },
  {
    key: '0111-02',
    title: 'Меркурий: передать ведение вопроса Алексею Лакомых',
    description: 'Переназначить действующее поручение по «Меркурию» с Кучкина Николая на Лакомых Алексея.',
    code: 'alexey',
    due: '2026-11-08',
  },
  {
    key: '0111-03',
    title: 'Купить ещё кроличьих лапок',
    description: 'Дополнительная закупка кроличьих лапок для ассортимента ХвостМаркета.',
    code: 'alexey',
    due: '2026-11-08',
  },
  {
    key: '0111-04',
    title: 'Продумать новую фасовку: 6 за 90 и 10 за 120',
    description: 'Проработать варианты фасовки «6 за 90» и «10 за 120». Единицы не уточнены в исходной записи.',
    code: 'alexey',
    due: '2026-11-06',
  },
  {
    key: '0111-05',
    title: 'Подготовить договоры с производителями на комиссионную реализацию',
    description: 'Подготовить договоры с производителями на комиссионную реализацию товаров ХвостМаркета.',
    code: 'nikolay',
    due: '2026-11-20',
  },
  {
    key: '0111-06',
    title: 'Разработать и утвердить регламент запуска новой партнёрской точки',
    description: 'Разработать и утвердить регламент запуска новой партнёрской точки ХвостМаркета.',
    code: 'angelina',
    due: '2026-12-31',
  },
  {
    key: '0111-08',
    title: 'Подготовить рекламный баннер для ХвостМаркета',
    description: 'Подготовить рекламный баннер для ХвостМаркета.',
    code: 'angelina',
    due: '2026-11-08',
  },
  {
    key: '0111-09',
    title: 'Оформить заказ с новыми лакомствами для ХвостМаркета',
    description: 'Оформить заказ с новыми лакомствами для ассортимента ХвостМаркета.',
    code: 'vitaly',
    due: '2026-11-08',
  },
  {
    key: '0111-10',
    title: 'Отправить липучки Ангелине Функ',
    description: 'Отправить липучки Ангелине Функ.',
    code: 'alexey',
    due: '2026-11-08',
  },
  {
    key: '0111-11',
    title: 'Разработать способы привлечения подписчиков во ВКонтакте',
    description: 'Предложить способы привлечения новых подписчиков в сообщество ХвостМаркета во ВКонтакте.',
    code: 'angelina',
    due: '2026-11-08',
  },
];

function active(row) {
  return row.status !== 'done' && row.status !== 'cancelled';
}

function normalized(text) {
  return String(text || '').toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

class AmbiguousImport extends Error {
  constructor(key, reason) {
    super('Поручение ' + key + ': ' + reason);
    this.code = 'TASK_IMPORT_AMBIGUOUS';
    this.task_key = key;
  }
}

function onlyOne(candidates, key, reason) {
  if (candidates.length > 1) {
    throw new AmbiguousImport(key, reason + '; найдено ' + candidates.length + ' совпадений');
  }
  return candidates[0] || null;
}

function findExisting(database, approved) {
  const records = database.prepare(
    'SELECT t.*, a.code AS assignee_code FROM meeting_tasks t ' +
    'LEFT JOIN task_assignees a ON a.id = t.assignee_id'
  ).all();

  // Source keys are immutable. A manually closed same-meeting task must never
  // be silently recreated or reopened.
  const ownKey = records.find((row) => row.source_key === approved.key);
  if (ownKey) return ownKey;

  // Exact title match handles tasks already created manually in the admin/bot.
  // A completed task from a previous meeting is not the new 01.11 assignment.
  const exact = records.filter((row) =>
    normalized(row.title) === normalized(approved.title) &&
    (active(row) || row.meeting_date === MEETING_DATE));
  const sameTitle = onlyOne(exact, approved.key, 'неоднозначное совпадение названия');
  if (sameTitle) return sameTitle;

  if (approved.key === '0111-02') {
    const mercury = records.filter((row) => active(row) && /меркур/iu.test(row.title));
    // User's explicit "remove it from Nikolai" takes precedence over older
    // seed data, where the Mercury task was initially assigned to Vitaly.
    const nikolay = mercury.filter((row) => row.assignee_code === 'nikolay');
    const fromNikolai = onlyOne(nikolay, approved.key, 'несколько поручений по Меркурию у Николая');
    if (fromNikolai) return fromNikolai;
    // If there is exactly one Mercury task, update it rather than creating a
    // duplicate. If several exist but none belongs to Nikolai, require review.
    return onlyOne(mercury, approved.key, 'несколько действующих поручений по Меркурию');
  }

  if (approved.key === '0111-09') {
    // The 25.10 meeting already contains two different collaborative tasks:
    // 2510-10a (Alexey) and 2510-10b (Vitaly). Reconcile only Vitaly's
    // procurement task; never silently overwrite Alexey's separate card.
    return records.find((row) => row.source_key === '2510-10b' && active(row)) || null;
  }

  return null;
}

function seedMeeting20261101(database = defaultDb) {
  if (database.prepare('SELECT 1 FROM task_seed_versions WHERE version=?').get(SEED_VERSION)) {
    return { already_applied: true, inserted: 0, updated: 0, unchanged: 0 };
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const people = new Map(database.prepare(
      "SELECT code,id FROM task_assignees WHERE active=1 AND code IN ('alexey','vitaly','nikolay','angelina')"
    ).all().map((row) => [row.code, row.id]));
    for (const approved of TASKS) {
      if (!people.has(approved.code)) {
        throw new AmbiguousImport(approved.key, 'исполнитель ' + approved.code + ' не найден или неактивен');
      }
    }

    const insert = database.prepare(
      'INSERT INTO meeting_tasks ' +
      '(source_key,meeting_date,title,description,assignee_id,due_date,priority,status,' +
      'reminder_enabled,recurrence_rule,created_by,completed_at) ' +
      "VALUES (?,?,?,?,?,?,'normal','new',1,NULL,?,NULL)"
    );
    const update = database.prepare(
      "UPDATE meeting_tasks SET title=?,description=?,assignee_id=?,due_date=?,updated_at=datetime('now') WHERE id=?"
    );
    const history = database.prepare(
      'INSERT INTO meeting_task_history (task_id,action,old_value,new_value,actor) VALUES (?,?,?,?,?)'
    );
    const summary = { already_applied: false, inserted: 0, updated: 0, unchanged: 0, linked: [] };

    for (const approved of TASKS) {
      const assigneeId = people.get(approved.code);
      const existing = findExisting(database, approved);
      if (!existing) {
        const result = insert.run(
          approved.key, MEETING_DATE, approved.title, approved.description,
          assigneeId, approved.due, ACTOR
        );
        const id = Number(result.lastInsertRowid);
        history.run(id, 'created', null, JSON.stringify({
          source_key: approved.key, title: approved.title, due_date: approved.due,
          assignee_code: approved.code,
        }), ACTOR);
        summary.inserted++;
        summary.linked.push({ key: approved.key, id, action: 'created' });
        continue;
      }

      summary.linked.push({ key: approved.key, id: existing.id, action: 'matched' });
      if (!active(existing)) {
        // Preserve human completion/cancellation rather than reopening it.
        summary.unchanged++;
        continue;
      }

      const title = approved.key === '0111-09' ? approved.title : existing.title;
      let description = existing.description || approved.description || null;
      if (approved.key === '0111-09' && existing.source_key === '2510-10b' &&
          !normalized(description).includes('новыми лакомствами')) {
        description += '\n\nРешение 01.11.2026: ' + approved.description;
      }
      if (title === existing.title && description === existing.description &&
          assigneeId === existing.assignee_id && approved.due === existing.due_date) {
        summary.unchanged++;
        continue;
      }
      update.run(title, description, assigneeId, approved.due, existing.id);
      history.run(existing.id, 'meeting_2026_11_01_reconciled', JSON.stringify({
        source_key: existing.source_key, title: existing.title,
        assignee_id: existing.assignee_id, due_date: existing.due_date,
        description: existing.description,
      }), JSON.stringify({
        approved_source_key: approved.key, title, assignee_id: assigneeId,
        assignee_code: approved.code, due_date: approved.due, description,
      }), ACTOR);
      summary.updated++;
      summary.linked[summary.linked.length - 1].action = 'updated';
    }

    database.prepare('INSERT INTO task_seed_versions (version) VALUES (?)').run(SEED_VERSION);
    database.exec('COMMIT');
    console.log('Поручения 01.11.2026: создано ' + summary.inserted +
      ', обновлено ' + summary.updated + ', без изменений ' + summary.unchanged);
    return summary;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) {}
    if (error.code === 'TASK_IMPORT_AMBIGUOUS') {
      // Never take the shop offline or alter a random person's task on an
      // ambiguous production DB. Entire import rolls back for manual review.
      console.error('Поручения 01.11.2026: импорт не применён:', error.message);
      return { already_applied: false, inserted: 0, updated: 0, unchanged: 0,
        conflict: error.message, conflict_key: error.task_key };
    }
    throw error;
  }
}

module.exports = { seedMeeting20261101, MEETING_DATE, SEED_VERSION, TASKS };
