'use strict';

// Live, read-only stock on retail shelves (stock), not central warehouses
// (warehouse_stock). A separate lightweight query runs only on an approved
// request from an account linked to this MAX chat.
const db = require('./db');

const PAGE_SIZE = 8;
const MAX_VARIANTS = 120;
const MAX_MESSAGE = 2700;
const ZONE = 'Asia/Krasnoyarsk';

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}
function safe(value, maxLength = 110) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function when(now) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
}

// Administrators do not have a max_chat_id field. Link them only through
// their super-admin-managed phone number and a verified MAX task assignee.
// Never trust a chat ID typed in a bot message or an unverified login token.
function resolveMaxStockAccess(chatId) {
  const chat = String(chatId ?? '');
  if (!/^\d{1,20}$/.test(chat)) return null;

  const linkedAssignees = db.prepare(
    'SELECT phone FROM task_assignees WHERE active=1 AND max_chat_id=?'
  ).all(chat);
  const verifiedPhones = new Set(linkedAssignees.map(row => normalizePhone(row.phone)).filter(Boolean));

  const admin = db.prepare(
    "SELECT id,phone FROM admins WHERE active=1 AND phone IS NOT NULL AND phone<>''"
  ).all().some(row => verifiedPhones.has(normalizePhone(row.phone)));
  if (admin) return { all: true, managerIds: [], pointIds: [] };

  const managerIds = db.prepare(
    'SELECT id,phone,max_chat_id FROM managers WHERE active=1'
  ).all().filter(row => String(row.max_chat_id ?? '') === chat ||
    (verifiedPhones.size > 0 && verifiedPhones.has(normalizePhone(row.phone))))
    .map(row => Number(row.id));

  const pointIds = new Set();
  for (const table of ['salon_owners', 'partners']) {
    const rows = db.prepare(
      'SELECT point_id FROM ' + table + ' WHERE active=1 AND max_chat_id=? AND point_id IS NOT NULL'
    ).all(chat);
    for (const row of rows) pointIds.add(String(row.point_id));
  }
  if (!managerIds.length && !pointIds.size) return null;
  return { all: false, managerIds, pointIds: [...pointIds] };
}
function scope(access) {
  if (!access) throw Object.assign(new Error('Требуется привязанный MAX-аккаунт сотрудника.'),{code:'FORBIDDEN'});
  if (access.all) return { predicate: '', args: [] };
  const predicates = [], args = [];
  if (access.managerIds.length) {
    predicates.push('p.manager_id IN (' + access.managerIds.map(() => '?').join(',') + ')');
    args.push(...access.managerIds);
  }
  if (access.pointIds.length) {
    predicates.push('p.id IN (' + access.pointIds.map(() => '?').join(',') + ')');
    args.push(...access.pointIds);
  }
  return {
    predicate: ' AND (' + (predicates.length ? predicates.join(' OR ') : '0') + ')',
    args,
  };
}
function stockSummary(access, requestedPage = 1, now = new Date()) {
  const page = Number(requestedPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw Object.assign(new Error('Номер страницы должен быть положительным целым числом.'),{code:'BAD_PAGE'});
  const filter = scope(access);
  const total = db.prepare(
    'SELECT COUNT(*) AS count FROM points p WHERE p.active=1' + filter.predicate
  ).get(...filter.args).count;
  const rows = db.prepare(
    'SELECT p.id,p.name,p.addr,p.icon,' +
      'COALESCE(SUM(s.qty),0) AS total_qty,' +
      'COALESCE(SUM(CASE WHEN s.qty>0 THEN 1 ELSE 0 END),0) AS in_stock_positions,' +
      'COALESCE(SUM(CASE WHEN s.qty<0 THEN 1 ELSE 0 END),0) AS negative_positions ' +
    'FROM points p LEFT JOIN stock s ON s.point_id=p.id ' +
    'WHERE p.active=1' + filter.predicate + ' ' +
    'GROUP BY p.id ORDER BY p.name COLLATE NOCASE,p.id LIMIT ? OFFSET ?'
  ).all(...filter.args,PAGE_SIZE,(page-1)*PAGE_SIZE);
  return {kind:'summary',page,pages:Math.max(1,Math.ceil(total/PAGE_SIZE)),
    count:total,points:rows,generatedAt:when(now)};
}
function stockDetail(access, pointId, now = new Date()) {
  const filter = scope(access);
  const id = String(pointId ?? '').trim().slice(0,130);
  const point = db.prepare(
    'SELECT p.id,p.name,p.addr,p.icon FROM points p WHERE p.id=? AND p.active=1' + filter.predicate
  ).get(id,...filter.args);
  if (!point) throw Object.assign(new Error('Точка не найдена или у вас нет к ней доступа.'),{code:'UNKNOWN_POINT'});
  const rows = db.prepare(
    'SELECT pr.name AS product_name,v.weight,v.sort_order,' +
      'pr.active AS product_active,v.active AS variant_active,' +
      'COALESCE(s.qty,0) AS qty ' +
    'FROM product_variants v JOIN products pr ON pr.id=v.product_id ' +
    'LEFT JOIN stock s ON s.variant_id=v.id AND s.point_id=? ' +
    'WHERE (pr.active=1 AND v.active=1) OR COALESCE(s.qty,0)<>0 ' +
    'ORDER BY pr.name COLLATE NOCASE,v.sort_order,v.weight,v.id LIMIT ?'
  ).all(point.id,MAX_VARIANTS+1);
  const truncated = rows.length > MAX_VARIANTS;
  const items = rows.slice(0,MAX_VARIANTS);
  const grandTotal = db.prepare(
    'SELECT COALESCE(SUM(qty),0) AS total_qty FROM stock WHERE point_id=?'
  ).get(point.id).total_qty;
  return {kind:'detail',point,items,truncated,totalQty:grandTotal,generatedAt:when(now)};
}

function formatSummary(data) {
  const lines = [
    '📦 ХвостМаркет · остатки на точках',
    '🕒 ' + data.generatedAt + ' · Красноярск',
    'Точек в доступе: ' + data.count + ' · страница ' + data.page + '/' + data.pages,
    '',
  ];
  if (!data.points.length) {
    lines.push(data.count ? 'На этой странице точек нет.' : 'Доступных действующих точек нет.');
  }
  for (const row of data.points) {
    const extra = Number(row.negative_positions) > 0 ? ' · ⚠️ минусовой остаток' : '';
    lines.push('🏪 ' + safe(row.name,75) + ' — ' +
      Number(row.total_qty).toLocaleString('ru-RU') + ' шт. (' +
      Number(row.in_stock_positions) + ' поз. в наличии)' + extra);
    lines.push('   /stock ' + safe(row.id,120));
  }
  if (data.page < data.pages) lines.push('', 'Следующие точки: /stock ' + (data.page+1));
  if (data.page > 1) lines.push('Предыдущая страница: /stock ' + (data.page-1));
  lines.push('', 'Для детализации нажмите /stock и код точки из списка.');
  return lines.join('\n');
}

function formatDetail(data) {
  const point = data.point;
  const header = '📦 ' + safe(point.name,75) + '\n' +
    '📍 ' + safe(point.addr,110) + '\n' +
    '🕒 ' + data.generatedAt + ' · Красноярск\n';
  const lines = data.items.map(item => {
    const qty = Number(item.qty);
    const icon = qty < 0 ? '⚠️' : qty === 0 ? '⚪' : '🟢';
    const archived = !item.product_active || !item.variant_active ? ' [архив]' : '';
    return icon + ' ' + safe(item.product_name,90) + ' (' + safe(item.weight,35) +
      ') — ' + qty.toLocaleString('ru-RU') + ' шт.' + archived;
  });
  if (!lines.length) lines.push('На точке нет позиций в каталоге.');
  const tail = [
    '📊 Всего на точке: ' + Number(data.totalQty).toLocaleString('ru-RU') + ' шт.',
    ...(data.truncated ? ['⚠️ Показаны первые ' + MAX_VARIANTS + ' позиций.'] : []),
  ];
  const messages=[], base=header.length+30;
  let chunk=[], chars=0;
  function flush(){
    const suffix = messages.length ? ' (продолжение)' : '';
    messages.push(header + suffix + '\n' + chunk.join('\n'));
    chunk=[]; chars=0;
  }
  for (const line of lines) {
    if (chunk.length && base+chars+line.length+1>MAX_MESSAGE) flush();
    chunk.push(line);chars+=line.length+1;
  }
  if (base+chars+tail.join('\n').length+3>MAX_MESSAGE) flush();
  chunk.push('',...tail);
  flush();
  return messages;
}


db.exec(
  'CREATE TABLE IF NOT EXISTS max_point_stock_approvals (' +
  'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  'chat_id TEXT NOT NULL,' +
  'selection TEXT NOT NULL,' +
  "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','cancelled','failed'))," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "expires_at TEXT NOT NULL DEFAULT (datetime('now','+20 minutes'))" +
  ')'
);
db.exec('CREATE INDEX IF NOT EXISTS idx_max_point_stock_approval_chat ON max_point_stock_approvals(chat_id,status,id)');

function parseStockCommand(input) {
  const command = String(input || '').trim();
  const match = command.match(/^\/stock(?:\s+(.+))?$/i);
  if (!match) return null;
  const argument = String(match[1] || '').trim();
  if (!argument) return {kind:'summary',page:1};
  if (/^\d{1,5}$/.test(argument)) {
    const page = Number(argument);
    if (page < 1 || page > 10000) return {error:'Страница должна быть от 1 до 10000.'};
    return {kind:'summary',page};
  }
  if (!/^[a-zа-яё0-9_-]{1,80}$/i.test(argument)) {
    return {error:'Используйте /stock, /stock 2 или /stock код_точки из списка.'};
  }
  return {kind:'detail',pointId:argument};
}

function requestStockApproval(chatId,selection) {
  const id = String(chatId || '');
  if (!resolveMaxStockAccess(id))
    return {ok:false,message:'🔒 Отчёт доступен только сотрудникам с подтверждённым MAX-аккаунтом. Подключите MAX в личном кабинете или попросите администратора привязать вас в разделе «Поручения».'};
  if (!selection || !['summary','detail'].includes(selection.kind))
    return {ok:false,message:'Неизвестный запрос. Используйте /stock.'};
  const parsed = parseStockCommand(selection.kind==='summary' ?
    '/stock ' + Number(selection.page) : '/stock ' + selection.pointId);
  if (!parsed || parsed.error) return {ok:false,message:parsed?.error || 'Некорректный запрос.'};
  // A new request supersedes any older unconfirmed stock request for this chat.
  db.prepare(
    "UPDATE max_point_stock_approvals SET status='cancelled' WHERE chat_id=? AND status='pending'"
  ).run(id);
  const serialized = JSON.stringify(parsed);
  const requestId = Number(db.prepare(
    'INSERT INTO max_point_stock_approvals(chat_id,selection) VALUES(?,?)'
  ).run(id,serialized).lastInsertRowid);
  const subject = parsed.kind==='detail' ?
    'Подробные остатки точки ' + safe(parsed.pointId,80) :
    'Остатки по точкам · страница ' + parsed.page;
  return {ok:true,id:requestId,message:
    '📦 ХвостМаркет · остатки\n' + subject +
    '\n\nСформировать отчёт по текущим остаткам? Подтверждение действительно 20 минут.',
    attachments:[{type:'inline_keyboard',payload:{buttons:[[
      {type:'callback',text:'✅ Показать остатки',payload:'stk:yes:'+requestId},
      {type:'callback',text:'❌ Отмена',payload:'stk:no:'+requestId}
    ]]}}]};
}
function decideStockApproval(chatId,action,rawId) {
  const id = String(chatId || ''), requestId = Number(rawId);
  if (!['yes','no'].includes(action) || !Number.isSafeInteger(requestId) || requestId<=0)
    return {ok:false,message:'Некорректное подтверждение.'};
  const record=db.prepare('SELECT * FROM max_point_stock_approvals WHERE id=?').get(requestId);
  if (!record || record.chat_id!==id || !resolveMaxStockAccess(id))
    return {ok:false,message:'Запрос недоступен. Проверьте привязку MAX-аккаунта.'};
  const status=action==='yes'?'running':'cancelled';
  const updated=db.prepare(
    "UPDATE max_point_stock_approvals SET status=? "+
    "WHERE id=? AND chat_id=? AND status='pending' AND expires_at>datetime('now')"
  ).run(status,requestId,id);
  if (!updated.changes)
    return {ok:false,message:'Запрос уже обработан или истёк. Отправьте /stock ещё раз.'};
  if (action==='no') return {ok:true,cancelled:true,message:'Отчёт отменён. Остатки не загружались.'};
  return {ok:true,id:requestId,selection:JSON.parse(record.selection),
    message:'Формирование согласовано.'};
}
function finishStockApproval(requestId,success) {
  db.prepare("UPDATE max_point_stock_approvals SET status=? WHERE id=? AND status='running'")
    .run(success?'done':'failed',requestId);
}

module.exports = {
  PAGE_SIZE, normalizePhone, resolveMaxStockAccess,
  stockSummary, stockDetail, formatSummary, formatDetail,
  parseStockCommand, requestStockApproval, decideStockApproval, finishStockApproval,
};
