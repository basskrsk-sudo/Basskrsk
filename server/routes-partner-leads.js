// routes-partner-leads.js — учёт прозвона грумерских салонов/ветклиник для
// привлечения новых партнёров: карточка заведения со статусом переговоров
// + история звонков и договорённостей (partner_lead_notes).
// Доступно администраторам и менеджерам (именно они звонят по скрипту
// «Первый звонок владельцу грумер-салона»).
'use strict';

const db = require('./db');
const referralProgram = require('./referral-program');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');

const STATUSES = ['to_call', 'no_answer', 'meeting_scheduled', 'meeting_held', 'signed', 'declined'];
const CATEGORIES = ['groomer', 'vet', 'training_center', 'kennel', 'hotel', 'other'];
const CATEGORY_LABEL = {
  groomer: 'Груминг-салон',
  vet: 'Ветклиника',
  training_center: 'Кинологический центр / центр дрессировки',
  kennel: 'Кинолог / питомник',
  hotel: 'Зоогостиница',
  other: 'Другое',
};

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


/* The admin and manager cabinets share these same rows. Manager access is
 * scoped on every API request, not only in the browser's table filters. */
function activeManager(payload, res) {
  if (payload.role !== 'manager') return null;
  const manager = db.prepare('SELECT id, city_id FROM managers WHERE id = ? AND active = 1').get(payload.id);
  if (!manager) sendJson(res, 401, { error: 'Менеджер отключён или не найден' });
  return manager;
}
function canReadLead(payload, manager, lead) {
  return payload.role === 'admin' ||
    (Number(lead.assigned_manager_id) === Number(payload.id) && lead.assigned_manager_id != null) ||
    (lead.assigned_manager_id == null && manager && manager.city_id != null &&
      String(lead.city_id) === String(manager.city_id));
}
function canEditLead(payload, lead) {
  return payload.role === 'admin' ||
    (lead.assigned_manager_id != null && Number(lead.assigned_manager_id) === Number(payload.id));
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
    const referralCode=String(b.referral_code || '').trim().toUpperCase();
    const referrer=referralCode ? referralProgram.referralFromCode(referralCode) : null;
    if (referralCode && !referrer) return sendJson(res,400,{error:'Реферальная ссылка больше не действует'});
    try { referralProgram.assertReferralRules(referrer,null,phone); } catch(e) {
      return sendJson(res,e.statusCode||409,{error:e.message});
    }
    if (referrer && db.prepare(
      "SELECT id FROM partner_leads WHERE referral_code=? AND phone=? AND linked_point_id IS NULL AND status<>'declined'"
    ).get(referrer.code,phone)) return sendJson(res,409,{error:'Такая реферальная заявка уже получена'});
    const info = db.prepare(`
      INSERT INTO partner_leads (salon_name, category, city_id, contact_name, phone, status,referral_code,referred_by_role,referred_by_id)
      VALUES (?, ?, ?, ?, ?, 'to_call', ?, ?, ?)
    `).run(salonName, category, b.city_id || null, (b.contact_name || '').trim() || null, phone,
      referrer?referrer.code:null, referrer?referrer.role:null, referrer?referrer.recipient_id:null);
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
      (referrer ? '\n🤝 <b>Реферальный пригласивший:</b> '+escapeHtml(referrer.full_name)+' ('+escapeHtml(referrer.code)+') · 1 000 ₽ при запуске новой точки' : '') +
      (b.message ? '\n<b>Сообщение:</b> ' + escapeHtml(b.message.trim()) : '')
    );
    sendJson(res, 201, { ok: true });
  });

  // Minimal selectable referrals for creating new points. No phone numbers.
  router.get('/api/partner-leads/referral-options', (req,res,ctx) => {
    const payload=requireAuth(['admin','manager'])(req,res,ctx);
    if (!payload) return;
    if (payload.role==='manager') {
      const manager=db.prepare('SELECT city_id FROM managers WHERE id=? AND active=1').get(payload.id);
      if (!manager) return sendJson(res,401,{error:'Менеджер отключён'});
      return sendJson(res,200,{leads:referralProgram.referralLeadOptions(manager.city_id,payload.id)});
    }
    const active=db.prepare('SELECT 1 FROM admins WHERE id=? AND active=1').get(payload.id);
    if (!active) return sendJson(res,401,{error:'Администратор отключён'});
    return sendJson(res,200,{leads:referralProgram.referralLeadOptions(null,null)});
  });
  // GET /api/partner-leads/network-map — compact, read-only markers for
  // both cabinets and their Mini Apps. Managers see only their operational
  // points and the same scoped lead list they can access in the CRM.
  router.get('/api/partner-leads/network-map', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'admin' &&
        !db.prepare('SELECT 1 FROM admins WHERE id=? AND active=1').get(payload.id)) {
      return sendJson(res, 401, { error: 'Администратор отключён' });
    }
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;

    const pointSql = [
      'SELECT p.id, p.name, p.addr AS address, p.city_id,',
      'c.name AS city_name, p.lat, p.lng',
      'FROM points p LEFT JOIN cities c ON c.id=p.city_id',
      'WHERE p.active=1 AND COALESCE(p.is_hub,0)=0',
      manager ? 'AND p.manager_id=?' : '',
      'ORDER BY p.name COLLATE NOCASE'
    ].join(' ');
    const points = db.prepare(pointSql).all(...(manager ? [payload.id] : []))
      .map(p => ({
        type: 'point', id: p.id, name: p.name, address: p.address,
        city_id: p.city_id, city_name: p.city_name, lat: p.lat, lng: p.lng,
        status: 'active'
      }));
    const activeIds = new Set(points.map(point => String(point.id)));
    const venueKey = (name, address) => String(name || '').trim().toLowerCase() + '|' +
      String(address || '').trim().toLowerCase();
    const activeNamesAndAddresses = new Set(points.map(p => venueKey(p.name, p.address)));

    const leadsSql = [
      'SELECT l.id, l.salon_name AS name, l.address, l.phone,',
      'l.status, l.category, l.city_id, c.name AS city_name,',
      'l.next_contact_date, l.assigned_manager_id, l.linked_point_id',
      'FROM partner_leads l LEFT JOIN cities c ON c.id=l.city_id',
      manager
        ? 'WHERE (l.assigned_manager_id=? OR (l.assigned_manager_id IS NULL AND l.city_id=?))'
        : '',
      'ORDER BY l.id DESC'
    ].join(' ');
    const args = manager ? [payload.id, manager.city_id] : [];
    const leads = db.prepare(leadsSql).all(...args)
      // When a CRM card is attached to an operating point, show only green
      // operational marker instead of two contradictory markers at one address.
      .filter(lead => (!lead.linked_point_id || !activeIds.has(String(lead.linked_point_id))) &&
        !activeNamesAndAddresses.has(venueKey(lead.name, lead.address)))
      .map(lead => ({
        type: 'lead', id: lead.id, name: lead.name,
        address: lead.address, phone: lead.phone, status: lead.status,
        category: lead.category, city_id: lead.city_id,
        city_name: lead.city_name, next_contact_date: lead.next_contact_date,
        // Leads have no persistent coordinates; geocode the public address
        // on demand in the Yandex Maps JS client, never write it to CRM here.
        lat: null, lng: null
      }));
    sendJson(res, 200, {
      points, leads, default_city_id: manager ? manager.city_id : 'krsk'
    });
  });

  // GET /api/partner-leads?status=&city_id=&q= — список лидов, новые сверху
  router.get('/api/partner-leads', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const { status, city_id, q } = ctx.query || {};
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    let sql = 'SELECT * FROM partner_leads WHERE 1=1';
    const args = [];
    // Assigned leads from any city + unassigned leads in the manager's own city.
    if (manager) {
      sql += ' AND (assigned_manager_id = ? OR (assigned_manager_id IS NULL AND city_id = ?))';
      args.push(payload.id, manager.city_id == null ? '__no_manager_city__' : manager.city_id);
    }
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
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (!canReadLead(payload, manager, row)) return sendJson(res, 403, { error: 'Нет доступа к заведению' });
    const notes = db.prepare('SELECT * FROM partner_lead_notes WHERE lead_id = ? ORDER BY id DESC').all(ctx.params.id);
    sendJson(res, 200, { lead: serializeLead(row), notes });
  });

  // POST /api/partner-leads — добавить новое заведение в список на прозвон
  router.post('/api/partner-leads', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const b = ctx.body || {};
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (manager && manager.city_id == null) {
      return sendJson(res, 400, { error: 'У менеджера не указан город. Обратитесь к администратору.' });
    }
    if (!b.salon_name || !String(b.salon_name).trim()) {
      return sendJson(res, 400, { error: 'Укажите название заведения' });
    }
    const category = CATEGORIES.includes(b.category) ? b.category : null;
    const status = STATUSES.includes(b.status) ? b.status : 'to_call';
    const info = db.prepare(`
      INSERT INTO partner_leads
        (salon_name, category, city_id, address, contact_name, phone, status, next_contact_date, assigned_manager_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(b.salon_name).trim(),
      category,
      manager ? manager.city_id : (b.city_id || null),
      b.address || null,
      b.contact_name || null,
      b.phone || null,
      status,
      b.next_contact_date || null,
      manager ? payload.id : (b.assigned_manager_id || null),
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
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (!canEditLead(payload, existing)) return sendJson(res, 403, { error: 'Редактировать можно только свои заведения' });
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
      b.salon_name !== undefined ? String(b.salon_name).trim() : existing.salon_name,
      b.category !== undefined ? b.category : existing.category,
      manager ? existing.city_id : (b.city_id !== undefined ? b.city_id : existing.city_id),
      b.address !== undefined ? b.address : existing.address,
      b.contact_name !== undefined ? b.contact_name : existing.contact_name,
      b.phone !== undefined ? b.phone : existing.phone,
      b.status !== undefined ? b.status : existing.status,
      b.next_contact_date !== undefined ? b.next_contact_date : existing.next_contact_date,
      manager ? payload.id : (b.assigned_manager_id !== undefined ? b.assigned_manager_id : existing.assigned_manager_id),
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


  // POST /api/partner-leads/:id/claim - manager accepts a free lead in their city.
  router.post('/api/partner-leads/:id/claim', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const manager = activeManager(payload, res);
    if (!manager) return;
    if (manager.city_id == null) return sendJson(res, 400, { error: 'Укажите город менеджера в админке' });
    const lead = db.prepare('SELECT * FROM partner_leads WHERE id = ?').get(ctx.params.id);
    if (!lead) return sendJson(res, 404, { error: 'Лид не найден' });
    if (!canReadLead(payload, manager, lead)) return sendJson(res, 403, { error: 'Нет доступа к заведению' });
    if (Number(lead.assigned_manager_id) === Number(payload.id) && lead.assigned_manager_id != null) {
      return sendJson(res, 200, { ok: true, already_assigned: true });
    }
    const updated = db.prepare(
      "UPDATE partner_leads SET assigned_manager_id = ?, updated_at = datetime('now') " +
      "WHERE id = ? AND assigned_manager_id IS NULL AND city_id = ?"
    ).run(payload.id, ctx.params.id, manager.city_id);
    if (!updated.changes) return sendJson(res, 409, { error: 'Заведение уже закреплено за другим менеджером' });
    db.prepare('INSERT INTO partner_lead_notes (lead_id, author, note) VALUES (?, ?, ?)')
      .run(ctx.params.id, authorLabel(payload), 'Взял заведение в работу');
    sendJson(res, 200, { ok: true });
  });

  // POST /api/partner-leads/:id/call — one-tap mobile call log.
  // Status, next contact and audit note are committed atomically so the
  // Telegram Mini App and desktop/admin CRM never disagree after a save.
  router.post('/api/partner-leads/:id/call', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'admin' &&
        !db.prepare('SELECT id FROM admins WHERE id=? AND active=1').get(payload.id)) {
      return sendJson(res, 401, { error: 'Администратор отключён' });
    }
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    const existing = db.prepare('SELECT * FROM partner_leads WHERE id=?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Заведение не найдено' });
    if (!canEditLead(payload, existing)) {
      return sendJson(res, 403, { error: 'Фиксировать звонки можно только по своим заведениям' });
    }

    const b = ctx.body || {};
    if (typeof b.status !== 'string' || !STATUSES.includes(b.status)) {
      return sendJson(res, 400, { error: 'Выберите результат звонка' });
    }
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
      return sendJson(res, 400, { error: 'Некорректный комментарий' });
    }
    const note = String(b.note || '').trim();
    if (note.length > 2000) {
      return sendJson(res, 400, { error: 'Комментарий не должен превышать 2000 символов' });
    }
    const dateRaw = b.next_contact_date;
    let nextDate = existing.next_contact_date;
    if (dateRaw !== undefined) {
      if (dateRaw !== null && typeof dateRaw !== 'string') {
        return sendJson(res, 400, { error: 'Некорректная дата следующего звонка' });
      }
      nextDate = dateRaw ? dateRaw.trim() : null;
      if (nextDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) ||
            !Number.isFinite(Date.parse(nextDate+'T00:00:00Z')) ||
            new Date(nextDate+'T00:00:00Z').toISOString().slice(0,10) !== nextDate) {
          return sendJson(res, 400, { error: 'Дата следующего звонка должна быть в формате ГГГГ-ММ-ДД' });
        }
      }
    }
    const labels = {
      to_call: 'Нужно позвонить', no_answer: 'Не дозвонились',
      meeting_scheduled: 'Встреча назначена', meeting_held: 'Встреча прошла',
      signed: 'Партнёр подключён', declined: 'Отказ',
    };
    const detail = 'Звонок: ' + labels[b.status] +
      (nextDate ? '. Следующий контакт: ' + nextDate : '') +
      (note ? '. ' + note : '');

    db.exec('SAVEPOINT partner_lead_quick_call');
    try {
      db.prepare("UPDATE partner_leads SET status=?,next_contact_date=?,updated_at=datetime('now') WHERE id=?")
        .run(b.status, nextDate, existing.id);
      db.prepare('INSERT INTO partner_lead_notes (lead_id,author,note) VALUES(?,?,?)')
        .run(existing.id, authorLabel(payload), detail);
      db.exec('RELEASE SAVEPOINT partner_lead_quick_call');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT partner_lead_quick_call');
      db.exec('RELEASE SAVEPOINT partner_lead_quick_call');
      throw error;
    }
    sendJson(res, 201, { ok: true, id: existing.id, status: b.status, next_contact_date: nextDate });
  });

  // POST /api/partner-leads/:id/notes — добавить запись в историю звонков
  router.post('/api/partner-leads/:id/notes', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM partner_leads WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Лид не найден' });
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (!canEditLead(payload, existing)) return sendJson(res, 403, { error: 'Записи доступны только для своих заведений' });
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
