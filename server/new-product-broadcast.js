// Moderated photo announcements for new HvostMarket products.
// Telegram commands are limited to personally linked, active super-admins.
// A confirmed campaign has durable per-recipient delivery records.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const db = require('./db');
const { preference } = require('./notification-preferences');

const SHOP_URL = 'https://хвостмаркет.рф/';
const PHOTO_LIMIT = 10 * 1024 * 1024;
const PAGE_SIZE = 6;
const AUDIENCES = Object.freeze({
  club: 'Клуб партнёров (группа)',
  partners: 'Грумеры, владельцы и менеджеры (подписчики)',
  customers: 'Покупатели с согласием на предложения',
  all: 'Все подписчики и Клуб партнёров',
});
const STAFF = Object.freeze([
  { role: 'partner', table: 'partners', key: 'new_products' },
  { role: 'owner', table: 'salon_owners', key: 'new_products' },
  { role: 'manager', table: 'managers', key: 'new_products' },
]);

db.exec(
  "CREATE TABLE IF NOT EXISTS new_product_bot_drafts (" +
  "chat_id TEXT PRIMARY KEY,product_id INTEGER,audience TEXT,photo_ref TEXT," +
  "custom_text TEXT,step TEXT NOT NULL DEFAULT 'choose'," +
  "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
  "CREATE TABLE IF NOT EXISTS new_product_campaigns (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT,admin_chat_id TEXT NOT NULL," +
  "product_id INTEGER NOT NULL,product_name TEXT NOT NULL,audience TEXT NOT NULL," +
  "photo_ref TEXT NOT NULL,caption_html TEXT NOT NULL," +
  "state TEXT NOT NULL DEFAULT 'queued'," +
  "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
  "finished_at TEXT);" +
  "CREATE TABLE IF NOT EXISTS new_product_deliveries (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id INTEGER NOT NULL " +
  "REFERENCES new_product_campaigns(id),chat_id TEXT NOT NULL," +
  "consents_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending'," +
  "attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0," +
  "error TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
  "UNIQUE(campaign_id,chat_id));" +
  "CREATE INDEX IF NOT EXISTS idx_new_product_delivery_queue " +
  "ON new_product_deliveries(status,next_attempt_at,campaign_id);"
);

