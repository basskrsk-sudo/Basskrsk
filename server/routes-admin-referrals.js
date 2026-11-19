// Admin control for the "Invite a partner" campaign.
// One referring groomer per new point, fixed 1,000 RUB bonus after 1,000 RUB
// of net PAID orders. This does not transfer money or mark a payout as paid.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { computePointRevenueSoFar, checkAndPayManagerBonus,
  REFERRAL_REVENUE_THRESHOLD } = require('./bonus-logic');
const { AMOUNT, storedReferral, assertReferralRules } = require('./referral-program');

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function referralControlList() {
  // Read only; viewing admin dashboard must never create an accrual or send alerts.
  const points = db.prepare(`
    SELECT p.id,p.name,p.addr,p.active,p.manager_id,p.created_at,
      pr.role,pr.recipient_id,pr.recipient_code,pr.source,pr.recorded_at,
      pr.invited_partner_id,
      g.full_name AS inviter_name,g.point_id AS inviter_point_id,
      invited.full_name AS invited_name,
      mp.id AS manager_point_id,mp.referred_groomer_id,mp.referred_groomer_amount,
      mp.referral_bonus_accrued_at,
      bp.id AS bonus_payout_id,bp.paid_at AS bonus_paid_at
    FROM points p
    LEFT JOIN point_referrals pr ON pr.point_id=p.id
    LEFT JOIN partners g ON g.id=pr.recipient_id AND pr.role='partner'
    LEFT JOIN partners invited ON invited.id=pr.invited_partner_id
    LEFT JOIN manager_points mp ON mp.id=(
      SELECT id FROM manager_points WHERE point_id=p.id ORDER BY id LIMIT 1)
    LEFT JOIN referral_bonus_payouts bp ON bp.manager_point_id=mp.id
      AND bp.role='partner' AND bp.recipient_id=pr.recipient_id
    WHERE COALESCE(p.is_hub,0)=0
    ORDER BY p.active DESC,p.name,p.id
  `).all();
  // Aggregation in one indexed pass, rather than N queries per point.
  const revenue = new Map(db.prepare(`
    SELECT point_id,COALESCE(SUM(
      CASE WHEN refund_status='refunded' AND refunded_amount IS NULL THEN 0
      ELSE MAX(0,total-COALESCE(refunded_amount,0)) END),0) AS net_revenue
    FROM orders WHERE status='paid' AND point_id IS NOT NULL GROUP BY point_id
  `).all().map(row=>[row.point_id,Number(row.net_revenue||0)]));

  const partners = db.prepare(
    'SELECT id,full_name,partner_code,point_id,active FROM partners ORDER BY full_name,id'
  ).all();
  const rows = points.map(p=>{
    const netRevenue = revenue.get(p.id)||0;
    const assigned = p.role==='partner' && !!p.recipient_id;
    const amount = assigned ? AMOUNT : 0;
    const accrued = assigned && Number(p.referred_groomer_id)===Number(p.recipient_id)
      && Number(p.referred_groomer_amount)===AMOUNT;
    const paid = accrued && !!p.bonus_payout_id;
    const status = !assigned ? (p.role==='owner' ? 'other_referral' : 'unassigned') :
      paid ? 'paid' : accrued && netRevenue<REFERRAL_REVENUE_THRESHOLD ? 'on_hold' :
      accrued ? 'payable' : netRevenue>=REFERRAL_REVENUE_THRESHOLD ? 'needs_reconcile' : 'awaiting';
    return {
      point_id:p.id,point_name:p.name,point_address:p.addr,active:!!p.active,
      manager_assigned:!!p.manager_point_id,source:p.source||null,role:p.role||'none',
      invited_partner_id:p.invited_partner_id||null,invited_name:p.invited_name||null,
      inviter_partner_id:assigned?Number(p.recipient_id):null,
      inviter_name:assigned?(p.inviter_name||null):null,
      inviter_code:assigned?(p.recipient_code||null):null,
      revenue:netRevenue,threshold:REFERRAL_REVENUE_THRESHOLD,
      amount,accrued:!!accrued,bonus_payout_id:p.bonus_payout_id||null,
      bonus_paid_at:p.bonus_paid_at||null,status,
    };
  });
  const bonusByPartner = new Map();
  for(const row of rows) if(row.status==='payable') {
    bonusByPartner.set(row.inviter_partner_id,
      (bonusByPartner.get(row.inviter_partner_id)||0)+row.amount);
  }
  const counts = {
    linked:rows.filter(row=>row.role==='partner').length,
    awaiting:rows.filter(row=>row.status==='awaiting').length,
    payable:rows.filter(row=>row.status==='payable').length,
    paid:rows.filter(row=>row.status==='paid').length,
    payable_amount:rows.filter(row=>row.status==='payable').reduce((sum,row)=>sum+row.amount,0),
  };
  return {threshold:REFERRAL_REVENUE_THRESHOLD,bonus_amount:AMOUNT,points:rows,
    partners,counts,bonus_by_partner:Object.fromEntries(bonusByPartner)};
}

