'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-tier-approval-'));
process.env.DATA_DIR=tmp;
process.env.TOKEN_SECRET='test-tier-approval-secret';
delete process.env.TG_TOKEN;
const db=require('./db');
const tiers=require('./partner-tiers');
const approvals=require('./partner-tier-approvals');
const now=new Date();
const month=tiers.currentMonthKey(now);
const pastMonth=tiers.currentMonthKey(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-3,1)));
const graceMonth=tiers.currentMonthKey(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)));

let counter=0;
function groomer(rate=0.18, confirmed=pastMonth){
  counter++;
  const id=Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,commission_rate,tier_confirmed_month,active) '+
    'VALUES (?,?,?,?,?,?,?,?,1)'
  ).run('RATE-'+counter,'tier-test-'+counter,'hash','Грумер '+counter,
    '7900555'+String(counter).padStart(4,'0'),'Салон '+counter,rate,confirmed).lastInsertRowid);
  return id;
}
function get(id){return db.prepare('SELECT * FROM partners WHERE id=?').get(id);}
function allFor(id){return db.prepare('SELECT * FROM partner_tier_approval_requests WHERE partner_id=? ORDER BY id').all(id);}
function latest(id){return allFor(id).at(-1);}
const adminId=Number(db.prepare(
  "INSERT INTO admins(login,password_hash,full_name,role,active) VALUES (?,?,?,?,1)"
).run('tier-super','hash','Тестовый супер-админ','super').lastInsertRowid);
db.prepare(
  "INSERT INTO admins(login,password_hash,full_name,role,telegram_chat_id,active) VALUES (?,?,?,?,?,1)"
).run('tier-normal','hash','Обычный админ','admin','712222222');

test('automatic check generates a pending approval without lowering the rate',async()=>{
  const id=groomer();
  const before=get(id);
  const result=await tiers.checkAndUpgradePartnerTier(id);
  assert.equal(result.direction,'pending_down');
  assert.equal(result.oldRate,0.18);
  assert.equal(result.newRate,0.15);
  assert.equal(get(id).commission_rate,0.18);
  assert.equal(get(id).tier_confirmed_month,before.tier_confirmed_month);
  assert.equal(latest(id).status,'pending');
  assert.equal(latest(id).month_key,month);
  const progress=tiers.getTierProgress(id);
  assert.equal(progress.currentRate,0.18);
  assert.equal(progress.pendingDowngradeApproval.requestId,latest(id).id);
  assert.equal(progress.pendingDowngradeApproval.proposedRate,0.15);
});

test('daily and post-sale rechecks do not generate repeated requests',async()=>{
  const id=db.prepare("SELECT id FROM partners WHERE partner_code='RATE-1'").get().id;
  const original=latest(id);
  await tiers.checkAndUpgradePartnerTier(id);
  await tiers.checkAllPartnerTiers();
  assert.equal(allFor(id).length,1);
  assert.equal(get(id).commission_rate,0.18);
  assert.equal(latest(id).id,original.id);
});

test('a new proposal is visible to linked superadmins only',async()=>{
  const proposal=latest(1);
  assert.equal(approvals.requestCardList('712222222').ok,false);
  assert.equal(approvals.requestCardList('712222223').ok,false);
  db.prepare('UPDATE admins SET telegram_chat_id=? WHERE id=?')
    .run('711111111',adminId);
  assert.equal(approvals.activeSuperAdmin('711111111').id,adminId);
  const cards=approvals.requestCardList('711111111');
  assert.equal(cards.ok,true);
  assert.equal(cards.cards.length,1);
  const card=cards.cards[0];
  assert.match(card.message,/Согласование снижения комиссии грумера/);
  assert.match(card.message,/18%/);
  assert.match(card.message,/15%/);
  assert.match(card.message,/До вашего одобрения комиссия не меняется/);
  assert.equal(card.reply_markup.inline_keyboard[0][0].callback_data,'tier:approve:'+proposal.id);
  assert.equal(card.reply_markup.inline_keyboard[1][0].callback_data,'tier:reject:'+proposal.id);
  assert.equal((await approvals.decideTierDowngrade('712222222','approve',proposal.id)).ok,false);
  assert.equal(get(1).commission_rate,0.18);
});

