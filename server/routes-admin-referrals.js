// Admin control for the "Invite a partner" campaign.
// One recommending owner/groomer/referrer per new point, fixed 1,000 RUB bonus after 1,000 RUB
// of net PAID orders. This does not transfer money or mark a payout as paid.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const { computePointRevenueSoFar, checkAndPayManagerBonus,
  REFERRAL_REVENUE_THRESHOLD } = require('./bonus-logic');
const { AMOUNT, storedReferral, assertReferralRules } = require('./referral-program');
const {NET_PAID_REVENUE_SQL}=require('./net-paid-revenue');

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
      COALESCE(g.full_name,so.full_name) AS inviter_name,COALESCE(g.point_id,so.point_id) AS inviter_point_id,
      g.partner_type AS inviter_partner_type,sp.name AS inviter_salon_name,
      invited.full_name AS invited_name,
      mp.id AS manager_point_id,mp.referred_groomer_id,mp.referred_groomer_amount,
      mp.referred_owner_id,mp.referred_owner_amount,
      mp.referral_bonus_accrued_at,
      bp.id AS bonus_payout_id,bp.paid_at AS bonus_paid_at
    FROM points p
    LEFT JOIN point_referrals pr ON pr.point_id=p.id
    LEFT JOIN partners g ON g.id=pr.recipient_id AND pr.role='partner'
    LEFT JOIN salon_owners so ON so.id=pr.recipient_id AND pr.role='owner'
    LEFT JOIN points sp ON sp.id=COALESCE(g.point_id,so.point_id)
    LEFT JOIN partners invited ON invited.id=pr.invited_partner_id
    LEFT JOIN manager_points mp ON mp.id=(
      SELECT id FROM manager_points WHERE point_id=p.id ORDER BY id LIMIT 1)
    LEFT JOIN referral_bonus_payouts bp ON bp.manager_point_id=mp.id
      AND bp.role=pr.role AND bp.recipient_id=pr.recipient_id
    WHERE COALESCE(p.is_hub,0)=0
    ORDER BY p.active DESC,p.name,p.id
  `).all();
  // Aggregation in one indexed pass, rather than N queries per point.
  const revenue = new Map(db.prepare(`
    SELECT point_id,COALESCE(SUM(${NET_PAID_REVENUE_SQL}),0) AS net_revenue
    FROM orders WHERE status='paid' AND point_id IS NOT NULL GROUP BY point_id
  `).all().map(row=>[row.point_id,Number(row.net_revenue||0)]));

  const partners = db.prepare(
    'SELECT g.id,g.full_name,g.partner_code,g.point_id,g.active,g.partner_type,p.name AS point_name FROM partners g LEFT JOIN points p ON p.id=g.point_id ORDER BY g.full_name,g.id'
  ).all();
  const owners=db.prepare('SELECT so.id,so.full_name,so.owner_code,so.point_id,so.active,p.name AS point_name FROM salon_owners so LEFT JOIN points p ON p.id=so.point_id ORDER BY so.full_name,so.id').all();
  const rows = points.map(p=>{
    const netRevenue = revenue.get(p.id)||0;
    const assigned = ['partner','owner'].includes(p.role) && !!p.recipient_id;
    const amount = assigned ? AMOUNT : 0;
    const accrued = assigned && Number(p.role==='owner'?p.referred_owner_id:p.referred_groomer_id)===Number(p.recipient_id)
      && Number(p.role==='owner'?p.referred_owner_amount:p.referred_groomer_amount)===AMOUNT;
    const paid = accrued && !!p.bonus_payout_id;
    const status = !assigned ? 'unassigned' :
      paid ? 'paid' : accrued && netRevenue<REFERRAL_REVENUE_THRESHOLD ? 'on_hold' :
      accrued ? 'payable' : netRevenue>=REFERRAL_REVENUE_THRESHOLD ? 'needs_reconcile' : 'awaiting';
    return {
      point_id:p.id,point_name:p.name,point_address:p.addr,active:!!p.active,
      manager_assigned:!!p.manager_point_id,source:p.source||null,role:p.role||'none',
      invited_partner_id:p.invited_partner_id||null,invited_name:p.invited_name||null,
      inviter_id:assigned?Number(p.recipient_id):null,
      inviter_partner_id:assigned&&p.role==='partner'?Number(p.recipient_id):null,
      inviter_owner_id:assigned&&p.role==='owner'?Number(p.recipient_id):null,
      inviter_kind:p.role==='owner'?'owner':p.inviter_partner_type==='referrer'?'referrer':'partner',
      inviter_salon_name:p.inviter_salon_name||null,
      inviter_name:assigned?(p.inviter_name||null):null,
      inviter_code:assigned?(p.recipient_code||null):null,
      revenue:netRevenue,threshold:REFERRAL_REVENUE_THRESHOLD,
      amount,accrued:!!accrued,bonus_payout_id:p.bonus_payout_id||null,
      bonus_paid_at:p.bonus_paid_at||null,status,
    };
  });
  const bonusByPartner = new Map(),bonusByOwner=new Map();
  for(const row of rows) if(row.status==='payable') {
    const ledger=row.role==='owner'?bonusByOwner:bonusByPartner;
    ledger.set(row.inviter_id,(ledger.get(row.inviter_id)||0)+row.amount);
  }
  const counts = {
    linked:rows.filter(row=>['partner','owner'].includes(row.role)).length,
    awaiting:rows.filter(row=>row.status==='awaiting').length,
    payable:rows.filter(row=>row.status==='payable').length,
    paid:rows.filter(row=>row.status==='paid').length,
    payable_amount:rows.filter(row=>row.status==='payable').reduce((sum,row)=>sum+row.amount,0),
  };
  return {threshold:REFERRAL_REVENUE_THRESHOLD,bonus_amount:AMOUNT,points:rows,
    partners,owners,counts,bonus_by_partner:Object.fromEntries(bonusByPartner),bonus_by_owner:Object.fromEntries(bonusByOwner)};
}

function adminAssignReferral(pointId, body, admin) {
  const role=body?.inviter_role??'partner';
  if(!['partner','owner'].includes(role))throw Object.assign(new Error('Выберите роль рекомендателя'),{statusCode:400});
  const inviterId=positiveId(body?.inviter_id??(role==='owner'?body?.inviter_owner_id:body?.inviter_partner_id));
  const invitedId=body?.invited_partner_id==null||body.invited_partner_id===''?
    null:positiveId(body.invited_partner_id);
  if (!inviterId || (body?.invited_partner_id!=null && body.invited_partner_id!=='' && !invitedId)) {
    throw Object.assign(new Error('Выберите пригласившего и корректного приглашённого грумера'),{statusCode:400});
  }
  if (role==='partner' && invitedId===inviterId) {
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
    const inviter=db.prepare(role==='owner'?'SELECT id,full_name,phone,point_id,owner_code AS code,active FROM salon_owners WHERE id=?':'SELECT id,full_name,phone,point_id,partner_code AS code,active FROM partners WHERE id=?').get(inviterId);
    if (!inviter || !inviter.active) throw Object.assign(new Error('Рекомендатель неактивен или не найден'),{statusCode:404});
    assertReferralRules({point_id:inviter.point_id,phone:inviter.phone},pointId,null);
    const invited=invitedId?db.prepare('SELECT id,full_name,point_id,phone,active,referred_by_partner_id,referred_by_owner_id FROM partners WHERE id=?').get(invitedId):null;
    if (invitedId && (!invited || !invited.active || invited.point_id!==pointId)) throw Object.assign(
      new Error('Приглашённый грумер должен работать на выбранной новой точке'),{statusCode:409});
    if (invited) {
      assertReferralRules({point_id:inviter.point_id,phone:inviter.phone},pointId,invited.phone);
      if ((invited.referred_by_partner_id && (role!=='partner'||Number(invited.referred_by_partner_id)!==inviterId)) || (invited.referred_by_owner_id&&(role!=='owner'||Number(invited.referred_by_owner_id)!==inviterId)))
        throw Object.assign(new Error('Для этого грумера уже указан другой пригласивший'),{statusCode:409});
    }
    const previous=storedReferral(pointId);
    if (previous && previous.role!=='none' && (previous.role!==role ||
        Number(previous.recipient_id)!==inviterId)) throw Object.assign(
      new Error('У точки уже закреплён другой пригласивший. Автоматическая перепривязка запрещена'),{statusCode:409});
    if (previous?.invited_partner_id && Number(previous.invited_partner_id)!==invitedId) throw Object.assign(
      new Error('Приглашённый грумер уже закреплён за точкой. Исправление требует отдельной проверки'),{statusCode:409});
    const accrued = !!db.prepare('SELECT 1 FROM manager_points WHERE point_id=? AND (referred_groomer_id IS NOT NULL OR referred_owner_id IS NOT NULL) LIMIT 1').get(pointId);
    const paid = db.prepare('SELECT bp.id FROM referral_bonus_payouts bp JOIN manager_points old ON old.id=bp.manager_point_id WHERE old.point_id=? LIMIT 1').get(pointId);
    const previousInviters=db.prepare('SELECT referred_by_partner_id,referred_by_owner_id,phone FROM partners WHERE point_id=? AND (referred_by_partner_id IS NOT NULL OR referred_by_owner_id IS NOT NULL)').all(pointId);
    if(previousInviters.some(g=>(g.referred_by_partner_id&&(role!==\'partner\'||Number(g.referred_by_partner_id)!==inviterId))||(g.referred_by_owner_id&&(role!==\'owner\'||Number(g.referred_by_owner_id)!==inviterId))))throw Object.assign(new Error('У точки уже есть другой рекомендатель в истории регистраций'),{statusCode:409});
    // Prevent an additional 1 000 RUB invitation after the manager already
    // received the entire 2 000 RUB launch budget. No automatic clawback.
    if ((!previous || previous.role==='none') && db.prepare(
      'SELECT bp.id FROM manager_launch_bonus_payouts bp JOIN manager_points old ON old.id=bp.manager_point_id WHERE old.point_id=? AND bp.amount>? LIMIT 1'
    ).get(pointId,1000)) throw Object.assign(new Error(
      'Менеджеру уже выплачена полная премия 2 000 ₽ за эту точку. Сначала урегулируйте прошлую выплату вручную'
    ),{statusCode:409});
    if (paid && (!previous||previous.role==='none')) throw Object.assign(new Error('По точке уже выплачен реферальный бонус'),{statusCode:409});
    if (accrued && (!previous || previous.role==='none')) throw Object.assign(
      new Error('По точке уже начислен реферальный бонус другому лицу'),{statusCode:409});
    const alreadyAssigned = previous?.role===role;
    if (!alreadyAssigned) {
      const historical=db.prepare("SELECT COUNT(*) AS count FROM orders WHERE point_id=? AND status='paid'").get(pointId);
      if (historical.count>0 && body?.confirm_historical_sales!==true) throw Object.assign(
        new Error('На точке уже были продажи. Подтвердите назначение задним числом в админке'),{statusCode:409,code:'CONFIRM_HISTORICAL_SALES'});
      if (previous) {
        db.prepare("UPDATE point_referrals SET role=?,recipient_id=?,recipient_code=?,amount=?,source='admin',invited_partner_id=?,recorded_at=datetime('now') WHERE point_id=? AND role='none'")
          .run(role,inviterId,inviter.code,AMOUNT,invitedId,pointId);
      } else {
        db.prepare("INSERT INTO point_referrals (point_id,point_name,role,recipient_id,recipient_code,amount,source,invited_partner_id) VALUES (?,?,?,?,?,?,'admin',?)")
          .run(pointId,point.name,role,inviterId,inviter.code,AMOUNT,invitedId);
      }
      changed=true;
    } else if (invitedId && !previous.invited_partner_id) {
      db.prepare('UPDATE point_referrals SET invited_partner_id=? WHERE point_id=? AND role=? AND recipient_id=?')
        .run(invitedId,pointId,role,inviterId);
      changed=true;
    }
    const field=role==='owner'?'referred_by_owner_id':'referred_by_partner_id';
    if (invited && !invited[field]) {
      db.prepare('UPDATE partners SET '+field+'=? WHERE id=? AND '+field+' IS NULL').run(inviterId,invited.id);
      changed=true;
    }
    if(changed){
      db.prepare(`INSERT INTO point_referral_assignment_log
        (point_id,point_name,inviter_role,inviter_partner_id,inviter_owner_id,inviter_name,invited_partner_id,invited_name,admin_id,admin_login)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pointId,point.name,role,role==='partner'?inviterId:null,role==='owner'?inviterId:null,inviter.full_name,
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
    if(!ref || !['partner','owner'].includes(ref.role))return sendJson(res,409,{error:'Сначала назначьте рекомендателя'});
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
