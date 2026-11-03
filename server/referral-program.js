'use strict';
const db = require('./db');
const AMOUNT = 1000;
function referralFromCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!code || code.length > 80) return null;
  const partner = db.prepare('SELECT id,full_name,phone,point_id,partner_code AS code FROM partners WHERE UPPER(partner_code)=? AND active=1').get(code);
  if (partner) return {role:'partner',recipient_id:partner.id,code:partner.code,phone:partner.phone,point_id:partner.point_id,full_name:partner.full_name};
  const owner = db.prepare('SELECT id,full_name,phone,point_id,owner_code AS code FROM salon_owners WHERE UPPER(owner_code)=? AND active=1').get(code);
  if (owner) return {role:'owner',recipient_id:owner.id,code:owner.code,phone:owner.phone,point_id:owner.point_id,full_name:owner.full_name};
  return null;
}
function digits(value) { return String(value||'').replace(/\D/g,'').slice(-10); }
function assertReferralRules(referrer,pointId,phone) {
  if (!referrer) return;
  if (pointId && referrer.point_id && String(referrer.point_id)===String(pointId)) {
    throw Object.assign(new Error('Нельзя получить бонус за приглашение на свою действующую точку'),{statusCode:409});
  }
  if (phone && digits(phone).length===10 && digits(referrer.phone)===digits(phone)) {
    throw Object.assign(new Error('Нельзя приглашать самого себя по своему реферальному коду'),{statusCode:409});
  }
}
function storedReferral(pointId) {
  return db.prepare('SELECT * FROM point_referrals WHERE point_id=?').get(pointId)||null;
}
function lockPointReferral(point,referrer,source) {
  const previous=storedReferral(point.id);
  if (previous) {
    if ((previous.role==='none' && referrer) ||
        (previous.role!=='none' && (!referrer || previous.role!==referrer.role ||
          Number(previous.recipient_id)!==Number(referrer.recipient_id)))) {
      throw Object.assign(new Error('У точки уже зафиксирован другой пригласивший'),{statusCode:409});
    }
    return previous;
  }
  db.prepare('INSERT INTO point_referrals (point_id,point_name,role,recipient_id,recipient_code,amount,source) VALUES (?,?,?,?,?,?,?)')
    .run(point.id,point.name,referrer?referrer.role:'none',referrer?referrer.recipient_id:null,
      referrer?referrer.code:null,referrer?AMOUNT:0,source||'registration');
  return storedReferral(point.id);
}
function referralSummary(role,recipientId) {
  if (!['partner','owner'].includes(role)||!Number.isSafeInteger(Number(recipientId))) {
    return {count:0,awaiting:0,payable:0,paid:0,rows:[]};
  }
  const rows=db.prepare(
    'SELECT pr.point_id,pr.point_name,pr.amount,pr.recorded_at,pr.source,' +
    'COALESCE(mp.bonus_paid,0) AS bonus_accrued,mp.id AS manager_point_id,' +
    'bp.id AS payout_id,bp.paid_at FROM point_referrals pr ' +
    'LEFT JOIN manager_points mp ON mp.id=(SELECT id FROM manager_points WHERE point_id=pr.point_id ORDER BY id LIMIT 1) ' +
    'LEFT JOIN referral_bonus_payouts bp ON bp.manager_point_id=mp.id AND bp.role=pr.role AND bp.recipient_id=pr.recipient_id ' +
    'WHERE pr.role=? AND pr.recipient_id=? ORDER BY pr.recorded_at DESC,pr.point_id'
  ).all(role,Number(recipientId)).map(row=>({
    point_id:row.point_id,point_name:row.point_name,amount:row.amount,
    recorded_at:row.recorded_at,source:row.source,
    status:row.payout_id?'paid':row.bonus_accrued?'payable':'awaiting',
    ...(row.paid_at?{paid_at:row.paid_at}:{}),
  }));
  const sum=(status)=>rows.filter(r=>r.status===status).reduce((n,r)=>n+Number(r.amount||0),0);
  return {count:rows.length,awaiting:sum('awaiting'),payable:sum('payable'),paid:sum('paid'),rows};
}
module.exports={AMOUNT,referralFromCode,assertReferralRules,storedReferral,lockPointReferral,referralSummary};
