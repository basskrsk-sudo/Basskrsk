'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-admin-workspaces-'));
const db=require('./db');
const {signToken}=require('./auth');
const {registerAdminPointWorkspaceRoutes,readPointWorkspace}
  =require('./routes-admin-point-workspace');
const {registerAdminReportCenterRoutes,reportParams,SUPPORTED}
  =require('./routes-admin-report-center');

const id=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES(?,?,?,?,?)'
).run('workspace-admin','hash','super',1,'8866001').lastInsertRowid);
const inactive=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,?,?)'
).run('workspace-disabled','hash','admin',0).lastInsertRowid);
const regular=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES(?,?,?,?,?)'
).run('workspace-regular','hash','admin',1,'8866002').lastInsertRowid);
const superToken=signToken({role:'admin',id,adminRole:'super'});
const normalToken=signToken({role:'admin',id:regular,adminRole:'admin'});
const inactiveToken=signToken({role:'admin',id:inactive,adminRole:'admin'});

const managerId=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)'
).run('RPT-MGR-01','report-manager','hash','Менеджер отдела','79009990001').lastInsertRowid);
db.prepare(
  'INSERT INTO points(id,name,addr,icon,city_id,manager_id,first_purchase_promo_code,active) VALUES(?,?,?,?,?,?,?,?)'
).run('workspace-point','Тестовая точка','ул. Проектная, 1','🐾','krsk',managerId,'PT-PROMO',1);
db.prepare(
  'INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,?)'
).run('inactive-workspace','Скрытая точка','ул. Проектная, 2','🐾',0);
db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id) VALUES(?,?,?,?,?)'
).run('workspace-owner','hash','Владелец точки','79009990002','workspace-point');
db.prepare(
  'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,point_id,first_purchase_promo_code) VALUES(?,?,?,?,?,?,?,?)'
).run('WS-TEST-01','ws-partner','hash','Грумер точки','79009990003','Тестовая точка','workspace-point','GR-PROMO');

const handlers={get:new Map(),post:new Map()};
const router={
  get:(name,fn)=>handlers.get.set(name,fn),
  post:(name,fn)=>handlers.post.set(name,fn),
};
registerAdminPointWorkspaceRoutes(router);
registerAdminReportCenterRoutes(router);
async function invoke(method,url,{token='',body={},query={},params={}}={}){
  const handler=handlers[method].get(url);
  assert.equal(typeof handler,'function','Unknown route '+url);
  const req={headers:{authorization:token?'Bearer '+token:''}};
  const res={
    status:0,payload:null,
    writeHead(code){this.status=code;},
    end(text){this.payload=text?JSON.parse(text):null;},
  };
  await handler(req,res,{body,query,params});
  return res;
}

test('point workspace returns real staff only for active point and authenticated admin',async()=>{
  const denied=await invoke('get','/api/admin/points/:id/workspace',
    {params:{id:'workspace-point'}});
  assert.equal(denied.status,401);
  const disabled=await invoke('get','/api/admin/points/:id/workspace',
    {token:inactiveToken,params:{id:'workspace-point'}});
  assert.equal(disabled.status,401);
  const ok=await invoke('get','/api/admin/points/:id/workspace',
    {token:normalToken,params:{id:'workspace-point'}});
  assert.equal(ok.status,200);
  assert.equal(ok.payload.point.first_purchase_promo_code,'PT-PROMO');
  assert.equal(ok.payload.manager.full_name,'Менеджер отдела');
  assert.deepEqual(ok.payload.owners.map(x=>x.full_name),['Владелец точки']);
  assert.deepEqual(ok.payload.groomers.map(x=>x.full_name),['Грумер точки']);
  const text=JSON.stringify(ok.payload);
  assert.equal(text.includes('password_hash'),false);
  assert.equal(text.includes('79009990003'),false);
  assert.equal(readPointWorkspace('inactive-workspace'),null);
  const missing=await invoke('get','/api/admin/points/:id/workspace',
    {token:superToken,params:{id:'inactive-workspace'}});
  assert.equal(missing.status,404);
});

