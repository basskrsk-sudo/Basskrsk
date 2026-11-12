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
const { geocodeAddress } = require('./geocoding');
const mapCandidates = require('./partner-map-candidates');
const MAP_REVIEW_REASONS = new Set(['not_grooming', 'duplicate', 'closed', 'not_suitable', 'other']);
const MAP_CANDIDATE_STATUSES = new Set([
  'candidate', 'to_call', 'no_answer', 'in_progress',
  'message_sent', 'waiting_reply', 'meeting_scheduled', 'meeting_held',
  'signed', 'declined'
]);
const MAP_CONTACT_CHANNELS = new Set(['vk', 'tg', 'max', 'phone', 'in_person']);
const MAP_MESSAGE_STATUSES = new Set(['message_sent', 'waiting_reply']);

// Only strong address + name/phone matches are treated as duplicate CRM
// candidates; identical phone alone is insufficient for salon chains.
function mapNormAddress(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/^(?:россия\s*[,\s]*)?(?:г\.?\s*)?красноярск\s*[,\s]*/i, '')
    .replace(/(?:улица|ул\.?|проспект|пр-т|пер\.?|переулок)/gi, '')
    .replace(/[^a-zа-я0-9]+/gi, '');
}
function mapNormName(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}
function mapPhones(value) {
  return String(value || '').split(/[;,]/)
    .map(x => x.replace(/\D/g, '').slice(-10))
    .filter(x => x.length === 10);
}
function mapDuplicate(source, row) {
  const address = mapNormAddress(source.address);
  if (address.length < 5 || address !== mapNormAddress(row.address)) return false;
  if (mapNormName(source.name) === mapNormName(row.name)) return true;
  const phones = mapPhones(source.phone);
  return phones.length > 0 && mapPhones(row.phone).some(phone => phones.includes(phone));
}

// Bounded, short-lived cache: map geocoding runs only after the employee opens
// the tab, never automatically as part of reports or a background job.
const mapAddressCache = new Map();
const MAP_CACHE_TTL = 6 * 60 * 60 * 1000;
const MAP_MAX_CACHE = 256;
function mapGeocodeAddress(row) {
  const address = String(row.address || '').trim();
  if (address.length < 6 || !/[а-яёa-z]/i.test(address) ||
      !/\b\d{1,4}(?:\s*[а-яёa-z]|\/\d+)?\b/i.test(address)) return '';
  const city = String(row.city_name || '').trim();
  if (!city && !/(?:Красноярск|Петербург|Москва|Новосибирск)/i.test(address))
    return '';
  return city && !address.toLowerCase().includes(city.toLowerCase())
    ? city + ', ' + address : address;
}
function cachedMapPosition(key) {
  const entry = mapAddressCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) { mapAddressCache.delete(key); return null; }
  return entry;
}
function cacheMapPosition(key, value) {
  if (mapAddressCache.size >= MAP_MAX_CACHE) mapAddressCache.delete(mapAddressCache.keys().next().value);
  mapAddressCache.set(key, { ...value, expires: Date.now() + MAP_CACHE_TTL });
}


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

// Keep the existing CRM JSON shape without 3 individual SQLite lookups per lead.
function serializeListLead(row) {
  const { last_note_id, last_note_author,
    last_note_text, last_note_created_at, ...lead } = row;
  return {
    ...lead,
    last_note: last_note_id == null ? null : {
      note: last_note_text, author: last_note_author,
      created_at: last_note_created_at,
    },
  };
}

