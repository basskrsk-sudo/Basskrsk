// db.js — вся работа с SQLite через встроенный node:sqlite (Node.js 22+).
// Никаких внешних зависимостей: только то, что уже есть в самом Node.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// На Amvera постоянное хранилище монтируется в /data (папка "Artifacts"/app
// пересобирается и стирается при каждом деплое!). Локально при разработке —
// обычная папка ../data рядом с проектом.
const DB_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'taiga.db')
  : path.join(__dirname, '..', 'data', 'taiga.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ── МИГРАЦИЯ: «амбассадор» → «менеджер» (июль 2026) ─────────────────────────
// На проде уже могла существовать база со старыми именами таблиц/колонок и
// старыми строковыми значениями ролей (amb_code, ambassadors, ambassador_id,
// initiated_by='ambassador' и т.п.) — переименовываем всё это здесь, ДО того,
// как ниже выполнится `CREATE TABLE IF NOT EXISTS managers/manager_points`
// (иначе на старой базе получилась бы пустая новая таблица рядом со старой,
// набитой реальными данными). На чистой базе (без старых таблиц) все проверки
// ниже просто не сработают — миграция сама себя пропускает.
function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function renameTableIfNeeded(oldName, newName) {
  if (tableExists(oldName) && !tableExists(newName)) {
    db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
    console.log(`Миграция «амбассадор→менеджер»: таблица ${oldName} → ${newName}`);
  }
}
function renameColumnIfNeeded(table, oldCol, newCol) {
  if (tableExists(table) && columnExists(table, oldCol) && !columnExists(table, newCol)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
    console.log(`Миграция «амбассадор→менеджер»: ${table}.${oldCol} → ${table}.${newCol}`);
  }
}

renameTableIfNeeded('ambassadors', 'managers');
renameTableIfNeeded('ambassador_points', 'manager_points');
renameColumnIfNeeded('managers', 'amb_code', 'mgr_code');
renameColumnIfNeeded('manager_points', 'ambassador_id', 'manager_id');
renameColumnIfNeeded('manager_points', 'bonus_ambassador_amount', 'bonus_manager_amount');
renameColumnIfNeeded('points', 'ambassador_id', 'manager_id');
renameColumnIfNeeded('points', 'ambassador_code', 'manager_code');
renameColumnIfNeeded('restock_requests', 'ambassador_id', 'manager_id');

// Викторина теперь награждает косточками вместо промокода со скидкой —
// переименовываем колонку под новый смысл (на новых базах CREATE TABLE ниже
// уже создаст её сразу с правильным именем, это только для уже развёрнутых).
renameColumnIfNeeded('quiz_prizes', 'discount_percent', 'bones_awarded');

// Строковые значения-данные в уже существующих строках (не только имена колонок/таблиц) —
// старые заявки/новости/токены могли быть сохранены со значением роли 'ambassador'.
if (tableExists('restock_requests')) {
  db.exec("UPDATE restock_requests SET initiated_by = 'manager' WHERE initiated_by = 'ambassador'");
}
if (tableExists('news')) {
  db.exec("UPDATE news SET target_role = 'manager' WHERE target_role = 'ambassador'");
}
if (tableExists('telegram_login_tokens')) {
  db.exec("UPDATE telegram_login_tokens SET role = 'manager' WHERE role = 'ambassador'");
}
// Старые логин-коды формата 'AMB-2025-001', выданные ДО переименования, продолжают
// работать как есть (это просто текстовое значение в БД) — принудительно переписывать
// уже выданные людям коды на 'MGR-...' не нужно и не нужно ломать то, что у них на руках.

db.exec(`
CREATE TABLE IF NOT EXISTS cities (
  id      TEXT PRIMARY KEY,     -- 'krsk' | 'spb' | слаг для новых городов
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS points (
  id               TEXT PRIMARY KEY,     -- сгенерированный slug (например, из названия точки при создании)
  name             TEXT NOT NULL,
  addr             TEXT NOT NULL,
  icon             TEXT NOT NULL,
  lat              REAL,                                  -- широта — для отображения на Яндекс.Картах
  lng              REAL,                                  -- долгота
  manager_id    INTEGER REFERENCES managers(id),  -- кто отвечает за пополнение этой точки (NULL = хаб)
  is_hub           INTEGER NOT NULL DEFAULT 0,           -- 1 — исходные 3 точки без менеджера-логиста
  active           INTEGER NOT NULL DEFAULT 1            -- 0 — скрыта из чекаута/списков, но история заказов сохранена
);

CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT UNIQUE NOT NULL,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL,        -- 'treats' | 'toys' | 'accessories' | 'care'
  icon      TEXT NOT NULL,
  badge     TEXT,
  img       TEXT,
  desc      TEXT NOT NULL,
  comp      TEXT NOT NULL,        -- JSON-массив строк состава
  pet_suitability TEXT,           -- для какого питомца / размера подходит
  purpose         TEXT,           -- назначение товара
  restrictions    TEXT,           -- ограничения и важные предостережения
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  weight      TEXT NOT NULL,      -- '50 г', '1 шт.' и т.п.
  price       INTEGER NOT NULL,   -- в рублях, целое число
  cost_price  REAL,               -- закупочная себестоимость за штуку (для расчёта прибыли)
  active      INTEGER NOT NULL DEFAULT 1,  -- показывать ли именно этот вес на сайте
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock (
  variant_id  INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  point_id    TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, point_id)
);

-- Отзывы о товарах со звёздным рейтингом. Проходят модерацию (status)
-- перед публикацией — админ одобряет/отклоняет в разделе «Отзывы».
-- Один клиент — один отзыв на товар (UNIQUE), повторная отправка обновляет
-- существующий и заново отправляет его на проверку.
CREATE TABLE IF NOT EXISTS product_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL,                    -- 1..5
  text         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'approved' | 'rejected'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, customer_id)
);

CREATE TABLE IF NOT EXISTS admins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT,
  telegram_chat_id TEXT,
  role           TEXT NOT NULL DEFAULT 'admin', -- 'super' — может создавать/отключать других админов; 'admin' — обычный, всё остальное
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_code           TEXT UNIQUE NOT NULL,     -- 'GR-001' и т.п.
  login                  TEXT UNIQUE NOT NULL,
  password_hash          TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  telegram_chat_id       TEXT,                    -- появляется после подтверждённого входа через Telegram
  point_id               TEXT REFERENCES points(id),  -- связь с точкой в общем справочнике (складской учёт)
  point_name             TEXT NOT NULL,
  point_address          TEXT,
  legal_form             TEXT,                     -- 'npd' | 'ip' | 'ooo'
  inn                    TEXT,
  bank_details           TEXT,
  commission_rate        REAL NOT NULL DEFAULT 0.15,
  tier_confirmed_month   TEXT,                     -- 'YYYY-MM' — когда показатели последний раз реально подтверждали текущий уровень (не просто перенесён по льготному месяцу)
  display_stand          INTEGER NOT NULL DEFAULT 1,  -- формат размещения на точке: полноценная стойка
  display_poster         INTEGER NOT NULL DEFAULT 0,  -- компактная картинка/постер с QR — почти не занимает места
  display_basket         INTEGER NOT NULL DEFAULT 0,  -- небольшая корзинка вместо/вместе со стойкой
  manager_code        TEXT,
  referred_by_partner_id INTEGER REFERENCES partners(id),  -- какой грумер привёл этого (реферальная программа)
  salon_tagline          TEXT,     -- короткий слоган для публичной страницы салона
  salon_description      TEXT,     -- свободное описание салона/услуг
  salon_photo_url        TEXT,     -- первое/главное фото (совместимость со старыми версиями)
  salon_photo_urls       TEXT NOT NULL DEFAULT '[]', -- JSON-массив фотографий галереи
  salon_instagram        TEXT,
  salon_vk                TEXT,
  salon_website           TEXT,
  salon_page_published    INTEGER NOT NULL DEFAULT 0,  -- партнёр сам включает публикацию своей страницы
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS managers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mgr_code       TEXT UNIQUE NOT NULL,        -- 'MGR-2025-001'
  login          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  email          TEXT,
  telegram_chat_id TEXT,                    -- появляется после подтверждённого входа через Telegram
  legal_form     TEXT,                        -- 'npd' | 'ip' | 'ooo' — для договора и налоговых рисков (см. партнёров)
  inn            TEXT,
  bank_details   TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS manager_points (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id            INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  point_id                 TEXT REFERENCES points(id),  -- связь с реальной точкой в points, если включён складской учёт
  point_name               TEXT NOT NULL,
  point_type               TEXT NOT NULL,     -- 'Грумминг' | 'Вет.клиника' и т.п.
  revenue                  INTEGER NOT NULL DEFAULT 0,
  commission_rate          REAL NOT NULL DEFAULT 0.07,  -- постоянная ставка 7% (см. routes-managers.js)
  active                   INTEGER NOT NULL DEFAULT 1,
  bonus_paid               INTEGER NOT NULL DEFAULT 0,
  bonus_manager_amount  INTEGER,           -- сколько реально получил менеджер (может быть уменьшено при сплите)
  referred_groomer_id      INTEGER REFERENCES partners(id),  -- если точку привёл другой грумер — сплит бонуса с ним
  referred_groomer_amount  INTEGER
);

-- ── СКЛАД И РАСПРОСТРАНЕНИЕ ЧЕРЕЗ МЕНЕДЖЕРОВ ───────────────────────
-- Транзитная модель: раз в неделю менеджер забирает запас с центрального
-- склада и в тот же день развозит по своим точкам — остаток у него самого
-- не хранится долго, что снимает риск порчи натурального товара.

CREATE TABLE IF NOT EXISTS warehouse_stock (
  variant_id  INTEGER PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS warehouse_keepers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Владелец салона — отдельная роль входа, видит статистику по своей точке
-- целиком: общую выручку, разбивку по каждому грумеру на этой точке и по
-- менеджеру, который её курирует. Один владелец = одна точка (если у
-- человека несколько салонов — заводим ему отдельный логин на каждый).
CREATE TABLE IF NOT EXISTS salon_owners (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  telegram_chat_id TEXT,
  point_id       TEXT REFERENCES points(id),
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Приход товара от поставщика — увеличивает warehouse_stock, с историей
-- (кто принял, когда, со ссылкой на накладную/поставку).
CREATE TABLE IF NOT EXISTS warehouse_receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL,
  supplier_note TEXT,                 -- номер накладной/комментарий, например "Счастливый хвостик, накладная №123"
  keeper_id     INTEGER REFERENCES warehouse_keepers(id),
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ручные удаления и корректировки складских строк администратором.
-- Название и фасовка сохраняются снимком, поэтому журнал остаётся понятным,
-- даже если сам товар позднее удалят из каталога.
CREATE TABLE IF NOT EXISTS warehouse_stock_adjustments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id       TEXT NOT NULL,
  variant_id    INTEGER NOT NULL,
  product_name  TEXT NOT NULL,
  weight        TEXT NOT NULL,
  old_qty       INTEGER NOT NULL,
  new_qty       INTEGER,
  action        TEXT NOT NULL,
  reason        TEXT,
  admin_id      INTEGER,
  admin_login   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── ПЕРЕМЕЩЕНИЕ ТОВАРА НА ТОЧКУ (без кладовщика) ───────────────────
-- Менеджер физически привозит товар на точку, ПОСЛЕ этого отчитывается в
-- системе — сколько и какого товара разместил. Администратор проверяет
-- отчёт и подтверждает: только в момент подтверждения товар реально
-- списывается с городского склада и зачисляется на точку. Роль кладовщика
-- в этом процессе больше не участвует — только менеджер и администратор.
CREATE TABLE IF NOT EXISTS stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id     INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  point_id       TEXT NOT NULL REFERENCES points(id),
  city_id        TEXT NOT NULL REFERENCES cities(id),
  status         TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  comment        TEXT,                              -- комментарий менеджера к отчёту (необязательно)
  reject_reason  TEXT,                              -- почему администратор отклонил (если отклонил)
  reported_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at    TEXT,
  reviewed_by    TEXT                               -- логин администратора, кто согласовал/отклонил
);

CREATE TABLE IF NOT EXISTS stock_movement_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_id   INTEGER NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL
);

-- ── (устарело, оставлено для истории уже выданных заявок) ──────────
-- Раньше выдачей со склада занимался кладовщик — роль убрана, новые
-- перемещения товара идут через stock_movements выше. Таблицы ниже больше
-- не используются в новых операциях, но старые записи не удаляем.
CREATE TABLE IF NOT EXISTS restock_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id   INTEGER REFERENCES managers(id) ON DELETE CASCADE,  -- кто физически развезёт (может быть выведен из точки)
  point_id        TEXT REFERENCES points(id),   -- если заявка от конкретного грумера — про его точку
  initiated_by    TEXT NOT NULL DEFAULT 'manager',  -- 'manager' | 'partner'
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'fulfilled' | 'cancelled'
  fulfilled_by    INTEGER REFERENCES warehouse_keepers(id),  -- какой кладовщик выдал
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at    TEXT
);

CREATE TABLE IF NOT EXISTS restock_request_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER NOT NULL REFERENCES restock_requests(id) ON DELETE CASCADE,
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty_requested   INTEGER NOT NULL,
  qty_allocated   INTEGER NOT NULL DEFAULT 0   -- сколько реально выдал склад (может быть меньше запроса)
);

CREATE TABLE IF NOT EXISTS restock_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES restock_requests(id) ON DELETE CASCADE,
  point_id      TEXT NOT NULL REFERENCES points(id),
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL,
  delivered_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── КЛИЕНТЫ ────────────────────────────────────────────────────────
-- Фиксация клиентов по телефону — заменяет старую систему промокодов
-- "-20% на первый заказ" (та проверялась через localStorage в браузере
-- и слетала при смене устройства). Теперь первый заказ определяется
-- надёжно на сервере: если такого телефона раньше не было — скидка.
-- ── НОВОСТИ / ОБНОВЛЕНИЯ ───────────────────────────────────────────
-- Публикуются из админки, показываются в кабинетах грумеров и/или
-- менеджеров в зависимости от target_role.
CREATE TABLE IF NOT EXISTS news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT,
  target_role TEXT NOT NULL DEFAULT 'all',  -- 'all'|'partner'|'manager' (кабинеты) | 'public' (сайт)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── ПЛАН ЗАПУСКА ПРОЕКТА ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS launch_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  note        TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ── ВОССТАНОВЛЕНИЕ ПАРОЛЯ АДМИНА ───────────────────────────────────
-- Только для роли admin — у неё нет "начальника" в системе, который мог бы
-- сбросить пароль вручную (в отличие от партнёров/менеджеров/кладовщиков,
-- которым пароль сбрасывает сам админ). Токен уходит на почту одноразово.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT UNIQUE NOT NULL,
  admin_id    INTEGER NOT NULL REFERENCES admins(id),
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Отдельная таблица (не переиспользуем password_reset_tokens выше) — там
-- admin_id NOT NULL, а трогать существующее ограничение на боевой таблице
-- рискованно. Восстановление пароля клиента — по почте, без SMS: письмо
-- со ссылкой уходит на email, указанный в профиле клиента.
CREATE TABLE IF NOT EXISTS customer_password_reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SMS-ВХОД В ЛИЧНЫЙ КАБИНЕТ КЛИЕНТА ──────────────────────────────
-- Второй способ входа в кабинет наряду с паролем — код из SMS, короткоживущий.
-- ── ВХОД В ЛИЧНЫЙ КАБИНЕТ ЧЕРЕЗ TELEGRAM ───────────────────────────
-- Бот не может написать клиенту первым — только после того, как клиент сам
-- откроет диалог по ссылке-приглашению с этим токеном (нажмёт /start).
CREATE TABLE IF NOT EXISTS telegram_login_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT UNIQUE NOT NULL,
  phone       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'customer', -- 'customer' | 'partner' | 'manager' | 'owner' | 'admin'
  account_id  INTEGER,                         -- для привязки из уже открытого кабинета
  chat_id     TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── ВХОД В ЛИЧНЫЙ КАБИНЕТ ЧЕРЕЗ MAX ────────────────────────────────
-- То же самое, что и для Telegram, но для мессенджера MAX.
-- ── ПРИЗЫ ИЗ ВИКТОРИНЫ О СОБАКАХ ─────────────────────────────────────
-- Не даём выбивать призы чаще раза в сутки на один номер телефона.
CREATE TABLE IF NOT EXISTS quiz_prizes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  correct_count INTEGER NOT NULL,
  bones_awarded INTEGER NOT NULL,
  promo_code  TEXT NOT NULL DEFAULT '', -- legacy, больше не используется (раньше приз был промокодом)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Рейтинг игроков — фиксируем КАЖДУЮ попытку (не только выигрышную, как
-- quiz_prizes выше), иначе рейтинг был бы нечестным и не показывал бы
-- реальный лучший результат тех, кто пока не набрал приз.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  correct_count INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Призы за победу в шахматах — начисляются только за УЛУЧШЕНИЕ результата
-- в течение недели (см. routes-chess.js), поэтому здесь не каждая победа,
-- а только те, что подняли лучший результат недели.
CREATE TABLE IF NOT EXISTS chess_prizes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  difficulty  TEXT NOT NULL,
  bones_awarded INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- КАЖДАЯ победа в шахматах (не только те, что дали доплату косточками) —
-- для рейтинга лучших игроков, аналогично quiz_attempts у викторины.
CREATE TABLE IF NOT EXISTS chess_wins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  difficulty  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS max_login_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT UNIQUE NOT NULL,
  phone       TEXT NOT NULL,
  chat_id     TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_login_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT UNIQUE NOT NULL,
  name            TEXT,
  lname           TEXT,
  email           TEXT,
  password_hash   TEXT,  -- задаётся клиентом самостоятельно для личного кабинета, изначально NULL
  pet_name        TEXT,  -- кличка питомца — для персонализации и поздравления с ДР
  pet_birthday    TEXT,  -- дата рождения питомца, 'YYYY-MM-DD' (используется только месяц/день — для скидки 15% в этот день ежегодно)
  pet_breed       TEXT,  -- порода — для будущей персонализации рекомендаций (например, для коробки-подписки)
  pet_size        TEXT,  -- 'small' | 'medium' | 'large' — размер, влияет на подходящий размер лакомств/жевательных
  pet_notes       TEXT,  -- особенности: аллергии, предпочтения, на что реагирует плохо
  first_order_at  TEXT,
  last_order_at   TEXT,  -- дата последнего заказа — по ней определяем "давно не заказывал" для win-back
  telegram_chat_id TEXT, -- заполняется при первом входе через Telegram — нужен, чтобы написать клиенту самим (win-back и т.п.)
  winback_sent_at TEXT,  -- когда в последний раз отправили win-back-сообщение — не шлём повторно бесконечно
  orders_count    INTEGER NOT NULL DEFAULT 0,
  total_spent     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Аудит удаления тестовых клиентов администратором. Сам клиент удаляется,
-- поэтому сохраняем достаточный текстовый снимок, чтобы позже было понятно,
-- кто, когда и какую запись убрал из базы.
CREATE TABLE IF NOT EXISTS customer_deletion_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER NOT NULL,
  phone          TEXT NOT NULL,
  full_name      TEXT,
  orders_count   INTEGER NOT NULL DEFAULT 0,
  total_spent    INTEGER NOT NULL DEFAULT 0,
  bones_balance  INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  admin_id       INTEGER,
  admin_login    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Операционные действия менеджеров. Храним снимок ФИО/логина и название
-- объекта, чтобы журнал оставался понятным после изменения или удаления
-- соответствующего аккаунта, точки или партнёра.
CREATE TABLE IF NOT EXISTS manager_action_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id     INTEGER NOT NULL,
  manager_name   TEXT,
  manager_login  TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  target_name    TEXT,
  details        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Финансово значимые исправления атрибуции уже оплаченных заказов.
-- Храним оба состояния и снимок администратора: это позволяет понять,
-- кто и когда переназначил комиссию, даже если партнёра позже переименуют.
CREATE TABLE IF NOT EXISTS order_partner_change_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_code         TEXT NOT NULL,
  old_partner_id     INTEGER,
  old_partner_name   TEXT,
  old_commission_rate REAL,
  new_partner_id     INTEGER,
  new_partner_name   TEXT,
  new_commission_rate REAL NOT NULL,
  admin_id           INTEGER,
  admin_login        TEXT,
  reason             TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,  -- JSON
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code       TEXT UNIQUE NOT NULL,   -- 'TG-...'
  customer_name    TEXT NOT NULL,
  customer_lname   TEXT,
  customer_phone   TEXT NOT NULL,
  customer_email   TEXT,
  pickup_point     TEXT NOT NULL,          -- человекочитаемый текст для Telegram/чека
  point_id         TEXT,                   -- id любой реальной точки, либо NULL (для "другой точки")
  partner_id       INTEGER REFERENCES partners(id),  -- если на точке несколько грумеров — кого выбрал клиент
  partner_name     TEXT,                   -- имя выбранного грумера, зафиксированное на момент заказа
  comment          TEXT,
  subtotal         INTEGER NOT NULL,
  discount         INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL,
  promo_code       TEXT,
  payment_method   TEXT NOT NULL,        -- 'card' | 'bank_card' | 'sbp' | 'yookassa'
  needs_delivery   INTEGER NOT NULL DEFAULT 0,
  fulfillment_type TEXT NOT NULL DEFAULT 'pickup',  -- 'pickup' | 'home_delivery'
  delivery_address TEXT,                 -- адрес для 'home_delivery' (доставка курьером/своими силами)
  delivery_fee     INTEGER NOT NULL DEFAULT 0,       -- стоимость доставки, уже включена в total
  has_custom_item  INTEGER NOT NULL DEFAULT 0,
  commission_rate  REAL,                 -- ставка партнёра, зафиксированная НА МОМЕНТ этого заказа (обычный уровень грумера, либо 0% для самозаказа — см. routes-payment.js). NULL у старых заказов — тогда используется текущая ставка партнёра как раньше.
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'paid'|'failed'|'cancelled'
  yookassa_payment_id TEXT,
  reservation_status TEXT NOT NULL DEFAULT 'none', -- 'none'|'active'|'consumed'|'released'
  reservation_expires_at TEXT,
  inventory_source_type TEXT,                    -- 'point' | 'warehouse'
  inventory_source_id TEXT,                      -- point_id либо city_id
  refund_status    TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'refunded'
  refunded_amount  INTEGER,
  refund_reason    TEXT,
  refunded_at      TEXT,
  yookassa_refund_id TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id  INTEGER REFERENCES product_variants(id),
  name        TEXT NOT NULL,
  weight      TEXT NOT NULL,
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  is_custom   INTEGER NOT NULL DEFAULT 0
);

-- Реестр фактически выплаченных комиссий грумерам. Отдельная таблица
-- partner_payout_items связывает выплату с конкретными заказами и не даёт
-- повторно включить один и тот же заказ в следующую выплату.
CREATE TABLE IF NOT EXISTS partner_payouts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id           INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  partner_name         TEXT NOT NULL,
  partner_code         TEXT,
  manager_id           INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  manager_name         TEXT,
  amount               INTEGER NOT NULL,
  orders_count         INTEGER NOT NULL DEFAULT 0,
  paid_by_admin_id     INTEGER,
  paid_by_admin_login  TEXT,
  paid_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partner_payout_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id          INTEGER NOT NULL REFERENCES partner_payouts(id) ON DELETE CASCADE,
  order_id           INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_code         TEXT NOT NULL,
  commission_amount  INTEGER NOT NULL,
  UNIQUE(order_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner
  ON partner_payouts(partner_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_payouts_manager
  ON partner_payouts(manager_id, paid_at DESC);

-- Реестр выплат владельцам салонов. Как и у грумеров, каждая выплата
-- связывается с конкретными оплаченными заказами: один заказ нельзя включить
-- во вторую выплату, а история остаётся даже после удаления заказа/аккаунта.
CREATE TABLE IF NOT EXISTS owner_payouts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id             INTEGER REFERENCES salon_owners(id) ON DELETE SET NULL,
  owner_name           TEXT NOT NULL,
  owner_code           TEXT,
  point_id             TEXT REFERENCES points(id) ON DELETE SET NULL,
  point_name           TEXT,
  amount               INTEGER NOT NULL,
  orders_count         INTEGER NOT NULL DEFAULT 0,
  paid_by_admin_id     INTEGER,
  paid_by_admin_login  TEXT,
  paid_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owner_payout_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id          INTEGER NOT NULL REFERENCES owner_payouts(id) ON DELETE CASCADE,
  order_id           INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_code         TEXT NOT NULL,
  commission_amount  INTEGER NOT NULL,
  UNIQUE(order_id)
);

CREATE INDEX IF NOT EXISTS idx_owner_payouts_owner
  ON owner_payouts(owner_id, paid_at DESC);

-- ── КОСТОЧКИ (внутренняя валюта «Тайги») ────────────────────────────
-- Полная история начислений/списаний — источник истины. Текущий баланс
-- дублируется в customers.bones_balance для быстрого чтения (обновляется
-- атомарно вместе с каждой вставкой сюда, см. server/bones.js).
CREATE TABLE IF NOT EXISTS bone_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,   -- положительное — начисление, отрицательное — списание
  type          TEXT NOT NULL,      -- 'referral' | 'gift' | 'reserve' | 'spend' | 'release' | 'refund'
  description   TEXT,
  order_id      INTEGER REFERENCES orders(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ── МИГРАЦИИ ───────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS не меняет уже существующую таблицу — если база
// была создана раньше, чем добавили новую колонку, её нужно добавить отдельно
// через ALTER TABLE, не теряя уже накопленные данные (реальные заказы и т.п.).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Миграция: добавлена колонка ${table}.${column}`);
  }
}

