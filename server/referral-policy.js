'use strict';
// One source of truth for all recommender roles. No dependency on the live
// singleton database: reports/tests can use their own database transaction.
const {NET_PAID_REVENUE_SQL}=require('./net-paid-revenue');
const REFERRAL_REVENUE_THRESHOLD=1000;
const REFERRAL_SPLIT=1000;
function computeReferralRevenue(db,pointId){
 return Number(db.prepare(`SELECT COALESCE(SUM(${NET_PAID_REVENUE_SQL}),0) AS revenue
   FROM orders WHERE point_id=? AND status='paid'`).get(pointId).revenue||0);
}
// On startup, bring previously locked owner invitations under the same
// threshold. Only inspect unaccrued, eligible points; no timer, no cash
// transfers, no changes to snapshots, no new accrual after full manager pay.
function backfillOwnerReferrals(db){
 const rows=db.prepare(`SELECT mp.id,pr.recipient_id
  FROM point_referrals pr
  JOIN salon_owners so ON so.id=pr.recipient_id
  JOIN manager_points mp ON mp.id=(SELECT MIN(id) FROM manager_points WHERE point_id=pr.point_id)
  WHERE pr.role='owner' AND mp.referred_owner_id IS NULL AND mp.referred_groomer_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM referral_bonus_payouts bp
      JOIN manager_points old ON old.id=bp.manager_point_id WHERE old.point_id=pr.point_id)
    AND NOT EXISTS (SELECT 1 FROM manager_points old WHERE old.point_id=pr.point_id
      AND (old.referred_owner_id IS NOT NULL OR old.referred_groomer_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM manager_launch_bonus_payouts bp
      JOIN manager_points old ON old.id=bp.manager_point_id
      WHERE old.point_id=pr.point_id AND bp.amount>?)
    AND (SELECT COALESCE(SUM(${NET_PAID_REVENUE_SQL}),0) FROM orders
      WHERE point_id=pr.point_id AND status='paid')>=?
  ORDER BY mp.id`).all(REFERRAL_SPLIT,REFERRAL_REVENUE_THRESHOLD);
 if(!rows.length)return 0;
 db.exec('BEGIN IMMEDIATE');
 try{
  const update=db.prepare(`UPDATE manager_points SET referred_owner_id=?,referred_owner_amount=?,
    referral_bonus_accrued_at=datetime('now')
    WHERE id=? AND referred_owner_id IS NULL AND referred_groomer_id IS NULL`);
  let count=0;
  for(const row of rows)count+=Number(update.run(row.recipient_id,REFERRAL_SPLIT,row.id).changes);
  db.exec('COMMIT');return count;
 }catch(error){try{db.exec('ROLLBACK')}catch(_){}throw error;}
}
module.exports={REFERRAL_REVENUE_THRESHOLD,REFERRAL_SPLIT,computeReferralRevenue,backfillOwnerReferrals};
