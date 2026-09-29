// task-seed.js — однократный перенос поручений с планёрок 20 и 27.09.2026.
// Версия фиксируется отдельно: удалённое/отменённое администратором поручение
// не появится снова после рестарта приложения.
'use strict';

const db = require('./db');

const SEED_VERSION = 'meetings-2026-09-20-27-v1';
const PRICE_LIST_TASK_VERSION = 'task-2026-09-28-price-list-angelina-v1';

function seedMeetingTasks() {
  const initialApplied = !!db.prepare('SELECT 1 FROM task_seed_versions WHERE version = ?').get(SEED_VERSION);
  const priceListApplied = !!db.prepare('SELECT 1 FROM task_seed_versions WHERE version = ?').get(PRICE_LIST_TASK_VERSION);
  if (initialApplied && priceListApplied) return;

  const members = [
    ['alexey', 'Лакомых Алексей', 'Операционка, финансы, продажи, сайт, партнёры и команда'],
    ['vitaly', 'Соколов Виталий', 'Закупки, логистика, остатки, качество и документы'],
    ['nikolay', 'Кучкин Николай', 'KPI, аналитика, регламенты, право, риски и безопасность'],
    ['angelina', 'Ангелина', 'Запуск точек, CRM, обзвон и работа с партнёрами'],
    ['sofia', 'Софья', 'Поставщик/контакт по фасовке и пробникам'],
  ];

  const tasks = [
    ['2009-01', '2026-09-20', 'Завершить макет таблички для новых точек', 'Макеты отправлены.', null, null, 'normal', 'done', 0, null],
    ['2009-02', '2026-09-20', 'Найти нового баера по игрушкам и аксессуарам из Китая', 'Показать счёт с ценами; количество закупки обсудить отдельно.', 'vitaly', null, 'high', 'new', 1, null],
    ['2009-03', '2026-09-20', 'Подготовить запуск продаж на маркетплейсе', 'Определить площадку, ассортимент, экономику и требования к карточкам.', null, null, 'normal', 'new', 1, null],
    ['2009-04', '2026-09-20', 'Собрать базу вариантов стоек и торгового оборудования', 'Оценить стоимость разных форматов и подготовить минимум 5 вариантов размещения для встречи с точкой.', 'angelina', null, 'high', 'in_progress', 1, null],
    ['2009-05', '2026-09-20', 'Получить цены на фасовку и крафтовые пакеты', 'Через Софью: самостоятельная фасовка, крафтовые пакеты и этикетки для расфасовки.', 'sofia', null, 'high', 'new', 1, null],
    ['2009-06', '2026-09-20', 'Получить зелёные QR-этикетки', 'Отдельные зелёные этикетки заказаны и находятся в пути.', null, null, 'normal', 'in_progress', 1, null],
    ['2009-07', '2026-09-20', 'Оформить работу с расфасовкой через «Меркурий»', 'Созвониться со специалистом и выяснить порядок оформления собственной расфасовки.', 'vitaly', null, 'critical', 'in_progress', 1, null],
    ['2009-09', '2026-09-20', 'Написать регламент встречи с новой точкой', 'Сценарий встречи, вопросы, презентация форматов и фиксация следующего шага.', 'alexey', null, 'high', 'new', 1, null],
    ['2009-10', '2026-09-20', 'Подготовить пятилетний план развития до 1000 точек', 'Финансовая модель и темп открытия точек подготовлены.', 'alexey', null, 'high', 'done', 0, null],
    ['2009-11', '2026-09-20', 'Проработать продажу модели собственникам и сетям', 'Проверить предложение для собственного бизнеса и роль оформления через «Меркурий».', null, null, 'normal', 'new', 1, null],
    ['2009-12', '2026-09-20', 'Собрать комплект сертификатов для каждой новой точки', 'Документы на товар передавать вместе со стойкой и включить в чек-лист запуска.', null, null, 'high', 'new', 1, null],
    ['2009-13', '2026-09-20', 'Проработать сотрудничество с ветеринарами', 'Будущее направление: рекомендации, реклама и экспертная поддержка.', null, null, 'low', 'new', 1, null],
    ['2009-15', '2026-09-20', 'Открывать не менее одной новой точки в неделю', 'Каждый понедельник — обзвон собственников бизнеса и контроль следующего открытия.', 'alexey', '2026-09-28', 'critical', 'new', 1, 'weekly:monday'],
    ['2009-16', '2026-09-20', 'Подготовить рекламный запуск после открытия пяти точек', 'Условие старта — сеть достигла 5 работающих точек.', null, null, 'normal', 'blocked', 1, null],
    ['2009-17', '2026-09-20', 'Сделать Ангелине ключ от офиса', null, 'vitaly', null, 'normal', 'new', 1, null],
    ['2709-01', '2026-09-27', 'Заказать 10 горизонтальных табличек и А4 для Sir Barsik', 'Заказ от юридического лица; готовые таблички брать на новые точки.', 'angelina', null, 'critical', 'new', 1, null],
    ['2709-02', '2026-09-27', 'Подготовить 10 наборов пробников для собак грумеров', 'Все позиции по 10 г; организовать через Софью/менеджера «Счастливого хвостика».', 'sofia', null, 'high', 'new', 1, null],
    ['2709-03', '2026-09-27', 'Подготовить 100 пробников-ассорти для клиентов', 'Пробники для бесплатной передачи клиентам через грумеров.', 'sofia', null, 'high', 'new', 1, null],
    ['2709-04', '2026-09-27', 'Подготовить ZIP-пакеты для рассыпных лакомств', 'Пакеты уже есть у Виталия.', 'vitaly', null, 'normal', 'done', 0, null],
    ['2709-05', '2026-09-27', 'Купить весы для фасовки', 'Передать Виталию подходящую ссылку и приобрести весы.', 'vitaly', null, 'high', 'new', 1, null],
    ['2709-06', '2026-09-27', 'Расфасовать ассорти из рассыпных лакомств', null, null, null, 'high', 'new', 1, null],
    ['2709-08', '2026-09-27', 'Передать грумерам бесплатные пробники для клиентов', 'Каждый грумер дарит пробник от ХвостМаркета каждому клиенту.', null, null, 'high', 'new', 1, null],
    ['2709-09', '2026-09-27', 'Добавить набор пробников грумеру в комплект открытия точки', 'Грумер должен дать своей собаке попробовать все лакомства.', null, null, 'normal', 'new', 1, null],
    ['2709-11', '2026-09-27', 'Сделать QR-код на пробниках', 'Страница с информацией о пробнике и регистрацией клиента.', null, null, 'high', 'new', 1, null],
    ['2709-12', '2026-09-27', 'Сделать единую базу грумеров', null, 'alexey', null, 'high', 'new', 1, null],
    ['2709-14', '2026-09-27', 'Выплачивать Ангелине аванс и зарплату 10-го и 25-го', 'После отметки о выполнении система перенесёт срок на следующую дату.', null, '2026-10-10', 'critical', 'new', 1, 'monthly:10,25'],
    ['2709-16', '2026-09-27', 'Подготовить территориально удобные точки для обзвона', 'Приоритетные районы: Воронова, Северный и Солнечный.', 'angelina', null, 'high', 'new', 1, null],
  ];

  db.exec('BEGIN IMMEDIATE');
  try {
    const insertMember = db.prepare(`
      INSERT OR IGNORE INTO task_assignees (code, full_name, responsibility)
      VALUES (?, ?, ?)
    `);
    members.forEach((row) => insertMember.run(...row));
    const memberIds = new Map(db.prepare('SELECT id, code FROM task_assignees').all().map((row) => [row.code, row.id]));
    const insertTask = db.prepare(`
      INSERT OR IGNORE INTO meeting_tasks
        (source_key, meeting_date, title, description, assignee_id, due_date,
         priority, status, reminder_enabled, recurrence_rule, created_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Импорт планёрок', CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)
    `);
    if (!initialApplied) tasks.forEach((task) => {
      const [sourceKey, meetingDate, title, description, assigneeCode, dueDate, priority, status, reminderEnabled, recurrenceRule] = task;
      insertTask.run(
        sourceKey, meetingDate, title, description || null,
        assigneeCode ? memberIds.get(assigneeCode) || null : null,
        dueDate, priority, status, reminderEnabled, recurrenceRule, status
      );
    });
    if (!initialApplied) {
      db.prepare('INSERT INTO task_seed_versions (version) VALUES (?)').run(SEED_VERSION);
    }
    if (!priceListApplied) {
      insertTask.run(
        '2809-01', '2026-09-28',
        'Подготовить и разместить прейскурант ХвостМаркета',
        'Подготовить актуальный прейскурант с ценами на товары ХвостМаркета, распечатать его в цвете и разместить на всех стойках.',
        memberIds.get('angelina') || null,
        null, 'high', 'new', 1, null, 'new'
      );
      db.prepare('INSERT INTO task_seed_versions (version) VALUES (?)').run(PRICE_LIST_TASK_VERSION);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = { seedMeetingTasks, SEED_VERSION, PRICE_LIST_TASK_VERSION };