test('Telegram notifications are retried and do not duplicate successful notices',async()=>{
  let attempts=0;
  const failure=await approvals.notifyPendingTierApprovals(async()=>{
    attempts++;return {ok:false,data:{ok:false},status:503};
  });
  assert.equal(failure.failed,1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM partner_tier_approval_notices').get().c,0);
  let sent=0;
  const success=await approvals.notifyPendingTierApprovals(async(chat,text,options)=>{
    sent++;
    assert.equal(String(chat),'711111111');
    assert.match(text,/Грумер 1/);
    assert.ok(options.reply_markup.inline_keyboard.length===2);
    return {ok:true,data:{ok:true}};
  });
  assert.equal(success.delivered,1);
  assert.equal(sent,1);
  await approvals.notifyPendingTierApprovals(async()=>{sent++;return {ok:true,data:{ok:true}};});
  assert.equal(sent,1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM partner_tier_approval_notices').get().c,1);
});

test('superadmin acceptance lowers rate atomically exactly once and audits actor',async()=>{
  const id=1,requestId=latest(id).id;
  const approved=await approvals.decideTierDowngrade('711111111','approve',requestId);
  assert.equal(approved.ok,true);
  assert.match(approved.message,/18% → 15%/);
  assert.equal(get(id).commission_rate,0.15);
  assert.equal(get(id).tier_confirmed_month,month);
  const row=latest(id);
  assert.equal(row.status,'approved');
  assert.equal(row.decided_by_admin_id,adminId);
  assert.equal(row.decided_by_admin_login,'tier-super');
  assert.ok(row.decided_at);
  assert.equal((await approvals.decideTierDowngrade('711111111','approve',requestId)).ok,false);
  assert.equal(allFor(id).length,1);
  assert.equal(get(id).commission_rate,0.15);
  await tiers.checkAndUpgradePartnerTier(id);
  assert.equal(allFor(id).length,1);
});

test('rejection preserves the current percentage and prevents repeated requests this month',async()=>{
  const id=groomer(0.2);
  await tiers.checkAndUpgradePartnerTier(id);
  const request=latest(id);
  assert.equal(request.old_rate,0.2);
  assert.equal(request.new_rate,0.15);
  const rejected=await approvals.decideTierDowngrade('711111111','reject',request.id);
  assert.equal(rejected.ok,true);
  assert.match(rejected.message,/остаётся 20%/);
  assert.equal(get(id).commission_rate,0.2);
  assert.equal(latest(id).status,'rejected');
  await tiers.checkAndUpgradePartnerTier(id);
  await tiers.checkAndUpgradePartnerTier(id);
  assert.equal(allFor(id).length,1);
  assert.equal(get(id).commission_rate,0.2);
});

test('outdated approval cannot override a newly edited rate',async()=>{
  const id=groomer();
  await tiers.checkAndUpgradePartnerTier(id);
  const request=latest(id).id;
  db.prepare('UPDATE partners SET commission_rate=0.2 WHERE id=?').run(id);
  const attempted=await approvals.decideTierDowngrade('711111111','approve',request);
  assert.equal(attempted.ok,false);
  assert.match(attempted.message,/устарела/);
  assert.equal(latest(id).status,'stale');
  assert.equal(get(id).commission_rate,0.2);
});

test('outdated proposal from a previous month never changes rate',async()=>{
  const id=groomer();
  await tiers.checkAndUpgradePartnerTier(id);
  const request=latest(id).id;
  db.prepare('UPDATE partner_tier_approval_requests SET month_key=? WHERE id=?')
    .run(pastMonth,request);
  const result=await approvals.decideTierDowngrade('711111111','approve',request);
  assert.equal(result.ok,false);
  assert.equal(get(id).commission_rate,0.18);
  assert.equal(latest(id).status,'stale');
});

test('grace period holds the rate and does not ask for approval early',async()=>{
  const id=groomer(0.2,graceMonth);
  assert.equal(await tiers.checkAndUpgradePartnerTier(id),null);
  assert.equal(get(id).commission_rate,0.2);
  assert.equal(allFor(id).length,0);
});

test('an earned tier can still increase automatically and clears pending approvals',async()=>{
  const id=groomer(0.18);
  await tiers.checkAndUpgradePartnerTier(id);
  assert.equal(latest(id).status,'pending');
  // Seven referrals qualify for Expert, even with zero sales.
  for(let i=0;i<7;i++){
    const refId=groomer(0.15);
    db.prepare('UPDATE partners SET referred_by_partner_id=? WHERE id=?').run(id,refId);
  }
  const changed=await tiers.checkAndUpgradePartnerTier(id);
  assert.equal(changed.direction,'up');
  assert.equal(changed.newRate,0.2);
  assert.equal(get(id).commission_rate,0.2);
  assert.equal(latest(id).status,'stale');
  assert.equal((await approvals.decideTierDowngrade('711111111','approve',latest(id).id)).ok,false);
});

test('a proposal cannot be approved once groomer becomes inactive',async()=>{
  const id=groomer();
  await tiers.checkAndUpgradePartnerTier(id);
  const request=latest(id).id;
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(id);
  assert.equal((await approvals.decideTierDowngrade('711111111','approve',request)).ok,false);
  assert.equal(get(id).commission_rate,0.18);
});

test('bot menu, command and callback only expose the super-admin approval path',()=>{
  const poller=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
  const tiersSource=fs.readFileSync(path.join(__dirname,'partner-tiers.js'),'utf8');
  const groomerHtml=fs.readFileSync(path.join(__dirname,'../public/taiga-groomer.html'),'utf8');
  assert.match(poller,/tierApprovals\.decideTierDowngrade\(chat\.id/);
  assert.match(poller,/tierApprovals\.activeSuperAdmin\(chatId\)/);
  assert.match(poller,/\/tierapprovals/);
  assert.match(poller,/String\(chat\.id\) === String\(callback\.from\?\.id\)/);
  assert.doesNotMatch(tiersSource,/await notifyTierChange\(partner, earnedTier, revenue, referralsCount, 'down'\)/);
  assert.match(groomerHtml,/Без одобрения процент не изменится/);
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(tmp,{recursive:true,force:true});
});
