'use strict';

const ROLES = {
  partner: { table: 'partners', code: 'partner_code', payouts: 'partner_payouts', items: 'partner_payout_items', id: 'partner_id', name: 'partner_name' },
  owner: { table: 'salon_owners', code: 'owner_code', payouts: 'owner_payouts', items: 'owner_payout_items', id: 'owner_id', name: 'owner_name' },
};

function roleConfig(role) {
  if (!Object.hasOwn(ROLES, role)) throw Object.assign(new Error('Неизвестный получатель отчёта'), { statusCode: 400 });
  return ROLES[role];
}

function initializeReports(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS payout_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL, recipient_id INTEGER, payout_id INTEGER,
    period_start TEXT, period_end TEXT, snapshot_json TEXT NOT NULL,
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(role, payout_id)
  );`);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function validatePeriod(start, end) {
  if (!validDate(start) || !validDate(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 366) {
    throw Object.assign(new Error('Укажите корректный период не более 367 дней'), { statusCode: 400 });
  }
}

function metadata(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const result = {};
  for (const key of ['contract_number', 'contract_date', 'principal', 'recipient_details', 'actions', 'payment_reference', 'tax_note']) {
    result[key] = String(input[key] || '').trim().slice(0, key === 'actions' ? 5000 : 1200);
  }
  return result;
}

function buildReport(role, recipient, orders, options = {}) {
  roleConfig(role);
  const items = orders.map((o) => ({
    order_code: String(o.order_code), date: o.created_at || null,
    base: o.total == null ? null : Number(o.total),
    rate: o.commission_rate == null ? null : Number(o.commission_rate),
    amount: Number(o.commission_amount), already_paid: !!o.already_paid,
  }));
  const sum = (key, list = items) => list.reduce((n, item) => n + Number(item[key] || 0), 0);
  const knownBase = items.every((item) => item.base != null);
  return {
    version: 1, role, recipient: { id: recipient.id || null, name: recipient.full_name, code: recipient.code || '', point: recipient.point_name || '', inn: recipient.inn || '' },
    kind: options.kind || 'period', period_start: options.start || null, period_end: options.end || null,
    date_basis: 'created_at_utc', generated_at: new Date().toISOString(),
    items, base_total: knownBase ? sum('base') : null, accrued: sum('amount'),
    already_paid: sum('amount', items.filter((i) => i.already_paid)),
    unpaid: sum('amount', items.filter((i) => !i.already_paid)),
    payout_id: options.payout_id || null, paid_at: options.paid_at || null,
    payout_amount: options.payout_amount == null ? null : Number(options.payout_amount),
    reconstructed: !!options.reconstructed, metadata: metadata(options.metadata),
    warnings: [
      'Период отбирается по дате создания заказа в UTC, а не по дате банковского платежа. Включены только заказы со статусом paid на момент формирования.',
      'Отчёт не является банковским подтверждением, чеком НПД или подписанным актом. Укажите реальные выполненные действия и подпишите документ.',
      'НДФЛ и страховые взносы автоматически не рассчитаны. Суммы начислений указаны до налоговых удержаний. Возвраты после формирования требуют отдельной корректировки.',
      ...(role === 'owner' ? ['Для ещё не выплаченных заказов ставка владельца берётся из текущего профиля. Перед подписанием проверьте историю её изменения.'] : []),
      ...(options.reconstructed ? ['Восстановлено из старого реестра выплаты. Историческая база и ставка не сохранены и не подставлены из текущего заказа.'] : []),
    ],
  };
}

function generatePeriodReport(db, role, id, start, end, meta) {
  const c = roleConfig(role);
  validatePeriod(start, end);
  const recipient = db.prepare(`SELECT r.*, r.${c.code} AS code, p.name AS point_name
    FROM ${c.table} r LEFT JOIN points p ON p.id = r.point_id WHERE r.id = ?`).get(id);
  if (!recipient) throw Object.assign(new Error('Получатель не найден'), { statusCode: 404 });
  const condition = role === 'partner' ? 'o.partner_id = ?' : 'o.point_id = ?';
  const orders = db.prepare(`SELECT o.order_code, o.created_at, o.total,
    ${role === 'partner' ? 'COALESCE(o.commission_rate, r.commission_rate, 0)' : 'r.commission_rate'} AS commission_rate,
    pi.commission_amount AS paid_commission, pi.id IS NOT NULL AS already_paid
    FROM orders o JOIN ${c.table} r ON r.id = ?
    LEFT JOIN ${c.items} pi ON pi.order_id = o.id
    WHERE ${condition} AND o.status = 'paid'
      AND o.created_at >= ? AND o.created_at < datetime(?, '+1 day')
    ORDER BY o.created_at, o.id`).all(id, role === 'partner' ? id : recipient.point_id, start, end).map((order) => ({
      ...order, commission_amount: order.already_paid ? order.paid_commission : Math.round(Number(order.total) * Number(order.commission_rate)),
      // An old payout may have used a different base/rate: never invent a historical one.
      ...(order.already_paid ? { total: null, commission_rate: null } : {}),
    }));
  return buildReport(role, recipient, orders, { start, end, metadata: meta });
}

function saveReport(db, report, adminId) {
  const info = db.prepare(`INSERT INTO payout_reports
    (role, recipient_id, payout_id, period_start, period_end, snapshot_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(report.role, report.recipient.id, report.payout_id, report.period_start, report.period_end, JSON.stringify(report), adminId || null);
  return { ...report, id: Number(info.lastInsertRowid) };
}

