// routes-partner-leads.js — учёт прозвона грумерских салонов/ветклиник для
// привлечения новых партнёров: карточка заведения со статусом переговоров
// + история звонков и договорённостей (partner_lead_notes).
// Доступно администраторам и менеджерам (именно они звонят по скрипту
// «Первый звонок владельцу грумер-салона»).
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');

const STATUSES = ['to_call', 'no_answer', 'meeting_scheduled', 'meeting_held', 'signed', 'declined'];
const CATEGORIES = ['groomer', 'vet', 'kennel', 'hotel', 'other'];
const CATEGORY_LABEL = { groomer: 'Груминг-салон', vet: 'Ветклиника', kennel: 'Кинолог', hotel: 'Зоогостиница', other: 'Другое' };

// Публичная форма «Стать партнёром» на главной — без авторизации, поэтому
// защищаем тем же простым способом, что и routes-public-messages.js: не
// более нескольких заявок в минуту с одного IP.
const publicAttempts = new Map();
const PUBLIC_WINDOW_MS = 60 * 1000;
const PUBLIC_MAX_PER_WINDOW = 5;
function isPublicRateLimited(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (publicAttempts.get(key) || []).filter((t) => now - t < PUBLIC_WINDOW_MS);
  recent.push(now);
  publicAttempts.set(key, recent);
  return recent.length > PUBLIC_MAX_PER_WINDOW;
}
function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Имя автора записи в истории — для менеджера подтягиваем ФИО из его
// профиля, чтобы в истории было видно, кто именно договаривался, а не
// просто «менеджер».
function authorLabel(payload) {
  if (payload.role === 'manager') {
    const m = db.prepare('SELECT full_name FROM managers WHERE id = ?').get(payload.id);
    return (m && m.full_name) || 'Менеджер';
  }
  return 'Администратор';
}

