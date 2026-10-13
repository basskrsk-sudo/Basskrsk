'use strict';

const ROLES = {
  partner: { table: 'partners', code: 'partner_code', payouts: 'partner_payouts', items: 'partner_payout_items', id: 'partner_id', name: 'partner_name' },
  owner: { table: 'salon_owners', code: 'owner_code', payouts: 'owner_payouts', items: 'owner_payout_items', id: 'owner_id', name: 'owner_name' },
  manager: { table: 'managers', code: 'mgr_code', payouts: 'manager_commission_payouts', items: 'manager_commission_payout_items', id: 'manager_id', name: 'manager_name' },
};

function roleConfig(role) {
  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) throw Object.assign(new Error('Неизвестный получатель отчёта'), { statusCode: 400 });
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
  if (!db.prepare('PRAGMA table_info(payout_reports)').all().some(c => c.name === 'source_key')) {
    db.exec('ALTER TABLE payout_reports ADD COLUMN source_key TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_report_source ON payout_reports(source_key)');
  require('./report-bonuses').initializeBonusLedger(db);
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
  const bonuses = (options.bonuses || []).map(b => ({
    manager_point_id: b.manager_point_id, point: b.point_name, amount: Number(b.amount),
    accrued_at: b.accrued_at || null, paid_at: b.paid_at || null,
    already_paid: !!b.already_paid, payout_id: b.payout_id || null,
  }));
  const bonusSum = list => list.reduce((s,b)=>s+b.amount,0);
  const bonusAccrued = bonusSum(bonuses);
  const bonusPaid = bonusSum(bonuses.filter(b=>b.already_paid));
  return {
    version: 2, role, recipient: { id: recipient.id || null, name: recipient.full_name, code: recipient.code || '', point: recipient.point_name || '', inn: recipient.inn || '' },
    kind: options.kind || 'period', period_start: options.start || null, period_end: options.end || null,
    date_basis: 'created_at_utc', generated_at: new Date().toISOString(),
    items, bonuses, bonus_payments: options.bonus_payments || [], undated_bonuses: options.undated_bonuses || [],
    commission_accrued: sum('amount'), bonus_accrued: bonusAccrued,
    base_total: knownBase ? sum('base') : null, accrued: sum('amount') + bonusAccrued,
    already_paid: sum('amount', items.filter((i) => i.already_paid)) + bonusPaid,
    unpaid: sum('amount', items.filter((i) => !i.already_paid)) + bonusAccrued - bonusPaid,
    source_key: options.source_key || null, payout_type: options.payout_type || 'commission',
    bonus_payout_id: options.bonus_payout_id || null,
    payout_id: options.payout_id || null, paid_at: options.paid_at || null,
    payout_amount: options.payout_amount == null ? null : Number(options.payout_amount),
    reconstructed: !!options.reconstructed, metadata: metadata(options.metadata),
    warnings: [
      'Период отбирается по дате создания заказа в UTC, а не по дате банковского платежа. Включены только заказы со статусом paid на момент формирования.',
      'Отчёт не является банковским подтверждением, чеком НПД или подписанным актом. Укажите реальные выполненные действия и подпишите документ.',
      'НДФЛ и страховые взносы автоматически не рассчитаны. Суммы начислений указаны до налоговых удержаний. Возвраты после формирования требуют отдельной корректировки.',
      'Бонусы показаны отдельно: начисления — по сохранённой дате начисления, переводы — по дате фиксации выплаты. Историческое поле bonus_paid означает начисление, а не перевод денег.',
      ...((options.undated_bonuses || []).length ? ['Есть старые бонусы без даты начисления: они показаны справочно и не включены в итог начислений за период.'] : []),
      ...(role === 'owner' ? ['Для ещё не выплаченных заказов ставка владельца берётся из текущего профиля. Перед подписанием проверьте историю её изменения.'] : []),
      ...(options.reconstructed ? ['Восстановлено из старого реестра выплаты. Историческая база и ставка не сохранены и не подставлены из текущего заказа.'] : []),
    ],
  };
}

function generatePeriodReport(db, role, id, start, end, meta) {
  const c = roleConfig(role);
  validatePeriod(start, end);
  const recipient = db.prepare(`SELECT r.*, r.${c.code} AS code${role === 'manager' ? '' : ', p.name AS point_name'}
    FROM ${c.table} r ${role === 'manager' ? '' : 'LEFT JOIN points p ON p.id = r.point_id'} WHERE r.id = ?`).get(id);
  if (!recipient) throw Object.assign(new Error('Получатель не найден'), { statusCode: 404 });
  if (role === 'manager') {
    const orders = db.prepare(`SELECT o.order_code, o.created_at, o.total, mp.commission_rate,
      NULL AS paid_commission, 0 AS already_paid
      FROM orders o JOIN points p ON p.id = o.point_id
      JOIN manager_points mp ON mp.point_id = p.id AND mp.manager_id = p.manager_id
      LEFT JOIN manager_commission_payout_items pi ON pi.order_id = o.id
      WHERE p.manager_id = ? AND pi.id IS NULL AND o.status = 'paid' AND o.created_at >= ? AND o.created_at < datetime(?, '+1 day')
      UNION ALL
      SELECT pi.order_code,o.created_at,NULL,pi.commission_rate,pi.commission_amount,1
      FROM manager_commission_payout_items pi JOIN manager_commission_payouts cp ON cp.id = pi.payout_id
      JOIN orders o ON o.id = pi.order_id
      WHERE cp.manager_id = ? AND o.status = 'paid' AND o.created_at >= ? AND o.created_at < datetime(?, '+1 day')
      ORDER BY 2,1`).all(id,start,end,id,start,end).map(o=>({ ...o,
        commission_amount: o.already_paid ? o.paid_commission : Math.round(Number(o.total)*Number(o.commission_rate)),
        ...(o.already_paid ? {total:null} : {}),
      }));
    return buildReport(role,recipient,orders,{start,end,metadata:meta,...require('./report-bonuses').periodBonuses(db,role,id,start,end)});
  }
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
  return buildReport(role, recipient, orders, { start, end, metadata: meta, ...require('./report-bonuses').periodBonuses(db,role,id,start,end) });
}

function saveReport(db, report, adminId) {
  const info = db.prepare(`INSERT INTO payout_reports
    (role, recipient_id, payout_id, period_start, period_end, snapshot_json, created_by, source_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(report.role, report.recipient.id, report.payout_id, report.period_start, report.period_end, JSON.stringify(report), adminId || null,report.source_key||null);
  return { ...report, id: Number(info.lastInsertRowid) };
}

function snapshotPayout(db, role, recipient, orders, payout, adminId) {
  const dates = orders.map((o) => String(o.created_at || '').slice(0, 10)).filter(Boolean).sort();
  return saveReport(db, buildReport(role, recipient, orders, {
    kind: 'payout', start: dates[0] || null, end: dates.at(-1) || null,
    payout_id: payout.id, paid_at: payout.paid_at, payout_amount: payout.amount,
  }), adminId);
}

function snapshotBonusPayout(db,role,person,payout,adminId,type='launch_bonus',accruedAt=null) {
  return saveReport(db,buildReport(role,person,[],{
    kind:'payout',source_key:role+':'+type+':'+payout.id,payout_type:type,bonus_payout_id:payout.id,
    start:String(payout.paid_at).slice(0,10),end:String(payout.paid_at).slice(0,10),paid_at:payout.paid_at,payout_amount:payout.amount,
    bonuses:[{manager_point_id:payout.manager_point_id,point_name:payout.point_name,amount:payout.amount,accrued_at:accruedAt,paid_at:payout.paid_at}],
  }),adminId);
}

function fromPayout(db, role, payoutId, adminId, type='commission') {
  const c = roleConfig(role);
  if (type !== 'commission') {
    if (type !== (role === 'manager' ? 'launch_bonus' : 'referral_bonus')) throw Object.assign(new Error('Неизвестный вид выплаты'),{statusCode:400});
    const source = role+':'+type+':'+payoutId;
    const savedBonus = db.prepare('SELECT id,snapshot_json FROM payout_reports WHERE source_key = ?').get(source);
    if (savedBonus) return {...JSON.parse(savedBonus.snapshot_json),id:savedBonus.id};
    const payout = role === 'manager'
      ? db.prepare('SELECT * FROM manager_launch_bonus_payouts WHERE id = ?').get(payoutId)
      : db.prepare('SELECT * FROM referral_bonus_payouts WHERE id = ? AND role = ?').get(payoutId,role);
    if (!payout) throw Object.assign(new Error('Выплата не найдена'),{statusCode:404});
    return snapshotBonusPayout(db,role,{id:role==='manager'?payout.manager_id:payout.recipient_id,
      full_name:role==='manager'?payout.manager_name:payout.recipient_name,
      code:role==='manager'?payout.manager_code:payout.recipient_code},payout,adminId,type);
  }
  const saved = db.prepare('SELECT id, snapshot_json FROM payout_reports WHERE role = ? AND payout_id = ?').get(role, payoutId);
  if (saved) return { ...JSON.parse(saved.snapshot_json), id: saved.id };
  const payout = db.prepare(`SELECT * FROM ${c.payouts} WHERE id = ?`).get(payoutId);
  if (!payout) throw Object.assign(new Error('Выплата не найдена'), { statusCode: 404 });
  const orders = db.prepare(`SELECT order_code, commission_amount FROM ${c.items} WHERE payout_id = ? ORDER BY id`).all(payoutId);
  return saveReport(db, buildReport(role, { id: payout[c.id], full_name: payout[c.name], code: payout[role === 'partner' ? 'partner_code' : role === 'owner' ? 'owner_code' : 'manager_code'], point_name: payout.point_name }, orders, {
    kind: 'payout', payout_id: payoutId, paid_at: payout.paid_at, payout_amount: payout.amount, reconstructed: true,
  }), adminId);
}

function printableReport(r) {
  const e = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const money = (v) => v == null ? 'не сохранено' : Number(v).toLocaleString('ru-RU') + ' ₽';
  const m = r.metadata;
  const bonusTable = (title,rows,dateKey) => rows.length ? `<h2>${e(title)}</h2><table><thead><tr><th>Точка</th><th>Дата UTC</th><th>Сумма</th><th>Статус</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${e(b.point || b.point_name)}</td><td>${e(b[dateKey] || 'не сохранена')}</td><td>${e(money(b.amount))}</td><td>${r.kind==='payout'?'В составе выплаты':b.already_paid?'Выплата зафиксирована':'Начислено, не выплачено'}</td></tr>`).join('')}</tbody></table>` : '';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт ${e(r.id || 'проект')} — ${e(r.recipient.name)}</title>
  <style>body{font:12pt Georgia,serif;color:#111;max-width:1000px;margin:24px auto;padding:0 20px}h1{font-size:19pt}table{width:100%;border-collapse:collapse;font-size:10pt}th,td{border:1px solid #aaa;padding:7px;text-align:left}th{background:#eee}p{line-height:1.4;overflow-wrap:anywhere}.note{font-size:10pt;color:#444}button{padding:12px}thead{display:table-header-group}tr{break-inside:avoid}@media print{button{display:none}body{margin:0;padding:0}@page{size:A4;margin:16mm}}</style>
  <button onclick="window.print()">Печать / сохранить PDF</button>
  <h1>Отчёт ${r.role === 'owner' ? 'владельца салона' : r.role === 'manager' ? 'менеджера' : 'грумера'} ${e(r.id ? '№ ' + r.id : 'проект')}</h1>
  <p>Приложение к договору № ${e(m.contract_number || '________')} от ${e(m.contract_date || '________')}.</p>
  <p>Заказчик / принципал: ${e(m.principal || '________________________________')}<br>Получатель: ${e(r.recipient.name)}; ИНН ${e(r.recipient.inn || '________')}; код ${e(r.recipient.code)}<br>Реквизиты получателя: ${e(m.recipient_details || '________________________________')}<br>Точка: ${e(r.recipient.point || '________')}</p>
  <p>Период: ${e(r.period_start || 'не сохранён')} — ${e(r.period_end || 'не сохранён')}. ${r.kind === 'payout' ? 'Отчёт по фактическому составу выплаты, который может включать задолженность за предыдущие периоды.' : 'Отчёт по выбранному периоду.'}</p>
  <p>Фактически выполненные действия / услуги: ${e(m.actions || '________________________________________________________________ (заполнить перед подписанием)')}</p>
  <h2>Комиссия с продаж</h2>
  <table><thead><tr><th>Заказ</th><th>Дата UTC</th><th>База</th><th>Ставка</th><th>Начисление</th><th>Учёт выплаты</th></tr></thead><tbody>${r.items.map((i) => `<tr><td>${e(i.order_code)}</td><td>${e(i.date || 'не сохранена')}</td><td>${e(money(i.base))}</td><td>${i.rate == null ? 'не сохранена' : e((i.rate * 100).toFixed(2)) + '%'}</td><td>${e(money(i.amount))}</td><td>${r.kind === 'payout' ? 'В составе выплаты' : i.already_paid ? 'Уже выплачено' : 'Не выплачено'}</td></tr>`).join('')}</tbody></table>
  <p>Заказов: ${r.items.length}; начислено: ${e(money(r.accrued))}. ${r.kind === 'payout' ? 'Зафиксированная выплата: ' + e(money(r.payout_amount)) + '; дата: ' + e(r.paid_at) : 'Из них уже выплачено: ' + e(money(r.already_paid)) + '; ещё не выплачено: ' + e(money(r.unpaid))}.</p>
  ${bonusTable('Бонусы за привлечение точек — начисления',(r.bonuses || []),'accrued_at')}
  <p>Комиссия: ${e(money(r.commission_accrued == null ? r.accrued : r.commission_accrued))}; бонусы: ${e(money(r.bonus_accrued || 0))}; всего начислений: ${e(money(r.accrued))}.</p>
  ${bonusTable('Фактические выплаты бонусов за выбранный период',(r.bonus_payments || []),'paid_at')}
  ${(r.bonus_payments || []).length ? `<p>Выплачено бонусов за период: ${e(money(r.bonus_payments.reduce((s,b)=>s+Number(b.amount),0)))}. Это реестр переводов; суммы не прибавляются повторно к начислениям за период.</p>` : ''}
  ${bonusTable('Справочно: старые начисления без даты — вне итогов периода',(r.undated_bonuses || []),'accrued_at')}
  <p>НДФЛ / налоговый статус: ${e(m.tax_note || '________________ (определяет бухгалтер)')}. Сумма к перечислению после удержаний: __________. Банковский платёж: ${e(m.payment_reference || '________________')}.</p>
  <p>Составил получатель: __________ / __________. Дата __________.<br>Принял заказчик / принципал: __________ / __________. Дата __________.</p>
  <p class="note">Сформировано ${e(r.generated_at)}. ${r.warnings.map(e).join(' ')}</p></html>`;
}

module.exports = { ROLES, roleConfig, initializeReports, validDate, validatePeriod, metadata, buildReport, generatePeriodReport, saveReport, snapshotPayout, snapshotBonusPayout, fromPayout, printableReport };