function registerPartnerLeadRoutes(router, options = {}) {
  const mapGeocode = options.geocodeAddress || geocodeAddress;
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
      'c.name AS city_name, p.lat, p.lng,',
      '(SELECT l.yandex_org_id FROM partner_leads l WHERE l.linked_point_id=p.id',
      "AND l.yandex_org_id IS NOT NULL AND l.yandex_org_id<>''",
      'ORDER BY l.id DESC LIMIT 1) AS yandex_org_id,',
      '(SELECT l.yandex_url FROM partner_leads l WHERE l.linked_point_id=p.id',
      "AND l.yandex_url IS NOT NULL AND l.yandex_url<>''",
      'ORDER BY l.id DESC LIMIT 1) AS yandex_url',
      'FROM points p LEFT JOIN cities c ON c.id=p.city_id',
      'WHERE p.active=1 AND COALESCE(p.is_hub,0)=0',
      manager ? 'AND p.manager_id=?' : '',
      'ORDER BY p.name COLLATE NOCASE'
    ].join(' ');
    const points = db.prepare(pointSql).all(...(manager ? [payload.id] : []))
      .map(p => ({
        type: 'point', id: p.id, name: p.name, address: p.address,
        city_id: p.city_id, city_name: p.city_name, lat: p.lat, lng: p.lng,
        yandex_org_id: p.yandex_org_id, yandex_url: p.yandex_url,
        status: 'active'
      }));
    const activeIds = new Set(points.map(point => String(point.id)));
    const venueKey = (name, address) => String(name || '').trim().toLowerCase() + '|' +
      String(address || '').trim().toLowerCase();
    const activeNamesAndAddresses = new Set(points.map(p => venueKey(p.name, p.address)));

    const leadsSql = [
      'SELECT l.id, l.salon_name AS name, l.address, l.phone,',
      'l.yandex_org_id, l.yandex_url,',
      'l.status, l.category, l.city_id,',
      "COALESCE(c.name, mc.name, CASE WHEN l.city_id IS NULL THEN 'Красноярск' END) AS city_name,",
      'l.next_contact_date, l.assigned_manager_id, l.linked_point_id',
      'FROM partner_leads l LEFT JOIN cities c ON c.id=l.city_id',
      'LEFT JOIN managers m ON m.id=l.assigned_manager_id',
      'LEFT JOIN cities mc ON mc.id=m.city_id',
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
        yandex_org_id: lead.yandex_org_id, yandex_url: lead.yandex_url,
        category: lead.category, city_id: lead.city_id,
        city_name: lead.city_name, next_contact_date: lead.next_contact_date,
        // Leads have no persistent coordinates. They are requested on demand
        // by ID through the authenticated read-only coordinates route.
        lat: null, lng: null
      }));
    // External 114-card Excel registry is deliberately kept OUT of partner_leads.
    // Only overlay it on the map. Manager city scoping still applies.
    const candidateReviewRows = db.prepare([
      'SELECT candidate_id, hidden, reason, note, reviewed_at,',
      'contact_status, contact_channel, contact_note, next_contact_date,',
      'contact_updated_at, contact_updated_by_role, contact_updated_by_id',
      'FROM partner_map_candidate_reviews'
    ].join(' ')).all();
    const reviewsById = new Map(candidateReviewRows.map(row => [row.candidate_id, row]));
    const mappedVenues = points.concat(leads);
    const candidates = (!manager || manager.city_id === 'krsk')
      ? mapCandidates.map(candidate => {
          const match = mappedVenues.find(row => mapDuplicate(candidate, row));
          const review = reviewsById.get(candidate.id);
          return { ...candidate, matched: match ? { type: match.type, id: match.id } : null,
            hidden: !!(review && review.hidden),
            review_reason: review ? review.reason : null,
            review_note: review ? review.note : null,
            reviewed_at: review ? review.reviewed_at : null,
            status: review && review.contact_status || candidate.status,
            contact_channel: review ? review.contact_channel : null,
            contact_note: review ? review.contact_note : null,
            next_contact_date: review ? review.next_contact_date : null,
            contact_updated_at: review ? review.contact_updated_at : null,
            contact_updated_by_role: review ? review.contact_updated_by_role : null,
            contact_updated_by_id: review ? review.contact_updated_by_id : null };

        })
      : [];
    sendJson(res, 200, {
      points, leads, candidates,
      candidate_hidden_total: candidates.filter(candidate => candidate.hidden).length,
      candidate_source_total: (!manager || manager.city_id === 'krsk') ? mapCandidates.length : 0,
      default_city_id: manager ? manager.city_id : 'krsk'
    });
  });

  // POST /api/partner-leads/network-map/candidates/:id/review
  // Explicit staff confirmation to mark an external (non-CRM) venue as
  // reviewed/hidden. A separate SQLite table persists across Amvera restarts.
  // Reversible and audited; no CRM lead, point, or source XLSX is changed.
  router.post('/api/partner-leads/network-map/candidates/:id/review', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'admin' &&
        !db.prepare('SELECT 1 FROM admins WHERE id=? AND active=1').get(payload.id)) {
      return sendJson(res, 401, { error: 'Администратор отключён' });
    }
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (manager && manager.city_id !== 'krsk') {
      return sendJson(res, 403, { error: 'Нет доступа к кандидатам этого города' });
    }
    const rawId = String(ctx.params.id || '');
    const id = /^\d{1,7}$/.test(rawId) ? Number(rawId) : 0;
    if (!Number.isSafeInteger(id) || id <= 0 || !mapCandidates.some(row => row.id === id)) {
      return sendJson(res, 404, { error: 'Организация из внешнего реестра не найдена' });
    }
    const body = ctx.body || {};
    const action = body.action;
    if (action !== 'hide' && action !== 'restore') {
      return sendJson(res, 400, { error: 'Укажите действие: скрыть или восстановить' });
    }
    const reason = action === 'hide' ? String(body.reason || '').trim() : null;
    if (action === 'hide' && !MAP_REVIEW_REASONS.has(reason)) {
      return sendJson(res, 400, { error: 'Выберите причину, по которой организация отработана' });
    }
    if (body.note != null && typeof body.note !== 'string') {
      return sendJson(res, 400, { error: 'Комментарий должен быть текстом' });
    }
    const note = action === 'hide' ? String(body.note || '').trim() : '';
    if (note.length > 300) {
      return sendJson(res, 400, { error: 'Комментарий не должен превышать 300 символов' });
    }
    let review;
    // The project uses node:sqlite DatabaseSync (no db.transaction()).
    // SAVEPOINT keeps the review state and its audit log atomic.
    db.exec('SAVEPOINT partner_map_candidate_review');
    try {
      db.prepare([
        'INSERT INTO partner_map_candidate_reviews',
        '(candidate_id, hidden, reason, note, reviewed_by_role, reviewed_by_id, reviewed_at)',
        "VALUES (?,?,?,?,?,?,datetime('now'))",
        'ON CONFLICT(candidate_id) DO UPDATE SET',
        'hidden=excluded.hidden, reason=excluded.reason, note=excluded.note,',
        'reviewed_by_role=excluded.reviewed_by_role, reviewed_by_id=excluded.reviewed_by_id,',
        'reviewed_at=excluded.reviewed_at'
      ].join(' ')).run(id, action === 'hide' ? 1 : 0, reason,
        note || null, payload.role, payload.id);
      db.prepare([
        'INSERT INTO partner_map_candidate_review_log',
        '(candidate_id, action, reason, note, actor_role, actor_id)',
        'VALUES (?,?,?,?,?,?)'
      ].join(' ')).run(id, action, reason, note || null, payload.role, payload.id);
      review = db.prepare([
        'SELECT candidate_id, hidden, reason, note, reviewed_at',
        'FROM partner_map_candidate_reviews WHERE candidate_id=?'
      ].join(' ')).get(id);
      db.exec('RELEASE SAVEPOINT partner_map_candidate_review');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT partner_map_candidate_review');
      db.exec('RELEASE SAVEPOINT partner_map_candidate_review');
      throw error;
    }
    return sendJson(res, 200, {
      ok: true, id, hidden: !!review.hidden,
      review_reason: review.reason, review_note: review.note,
      reviewed_at: review.reviewed_at
    });
  });

  // POST /api/partner-leads/network-map/candidates/:id/contact
  // Save an interaction with a candidate from the unapproved external list.
  // The CRM lead database is NOT modified; all changes are team-visible
  // and independently audited. Active manager or admin access is mandatory.
  router.post('/api/partner-leads/network-map/candidates/:id/contact', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'admin' &&
        !db.prepare('SELECT 1 FROM admins WHERE id=? AND active=1').get(payload.id)) {
      return sendJson(res, 401, { error: 'Администратор отключён' });
    }
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    if (manager && manager.city_id !== 'krsk') {
      return sendJson(res, 403, { error: 'Нет доступа к кандидатам этого города' });
    }
    const rawId = String(ctx.params.id || '');
    const id = /^\d{1,7}$/.test(rawId) ? Number(rawId) : 0;
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !mapCandidates.some(candidate => candidate.id === id)) {
      return sendJson(res, 404, { error: 'Организация из внешнего реестра не найдена' });
    }
    if (db.prepare('SELECT hidden FROM partner_map_candidate_reviews WHERE candidate_id=?')
      .get(id)?.hidden) {
      return sendJson(res, 409, { error: 'Организация скрыта. Сначала восстановите её на карте' });
    }
    const body = ctx.body || {};
    const status = String(body.status || '').trim();
    const channel = String(body.channel || '').trim();
    const note = body.note === undefined || body.note === null ? '' : body.note;
    const nextDate = body.next_contact_date === undefined ||
      body.next_contact_date === null ? '' : body.next_contact_date;
    if (!MAP_CANDIDATE_STATUSES.has(status)) {
      return sendJson(res, 400, { error: 'Выберите этап из списка' });
    }
    if (channel && !MAP_CONTACT_CHANNELS.has(channel)) {
      return sendJson(res, 400, { error: 'Неизвестный канал контакта' });
    }
    if (MAP_MESSAGE_STATUSES.has(status) && !['vk', 'tg', 'max'].includes(channel)) {
      return sendJson(res, 400, { error: 'Для сообщения выберите ВК, Telegram или MAX' });
    }
    if (typeof note !== 'string' || note.length > 500) {
      return sendJson(res, 400, { error: 'Комментарий должен быть текстом до 500 символов' });
    }
    if (typeof nextDate !== 'string' || (nextDate &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) ||
        !Number.isFinite(Date.parse(nextDate + 'T00:00:00Z')) ||
        new Date(nextDate + 'T00:00:00Z').toISOString().slice(0,10) !== nextDate))) {
      return sendJson(res, 400, { error: 'Неверная дата следующего контакта' });
    }

    let contact;
    // node:sqlite DatabaseSync: SAVEPOINT rather than better-sqlite3 .transaction().
    db.exec('SAVEPOINT partner_map_candidate_contact');
    try {
      db.prepare([
        'INSERT INTO partner_map_candidate_reviews',
        '(candidate_id, hidden, reason, note, reviewed_by_role, reviewed_by_id, reviewed_at,',
        'contact_status, contact_channel, contact_note, next_contact_date,',
        'contact_updated_at, contact_updated_by_role, contact_updated_by_id)',
        "VALUES (?,0,NULL,NULL,?,?,datetime('now'),?,?,?,?,datetime('now'),?,?)",
        'ON CONFLICT(candidate_id) DO UPDATE SET',
        'contact_status=excluded.contact_status,',
        'contact_channel=excluded.contact_channel,',
        'contact_note=excluded.contact_note,',
        'next_contact_date=excluded.next_contact_date,',
        'contact_updated_at=excluded.contact_updated_at,',
        'contact_updated_by_role=excluded.contact_updated_by_role,',
        'contact_updated_by_id=excluded.contact_updated_by_id'
      ].join(' ')).run(
        id, payload.role, payload.id, status, channel || null,
        note.trim() || null, nextDate || null, payload.role, payload.id
      );
      db.prepare([
        'INSERT INTO partner_map_candidate_contact_log',
        '(candidate_id, contact_status, contact_channel, next_contact_date,',
        'note, actor_role, actor_id) VALUES (?,?,?,?,?,?,?)'
      ].join(' ')).run(
        id, status, channel || null, nextDate || null,
        note.trim() || null, payload.role, payload.id
      );
      contact = db.prepare([
        'SELECT candidate_id, hidden, contact_status, contact_channel, contact_note,',
        'next_contact_date, contact_updated_at, contact_updated_by_role,',
        'contact_updated_by_id FROM partner_map_candidate_reviews WHERE candidate_id=?'
      ].join(' ')).get(id);
      db.exec('RELEASE SAVEPOINT partner_map_candidate_contact');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT partner_map_candidate_contact');
      db.exec('RELEASE SAVEPOINT partner_map_candidate_contact');
      throw error;
    }
    return sendJson(res, 200, { ok: true, id, ...contact, hidden: !!contact.hidden });
  });

  // POST /api/partner-leads/network-map/coordinates
  // Read-only mapping of EXISTING CRM IDs, not arbitrary addresses.
  // Does not modify CRM or store coordinates received from Yandex in SQLite.
  router.post('/api/partner-leads/network-map/coordinates', async (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'admin' &&
        !db.prepare('SELECT 1 FROM admins WHERE id=? AND active=1').get(payload.id)) {
      return sendJson(res, 401, { error: 'Администратор отключён' });
    }
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    const ids = ctx.body && ctx.body.lead_ids === undefined ? [] : ctx.body && ctx.body.lead_ids;
    const candidateIds = ctx.body && ctx.body.candidate_ids === undefined
      ? [] : ctx.body && ctx.body.candidate_ids;
    const validIds = arr => Array.isArray(arr) &&
      arr.every(id => Number.isSafeInteger(id) && id > 0) &&
      new Set(arr).size === arr.length;
    if (!validIds(ids) || !validIds(candidateIds) ||
        ids.length + candidateIds.length < 1 || ids.length + candidateIds.length > 10) {
      return sendJson(res, 400, { error: 'Передайте от 1 до 10 уникальных ID объектов' });
    }
    if (candidateIds.length && manager && manager.city_id !== 'krsk') {
      return sendJson(res, 403, { error: 'Нет доступа к кандидатам этого города' });
    }
    const rows = ids.map(id => db.prepare([
      'SELECT l.*,',
      "COALESCE(c.name, mc.name, CASE WHEN l.city_id IS NULL THEN 'Красноярск' END) AS city_name",
      'FROM partner_leads l LEFT JOIN cities c ON c.id=l.city_id',
      'LEFT JOIN managers m ON m.id=l.assigned_manager_id',
      'LEFT JOIN cities mc ON mc.id=m.city_id',
      'WHERE l.id=?'
    ].join(' ')).get(id));
    // Never leak whether a foreign lead exists, or send its address to Yandex.
    if (rows.some(row => !row || !canReadLead(payload, manager, row))) {
      return sendJson(res, 403, { error: 'Нет доступа к одному или нескольким заведениям' });
    }
    const external = candidateIds.map(id => mapCandidates.find(candidate => candidate.id === id));
    if (external.some(item => !item)) {
      return sendJson(res, 403, { error: 'Нет доступа к одному или нескольким кандидатам' });
    }
    const records = rows.map(row => ({ ...row, type: 'lead' }))
      .concat(external.map(item => ({ ...item, type: 'candidate' })));
    const hiddenCandidateIds = new Set(db.prepare(
      'SELECT candidate_id FROM partner_map_candidate_reviews WHERE hidden=1'
    ).all().map(row => row.candidate_id));
    const results = await Promise.all(records.map(async row => {
      if (row.type === 'candidate' && hiddenCandidateIds.has(row.id)) {
        return { id: row.id, type: row.type, status: 'hidden' };
      }
      const query = mapGeocodeAddress(row);
      const label = { id: row.id, type: row.type };
      if (!query) return { ...label, status: 'needs_address' };
      const cacheKey = query.trim().toLowerCase();
      const cached = cachedMapPosition(cacheKey);
      if (cached) return { ...label, ...cached.value };
      try {
        const found = await mapGeocode(query, { timeoutMs: 6500 });
        // Do not place a marker at the city or street centre when the building
        // cannot be resolved. A false marker is worse than an unplaced card.
        if (!found || !Number.isFinite(found.lat) || !Number.isFinite(found.lng) ||
            !['exact', 'number', 'near', 'range'].includes(found.precision) ||
            (row.city_name && found.formattedAddress &&
              !found.formattedAddress.toLowerCase().includes(row.city_name.toLowerCase()))) {
          const value = { status: 'needs_verification' };
          cacheMapPosition(cacheKey, { value });
          return { ...label, ...value };
        }
        const value = { status: 'mapped', lat: found.lat, lng: found.lng };
        cacheMapPosition(cacheKey, { value });
        return { ...label, ...value };
      } catch (error) {
        // Transient failures must not poison the cache; retry is possible.
        return { ...label, status: 'unavailable' };
      }
    }));
    sendJson(res, 200, { results });
  });

  // GET /api/partner-leads?status=&city_id=&q= — список лидов, новые сверху
  router.get('/api/partner-leads', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const { status, city_id, q } = ctx.query || {};
    const manager = payload.role === 'manager' ? activeManager(payload, res) : null;
    if (payload.role === 'manager' && !manager) return;
    let sql = [
      'SELECT l.*, m.full_name AS assigned_manager_name,',
      'COALESCE(n.notes_count,0) AS notes_count,',
      'last_note.id AS last_note_id,',
      'last_note.author AS last_note_author, last_note.note AS last_note_text,',
      'last_note.created_at AS last_note_created_at',
      'FROM partner_leads l LEFT JOIN managers m ON m.id=l.assigned_manager_id',
      'LEFT JOIN (SELECT lead_id,COUNT(*) AS notes_count,MAX(id) AS last_id',
      'FROM partner_lead_notes GROUP BY lead_id) n ON n.lead_id=l.id',
      'LEFT JOIN partner_lead_notes last_note ON last_note.id=n.last_id',
      'WHERE 1=1',
    ].join(' ');
    const args = [];
    // Assigned leads from any city + unassigned leads in the manager's own city.
    if (manager) {
      sql += ' AND (l.assigned_manager_id = ? OR (l.assigned_manager_id IS NULL AND l.city_id = ?))';
      args.push(payload.id, manager.city_id == null ? '__no_manager_city__' : manager.city_id);
    }
    if (status && STATUSES.includes(status)) { sql += ' AND l.status = ?'; args.push(status); }
    if (city_id) { sql += ' AND l.city_id = ?'; args.push(city_id); }
    if (q && q.trim()) {
      sql += ' AND (l.salon_name LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ?)';
      const like = '%' + q.trim() + '%';
      args.push(like, like, like);
    }
    sql += ' ORDER BY CASE WHEN l.next_contact_date IS NULL THEN 1 ELSE 0 END, l.next_contact_date ASC, l.id DESC';
    const rows = db.prepare(sql).all(...args);
    sendJson(res, 200, { leads: rows.map(serializeListLead) });
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
