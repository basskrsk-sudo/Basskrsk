'use strict';
const db = require('./db');
const AMOUNT = 1000;
function referralFromCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!code || code.length > 80) return null;
  const partner = db.prepare(
    'SELECT id,full_name,phone,point_id,partner_code AS code FROM partners WHERE UPPER(partner_code)=? AND active=1'
  ).get(code);
  if (partner) return {role:'partner',recipient_id:partner.id,code:partner.code,
    phone:partner.phone,point_id:partner.point_id,full_name:partner.full_name};
  const owner = db.prepare(
    'SELECT id,full_name,phone,point_id,owner_code AS code FROM salon_owners WHERE UPPER(owner_code)=? AND active=1'
  ).get(code);
  if (owner) return {role:'owner',recipient_id:owner.id,code:owner.code,
    phone:owner.phone,point_id:owner.point_id,full_name:owner.full_name};
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
function lockPointReferral(point,referrer,source,leadId=null) {
  const previous=storedReferral(point.id);
  if (previous) {
    if ((previous.role==='none' && referrer) ||
        (previous.role!=='none' && (!referrer || previous.role!==referrer.role ||
          Number(previous.recipient_id)!==Number(referrer.recipient_id)))) {
      throw Object.assign(new Error('У точки уже зафиксирован другой пригласивший'),{statusCode:409});
    }
    return previous;
  }
  db.prepare('INSERT INTO point_referrals ' +
    '(point_id,point_name,role,recipient_id,recipient_code,amount,source,lead_id) ' +
    'VALUES (?,?,?,?,?,?,?,?)'
  ).run(point.id,point.name,referrer?referrer.role:'none',referrer?referrer.recipient_id:null,
    referrer?referrer.code:null,referrer?AMOUNT:0,source||'registration',leadId);
  return storedReferral(point.id);
}
function firstGroomerReferral(point,code,phone) {
  const record=storedReferral(point.id);
  if (!record || !code) return record;
  const referrer=referralFromCode(code);
  if (!referrer) throw Object.assign(new Error('Код пригласившего не найден или отключён'),{statusCode:400});
  assertReferralRules(referrer,point.id,phone);
  if (record.role==='none') {
    const older=db.prepare('SELECT COUNT(*) AS n FROM partners WHERE point_id=?').get(point.id).n;
    const orders=db.prepare('SELECT COUNT(*) AS n FROM orders WHERE point_id=?').get(point.id).n;
    if (older>0 || orders>0) throw Object.assign(new Error(
      'На точке уже есть регистрации или заказы. Реферальный бонус за новую точку не назначается'
    ),{statusCode:409});
    db.prepare('UPDATE point_referrals SET role=?,recipient_id=?,recipient_code=?,amount=?,source=? WHERE point_id=? AND role=?')
      .run(referrer.role,referrer.recipient_id,referrer.code,AMOUNT,'first-groomer',point.id,'none');
    return storedReferral(point.id);
  }
  if (record.role!==referrer.role || Number(record.recipient_id)!==Number(referrer.recipient_id)) {
    throw Object.assign(new Error('Пригласивший эту точку уже зафиксирован'),{statusCode:409});
  }
  return record;
}
function normalizedName(value) {
  return String(value||'').normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/[.,;]+/g,' ').replace(/\s+/g,' ').trim();
}
function resolveLead(raw,cityId,pointName,managerId) {
  if (raw==null || raw==='') return null;
  const id=Number(raw);
  if (!Number.isSafeInteger(id)||id<=0) throw Object.assign(
    new Error('Некорректный номер реферальной заявки'),{statusCode:400});
  const lead=db.prepare('SELECT * FROM partner_leads WHERE id=?').get(id);
  if (!lead || !lead.referral_code || lead.linked_point_id ||
      ['declined'].includes(lead.status)) throw Object.assign(
    new Error('Реферальная заявка не найдена или уже использована'),{statusCode:409});
  if (lead.city_id && String(lead.city_id)!==String(cityId)) throw Object.assign(
    new Error('У реферальной заявки указан другой город'),{statusCode:409});
  if (normalizedName(lead.salon_name)!==normalizedName(pointName)) throw Object.assign(
    new Error('Название нового салона должно совпадать с выбранной реферальной заявкой'),{statusCode:409});
  if (lead.assigned_manager_id && Number(lead.assigned_manager_id)!==Number(managerId)) {
    throw Object.assign(new Error('Заявка закреплена за другим менеджером'),{statusCode:403});
  }
  const referrer=referralFromCode(lead.referral_code);
  if (!referrer || referrer.role!==lead.referred_by_role ||
      Number(referrer.recipient_id)!==Number(lead.referred_by_id)) throw Object.assign(
    new Error('Пригласивший по заявке недоступен — обратитесь к администратору'),{statusCode:409});
  assertReferralRules(referrer,null,lead.phone);
  return {lead,referrer};
}
function markLeadLinked(leadId,pointId) {
  if (!leadId) return;
  const result=db.prepare(
    'UPDATE partner_leads SET linked_point_id=?,status=?,updated_at=datetime(\'now\') ' +
    'WHERE id=? AND linked_point_id IS NULL'
  ).run(pointId,'signed',leadId);
  if (result.changes!==1) throw Object.assign(new Error(
    'Реферальная заявка уже была использована'),{statusCode:409});
}
function referralSummary(role,recipientId) {
  if (!['partner','owner'].includes(role)||!Number.isSafeInteger(Number(recipientId))) {
    return {count:0,awaiting:0,payable:0,paid:0,rows:[]};
  }
  const rows=db.prepare(
    'SELECT pr.point_id,pr.point_name,pr.amount,pr.recorded_at,pr.source,' +
    'mp.referred_groomer_id,mp.referred_owner_id,mp.referred_groomer_amount,mp.referred_owner_amount,' +
    'COALESCE(mp.bonus_paid,0) AS bonus_accrued,mp.id AS manager_point_id,' +
    'bp.id AS payout_id,bp.paid_at FROM point_referrals pr ' +
    'LEFT JOIN manager_points mp ON mp.id=(SELECT id FROM manager_points WHERE point_id=pr.point_id ORDER BY id LIMIT 1) ' +
    'LEFT JOIN referral_bonus_payouts bp ON bp.manager_point_id=mp.id AND bp.role=pr.role AND bp.recipient_id=pr.recipient_id ' +
    'WHERE pr.role=? AND pr.recipient_id=? ORDER BY pr.recorded_at DESC,pr.point_id'
  ).all(role,Number(recipientId)).map(row=>{
    const eligible=row.bonus_accrued && (role==='owner' ?
      Number(row.referred_owner_id)===Number(recipientId) && row.referred_owner_amount===AMOUNT :
      Number(row.referred_groomer_id)===Number(recipientId) && row.referred_groomer_amount===AMOUNT);
    return {
      point_id:row.point_id,point_name:row.point_name,amount:row.amount,
      recorded_at:row.recorded_at,source:row.source,
      status:row.payout_id?'paid':eligible?'payable':'awaiting',
      ...(row.paid_at?{paid_at:row.paid_at}:{}),
    };
  });
  const sum=status=>rows.filter(r=>r.status===status).reduce((n,r)=>n+Number(r.amount||0),0);
  return {count:rows.length,awaiting:sum('awaiting'),payable:sum('payable'),paid:sum('paid'),rows};
}
function referralLeadOptions(cityId,managerId) {
  let query="SELECT id,salon_name,city_id,referral_code FROM partner_leads " +
    "WHERE referral_code IS NOT NULL AND linked_point_id IS NULL AND status<>'declined'";
  let args=[];
  if (cityId) {query+=" AND (city_id=? OR city_id IS NULL)"; args.push(cityId);}
  if (managerId) {query+=" AND (assigned_manager_id=? OR assigned_manager_id IS NULL)";args.push(managerId);}
  query+=" ORDER BY id DESC LIMIT 150";
  return db.prepare(query).all(...args);
}
module.exports={
  AMOUNT,referralFromCode,assertReferralRules,storedReferral,lockPointReferral,
  firstGroomerReferral,resolveLead,markLeadLinked,referralSummary,referralLeadOptions,
};