ensureColumn('points', 'manager_id', 'INTEGER REFERENCES managers(id)');
ensureColumn('points', 'is_hub', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('partners', 'point_id', 'TEXT REFERENCES points(id)');
ensureColumn('manager_points', 'point_id', 'TEXT REFERENCES points(id)');
ensureColumn('manager_points', 'commission_rate', 'REAL NOT NULL DEFAULT 0.07');
// Раньше было два тарифа (3% без сопровождения, 5% с полным сопровождением) —
// оставляем только 5% с полным сопровождением, поднимаем старые точки на 3%.
db.exec("UPDATE manager_points SET commission_rate = 0.05 WHERE commission_rate = 0.03");

// Переход на ступенчатое вознаграждение менеджеров: первые 5 привлечённых
// точек каждого менеджера — 10% навсегда, точки начиная с 6-й — 7%.
// Пересчитываем ОДИН раз задним числом все уже существующие точки (порядок
// определяем по id — он совпадает с порядком добавления). Флаг в
// site_settings не даёт запускать это повторно при каждом рестарте —
// иначе это затирало бы ручные корректировки ставки, если админ когда-то
// поменяет её для конкретной точки вручную.
if (!db.prepare("SELECT value FROM site_settings WHERE key = 'manager_tiered_commission_migrated'").get()) {
  const managerIds = db.prepare('SELECT DISTINCT manager_id FROM manager_points').all().map((r) => r.manager_id);
  const setRate = db.prepare('UPDATE manager_points SET commission_rate = ? WHERE id = ?');
  for (const managerId of managerIds) {
    const points = db.prepare('SELECT id FROM manager_points WHERE manager_id = ? ORDER BY id ASC').all(managerId);
    points.forEach((p, idx) => {
      setRate.run(idx < 5 ? 0.10 : 0.07, p.id);
    });
  }
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at) VALUES ('manager_tiered_commission_migrated', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();
}

// Отменили ступенчатую систему — вознаграждение менеджера теперь ВСЕГДА 7%,
// независимо от числа привлечённых точек. Проставляем это задним числом всем
// уже существующим точкам ОДИН раз (флаг в site_settings не даёт запускать
// повторно при каждом рестарте).
if (!db.prepare("SELECT value FROM site_settings WHERE key = 'manager_flat_7pct_migrated'").get()) {
  db.exec('UPDATE manager_points SET commission_rate = 0.07');
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at) VALUES ('manager_flat_7pct_migrated', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();
}

// Скидку на «Товар дня» решили снизить с 20% до 10%. Настройки скидок
// хранятся одной JSON-строкой (site_settings.key='discounts') — если админ
// уже хоть раз сохранял её через панель, там могло остаться старое 20%,
// которое новый DEFAULT в settings.js сам по себе не перекроет. Правим
// один раз, только если там ещё "родные" 20% (не трогаем, если админ уже
// вручную поставил своё значение).
{
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'discounts'").get();
  if (row) {
    try {
      const stored = JSON.parse(row.value);
      if (stored.product_of_day_percent === 20) {
        stored.product_of_day_percent = 10;
        db.prepare("UPDATE site_settings SET value = ?, updated_at = datetime('now') WHERE key = 'discounts'").run(JSON.stringify(stored));
      }
    } catch (e) { /* повреждённый JSON — не трогаем, вернутся дефолты */ }
  }
}
ensureColumn('restock_requests', 'point_id', 'TEXT REFERENCES points(id)');
ensureColumn('restock_requests', 'initiated_by', "TEXT NOT NULL DEFAULT 'manager'");

ensureColumn('restock_requests', 'fulfilled_by', 'INTEGER REFERENCES warehouse_keepers(id)');

// Разовая полная замена каталога — по просьбе владельца бизнеса, реальный
// ассортимент лакомств заменён на новый список. DELETE FROM products
// каскадно чистит product_variants (варианты веса/цены) и stock (остатки
// по точкам) — обе объявлены с ON DELETE CASCADE. order_items НЕ трогает:
// там название/цена хранятся как текстовый снимок на момент заказа, без
// связи с products, поэтому история старых заказов не пострадает. Новый
// ассортимент добавляет seed.js ниже по обычной схеме INSERT OR IGNORE.
//
// Вся миграция обёрнута в try/catch: раньше ошибка здесь (как эта самая
// FOREIGN KEY constraint failed) валила весь процесс на старте, кладя
// сайт целиком. Теперь миграция может провалиться без вреда — залогируется
// и просто не выставит флаг (значит попробует снова при следующем рестарте),
// но сервер в любом случае поднимется и сайт будет работать.
if (!db.prepare("SELECT value FROM site_settings WHERE key = 'products_catalog_reset_2026_08'").get()) {
  try {
    // Три таблицы склада тоже ссылаются на product_variants БЕЗ CASCADE
    // (приёмки от поставщика, заявки и доставки на пополнение точек) —
    // это операционные логи склада, а не история заказов клиентов (в
    // отличие от order_items, у которых название/цена — текстовый снимок
    // без связи с products). При полной замене каталога эти записи всё
    // равно больше не на что ссылаться осмысленно — чистим, чтобы миграция
    // не упёрлась в то же ограничение на следующем шаге.
    db.prepare('DELETE FROM warehouse_receipts').run();
    db.prepare('DELETE FROM restock_request_items').run();
    db.prepare('DELETE FROM restock_deliveries').run();
    const { changes } = db.prepare('DELETE FROM products').run();
    if (changes > 0) {
      console.log('Каталог товаров очищен (' + changes + ' товар(ов) удалено) — новый ассортимент добавит seed.js.');
    }
    db.prepare(`
      INSERT INTO site_settings (key, value, updated_at) VALUES ('products_catalog_reset_2026_08', '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run();
  } catch (e) {
    console.error('[миграция products_catalog_reset_2026_08] Не удалось очистить каталог — сервер продолжит запуск как обычно, миграция попробует снова при следующем рестарте. Причина:', e.message);
  }
}
ensureColumn('orders', 'point_id', 'TEXT');
ensureColumn('orders', 'customer_email', 'TEXT');
ensureColumn('customers', 'email', 'TEXT');
ensureColumn('customers', 'password_hash', 'TEXT');
ensureColumn('customers', 'pet_name', 'TEXT');
ensureColumn('customers', 'pet_birthday', 'TEXT');
ensureColumn('customers', 'pet_breed', 'TEXT');
ensureColumn('customers', 'pet_size', 'TEXT');
ensureColumn('customers', 'pet_notes', 'TEXT');
// Программа "Приведи друга" — свой код клиента + кто его привёл (если был приведён).
ensureColumn('customers', 'referral_code', 'TEXT');
ensureColumn('customers', 'referred_by_customer_id', 'INTEGER');
ensureColumn('customers', 'last_order_at', 'TEXT');
ensureColumn('customers', 'telegram_chat_id', 'TEXT');
ensureColumn('customers', 'max_chat_id', 'TEXT');
ensureColumn('customers', 'winback_sent_at', 'TEXT');
ensureColumn('admins', 'full_name', 'TEXT');
ensureColumn('admins', 'role', "TEXT NOT NULL DEFAULT 'admin'");
ensureColumn('admins', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('admins', 'created_at', 'TEXT');
db.exec("UPDATE admins SET created_at = datetime('now') WHERE created_at IS NULL");

// Если на уже существующей базе ещё нет ни одного супер-админа (например,
// сразу после этого обновления) — назначаем супер-админом самого первого
// созданного администратора, чтобы не остаться совсем без возможности
// управлять остальными.
const hasSuperAdmin = db.prepare("SELECT id FROM admins WHERE role = 'super'").get();
if (!hasSuperAdmin) {
  const firstAdmin = db.prepare('SELECT id FROM admins ORDER BY id ASC LIMIT 1').get();
  if (firstAdmin) {
    db.prepare("UPDATE admins SET role = 'super' WHERE id = ?").run(firstAdmin.id);
    console.log('Миграция: администратор #' + firstAdmin.id + ' назначен супер-админом (первый на базе)');
  }
}
ensureColumn('product_variants', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'pet_suitability', 'TEXT');
ensureColumn('products', 'purpose', 'TEXT');
ensureColumn('products', 'restrictions', 'TEXT');
ensureColumn('points', 'lat', 'REAL');
ensureColumn('points', 'lng', 'REAL');

// Координаты двух действующих минимаркетов сверены по карточкам и маршрутам
// 2ГИС. Заполняем только пустые значения: если администратор позднее вручную
// уточнит положение входа, его координаты при следующем запуске не затрутся.
db.prepare(`
  UPDATE points SET lat = ?, lng = ?
  WHERE id = ? AND (lat IS NULL OR lng IS NULL)
`).run(56.024484, 92.819061, 'sir-barsik');
db.prepare(`
  UPDATE points SET lat = ?, lng = ?
  WHERE id = ? AND (lat IS NULL OR lng IS NULL)
`).run(55.994955, 92.931145, 'zveryuga');
ensureColumn('orders', 'refund_status', "TEXT NOT NULL DEFAULT 'none'");
ensureColumn('orders', 'refunded_amount', 'INTEGER');
ensureColumn('orders', 'refund_reason', 'TEXT');
ensureColumn('orders', 'refunded_at', 'TEXT');
ensureColumn('orders', 'yookassa_refund_id', 'TEXT');
ensureColumn('orders', 'partner_id', 'INTEGER');
ensureColumn('orders', 'partner_name', 'TEXT');
// Для уже существующих заказов сохраняем текущее имя связанного грумера.
// В дальнейшем заказ использует снимок имени и не зависит от изменений профиля.
db.exec(`
  UPDATE orders
  SET partner_name = (SELECT full_name FROM partners WHERE partners.id = orders.partner_id)
  WHERE partner_name IS NULL AND partner_id IS NOT NULL
`);
ensureColumn('orders', 'fulfillment_type', "TEXT NOT NULL DEFAULT 'pickup'");
ensureColumn('order_items', 'variant_id', 'INTEGER REFERENCES product_variants(id)');
ensureColumn('orders', 'delivery_address', 'TEXT');
ensureColumn('orders', 'delivery_fee', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'referral_code', 'TEXT');
ensureColumn('partners', 'tier_confirmed_month', 'TEXT');
ensureColumn('partners', 'telegram_chat_id', 'TEXT');
ensureColumn('managers', 'telegram_chat_id', 'TEXT');
ensureColumn('salon_owners', 'telegram_chat_id', 'TEXT');
ensureColumn('admins', 'telegram_chat_id', 'TEXT');
// Формат размещения на точке — раньше был только один вариант (полноценная
// стойка), поэтому у уже существующих партнёров по умолчанию включаем именно
// её, а два новых формата (постер, корзинка) — выключены, пока партнёр или
// админ не включит их явно.
ensureColumn('partners', 'display_stand', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('partners', 'display_poster', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('partners', 'display_basket', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('telegram_login_tokens', 'role', "TEXT NOT NULL DEFAULT 'customer'");
ensureColumn('telegram_login_tokens', 'account_id', 'INTEGER');
// Короткий числовой код — запасной способ входа, если фронтенд не подхватил
// подтверждение автоматически (опрос /telegram/check). Бот присылает его в
// сообщении вместе с обычным подтверждением; пользователь может ввести его
// на сайте вручную, не имея больше доступа к исходному длинному token.
ensureColumn('telegram_login_tokens', 'code', 'TEXT');

// Единая структура каталога: лакомства, игрушки, аксессуары и уход.
// Старую категорию chews объединяем с лакомствами. Несколько аксессуаров
// исторически были заведены как toys/treats, поэтому переносим их по названию.
// Миграция идемпотентна и безопасно выполняется при каждом запуске.
function migrateProductCategories() {
  const accessoryWords = /миска|поилк|пакет|диспенсер|ошейн|повод|шле|щ[её]тк|расч[её]с|когтерез|одежд|дождевик|аксессуар/i;
  const rows = db.prepare('SELECT id, name, category FROM products').all();
  const update = db.prepare('UPDATE products SET category = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const product of rows) {
      let category = product.category;
      if (category === 'chews') category = 'treats';
      if (category === 'walk') category = 'accessories';
      if (accessoryWords.test(product.name || '')) category = 'accessories';
      if (category !== product.category) {
        update.run(category, product.id);
        changed += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (changed) console.log('Миграция каталога: товары распределены по 4 категориям (' + changed + ' изм.)');
}
migrateProductCategories();

// В старых версиях chat_id партнёра и менеджера сохранялся только в
// telegram_login_tokens. Переносим последнюю подтверждённую связь в профиль,
// чтобы уведомления о новых продажах не зависели от срока жизни токена входа.
function backfillTelegramChatIds(table, role) {
  const accounts = db.prepare(`SELECT id, phone FROM ${table} WHERE telegram_chat_id IS NULL`).all();
  const tokens = db.prepare(`
    SELECT phone, chat_id FROM telegram_login_tokens
    WHERE role = ? AND verified = 1 AND chat_id IS NOT NULL
    ORDER BY id DESC
  `).all(role);
  const last10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  const update = db.prepare(`UPDATE ${table} SET telegram_chat_id = ? WHERE id = ?`);
  for (const account of accounts) {
    const phone = last10(account.phone);
    if (!phone) continue;
    const token = tokens.find((row) => last10(row.phone) === phone);
    if (token) update.run(String(token.chat_id), account.id);
  }
}
backfillTelegramChatIds('partners', 'partner');
backfillTelegramChatIds('managers', 'manager');

ensureColumn('points', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('partners', 'referred_by_partner_id', 'INTEGER REFERENCES partners(id)');
// Забыли при переименовании амбассадор→менеджер: manager_code уже был в
// CREATE TABLE IF NOT EXISTS (для новых баз), но CREATE TABLE IF NOT EXISTS
// не добавляет колонки в уже существующую таблицу — на прод-базах, созданных
// раньше, колонки не было вообще, из-за чего регистрация партнёра падала с
// ошибкой «table partners has no column named manager_code».
ensureColumn('partners', 'manager_code', 'TEXT');
// Поля salon_* ниже остаются на partners для истории (не удаляем и не
// используем дальше в новом коде) — сама страница салона переехала на
// points, см. блок ниже. Так страница доступна и для точек без назначенного
// партнёра (в том числе будущих), и её могут редактировать не только
// грумеры, но и администратор, менеджер, владелец салона.
ensureColumn('partners', 'salon_tagline', 'TEXT');
ensureColumn('partners', 'salon_description', 'TEXT');
ensureColumn('partners', 'salon_photo_url', 'TEXT');
ensureColumn('partners', 'salon_instagram', 'TEXT');
ensureColumn('partners', 'salon_vk', 'TEXT');
ensureColumn('partners', 'salon_website', 'TEXT');
ensureColumn('partners', 'salon_page_published', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('manager_points', 'bonus_manager_amount', 'INTEGER');

// ── СТРАНИЦА ТОЧКИ (салона) — теперь у самой точки, не у партнёра ──────
// Раньше эти же поля жили на partners — значит, у точки без назначенного
// партнёра страницы просто не могло быть, и редактировать её мог только
// сам грумер. Теперь она принадлежит точке напрямую: есть у любой точки,
// даже будущей, и редактировать её может администратор, менеджер (только
// свои точки) и владелец салона (только свою точку) — не только партнёр.
ensureColumn('points', 'salon_tagline', 'TEXT');
ensureColumn('points', 'salon_description', 'TEXT');
ensureColumn('points', 'salon_photo_url', 'TEXT');
ensureColumn('points', 'salon_photo_urls', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('points', 'salon_instagram', 'TEXT');
ensureColumn('points', 'salon_vk', 'TEXT');
ensureColumn('points', 'salon_website', 'TEXT');
ensureColumn('points', 'salon_page_published', 'INTEGER NOT NULL DEFAULT 0');
// Время последнего изменения нужно страховочной копии страниц салонов:
// после нового деплоя она восстанавливает только более свежие данные и не
// перезаписывает правки, уже сделанные в текущей базе.
ensureColumn('points', 'salon_page_updated_at', 'TEXT');

// Существующую единственную фотографию превращаем в первый кадр новой
// галереи. Старое поле сохраняется как обложка для обратной совместимости.
(function migrateSalonPhotoToGallery() {
  const rows = db.prepare(`
    SELECT id, salon_photo_url, salon_photo_urls FROM points
    WHERE salon_photo_url IS NOT NULL AND TRIM(salon_photo_url) != ''
  `).all();
  const update = db.prepare('UPDATE points SET salon_photo_urls = ? WHERE id = ?');
  for (const row of rows) {
    let photos = [];
    try { photos = JSON.parse(row.salon_photo_urls || '[]'); } catch (e) { photos = []; }
    if (!Array.isArray(photos) || !photos.length) {
      update.run(JSON.stringify([row.salon_photo_url]), row.id);
    }
  }
})();

// Одноразовый перенос уже заполненных страниц с партнёра на его точку —
// чтобы то, что грумеры уже успели опубликовать, не потерялось при переезде.
// Переносим только там, где у точки эти поля ещё пустые (не перезаписываем
// то, что уже могли успеть завести через новый интерфейс).
(function migrateSalonPagesToPoints() {
  const withPartnerSalon = db.prepare(`
    SELECT point_id, salon_tagline, salon_description, salon_photo_url,
           salon_instagram, salon_vk, salon_website, salon_page_published
    FROM partners
    WHERE point_id IS NOT NULL AND (salon_tagline IS NOT NULL OR salon_description IS NOT NULL
      OR salon_photo_url IS NOT NULL OR salon_page_published = 1)
  `).all();
  for (const row of withPartnerSalon) {
    const point = db.prepare('SELECT salon_tagline, salon_description, salon_photo_url FROM points WHERE id = ?').get(row.point_id);
    if (!point) continue;
    const alreadyFilled = point.salon_tagline || point.salon_description || point.salon_photo_url;
    if (alreadyFilled) continue;
    db.prepare(`
      UPDATE points SET salon_tagline = ?, salon_description = ?, salon_photo_url = ?,
        salon_photo_urls = ?, salon_instagram = ?, salon_vk = ?, salon_website = ?, salon_page_published = ?
      WHERE id = ?
    `).run(
      row.salon_tagline, row.salon_description, row.salon_photo_url,
      JSON.stringify(row.salon_photo_url ? [row.salon_photo_url] : []),
      row.salon_instagram, row.salon_vk, row.salon_website, row.salon_page_published,
      row.point_id
    );
  }
})();

// Старые заполненные страницы появились до поля updated_at. Помечаем их
// стабильной начальной датой: при первом запуске они попадут в снимок, а все
// последующие изменения получат реальное время из API.
db.prepare(`
  UPDATE points SET salon_page_updated_at = '1970-01-01T00:00:00.000Z'
  WHERE salon_page_updated_at IS NULL AND (
    salon_tagline IS NOT NULL OR salon_description IS NOT NULL OR
    salon_photo_url IS NOT NULL OR salon_instagram IS NOT NULL OR
    salon_vk IS NOT NULL OR salon_website IS NOT NULL OR salon_page_published = 1
  )
`).run();
ensureColumn('manager_points', 'referred_groomer_id', 'INTEGER REFERENCES partners(id)');
ensureColumn('manager_points', 'referred_groomer_amount', 'INTEGER');
ensureColumn('product_variants', 'cost_price', 'REAL');
// Юридический статус менеджера (самозанятый/ИП/ООО) — для договора оказания
// услуг и снижения риска переквалификации в трудовые отношения, по тому же
// принципу, что уже применяется к партнёрам (см. partners.legal_form).
ensureColumn('managers', 'legal_form', 'TEXT');
ensureColumn('managers', 'inn', 'TEXT');
ensureColumn('managers', 'bank_details', 'TEXT');
ensureColumn('managers', 'email', 'TEXT');
// Внутренняя валюта «Тайги» — 1 косточка = 1 ₽ при оплате (см. server/bones.js).
ensureColumn('customers', 'bones_balance', 'INTEGER NOT NULL DEFAULT 0');
// Не даём начислить бонус за анкету питомца дважды одному клиенту (при
// повторном сохранении профиля) — см. PUT /api/customer/me в routes-customers.js.
ensureColumn('customers', 'profile_bones_awarded', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'bones_used', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'commission_rate', 'REAL');
// Резерв товара и косточек на время оплаты. Старые заказы получают 'none' и
// не затрагиваются; новые pending-заказы держат резерв до оплаты/отмены.
ensureColumn('orders', 'reservation_status', "TEXT NOT NULL DEFAULT 'none'");
ensureColumn('orders', 'reservation_expires_at', 'TEXT');
ensureColumn('orders', 'inventory_source_type', 'TEXT');
ensureColumn('orders', 'inventory_source_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_active_reservations ON orders(reservation_status, reservation_expires_at)');

// Игра «Поймай косточку» заменена викториной о собаках — старые таблицы
// на уже развёрнутых серверах больше не используются нигде в коде, чистим их.
db.exec('DROP TABLE IF EXISTS game_prizes');
db.exec('DROP TABLE IF EXISTS game_scores');

// ── БЭКАФИЛЛ last_order_at (для win-back) ──────────────────────────────────
// Колонка новая — у уже существующих клиентов она пуста. Без бэкафилла
// клиенты, которые ничего не закажут ПОСЛЕ этого обновления, никогда не
// попали бы под win-back-рассылку (last_order_at так и остался бы NULL
// навсегда, ведь заполняется он только при новом заказе). Восстанавливаем
// дату последнего заказа из уже накопленной истории — один раз, безопасно
// повторять при каждом старте (обрабатывает только пустые значения).
// ВАЖНО: ALTER TABLE ADD COLUMN с DEFAULT (datetime('now')) падает в SQLite —
// допустимы только константные дефолты, поэтому здесь NULL, а не функция.
ensureColumn('orders', 'created_at', 'TEXT');
db.exec("UPDATE orders SET created_at = datetime('now') WHERE created_at IS NULL");
(function backfillLastOrderAt() {
  const pendingCount = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE last_order_at IS NULL').get().c;
  if (pendingCount === 0) return;

  const orders = db.prepare("SELECT customer_phone, created_at FROM orders WHERE status != 'pending'").all();
  const lastByPhone = new Map();
  for (const o of orders) {
    const digits = String(o.customer_phone || '').replace(/\D/g, '');
    if (!digits) continue;
    const prev = lastByPhone.get(digits);
    if (!prev || o.created_at > prev) lastByPhone.set(digits, o.created_at);
  }

  const customers = db.prepare('SELECT id, phone FROM customers WHERE last_order_at IS NULL').all();
  const updateStmt = db.prepare('UPDATE customers SET last_order_at = ? WHERE id = ?');
  let updated = 0;
  for (const c of customers) {
    const last = lastByPhone.get(c.phone);
    if (last) { updateStmt.run(last, c.id); updated++; }
  }
  if (updated > 0) console.log(`Миграция: восстановлена дата последнего заказа для ${updated} клиентов (для win-back)`);
})();

// Владелец салона получает фиксированную комиссию 5% с выручки своей точки —
// отдельная, дополнительная выплата поверх комиссий грумера и менеджера
// (их доли не уменьшаются). DEFAULT 0.05 автоматически применится и к уже
// существующим владельцам, и к новым — ничего вручную донастраивать не нужно.
ensureColumn('salon_owners', 'commission_rate', 'REAL NOT NULL DEFAULT 0.05');

// ── ЭКОНОМИКА ПРОЕКТА ────────────────────────────────────────────────
// Затраты на закуп товара админ вносит вручную (реальные суммы по факту
// покупки — точнее, чем расчёт от cost_price за штуку, который не учитывает
// оптовые скидки, доставку, порчу и т.п.). Остальные статьи (комиссии
// партнёру/менеджеру/владельцу, налог, эквайринг) считаются автоматически
// из уже имеющихся в системе данных — см. server/routes-economics.js.
db.exec(`
CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date  TEXT NOT NULL,                        -- дата самого расхода (может отличаться от даты внесения)
  category      TEXT NOT NULL DEFAULT 'Закуп товара',
  amount        INTEGER NOT NULL,
  note          TEXT,
  created_by    TEXT,                                 -- логин администратора, кто внёс запись
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ── МУЛЬТИГОРОДСКАЯ АРХИТЕКТУРА ──────────────────────────────────────
// Изначально вся сеть была в одном городе (Красноярск) — города нигде не
// выделялись отдельным полем. При запуске второго города (Санкт-Петербург)
// и далее — точки, склад, менеджеры и кладовщики должны быть чётко разнесены
// по городам: одна точка физически не может пополняться складом в другом
// городе за 4000+ км, и один менеджер не может физически развозить товар
// сразу в двух городах.
db.exec(`
CREATE TABLE IF NOT EXISTS cities (
  id      TEXT PRIMARY KEY,     -- 'krsk' | 'spb' | слаг для новых городов
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);
`);
db.prepare("INSERT OR IGNORE INTO cities (id, name) VALUES ('krsk', 'Красноярск')").run();
db.prepare("INSERT OR IGNORE INTO cities (id, name) VALUES ('spb', 'Санкт-Петербург')").run();

// Существующие точки/менеджеры/кладовщики созданы до появления городов —
// DEFAULT 'krsk' автоматически относит их к Красноярску, ничего вручную
// разбирать не нужно.
ensureColumn('points', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");
ensureColumn('managers', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");
ensureColumn('warehouse_keepers', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");
ensureColumn('warehouse_receipts', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");
ensureColumn('restock_requests', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");
ensureColumn('expenses', 'city_id', "TEXT NOT NULL DEFAULT 'krsk'");

// ── РЕФЕРАЛЬНЫЙ КОД ВЛАДЕЛЬЦА САЛОНА ─────────────────────────────────
// Раньше приводить новых партнёров (и получать за это бонус) мог только
// грумер — у владельца салона своего кода не было вообще. Теперь оба
// могут привести новую точку и получить долю бонуса за её запуск.
ensureColumn('salon_owners', 'owner_code', 'TEXT');
ensureColumn('partners', 'referred_by_owner_id', 'INTEGER REFERENCES salon_owners(id)');
ensureColumn('manager_points', 'referred_owner_id', 'INTEGER REFERENCES salon_owners(id)');
ensureColumn('manager_points', 'referred_owner_amount', 'INTEGER');
// Присваиваем код уже существующим владельцам, у которых его ещё нет —
// иначе после обновления системы у них не будет что показать в кабинете.
(function assignOwnerCodesToExisting() {
  const withoutCode = db.prepare('SELECT id FROM salon_owners WHERE owner_code IS NULL ORDER BY id').all();
  for (const row of withoutCode) {
    const code = 'OWN-' + String(row.id).padStart(3, '0');
    db.prepare('UPDATE salon_owners SET owner_code = ? WHERE id = ?').run(code, row.id);
  }
})();

// warehouse_stock раньше был один общий склад на всю систему (первичный
// ключ — только variant_id). SQLite не даёт поменять первичный ключ через
// ALTER TABLE, поэтому пересоздаём таблицу целиком: составной ключ
// (city_id, variant_id) — теперь у каждого города свой отдельный остаток
// по каждой позиции, а не общий на всех.
(function migrateWarehouseStockToCities() {
  const cols = db.prepare("PRAGMA table_info(warehouse_stock)").all();
  const alreadyMigrated = cols.some((c) => c.name === 'city_id');
  if (alreadyMigrated) return;

  db.exec(`
    ALTER TABLE warehouse_stock RENAME TO warehouse_stock_old;
    CREATE TABLE warehouse_stock (
      city_id     TEXT NOT NULL REFERENCES cities(id),
      variant_id  INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
      qty         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (city_id, variant_id)
    );
    INSERT INTO warehouse_stock (city_id, variant_id, qty)
      SELECT 'krsk', variant_id, qty FROM warehouse_stock_old;
    DROP TABLE warehouse_stock_old;
  `);
  console.log('Миграция: warehouse_stock переведён на раздельные склады по городам (существующие остатки отнесены к Красноярску).');
})();

module.exports = db;
module.exports.DB_PATH = DB_PATH;