function adminAssignReferral(pointId, body, admin) {
  const inviterId=positiveId(body?.inviter_partner_id);
  const invitedId=body?.invited_partner_id==null||body.invited_partner_id===''?
    null:positiveId(body.invited_partner_id);
  if (!inviterId || (body?.invited_partner_id!=null && body.invited_partner_id!=='' && !invitedId)) {
    throw Object.assign(new Error('Выберите пригласившего и корректного приглашённого грумера'),{statusCode:400});
  }
  if (invitedId===inviterId) {
    throw Object.assign(new Error('Нельзя приглашать самого себя'),{statusCode:409});
  }
  let changed=false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const point = db.prepare('SELECT id,name,manager_id,is_hub FROM points WHERE id=?').get(pointId);
    if (!point || point.is_hub) throw Object.assign(new Error('Новая точка не найдена'),{statusCode:404});
    const mgrPoint = db.prepare('SELECT * FROM manager_points WHERE point_id=? ORDER BY id LIMIT 1').get(pointId);
    if (!mgrPoint || !point.manager_id) throw Object.assign(
      new Error('Сначала назначьте точке ответственного менеджера, чтобы появилась запись начислений'),{statusCode:409});
    const inviter=db.prepare('SELECT id,full_name,phone,point_id,partner_code,active FROM partners WHERE id=?').get(inviterId);
    if (!inviter || !inviter.active) throw Object.assign(new Error('Пригласивший грумер неактивен или не найден'),{statusCode:404});
    assertReferralRules({point_id:inviter.point_id,phone:inviter.phone},pointId,null);
    const invited=invitedId?db.prepare('SELECT id,full_name,point_id,phone,active,referred_by_partner_id,referred_by_owner_id FROM partners WHERE id=?').get(invitedId):null;
    if (invitedId && (!invited || !invited.active || invited.point_id!==pointId)) throw Object.assign(
      new Error('Приглашённый грумер должен работать на выбранной новой точке'),{statusCode:409});
    if (invited) {
      assertReferralRules({point_id:inviter.point_id,phone:inviter.phone},pointId,invited.phone);
      if ((invited.referred_by_partner_id && Number(invited.referred_by_partner_id)!==inviterId) || invited.referred_by_owner_id)
        throw Object.assign(new Error('Для этого грумера уже указан другой пригласивший'),{statusCode:409});
    }
    const previous=storedReferral(pointId);
    if (previous && previous.role!=='none' && (previous.role!=='partner' ||
        Number(previous.recipient_id)!==inviterId)) throw Object.assign(
      new Error('У точки уже закреплён другой пригласивший. Автоматическая перепривязка запрещена'),{statusCode:409});
    if (previous?.invited_partner_id && Number(previous.invited_partner_id)!==invitedId) throw Object.assign(
      new Error('Приглашённый грумер уже закреплён за точкой. Исправление требует отдельной проверки'),{statusCode:409});
    const accrued = !!(mgrPoint.referred_groomer_id||mgrPoint.referred_owner_id);
    const paid = db.prepare('SELECT id FROM referral_bonus_payouts WHERE manager_point_id=?').get(mgrPoint.id);
    // Prevent an additional 1 000 RUB invitation after the manager already
    // received the entire 2 000 RUB launch budget. No automatic clawback.
    if ((!previous || previous.role==='none') && db.prepare(
      'SELECT id FROM manager_launch_bonus_payouts WHERE manager_point_id=? AND amount>?'
    ).get(mgrPoint.id,1000)) throw Object.assign(new Error(
      'Менеджеру уже выплачена полная премия 2 000 ₽ за эту точку. Сначала урегулируйте прошлую выплату вручную'
    ),{statusCode:409});
    if (paid && !previous) throw Object.assign(new Error('По точке уже выплачен реферальный бонус'),{statusCode:409});
    if (accrued && (!previous || previous.role==='none')) throw Object.assign(
      new Error('По точке уже начислен реферальный бонус другому лицу'),{statusCode:409});
    const alreadyPartner = previous?.role==='partner';
    if (!alreadyPartner) {
      const historical=db.prepare("SELECT COUNT(*) AS count FROM orders WHERE point_id=? AND status='paid'").get(pointId);
      if (historical.count>0 && body?.confirm_historical_sales!==true) throw Object.assign(
        new Error('На точке уже были продажи. Подтвердите назначение задним числом в админке'),{statusCode:409,code:'CONFIRM_HISTORICAL_SALES'});
      if (previous) {
        db.prepare("UPDATE point_referrals SET role='partner',recipient_id=?,recipient_code=?,amount=?,source='admin',invited_partner_id=?,recorded_at=datetime('now') WHERE point_id=? AND role='none'")
          .run(inviterId,inviter.partner_code,AMOUNT,invitedId,pointId);
      } else {
        db.prepare("INSERT INTO point_referrals (point_id,point_name,role,recipient_id,recipient_code,amount,source,invited_partner_id) VALUES (?,?,'partner',?,?,?,'admin',?)")
          .run(pointId,point.name,inviterId,inviter.partner_code,AMOUNT,invitedId);
      }
      changed=true;
    } else if (invitedId && !previous.invited_partner_id) {
      db.prepare('UPDATE point_referrals SET invited_partner_id=? WHERE point_id=? AND role=? AND recipient_id=?')
        .run(invitedId,pointId,'partner',inviterId);
      changed=true;
    }
    if (invited && !invited.referred_by_partner_id) {
      db.prepare('UPDATE partners SET referred_by_partner_id=? WHERE id=? AND referred_by_partner_id IS NULL').run(inviterId,invited.id);
      changed=true;
    }
    if(changed){
      db.prepare(`INSERT INTO point_referral_assignment_log
        (point_id,point_name,inviter_partner_id,inviter_name,invited_partner_id,invited_name,admin_id,admin_login)
        VALUES (?,?,?,?,?,?,?,?)`).run(pointId,point.name,inviterId,inviter.full_name,
        invitedId,invited?.full_name||null,admin.id,admin.login||null);
    }
    db.exec('COMMIT');
  } catch (error) {
    try{db.exec('ROLLBACK');}catch(_){}
    throw error;
  }
  return changed;
}