function serializeLead(row) {
  const notesCount = db.prepare('SELECT COUNT(*) AS c FROM partner_lead_notes WHERE lead_id = ?').get(row.id).c;
  const lastNote = db.prepare('SELECT note, author, created_at FROM partner_lead_notes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
  const manager = row.assigned_manager_id
    ? db.prepare('SELECT full_name FROM managers WHERE id = ?').get(row.assigned_manager_id)
    : null;
  return {
    ...row,
    assigned_manager_name: manager ? manager.full_name : null,
    notes_count: notesCount,
    last_note: lastNote || null,
  };
}

function registerPartnerLeadRoutes(router) {
  // POST /api/partner-leads/public — заявка «Стать партнёром» с главной
  // страницы сайта. Без авторизации: попадает в общий список прозвона со
  // статусом «Нужно позвонить», плюс мгновенное уведомление в Telegram, чтобы
  // менеджер перезвонил, пока лид «тёплый».
  router.post('/api/partner-leads/public', async (req, res, ctx) => {
    if (isPublicRateLimited(req)) {
      return sendJson(res, 429, { error: 'Слишком много заявок подряд. Попробуйте через минуту.' });
    }
    const b = ctx.body || {};
    const salonName = String(b.salon_name || '').trim();
    const phone = String(b.phone || '').trim();
    if (!salonName || !phone) {
      return sendJson(res, 400, { error: 'Укажите название заведения и телефон' });
    }
    const category = CATEGORIES.includes(b.category) ? b.category : null;
    const info = db.prepare(`
      INSERT INTO partner_leads (salon_name, category, city_id, contact_name, phone, status)
      VALUES (?, ?, ?, ?, ?, 'to_call')
    `).run(salonName, category, b.city_id || null, (b.contact_name || '').trim() || null, phone);
    db.prepare('INSERT INTO partner_lead_notes (lead_id, author, note) VALUES (?, ?, ?)')
      .run(info.lastInsertRowid, 'Сайт', 'Заявка с формы «Стать партнёром» на главной странице' + (b.message ? ': ' + b.message.trim() : ''));

    const cityRow = b.city_id ? db.prepare('SELECT name FROM cities WHERE id = ?').get(b.city_id) : null;
    await sendTelegram(
      '🤝 <b>Новая заявка «Стать партнёром»</b>\n\n' +
      '<b>Заведение:</b> ' + escapeHtml(salonName) + '\n' +
      (category ? '<b>Категория:</b> ' + escapeHtml(CATEGORY_LABEL[category]) + '\n' : '') +
      (cityRow ? '<b>Город:</b> ' + escapeHtml(cityRow.name) + '\n' : '') +
      (b.contact_name ? '<b>Контакт:</b> ' + escapeHtml(b.contact_name.trim()) + '\n' : '') +
      '<b>Телефон:</b> ' + escapeHtml(phone) +
      (b.message ? '\n<b>Сообщение:</b> ' + escapeHtml(b.message.trim()) : '')
    );
    sendJson(res, 201, { ok: true });
  });

  // GET /api/partner-leads?status=&city_id=&q= — список лидов, новые сверху
  router.get('/api/partner-leads', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const { status, city_id, q } = ctx.query || {};
    let sql = 'SELECT * FROM partner_leads WHERE 1=1';
    const args = [];
    if (status && STATUSES.includes(status)) { sql += ' AND status = ?'; args.push(status); }
    if (city_id) { sql += ' AND city_id = ?'; args.push(city_id); }
    if (q && q.trim()) {
      sql += ' AND (salon_name LIKE ? OR contact_name LIKE ? OR phone LIKE ?)';
      const like = '%' + q.trim() + '%';
      args.push(like, like, like);
    }
    sql += ' ORDER BY CASE WHEN next_contact_date IS NULL THEN 1 ELSE 0 END, next_contact_date ASC, id DESC';
    const rows = db.prepare(sql).all(...args);
    sendJson(res, 200, { leads: rows.map(serializeLead) });
  });

  // GET /api/partner-leads/:id — карточка + полная история звонков
  router.get('/api/partner-leads/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const row = db.prepare('SELECT * FROM partner_leads WHERE id = ?').get(ctx.params.id);
    if (!row) return sendJson(res, 404, { error: 'Лид не найден' });
    const notes = db.prepare('SELECT * FROM partner_lead_notes WHERE lead_id = ? ORDER BY id DESC').all(ctx.params.id);
    sendJson(res, 200, { lead: serializeLead(row), notes });
  });

  // POST /api/partner-leads — добавить новое заведение в список на прозвон
  router.post('/api/partner-leads', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const b = ctx.body || {};
    if (!b.salon_name || !b.salon_name.trim()) {
      return sendJson(res, 400, { error: 'Укажите название заведения' });
    }
    const category = CATEGORIES.includes(b.category) ? b.category : null;
    const status = STATUSES.includes(b.status) ? b.status : 'to_call';
    const info = db.prepare(`
      INSERT INTO partner_leads
        (salon_name, category, city_id, address, contact_name, phone, status, next_contact_date, assigned_manager_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.salon_name.trim(),
      category,
      b.city_id || null,
      b.address || null,
      b.contact_name || null,
      b.phone || null,
      status,
      b.next_contact_date || null,
      b.assigned_manager_id || null,
    );
    // Первая заметка — необязательная, но удобно сразу зафиксировать, откуда лид
    if (b.note && b.note.trim()) {
      db.prepare('INSERT INTO partner_lead_notes (lead_id, author, note) VALUES (?, ?, ?)')
        .run(info.lastInsertRowid, authorLabel(payload), b.note.trim());
    }
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // PUT /api/partner-leads/:id — изменить статус/данные заведения
  router.put('/api/partner-leads/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM partner_leads WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Лид не найден' });
    const b = ctx.body || {};
    if (b.status !== undefined && !STATUSES.includes(b.status)) {
      return sendJson(res, 400, { error: 'Недопустимый статус' });
    }
    if (b.category !== undefined && b.category !== null && !CATEGORIES.includes(b.category)) {
      return sendJson(res, 400, { error: 'Недопустимая категория' });
    }
    db.prepare(`
      UPDATE partner_leads SET
        salon_name = ?, category = ?, city_id = ?, address = ?, contact_name = ?,
        phone = ?, status = ?, next_contact_date = ?, assigned_manager_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.salon_name !== undefined ? b.salon_name.trim() : existing.salon_name,
      b.category !== undefined ? b.category : existing.category,
      b.city_id !== undefined ? b.city_id : existing.city_id,
      b.address !== undefined ? b.address : existing.address,
      b.contact_name !== undefined ? b.contact_name : existing.contact_name,
      b.phone !== undefined ? b.phone : existing.phone,
      b.status !== undefined ? b.status : existing.status,
      b.next_contact_date !== undefined ? b.next_contact_date : existing.next_contact_date,
      b.assigned_manager_id !== undefined ? b.assigned_manager_id : existing.assigned_manager_id,
      ctx.params.id,
    );
    // Смена статуса — сама по себе значимое событие, фиксируем в истории
    if (b.status !== undefined && b.status !== existing.status) {
      const STATUS_LABEL = {
        to_call: 'Нужно позвонить', no_answer: 'Не дозвонились',
        meeting_scheduled: 'Встреча назначена', meeting_held: 'Встреча прошла',
        signed: 'Партнёр подключён', declined: 'Отказ',
      };
      db.prepare('INSERT INTO partner_lead_notes (lead_id, author, note) VALUES (?, ?, ?)')
        .run(ctx.params.id, authorLabel(payload), `Статус изменён на «${STATUS_LABEL[b.status] || b.status}»`);
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/partner-leads/:id/notes — добавить запись в историю звонков
  router.post('/api/partner-leads/:id/notes', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT id FROM partner_leads WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Лид не найден' });
    const note = (ctx.body && ctx.body.note || '').trim();
    if (!note) return sendJson(res, 400, { error: 'Пустая запись' });
    const info = db.prepare('INSERT INTO partner_lead_notes (lead_id, author, note) VALUES (?, ?, ?)')
      .run(ctx.params.id, authorLabel(payload), note);
    db.prepare("UPDATE partner_leads SET updated_at = datetime('now') WHERE id = ?").run(ctx.params.id);
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // DELETE /api/partner-leads/:id — убрать заведение из списка (например, задвоение)
  router.delete('/api/partner-leads/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM partner_leads WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPartnerLeadRoutes };
