'use strict';

function initializeBonusLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS referral_bonus_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN ('owner','partner')),
    manager_point_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
    recipient_name TEXT NOT NULL, recipient_code TEXT, point_id TEXT, point_name TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0), paid_by_admin_id INTEGER, paid_by_admin_login TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(role, manager_point_id)
  );`);
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manager_points'").get() &&
      !db.prepare('PRAGMA table_info(manager_points)').all().some(c => c.name === 'bonus_accrued_at')) {
    db.exec('ALTER TABLE manager_points ADD COLUMN bonus_accrued_at TEXT');
  }
}

function getBonuses(db, role, recipientId) {
  const manager = role === 'manager';
  const field = role === 'owner' ? 'referred_owner' : 'referred_groomer';
  const where = manager ? 'mp.manager_id' : `mp.${field}_id`;
  const amount = manager ? 'COALESCE(mp.bonus_manager_amount, 2000)' : `mp.${field}_amount`;
  const accruedAt = manager ? 'mp.bonus_accrued_at' : 'COALESCE(mp.referral_bonus_accrued_at,mp.bonus_accrued_at)';
  const paidTable = manager ? 'manager_launch_bonus_payouts' : 'referral_bonus_payouts';
  const paidCondition = manager ? '' : ' AND bp.role = ?';
  const pending = db.prepare(`SELECT mp.id AS manager_point_id, mp.point_id, mp.point_name,
    ${amount} AS amount, ${accruedAt} AS accrued_at
    FROM manager_points mp LEFT JOIN ${paidTable} bp ON bp.manager_point_id = mp.id${paidCondition}
    WHERE ${where} = ? AND ${manager ? 'mp.bonus_paid = 1' : `${amount} > 0`} AND bp.id IS NULL AND ${amount} > 0
    ORDER BY mp.id`).all(...(manager ? [recipientId] : [role, recipientId]));
  // An accrued referral can become temporarily unpayable after a refund.
  // Do not remove the historic accrual; separate it from payable balances.
  const held = [];
  const payable = [];
  if (role === 'partner') {
    const { computePointRevenueSoFar, REFERRAL_REVENUE_THRESHOLD } = require('./bonus-logic');
    for (const item of pending) {
      if (item.point_id && computePointRevenueSoFar(item.point_id)<REFERRAL_REVENUE_THRESHOLD)
        held.push({...item, reason:'После возвратов выручка ниже 1 000 ₽'});
      else payable.push(item);
    }
  } else payable.push(...pending);
  const paid = db.prepare(`SELECT bp.*, ${accruedAt} AS accrued_at
    FROM ${paidTable} bp LEFT JOIN manager_points mp ON mp.id = bp.manager_point_id
    WHERE ${manager ? 'bp.manager_id = ?' : 'bp.role = ? AND bp.recipient_id = ?'} ORDER BY bp.paid_at, bp.id`)
    .all(...(manager ? [recipientId] : [role, recipientId]));
  return {
    pending: payable,
    held,
    paid: paid.map(b => ({ ...b, payout_id: b.id, already_paid: true })),
  };
}

function periodBonuses(db, role, id, start, end) {
  const all = getBonuses(db, role, id);
  const within = value => value && String(value).slice(0,10) >= start && String(value).slice(0,10) <= end;
  return {
    bonuses: [...all.pending, ...all.paid].filter(b => within(b.accrued_at)),
    bonus_payments: all.paid.filter(b => within(b.paid_at)),
    undated_bonuses: all.pending.filter(b => !b.accrued_at),
  };
}

function createReferralBonusPayout(db, role, managerPointId, recipientId, expectedAmount, admin, options = {}) {
  const { roleConfig, snapshotBonusPayout } = require('./payout-reports');
  const c = roleConfig(role);
  if (!['owner','partner'].includes(role)) throw Object.assign(new Error('Некорректная роль'), {statusCode:400});
  const field = role === 'owner' ? 'referred_owner' : 'referred_groomer';
  if(!options.inTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const point = db.prepare('SELECT * FROM manager_points WHERE id = ?').get(managerPointId);
    if (!point || point[field+'_id'] !== recipientId) throw Object.assign(new Error('Бонус получателя не найден'),{statusCode:404});
    const amount = Number(point[field+'_amount']);
    // Referral accrual is independent of the manager's launch bonus. The
    // referral id and amount are written only after the relevant threshold.
    if (!Number.isSafeInteger(amount) || amount <= 0) throw Object.assign(new Error('Бонус ещё не начислен'),{statusCode:409});
    if (role === 'partner' && point.point_id) {
      const { computePointRevenueSoFar, REFERRAL_REVENUE_THRESHOLD } = require('./bonus-logic');
      if (computePointRevenueSoFar(point.point_id) < REFERRAL_REVENUE_THRESHOLD) {
        throw Object.assign(new Error('После возвратов оплаченная выручка точки ниже 1 000 ₽ — выплата временно недоступна'),{statusCode:409});
      }
    }
    if (amount !== expectedAmount) throw Object.assign(new Error('Сумма изменилась. Обновите данные перед подтверждением'),{statusCode:409});
    if (db.prepare('SELECT id FROM referral_bonus_payouts WHERE role = ? AND manager_point_id = ?').get(role,managerPointId)) throw Object.assign(new Error('Выплата уже зафиксирована'),{statusCode:409});
    const person = db.prepare(`SELECT id, full_name, ${c.code} AS code FROM ${c.table} WHERE id = ?`).get(recipientId);
    if (!person) throw Object.assign(new Error('Получатель не найден'),{statusCode:404});
    const info = db.prepare(`INSERT INTO referral_bonus_payouts
      (role,manager_point_id,recipient_id,recipient_name,recipient_code,point_id,point_name,amount,paid_by_admin_id,paid_by_admin_login)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(role,managerPointId,recipientId,person.full_name,person.code,point.point_id,point.point_name,amount,admin.id||null,admin.login||null);
    const payout = db.prepare('SELECT * FROM referral_bonus_payouts WHERE id = ?').get(Number(info.lastInsertRowid));
    const report = snapshotBonusPayout(db,role,person,payout,admin.id,'referral_bonus',
      point.referral_bonus_accrued_at || point.bonus_accrued_at);
    if(!options.inTransaction) db.exec('COMMIT');
    return { payout, report };
  } catch(error) { try {if(!options.inTransaction) db.exec('ROLLBACK');} catch(_) {} throw error; }
}

module.exports = { initializeBonusLedger, getBonuses, periodBonuses, createReferralBonusPayout };