function snapshotPayout(db, role, recipient, orders, payout, adminId) {
  const dates = orders.map((o) => String(o.created_at || '').slice(0, 10)).filter(Boolean).sort();
  return saveReport(db, buildReport(role, recipient, orders, {
    kind: 'payout', start: dates[0] || null, end: dates.at(-1) || null,
    payout_id: payout.id, paid_at: payout.paid_at, payout_amount: payout.amount,
  }), adminId);
}

function fromPayout(db, role, payoutId, adminId) {
  const c = roleConfig(role);
  const saved = db.prepare('SELECT id, snapshot_json FROM payout_reports WHERE role = ? AND payout_id = ?').get(role, payoutId);
  if (saved) return { ...JSON.parse(saved.snapshot_json), id: saved.id };
  const payout = db.prepare(`SELECT * FROM ${c.payouts} WHERE id = ?`).get(payoutId);
  if (!payout) throw Object.assign(new Error('Выплата не найдена'), { statusCode: 404 });
  const orders = db.prepare(`SELECT order_code, commission_amount FROM ${c.items} WHERE payout_id = ? ORDER BY id`).all(payoutId);
  return saveReport(db, buildReport(role, { id: payout[c.id], full_name: payout[c.name], code: payout[role === 'partner' ? 'partner_code' : 'owner_code'], point_name: payout.point_name }, orders, {
    kind: 'payout', payout_id: payoutId, paid_at: payout.paid_at, payout_amount: payout.amount, reconstructed: true,
  }), adminId);
}

function printableReport(r) {
  const e = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const money = (v) => v == null ? 'не сохранено' : Number(v).toLocaleString('ru-RU') + ' ₽';
  const m = r.metadata;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт ${e(r.id || 'проект')} — ${e(r.recipient.name)}</title>
  <style>body{font:12pt Georgia,serif;color:#111;max-width:1000px;margin:24px auto;padding:0 20px}h1{font-size:19pt}table{width:100%;border-collapse:collapse;font-size:10pt}th,td{border:1px solid #aaa;padding:7px;text-align:left}th{background:#eee}p{line-height:1.4;overflow-wrap:anywhere}.note{font-size:10pt;color:#444}button{padding:12px}thead{display:table-header-group}tr{break-inside:avoid}@media print{button{display:none}body{margin:0;padding:0}@page{size:A4;margin:16mm}}</style>
  <button onclick="window.print()">Печать / сохранить PDF</button>
  <h1>Отчёт ${r.role === 'owner' ? 'владельца салона' : 'грумера'} ${e(r.id ? '№ ' + r.id : 'проект')}</h1>
  <p>Приложение к договору № ${e(m.contract_number || '________')} от ${e(m.contract_date || '________')}.</p>
  <p>Заказчик / принципал: ${e(m.principal || '________________________________')}<br>Получатель: ${e(r.recipient.name)}; ИНН ${e(r.recipient.inn || '________')}; код ${e(r.recipient.code)}<br>Реквизиты получателя: ${e(m.recipient_details || '________________________________')}<br>Точка: ${e(r.recipient.point || '________')}</p>
  <p>Период: ${e(r.period_start || 'не сохранён')} — ${e(r.period_end || 'не сохранён')}. ${r.kind === 'payout' ? 'Отчёт по фактическому составу выплаты, который может включать задолженность за предыдущие периоды.' : 'Отчёт по выбранному периоду.'}</p>
  <p>Фактически выполненные действия / услуги: ${e(m.actions || '________________________________________________________________ (заполнить перед подписанием)')}</p>
  <table><thead><tr><th>Заказ</th><th>Дата UTC</th><th>База</th><th>Ставка</th><th>Начисление</th><th>Учёт выплаты</th></tr></thead><tbody>${r.items.map((i) => `<tr><td>${e(i.order_code)}</td><td>${e(i.date || 'не сохранена')}</td><td>${e(money(i.base))}</td><td>${i.rate == null ? 'не сохранена' : e((i.rate * 100).toFixed(2)) + '%'}</td><td>${e(money(i.amount))}</td><td>${r.kind === 'payout' ? 'В составе выплаты' : i.already_paid ? 'Уже выплачено' : 'Не выплачено'}</td></tr>`).join('')}</tbody></table>
  <p>Заказов: ${r.items.length}; начислено: ${e(money(r.accrued))}. ${r.kind === 'payout' ? 'Зафиксированная выплата: ' + e(money(r.payout_amount)) + '; дата: ' + e(r.paid_at) : 'Из них уже выплачено: ' + e(money(r.already_paid)) + '; ещё не выплачено: ' + e(money(r.unpaid))}.</p>
  <p>НДФЛ / налоговый статус: ${e(m.tax_note || '________________ (определяет бухгалтер)')}. Сумма к перечислению после удержаний: __________. Банковский платёж: ${e(m.payment_reference || '________________')}.</p>
  <p>Составил получатель: __________ / __________. Дата __________.<br>Принял заказчик / принципал: __________ / __________. Дата __________.</p>
  <p class="note">Сформировано ${e(r.generated_at)}. ${r.warnings.map(e).join(' ')}</p></html>`;
}

module.exports = { ROLES, roleConfig, initializeReports, validDate, validatePeriod, metadata, buildReport, generatePeriodReport, saveReport, snapshotPayout, fromPayout, printableReport };