function registerAdminReferralRoutes(router) {
  router.get('/api/admin/referral-control', (req,res,ctx)=>{
    const admin=requireActiveAdmin(req,res,ctx);
    if(!admin)return;
    res.setHeader('Cache-Control','no-store');
    sendJson(res,200,referralControlList());
  });
  router.put('/api/admin/referral-control/points/:id', async(req,res,ctx)=>{
    const admin=requireActiveAdmin(req,res,ctx);
    if(!admin)return;
    res.setHeader('Cache-Control','no-store');
    const id=String(ctx.params.id||'');
    if(!id||id.length>150)return sendJson(res,400,{error:'Некорректная точка'});
    try{
      const changed=adminAssignReferral(id,ctx.body||{},admin);
      // Same calculation as the paid-order webhook, to handle point assignments
      // recorded AFTER the qualifying sale. Both paths are idempotent.
      await checkAndPayManagerBonus(id);
      const row=referralControlList().points.find(p=>p.point_id===id);
      return sendJson(res,200,{ok:true,changed,point:row});
    } catch(error){
      if(!error.statusCode) console.error('[admin-referral-control]',error);
      return sendJson(res,error.statusCode||500,{
        error:error.statusCode?error.message:'Не удалось назначить пригласившего',
        ...(error.code?{code:error.code}:{}),
      });
    }
  });
  router.post('/api/admin/referral-control/points/:id/reconcile',async(req,res,ctx)=>{
    const admin=requireActiveAdmin(req,res,ctx);
    if(!admin)return;
    res.setHeader('Cache-Control','no-store');
    const id=String(ctx.params.id||'');
    const ref=storedReferral(id);
    if(!ref || ref.role!=='partner')return sendJson(res,409,{error:'Сначала назначьте пригласившего грумера'});
    try{
      await checkAndPayManagerBonus(id);
      const row=referralControlList().points.find(p=>p.point_id===id);
      return sendJson(res,200,{ok:true,point:row});
    } catch(error){
      if(!error.statusCode)console.error('[admin-referral-reconcile]',error);
      return sendJson(res,error.statusCode||500,{error:'Не удалось проверить начисление'});
    }
  });
}

module.exports={registerAdminReferralRoutes,referralControlList,adminAssignReferral};
