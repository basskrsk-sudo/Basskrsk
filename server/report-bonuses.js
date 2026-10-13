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
  const paidTable = manager ? 'manager_launch_bonus_payouts' : 'referral_bonus_payouts';
  const paidCondition = manager ? '' : ' AND bp.role = ?';
  const pending = db.prepare(`SELECT mp.id AS manager_point_id, mp.point_id, mp.point_name,
    ${amount} AS amount, mp.bonus_accrued_at AS accrued_at
    FROM manager_points mp LEFT JOIN ${paidTable} bp ON bp.manager_point_id = mp.id${paidCondition}
    WHERE ${where} = ? AND mp.bonus_paid = 1 AND bp.id IS NULL AND ${amount} > 0
    ORDER BY mp.id`).all(...(manager ? [recipientId] : [role, recipientId]));
  const paid = db.prepare(`SELECT bp.*, mp.bonus_accrued_at AS accrued_at
    FROM ${paidTable} bp LEFT JOIN manager_points mp ON mp.id = bp.manager_point_id
    WHERE ${manager ? 'bp.manager_id = ?' : 'bp.role = ? AND bp.recipient_id = ?'} ORDER BY bp.paid_at, bp.id`)
    .all(...(manager ? [recipientId] : [role, recipientId]));
  return {
    pending,
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

function createReferralBonusPayout(db, role, managerPointId, recipientId, expectedAmount, admin) {
  const { roleConfig, snapshotBonusPayout } = require('./payout-reports');
  const c = roleConfig(role);
  if (!['owner','partner'].includes(role)) throw Object.assign(new Error('Некорректная роль'), {statusCode:400});
  const field = role === 'owner' ? 'referred_owner' : 'referred_groomer';
  db.exec('BEGIN IMMEDIATE');
  try {
    const point = db.prepare('SELECT * FROM manager_points WHERE id = ?').get(managerPointId);
    if (!point || point[field+'_id'] !== recipientId) throw Object.assign(new Error('Бонус получателя не найден'),{statusCode:404});
    const amount = Number(point[field+'_amount']);
    if (!point.bonus_paid || !Number.isSafeInteger(amount) || amount <= 0) throw Object.assign(new Error('Бонус ещё не начислен'),{statusCode:409});
    if (amount !== expectedAmount) throw Object.assign(new Error('Сумма изменилась. Обновите данные перед подтверждением'),{statusCode:409});
    if (db.prepare('SELECT id FROM referral_bonus_payouts WHERE role = ? AND manager_point_id = ?').get(role,managerPointId)) throw Object.assign(new Error('Выплата уже зафиксирована'),{statusCode:409});
    const person = db.prepare(`SELECT id, full_name, ${c.code} AS code FROM ${c.table} WHERE id = ?`).get(recipientId);
    if (!person) throw Object.assign(new Error('Получатель не найден'),{statusCode:404});
    const info = db.prepare(`INSERT INTO referral_bonus_payouts
      (role,manager_point_id,recipient_id,recipient_name,recipient_code,point_id,point_name,amount,paid_by_admin_id,paid_by_admin_login)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(role,managerPointId,recipientId,person.full_name,person.code,point.point_id,point.point_name,amount,admin.id||null,admin.login||null);
    const payout = db.prepare('SELECT * FROM referral_bonus_payouts WHERE id = ?').get(Number(info.lastInsertRowid));
    const report = snapshotBonusPayout(db,role,person,payout,admin.id,'referral_bonus',point.bonus_accrued_at);
    db.exec('COMMIT');
    return { payout, report };
  } catch(error) { try {db.exec('ROLLBACK');} catch(_) {} throw error; }
}

module.exports = { initializeBonusLedger, getBonuses, periodBonuses, createReferralBonusPayout };