test('report center validates only supported filters, never runs report without approval',()=>{
  assert.equal(SUPPORTED.has('gdweek'),true);
  assert.equal(SUPPORTED.has('business'),true);
  assert.equal(SUPPORTED.has('qrweek'),true);
  assert.equal(SUPPORTED.has('arbitrary-backup'),false);
  assert.deepEqual(reportParams('business',{year:2026,start:'2025-11-01'}),{year:2026});
  assert.deepEqual(reportParams('stock',{citySelector:'krsk',point:'other'}),{citySelector:'krsk'});
  assert.throws(()=>reportParams('gdweek',{start:'2026-11-01'}),/обе даты/);
  assert.throws(()=>reportParams('business',{year:2020}),/год/);
  assert.throws(()=>reportParams('stock',{citySelector:'krsk; DROP TABLE points'}),/города/);
});

test('generated reports require an authorized, Telegram-linked admin',async()=>{
  const approvals=require('./report-approvals');
  const orig=approvals.requestReport;
  const requests=[];
  approvals.requestReport=async(chat,type,params)=>{
    requests.push({chat,type,params});
    return {ok:true,message:'Ожидаем подтверждение в Telegram'};
  };
  try{
    const noAuth=await invoke('post','/api/admin/report-center/request',
      {body:{type:'gdweek'}});
    assert.equal(noAuth.status,401);
    const noAccess=await invoke('post','/api/admin/report-center/request',
      {token:inactiveToken,body:{type:'gdweek'}});
    assert.equal(noAccess.status,401);
    const forbidden=await invoke('post','/api/admin/report-center/request',
      {token:normalToken,body:{type:'qrweek'}});
    assert.equal(forbidden.status,403);
    const unknown=await invoke('post','/api/admin/report-center/request',
      {token:normalToken,body:{type:'dangerous-command'}});
    assert.equal(unknown.status,400);
    assert.equal(requests.length,0);
    const ok=await invoke('post','/api/admin/report-center/request',
      {token:superToken,body:{type:'gdweek',start:'2026-11-02',end:'2026-11-08'}});
    assert.equal(ok.status,202);
    assert.equal(ok.payload.pending,true);
    assert.deepEqual(requests[0],{
      chat:'8866001',type:'gdweek',
      params:{start:'2026-11-02',end:'2026-11-08',skipTelegram:false},
    });
    const qr=await invoke('post','/api/admin/report-center/request',
      {token:superToken,body:{type:'qrweek'}});
    assert.equal(qr.status,202);
    assert.equal(requests.length,2);
  }finally{approvals.requestReport=orig;}
});

test('admin UI has exactly 8 primary menu items and modules without breaking previous screens',()=>{
  const root=path.join(__dirname,'..','public');
  const html=fs.readFileSync(path.join(root,'taiga-admin.html'),'utf8');
  const menu=html.slice(html.indexOf('<aside class="sidebar"'),
    html.indexOf('<div class="sidebar-footer">'));
  assert.equal((menu.match(/class="nav-item/g)||[]).length,8);
  const names=['dashboard','points','products','orders','campaigns',
    'report-center','tasks','system-health'];
  for(const name of names){
    assert.match(menu,new RegExp("showSection\\('"+name+"'\\)"));
  }
  for(const section of ['report-center','campaigns','backup','max',
    'telegram-connections','payout-reports','weekly-reports','point']){
    assert.ok(html.includes('id="sec-'+section+'"'),section+' preserved');
  }
  for(const file of ['admin-navigation.js','admin-point.js','admin-report-center.js']){
    assert.ok(html.includes('src="'+file),file+' is loaded');
    const source=fs.readFileSync(path.join(root,file),'utf8');
    assert.doesNotThrow(()=>new Function(source),file+' syntax');
  }
  const inline=[...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m=>m[1]).sort((a,b)=>b.length-a.length)[0];
  assert.ok(inline.length>100000);
  assert.doesNotThrow(()=>new Function(inline));
  assert.ok(!inline.includes('async function showPoint(idx)'));
  assert.ok(!inline.includes('async function showSection(id)'));
  assert.match(html,/id="pt-tab-people"/);
  assert.match(html,/id="pt-tab-qr"/);
  assert.match(html,/id="admin-telegram-connect"/);
  assert.equal((html.match(/id="admin-telegram-connect"/g)||[]).length,1);
  const backups=html.slice(html.indexOf('id="sec-backup"'),html.indexOf('id="sec-system-health"'));
  assert.match(backups,/restore-backup-file/);
});