function html(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function label(value, max = 60) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}
function money(value) { return new Intl.NumberFormat('ru-RU').format(Number(value) || 0); }
function isBroadcaster(chatId) {
  if (!/^\d{1,20}$/.test(String(chatId || ''))) return false;
  return !!db.prepare(
    "SELECT 1 FROM admins WHERE role='super' AND active=1 AND telegram_chat_id=? LIMIT 1"
  ).get(String(chatId));
}
function productById(id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
  return db.prepare(
    "SELECT p.id,p.slug,p.name,p.img,p.desc,MIN(v.price) AS price " +
    "FROM products p JOIN product_variants v ON v.product_id=p.id " +
    "AND v.active=1 AND v.price>0 " +
    "WHERE p.id=? AND p.active=1 AND p.archived_at IS NULL GROUP BY p.id"
  ).get(Number(id)) || null;
}
function currentDraft(chatId) {
  const id = String(chatId);
  const draft = db.prepare(
    "SELECT * FROM new_product_bot_drafts WHERE chat_id=? " +
    "AND updated_at >= datetime('now','-45 minutes')"
  ).get(id);
  if (!draft) db.prepare('DELETE FROM new_product_bot_drafts WHERE chat_id=?').run(id);
  return draft || null;
}
function patchDraft(chatId, patch) {
  const fields = Object.keys(patch);
  const allowed = new Set(['product_id', 'audience', 'photo_ref', 'custom_text', 'step']);
  if (!fields.length || fields.some(field => !allowed.has(field))) throw Error('Invalid draft patch');
  db.prepare('UPDATE new_product_bot_drafts SET ' +
    fields.map(field => field + '=?').join(',') + ',updated_at=CURRENT_TIMESTAMP WHERE chat_id=?')
    .run(...fields.map(field => patch[field]), String(chatId));
}
function reply(message, markup, preview) {
  return { ok: true, message, ...(markup ? { reply_markup: markup } : {}),
    ...(preview ? { preview } : {}) };
}
function button(text, data) { return { text, callback_data: data }; }
function productsPage(chatId, page = 0) {
  const n = Number.isSafeInteger(Number(page)) ? Math.max(0, Math.min(1000, Number(page))) : 0;
  const rows = db.prepare(
    "SELECT p.id,p.name,p.img,MIN(v.price) AS price FROM products p " +
    "JOIN product_variants v ON v.product_id=p.id AND v.active=1 AND v.price>0 " +
    "WHERE p.active=1 AND p.archived_at IS NULL GROUP BY p.id " +
    "ORDER BY p.id DESC LIMIT ? OFFSET ?"
  ).all(PAGE_SIZE + 1, n * PAGE_SIZE);
  if (!rows.length && n > 0) return productsPage(chatId, 0);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const keys = visible.map(p => [button(
    (p.img ? '📷 ' : '📎 ') + label(p.name, 39) + ' · ' + money(p.price) + ' ₽',
    'newprod:pick:' + p.id,
  )]);
  const navigation = [];
  if (n > 0) navigation.push(button('◀️ Назад', 'newprod:page:' + (n - 1)));
  if (hasMore) navigation.push(button('Далее ▶️', 'newprod:page:' + (n + 1)));
  if (navigation.length) keys.push(navigation);
  keys.push([button('❌ Отмена', 'newprod:cancel')]);
  return reply(visible.length
    ? '🦴 Выберите новый товар для рассылки.\n📷 — фото уже есть в карточке; 📎 — фото нужно прислать боту.'
    : 'Активных товаров с ценой нет. Сначала добавьте товар в каталог.',
    { inline_keyboard: keys });
}
function startBroadcast(chatId) {
  if (!isBroadcaster(chatId)) return { ok: false, message: '🔒 Рассылка доступна только супер-администратору с подключённым личным Telegram.' };
  db.prepare(
    "INSERT INTO new_product_bot_drafts(chat_id,step,updated_at) VALUES(?,'choose',CURRENT_TIMESTAMP) " +
    "ON CONFLICT(chat_id) DO UPDATE SET product_id=NULL,audience=NULL," +
    "photo_ref=NULL,custom_text=NULL,step='choose',updated_at=CURRENT_TIMESTAMP"
  ).run(String(chatId));
  return productsPage(chatId, 0);
}
function clubChatId() {
  const settings = require('./routes-partner-club').settings();
  const chatId = String(settings.chat_id || '');
  return /^-100\d{6,18}$/.test(chatId) ? chatId : null;
}
function recipientSnapshot(audience) {
  if (!Object.hasOwn(AUDIENCES, audience)) return [];
  const recipients = new Map();
  const includeClub = audience === 'club' || audience === 'all';
  const includeStaff = audience === 'partners' || audience === 'all';
  const includeCustomers = audience === 'customers' || audience === 'all';
  const insert = (chatId, consent) => {
    const key = String(chatId || '').trim();
    if (!/^\d{1,20}$/.test(key)) return;
    if (!recipients.has(key)) recipients.set(key, { chat_id: key, consents: [] });
    recipients.get(key).consents.push(consent);
  };
  if (includeStaff) {
    for (const item of STAFF) {
      const rows = db.prepare(
        'SELECT a.id,a.telegram_chat_id FROM ' + item.table + ' a ' +
        'JOIN notification_preferences n ON n.recipient_role=? AND n.recipient_id=a.id ' +
        "AND n.notification_key=? AND n.enabled=1 WHERE a.active=1 " +
        "AND TRIM(COALESCE(a.telegram_chat_id,''))<>''"
      ).all(item.role, item.key);
      for (const row of rows) insert(row.telegram_chat_id,
        { role: item.role, id: Number(row.id), key: item.key });
    }
  }
  if (includeCustomers) {
    const rows = db.prepare(
      "SELECT c.id,c.telegram_chat_id FROM customers c JOIN notification_preferences n " +
      "ON n.recipient_role='customer' AND n.recipient_id=c.id " +
      "AND n.notification_key='offers' AND n.enabled=1 " +
      "WHERE TRIM(COALESCE(c.telegram_chat_id,''))<>''"
    ).all();
    for (const row of rows) insert(row.telegram_chat_id,
      { role: 'customer', id: Number(row.id), key: 'offers' });
  }
  if (includeClub) {
    const chatId = clubChatId();
    if (chatId) recipients.set(chatId, { chat_id: chatId, consents: [{ role: 'club' }] });
  }
  return [...recipients.values()];
}
function audienceMenu() {
  const markup = Object.entries(AUDIENCES).map(([key, name]) =>
    [button(name + ' · ' + recipientSnapshot(key).length, 'newprod:aud:' + key)]);
  markup.push([button('⬅️ Выбрать другой товар', 'newprod:page:0')]);
  markup.push([button('❌ Отмена', 'newprod:cancel')]);
  return { inline_keyboard: markup };
}
function productCaption(product, customText) {
  const description = label(customText == null ? product.desc : customText, 540);
  return [
    '🐾 <b>Новинка в ХвостМаркете!</b>',
    '',
    '🦴 <b>' + html(label(product.name, 145)) + '</b>',
    '',
    html(description || 'Знакомьтесь с новым товаром нашего ассортимента.'),
    '',
    '💚 Цена от <b>' + money(product.price) + ' ₽</b>',
    '📍 Наличие зависит от выбранной точки.',
    '',
    '🐾 Откройте каталог и выберите свой минимаркет.',
  ].join('\n');
}
function validPhotoRef(ref) {
  const value = String(ref || '');
  if (value.startsWith('tg:')) return /^[A-Za-z0-9_-]{15,300}$/.test(value.slice(3));
  if (!value.startsWith('catalog:')) return false;
  const img = value.slice(8);
  if (/^https:\/\//i.test(img)) {
    try { return new URL(img).protocol === 'https:' && img.length < 2048; }
    catch (_) { return false; }
  }
  if (!/^\/?images\/[A-Za-z0-9_./-]+$/.test(img) || img.includes('..')) return false;
  const relative = img.replace(/^\/+/, '');
  const base = relative.startsWith('images/uploads/')
    ? path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads')
    : path.join(__dirname, '..', 'public');
  const suffix = relative.startsWith('images/uploads/')
    ? relative.slice('images/uploads/'.length) : relative;
  const target = path.resolve(base, suffix);
  const root = path.resolve(base);
  if (!target.startsWith(root + path.sep)) return false;
  try {
    const stat = fs.statSync(target);
    return stat.isFile() && stat.size > 0 && stat.size <= PHOTO_LIMIT;
  } catch (_) { return false; }
}
function photoFile(ref) {
  const img = String(ref).slice(8).replace(/^\/+/, '');
  const isUpload = img.startsWith('images/uploads/');
  const base = isUpload
    ? path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads')
    : path.join(__dirname, '..', 'public');
  return path.resolve(base, isUpload ? img.slice('images/uploads/'.length) : img);
}
function preview(chatId) {
  const draft = currentDraft(chatId);
  if (!draft || !draft.product_id || !draft.audience) {
    return reply('Сначала выберите товар и адресатов. Начните с /newproduct.');
  }
  const product = productById(draft.product_id);
  if (!product) return reply('Товар больше не доступен в каталоге. Запустите /newproduct заново.');
  const recipients = recipientSnapshot(draft.audience);
  const details = '📨 Аудитория: ' + AUDIENCES[draft.audience] +
    '\nПолучателей: ' + recipients.length +
    '\n\nОтправка начнётся только после двух подтверждений.';
  if (!validPhotoRef(draft.photo_ref)) {
    return reply(details + '\n\n📷 У товара нет доступного фото. Прикрепите его через кнопку ниже.',
      { inline_keyboard: [
        [button('📷 Прикрепить фото', 'newprod:photo')],
        [button('👥 Сменить аудиторию', 'newprod:audience')],
        [button('❌ Отмена', 'newprod:cancel')],
      ] });
  }
  const controls = { inline_keyboard: [
    [button('✅ Подготовить отправку', 'newprod:prepare')],
    [button('✏️ Изменить текст', 'newprod:text'), button('📷 Заменить фото', 'newprod:photo')],
    [button('👥 Сменить аудиторию', 'newprod:audience'), button('❌ Отмена', 'newprod:cancel')],
  ] };
  return reply('🔎 Предпросмотр рассылки\n' + details,
    null, { ref: draft.photo_ref, caption: productCaption(product, draft.custom_text),
      reply_markup: controls });
}
function messageInput(message) {
  if (!message?.chat || message.chat.type !== 'private') return null;
  const chatId = String(message.chat.id);
  const draft = currentDraft(chatId);
  if (!draft || !['edit_text', 'edit_photo'].includes(draft.step)) return null;
  if (!isBroadcaster(chatId)) return { ok: false, message: 'Нет доступа к рассылкам.' };
  if (/^\/cancel(?:@\w+)?$/i.test(String(message.text || '').trim())) {
    return handleCallback(chatId, 'newprod:cancel');
  }
  if (draft.step === 'edit_photo') {
    const photos = message.photo;
    if (Array.isArray(photos) && photos.length && photos[photos.length - 1]?.file_id) {
      const photoRef = 'tg:' + photos[photos.length - 1].file_id;
      if (!validPhotoRef(photoRef)) return reply('Telegram вернул некорректный файл. Пришлите другое фото.');
      patchDraft(chatId, { photo_ref: photoRef, step: 'preview' });
      return preview(chatId);
    }
    if (message.text?.startsWith('/')) return null;
    return reply('📷 Отправьте фотографию именно как фото Telegram (не как документ), или /cancel.');
  }
  if (message.text?.startsWith('/')) return null;
  if (!message.text) return reply('✏️ Пришлите текст описания обычным сообщением (до 540 символов).');
  const entered = message.text.trim();
  if (!entered || entered.length > 540) {
    return reply('✏️ Текст должен содержать от 1 до 540 символов. Попробуйте ещё раз.');
  }
  patchDraft(chatId, { custom_text: entered, step: 'preview' });
  return preview(chatId);
}
function campaignStatus(id, chatId) {
  const row = db.prepare('SELECT id,product_name,audience,state FROM new_product_campaigns WHERE id=? AND admin_chat_id=?')
    .get(Number(id), String(chatId));
  if (!row) return { ok: false, message: 'Рассылка не найдена или недоступна.' };
  const counts = db.prepare(
    'SELECT status,COUNT(*) AS n FROM new_product_deliveries WHERE campaign_id=? GROUP BY status'
  ).all(row.id);
  const by = Object.fromEntries(counts.map(item => [item.status, Number(item.n)]));
  return reply('📊 Рассылка #' + row.id + ' — ' + label(row.product_name) +
    '\nСтатус: ' + ({ queued: 'В очереди', running: 'Отправляется',
      done: 'Завершена', cancelled: 'Остановлена' }[row.state] || row.state) +
    '\n✅ Доставлено: ' + (by.sent || 0) +
    '\n⏳ В очереди: ' + (by.pending || 0) +
    '\n❌ Ошибки: ' + (by.failed || 0) +
    '\n❔ Не подтверждено: ' + (by.uncertain || 0) +
    '\n🚫 Пропущено: ' + (by.skipped || 0),
    { inline_keyboard: row.state === 'queued' || row.state === 'running'
      ? [[button('↻ Обновить статус', 'newprod:status:' + row.id)],
        [button('🛑 Остановить неотправленные', 'newprod:stop:' + row.id)]]
      : [[button('🦴 Новая рассылка', 'newprod:new')]] });
}
function stopCampaign(chatId, id) {
  const row = db.prepare('SELECT state FROM new_product_campaigns WHERE id=? AND admin_chat_id=?')
    .get(Number(id), String(chatId));
  if (!row) return { ok: false, message: 'Рассылка не найдена.' };
  if (!['queued', 'running'].includes(row.state)) return campaignStatus(id, chatId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE new_product_campaigns SET state='cancelled',finished_at=CURRENT_TIMESTAMP WHERE id=? AND admin_chat_id=? AND state IN ('queued','running')")
      .run(Number(id), String(chatId));
    db.prepare("UPDATE new_product_deliveries SET status='skipped',error='stopped by admin',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND status='pending'")
      .run(Number(id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return campaignStatus(id, chatId);
}
function confirmCampaign(chatId) {
  const draft = currentDraft(chatId);
  if (!draft || draft.step !== 'confirm') return { ok: false, message: 'Подтверждение устарело. Снова откройте /newproduct.' };
  const product = productById(draft.product_id);
  if (!product || !Object.hasOwn(AUDIENCES, draft.audience) || !validPhotoRef(draft.photo_ref)) {
    return { ok: false, message: 'Товар или фотография больше не доступны. Начните с /newproduct.' };
  }
  const receivers = recipientSnapshot(draft.audience);
  if (!receivers.length) return { ok: false, message: 'Нет получателей с нужной подпиской. Рассылка не создана.' };
  if (receivers.length > 5000) return { ok: false, message: 'Слишком много получателей для одной рассылки (лимит 5000).' };
  let campaignId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = db.prepare("UPDATE new_product_bot_drafts SET step='claimed' WHERE chat_id=? AND step='confirm'").run(String(chatId));
    if (!locked.changes) { db.exec('ROLLBACK'); return { ok: false, message: 'Рассылка уже подтверждена или черновик изменился.' }; }
    campaignId = Number(db.prepare(
      "INSERT INTO new_product_campaigns(admin_chat_id,product_id,product_name,audience,photo_ref,caption_html) VALUES(?,?,?,?,?,?)"
    ).run(String(chatId), product.id, product.name, draft.audience, draft.photo_ref,
      productCaption(product, draft.custom_text)).lastInsertRowid);
    const insert = db.prepare(
      'INSERT INTO new_product_deliveries(campaign_id,chat_id,consents_json) VALUES(?,?,?)'
    );
    for (const recipient of receivers) insert.run(campaignId, recipient.chat_id, JSON.stringify(recipient.consents));
    db.prepare('DELETE FROM new_product_bot_drafts WHERE chat_id=?').run(String(chatId));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return reply('✅ Рассылка #' + campaignId + ' поставлена в очередь.\n' +
    'Адресатов: ' + receivers.length + '.\n' +
    'Бот отправит фото и сообщение по очереди, сохраняя результат каждой доставки.\n' +
    'После завершения пришлёт итог.',
    { inline_keyboard: [
      [button('📊 Статус', 'newprod:status:' + campaignId)],
      [button('🛑 Остановить неотправленные', 'newprod:stop:' + campaignId)],
    ] });
}
function handleCallback(chatId, data) {
  if (!isBroadcaster(chatId)) return { ok: false, message: '🔒 Недостаточно прав. Нужна личная привязка супер-администратора.' };
  const action = String(data || '');
  if (action === 'newprod:new') return startBroadcast(chatId);
  const status = action.match(/^newprod:(status|stop):(\d+)$/);
  if (status) return status[1] === 'status'
    ? campaignStatus(status[2], chatId) : stopCampaign(chatId, status[2]);
  if (action === 'newprod:cancel') {
    const changed = db.prepare('DELETE FROM new_product_bot_drafts WHERE chat_id=?').run(String(chatId)).changes;
    return reply(changed ? '🚫 Черновик удалён. Ничего не отправлено.' : 'Нет активного черновика.');
  }
  const draft = currentDraft(chatId);
  if (!draft) return { ok: false, message: 'Черновик устарел. Начните с /newproduct.' };
  const page = action.match(/^newprod:page:(\d{1,4})$/);
  if (page) { patchDraft(chatId, { step: 'choose' }); return productsPage(chatId, Number(page[1])); }
  const pick = action.match(/^newprod:pick:(\d{1,10})$/);
  if (pick) {
    const product = productById(Number(pick[1]));
    if (!product) return { ok: false, message: 'Товар недоступен. Выберите другой.' };
    patchDraft(chatId, { product_id: product.id, audience: null,
      photo_ref: product.img ? 'catalog:' + product.img : null, custom_text: null, step: 'audience' });
    return reply('🦴 ' + product.name + '\n\nВыберите получателей. Личные рекламные сообщения получат только подписавшиеся пользователи.',
      audienceMenu());
  }
  if (action === 'newprod:audience') {
    if (!draft.product_id) return productsPage(chatId, 0);
    patchDraft(chatId, { step: 'audience' });
    return reply('👥 Кому отправить анонс?', audienceMenu());
  }
  const audience = action.match(/^newprod:aud:(club|partners|customers|all)$/);
  if (audience) {
    if (!productById(draft.product_id)) return { ok: false, message: 'Товар больше не доступен.' };
    patchDraft(chatId, { audience: audience[1], step: 'preview' });
    return preview(chatId);
  }
  if (action === 'newprod:preview') {
    patchDraft(chatId, { step: 'preview' });
    return preview(chatId);
  }
  if (action === 'newprod:photo' || action === 'newprod:text') {
    if (!draft.product_id || !draft.audience) return { ok: false, message: 'Сначала выберите товар и получателей.' };
    patchDraft(chatId, { step: action === 'newprod:photo' ? 'edit_photo' : 'edit_text' });
    return reply(action === 'newprod:photo'
      ? '📷 Пришлите новую фотографию обычным фото Telegram (не документом). /cancel — отмена.'
      : '✏️ Пришлите текст описания новинки (до 540 символов). /cancel — отмена.');
  }
  if (action === 'newprod:prepare') {
    if (!draft.product_id || !draft.audience || !validPhotoRef(draft.photo_ref)) {
      return { ok: false, message: 'Сначала выберите товар, адресатов и рабочую фотографию.' };
    }
    const recipients = recipientSnapshot(draft.audience);
    if (!recipients.length) return { ok: false, message: 'В этой аудитории пока нет получателей с подпиской. Ничего не отправлено.' };
    patchDraft(chatId, { step: 'confirm' });
    return reply('⚠️ Подтвердите массовую отправку.\n\nТовар: ' +
      productById(draft.product_id).name + '\nАудитория: ' + AUDIENCES[draft.audience] +
      '\nПолучателей: ' + recipients.length +
      '\n\nПосле подтверждения сообщения начнут отправляться.',
      { inline_keyboard: [
        [button('✅ Да, начать рассылку', 'newprod:confirm')],
        [button('⬅️ Вернуться к предпросмотру', 'newprod:preview')],
        [button('❌ Отменить', 'newprod:cancel')],
      ] });
  }
  if (action === 'newprod:confirm') return confirmCampaign(chatId);
  return { ok: false, message: 'Неизвестное действие.' };
}
function cancelDraft(chatId) {
  if (!isBroadcaster(chatId)) return false;
  return db.prepare('DELETE FROM new_product_bot_drafts WHERE chat_id=?')
    .run(String(chatId)).changes > 0;
}
async function sendProductPhoto(chatId, ref, caption, replyMarkup) {
  const token = process.env.TG_TOKEN;
  if (!token) return { ok: false, error: 'TG_TOKEN не настроен' };
  if (!validPhotoRef(ref)) return { ok: false, error: 'Фото недоступно или удалено из каталога' };
  const data = { chat_id: String(chatId), caption, parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  let tempFolder;
  try {
    let body, headers;
    if (ref.startsWith('tg:') || /^catalog:https:\/\//i.test(ref)) {
      data.photo = ref.startsWith('tg:') ? ref.slice(3) : ref.slice(8);
      body = JSON.stringify(data);
      headers = { 'Content-Type': 'application/json' };
    } else {
      let file = photoFile(ref);
      if (/\.webp$/i.test(file)) {
        // Product uploads are WebP. Telegram sendPhoto is safest with JPEG.
        tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-product-photo-'));
        const output = path.join(tempFolder, 'photo.jpg');
        try { execFileSync('magick', [file, '-auto-orient', '-strip', '-quality', '87', output]); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          execFileSync('convert', [file, '-auto-orient', '-strip', '-quality', '87', output]);
        }
        file = output;
      }
      const buffer = fs.readFileSync(file);
      if (!buffer.length || buffer.length > PHOTO_LIMIT) throw Error('Изображение слишком большое для Telegram');
      const form = new FormData();
      form.append('chat_id', data.chat_id);
      form.append('caption', data.caption);
      form.append('parse_mode', 'HTML');
      if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
      const ext = path.extname(file).toLowerCase();
      form.append('photo', new Blob([buffer], { type: ext === '.png' ? 'image/png' : 'image/jpeg' }),
        ext === '.png' ? 'photo.png' : 'photo.jpg');
      body = form;
    }
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
      method: 'POST', ...(headers ? { headers } : {}), body,
      signal: AbortSignal.timeout(20000),
    });
    const json = await response.json().catch(() => ({}));
    return { ok: !!response.ok && json.ok === true,
      status: response.status, retry_after: json.parameters?.retry_after,
      error: json.description || (!response.ok ? 'HTTP ' + response.status : undefined) };
  } catch (error) {
    // No automatic retry for uncertain network errors: a photo might have arrived.
    return { ok: false, uncertain: true, error: String(error.message || error) };
  } finally {
    if (tempFolder) try { fs.rmSync(tempFolder, { recursive: true, force: true }); } catch (_) {}
  }
}
function subscribedNow(delivery) {
  const claims = JSON.parse(delivery.consents_json || '[]');
  for (const claim of claims) {
    if (claim.role === 'club') {
      if (clubChatId() === String(delivery.chat_id)) return true;
      continue;
    }
    const table = claim.role === 'customer' ? 'customers'
      : STAFF.find(entry => entry.role === claim.role)?.table;
    if (!table) continue;
    const active = claim.role === 'customer' ? '' : ' AND active=1';
    const row = db.prepare('SELECT 1 FROM ' + table +
      ' WHERE id=? AND telegram_chat_id=?' + active).get(claim.id, String(delivery.chat_id));
    if (row && preference(claim.role, claim.id, claim.key)) return true;
  }
  return false;
}
function statusCounts(campaignId) {
  const rows = db.prepare(
    'SELECT status,COUNT(*) n FROM new_product_deliveries WHERE campaign_id=? GROUP BY status'
  ).all(campaignId);
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}
async function finalizeCompleted(notify) {
  const rows = db.prepare(
    "SELECT c.id,c.admin_chat_id,c.product_name FROM new_product_campaigns c " +
    "WHERE c.state IN ('queued','running') " +
    "AND NOT EXISTS (SELECT 1 FROM new_product_deliveries d WHERE d.campaign_id=c.id " +
    "AND d.status IN ('pending','sending')) ORDER BY c.id LIMIT 10"
  ).all();
  for (const row of rows) {
    const result = db.prepare(
      "UPDATE new_product_campaigns SET state='done',finished_at=CURRENT_TIMESTAMP " +
      "WHERE id=? AND state IN ('queued','running')"
    ).run(row.id);
    if (!result.changes) continue;
    const counts = statusCounts(row.id);
    const summary = '🐾 Рассылка #' + row.id + ' завершена: ' + row.product_name +
      '\n✅ Отправлено: ' + (counts.sent || 0) +
      '\n❌ Ошибки: ' + (counts.failed || 0) +
      '\n❔ Без подтверждения доставки: ' + (counts.uncertain || 0) +
      '\n🚫 Пропущено из-за отмены подписки: ' + (counts.skipped || 0);
    try { await notify(row.admin_chat_id, summary); }
    catch (e) { console.warn('[new-product] Status notification failed:', e.message); }
  }
}
let tickBusy = false;
async function processBroadcastQueue(send = sendProductPhoto, notify = async (chat, message) => {
  await require('./telegram').sendToChat(chat, html(message));
}) {
  if (tickBusy) return false;
  tickBusy = true;
  try {
    const row = db.prepare(
      "SELECT d.*,c.state,c.photo_ref,c.caption_html FROM new_product_deliveries d " +
      "JOIN new_product_campaigns c ON c.id=d.campaign_id " +
      "WHERE d.status='pending' AND d.next_attempt_at<=? " +
      "AND c.state IN ('queued','running') ORDER BY d.id LIMIT 1"
    ).get(Math.floor(Date.now() / 1000));
    if (row) {
      const claimed = db.prepare(
        "UPDATE new_product_deliveries SET status='sending',attempts=attempts+1," +
        "updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'"
      ).run(row.id);
      if (claimed.changes) {
        db.prepare("UPDATE new_product_campaigns SET state='running' WHERE id=? AND state='queued'")
          .run(row.campaign_id);
        const state = db.prepare('SELECT state FROM new_product_campaigns WHERE id=?').get(row.campaign_id);
        if (!state || state.state === 'cancelled' || !subscribedNow(row)) {
          db.prepare("UPDATE new_product_deliveries SET status='skipped',updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(row.id);
        } else {
          let result;
          try { result = await send(row.chat_id, row.photo_ref, row.caption_html,
            { inline_keyboard: [[{ text: '🛍 Перейти в каталог', url: SHOP_URL }]] }); }
          catch (error) { result = { ok: false, uncertain: true, error: error.message }; }
          if (result.ok) {
            db.prepare("UPDATE new_product_deliveries SET status='sent',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
              .run(row.id);
          } else if (result.status === 429 && row.attempts < 3) {
            const delay = Math.max(5, Math.min(300, Number(result.retry_after) || 30));
            db.prepare("UPDATE new_product_deliveries SET status='pending',next_attempt_at=?," +
              "error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
              .run(Math.floor(Date.now()/1000) + delay, 'Telegram ограничил скорость (429)', row.id);
          } else {
            db.prepare("UPDATE new_product_deliveries SET status=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
              .run(result.uncertain ? 'uncertain' : 'failed', label(result.error || 'Telegram не подтвердил отправку', 400), row.id);
          }
        }
      }
    }
    await finalizeCompleted(notify);
    return !!row;
  } finally { tickBusy = false; }
}
let worker = null;
function startBroadcastWorker() {
  if (worker) return;
  // Do not blindly retry interrupted sends: Telegram might have delivered them.
  db.prepare("UPDATE new_product_deliveries SET status='uncertain'," +
    "error='Сервер перезапущен во время отправки',updated_at=CURRENT_TIMESTAMP " +
    "WHERE status='sending'").run();
  worker = setInterval(() => {
    processBroadcastQueue().catch(e => console.warn('[new-product] delivery:', e.message));
  }, 1700);
  worker.unref?.();
  processBroadcastQueue().catch(e => console.warn('[new-product] initial delivery:', e.message));
}
module.exports = {
  AUDIENCES, isBroadcaster, productById, recipientSnapshot,
  productCaption, validPhotoRef, startBroadcast, handleCallback,
  messageInput, cancelDraft, sendProductPhoto, processBroadcastQueue,
  startBroadcastWorker, campaignStatus,
};
