'use strict';

// Lifetime = commission recorded in payment ledgers + commission on yet-unpaid
// paid orders + all accrued referral/launch bonuses (paid and pending).
// Never count payment transfers as extra earnings.
const PAID = {
  partner: `SELECT COALESCE(SUM(i.commission_amount),0) AS amount
    FROM partner_payout_items i JOIN partner_payouts p ON p.id=i.payout_id
    WHERE p.partner_id=?`,
  owner: `SELECT COALESCE(SUM(i.commission_amount),0) AS amount
    FROM owner_payout_items i JOIN owner_payouts p ON p.id=i.payout_id
    WHERE p.owner_id=?`,
  manager: `SELECT COALESCE(SUM(i.commission_amount),0) AS amount
    FROM manager_commission_payout_items i
    JOIN manager_commission_payouts p ON p.id=i.payout_id WHERE p.manager_id=?`,
};
const UNPAID = {
  partner: `SELECT o.total,COALESCE(o.commission_rate,p.commission_rate,0) AS rate
    FROM orders o JOIN partners p ON p.id=o.partner_id
    LEFT JOIN partner_payout_items i ON i.order_id=o.id
    WHERE p.id=? AND o.status='paid' AND i.id IS NULL`,
  owner: `SELECT o.total,COALESCE(p.commission_rate,0) AS rate
    FROM salon_owners p JOIN orders o ON o.point_id=p.point_id
    LEFT JOIN owner_payout_items i ON i.order_id=o.id
    WHERE p.id=? AND o.status='paid' AND i.id IS NULL`,
  manager: `SELECT o.total,COALESCE(mp.commission_rate,0) AS rate
    FROM orders o JOIN points p ON p.id=o.point_id
    JOIN manager_points mp ON mp.point_id=p.id AND mp.manager_id=p.manager_id
    LEFT JOIN manager_commission_payout_items i ON i.order_id=o.id
    WHERE p.manager_id=? AND o.status='paid' AND i.id IS NULL`,
};

function calculateLifetimeEarnings(db, role, recipientId) {
  if (!Object.hasOwn(PAID,role) || !Number.isSafeInteger(Number(recipientId)) || Number(recipientId)<=0) return null;
  const id=Number(recipientId);
  const paidCommission=Number(db.prepare(PAID[role]).get(id)?.amount || 0);
  const unpaidCommission=db.prepare(UNPAID[role]).all(id)
    .reduce((sum,o)=>sum+Math.round(Number(o.total || 0)*Number(o.rate || 0)),0);
  const {pending,paid}=require('./report-bonuses').getBonuses(db,role,id);
  const bonuses=[...pending,...paid].reduce((sum,b)=>sum+Number(b.amount || 0),0);
  return paidCommission + unpaidCommission + bonuses;
}
module.exports={calculateLifetimeEarnings};
