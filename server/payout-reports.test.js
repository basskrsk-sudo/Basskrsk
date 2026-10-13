'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const vm = require('node:vm');
const reports = require('./payout-reports');
const bonusLedger = require('./report-bonuses');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE points(id TEXT PRIMARY KEY, name TEXT, manager_id INTEGER);
    CREATE TABLE managers(id INTEGER PRIMARY KEY, full_name TEXT, mgr_code TEXT, inn TEXT);
    CREATE TABLE manager_points(id INTEGER PRIMARY KEY, manager_id INTEGER, point_id TEXT, point_name TEXT, commission_rate REAL, bonus_paid INTEGER DEFAULT 0, bonus_manager_amount INTEGER, referred_owner_id INTEGER, referred_owner_amount INTEGER, referred_groomer_id INTEGER, referred_groomer_amount INTEGER);
    CREATE TABLE manager_commission_payouts(id INTEGER PRIMARY KEY, manager_id INTEGER, manager_name TEXT, manager_code TEXT, amount INTEGER, orders_count INTEGER, paid_by_admin_id INTEGER, paid_by_admin_login TEXT, paid_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE manager_commission_payout_items(id INTEGER PRIMARY KEY, payout_id INTEGER, order_id INTEGER UNIQUE, order_code TEXT, point_id TEXT, point_name TEXT, commission_rate REAL, commission_amount INTEGER);
    CREATE TABLE manager_launch_bonus_payouts(id INTEGER PRIMARY KEY, manager_point_id INTEGER UNIQUE, manager_id INTEGER, manager_name TEXT, manager_code TEXT, point_id TEXT, point_name TEXT, amount INTEGER, paid_by_admin_id INTEGER, paid_by_admin_login TEXT, paid_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE partners(id INTEGER PRIMARY KEY, full_name TEXT, partner_code TEXT, point_id TEXT, commission_rate REAL, inn TEXT);
    CREATE TABLE salon_owners(id INTEGER PRIMARY KEY, full_name TEXT, owner_code TEXT, point_id TEXT, commission_rate REAL);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, order_code TEXT, created_at TEXT, total REAL, commission_rate REAL, partner_id INTEGER, point_id TEXT, status TEXT);
    CREATE TABLE partner_payouts(id INTEGER PRIMARY KEY, partner_id INTEGER, partner_name TEXT, partner_code TEXT, manager_id INTEGER, manager_name TEXT, amount REAL, orders_count INTEGER, paid_by_admin_id INTEGER, paid_by_admin_login TEXT, paid_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE owner_payouts(id INTEGER PRIMARY KEY, owner_id INTEGER, owner_name TEXT, owner_code TEXT, point_id TEXT, point_name TEXT, amount REAL, orders_count INTEGER, paid_by_admin_id INTEGER, paid_by_admin_login TEXT, paid_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE partner_payout_items(id INTEGER PRIMARY KEY, payout_id INTEGER, order_id INTEGER UNIQUE, order_code TEXT, commission_amount REAL);
    CREATE TABLE owner_payout_items(id INTEGER PRIMARY KEY, payout_id INTEGER, order_id INTEGER UNIQUE, order_code TEXT, commission_amount REAL);
    INSERT INTO points VALUES('a','Салон А',1),('b','Салон Б',1);
    INSERT INTO managers VALUES(1,'Менеджер','M1','123');
    INSERT INTO manager_points(id,manager_id,point_id,point_name,commission_rate) VALUES(1,1,'a','Салон А',0.07),(2,1,'b','Салон Б',0.07);
    INSERT INTO partners VALUES(1,'Грумер','G1','a',0.2,'123'),(2,'Другой','G2','b',0.15,'456');
    INSERT INTO salon_owners VALUES(1,'Владелец','O1','a',0.05);
    INSERT INTO orders VALUES
      (1,'A','2026-09-01 00:00:00',101,0.15,1,'a','paid'),
      (2,'B','2026-09-15 23:59:59',102,0.18,1,'a','paid'),
      (3,'C','2026-09-16 00:00:00',103,0.2,1,'a','paid'),
      (4,'D','2026-09-10 12:00:00',1000,0.2,1,'a','pending'),
      (5,'E','2026-09-10 12:00:00',1000,0.2,1,'a','refunded'),
      (6,'F','2026-09-10 12:00:00',1000,0.2,2,'b','paid');
  `);
  reports.initializeReports(db);
  return db;
}
function loadWithDb(file, db, extra = {}) {
  const mod = { exports: {} };
  const localRequire = (name) => name === './db' ? db : Object.hasOwn(extra, name) ? extra[name] : require(name);
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), { require: localRequire, module: mod, exports: mod.exports, console });
  return mod.exports;
}

test('period boundaries, paid-only filter, per-order rates and rounding', () => {
  const db = fixture();
  const r = reports.generatePeriodReport(db, 'partner', 1, '2026-09-01', '2026-09-15');
  assert.deepEqual(r.items.map(i => i.order_code), ['A','B']);
  assert.equal(r.accrued, 33); assert.equal(r.unpaid, 33); assert.equal(r.base_total, 203);
  assert.equal(r.items[0].rate, 0.15); db.close();
});
test('owner point and rate match payout calculations', () => {
  const db = fixture();
  const r = reports.generatePeriodReport(db, 'owner', 1, '2026-09-01', '2026-09-15');
  assert.equal(r.accrued, 10); assert.equal(r.items.length, 2); db.close();
});
test('paid commission uses ledger, not mutable order; excluded from outstanding', () => {
  const db = fixture();
  db.exec("INSERT INTO partner_payout_items VALUES(1,99,1,'A',12)");
  const r = reports.generatePeriodReport(db, 'partner', 1, '2026-09-01', '2026-09-15');
  assert.equal(r.accrued, 30); assert.equal(r.already_paid, 12); assert.equal(r.unpaid, 18);
  assert.equal(r.items[0].base, null); assert.equal(r.items[0].rate, null); db.close();
});
test('new payouts automatically save exact immutable report in transaction', () => {
  for (const role of ['partner','owner']) {
    const db = fixture();
    const api = loadWithDb('./' + role + '-payouts', db);
    const payout = api[role === 'partner' ? 'createPartnerPayout' : 'createOwnerPayout'](1, { id:1, login:'admin' });
    assert.ok(payout.report_id);
    const r = reports.fromPayout(db, role, payout.id, 1);
    assert.equal(r.accrued, payout.amount); assert.equal(r.items.length, payout.orders_count);
    assert.equal(r.reconstructed, false);
    db.exec("UPDATE orders SET total=99999; UPDATE partners SET full_name='Changed'; UPDATE salon_owners SET full_name='Changed'");
    assert.deepEqual(reports.fromPayout(db, role, payout.id, 1), r);
    db.close();
  }
});
test('snapshot failure rolls back payout and its items', () => {
  const db = fixture();
  db.exec('DROP TABLE payout_reports');
  const api = loadWithDb('./partner-payouts', db);
  assert.throws(() => api.createPartnerPayout(1, {id:1}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM partner_payouts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM partner_payout_items').get().n, 0); db.close();
});
test('old payout reconstruction uses stored amounts and never fabricates rates', () => {
  const db = fixture();
  db.exec("INSERT INTO partner_payouts(id,partner_id,partner_name,partner_code,amount,orders_count) VALUES(99,1,'Old name','OLD',12,1); INSERT INTO partner_payout_items VALUES(1,99,1,'OLDORDER',12)");
  const r = reports.fromPayout(db,'partner',99,1);
  assert.equal(r.recipient.name,'Old name'); assert.equal(r.items[0].amount,12);
  assert.equal(r.items[0].date,null); assert.equal(r.items[0].rate,null); assert.equal(r.items[0].base,null);
  assert.equal(r.reconstructed,true); assert.deepEqual(reports.fromPayout(db,'partner',99,1),r); db.close();
});
test('validation and HTML escaping', () => {
  assert.throws(() => reports.validatePeriod('2026-02-30','2026-03-01'));
  assert.throws(() => reports.validatePeriod('2026-09-15','2026-09-01'));
  assert.throws(() => reports.roleConfig('__proto__'));
  assert.throws(() => reports.roleConfig('toString'));
  const r = reports.buildReport('partner',{full_name:'<script>bad()</script>'},[],{metadata:{actions:'<img onerror=x>'}});
  const html = reports.printableReport(r);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;img onerror=x&gt;'));
  assert.ok(!html.includes('<script>bad')); assert.deepEqual(reports.metadata(null), reports.metadata());
});
test('all report routes require admin authentication; bad ids reject before SQL', () => {
  const handlers = []; let allow = false;
  const api = loadWithDb('./routes-payout-reports', { prepare() { throw new Error('must not query'); } }, {
    './routes-auth': {requireAuth: roles => { assert.deepEqual(Array.from(roles),['admin']); return () => allow ? {id:1} : null; }},
    './http-utils': {sendJson(res,status,data) {res.status=status;res.data=data;}}
  });
  api.registerPayoutReportRoutes({get(path,fn){handlers.push({path,fn});},post(path,fn){handlers.push({path,fn});}});
  for (const h of handlers) { const res={setHeader(){}}; h.fn({},res,{}); assert.equal(res.status,undefined); }
  allow = true;
  for (const path of ['/api/payout-reports/period','/api/payout-reports/from-payout','/api/payout-reports/:id']) {
    const res={setHeader(){}};
    handlers.find(h=>h.path===path).fn({},res,{body:{role:'partner',recipient_id:'x',payout_id:0},params:{id:-1}});
    assert.equal(res.status,400);
  }
});

test('admin endpoints preview, save, retrieve and list an archived report', () => {
  const db = fixture(), handlers = new Map();
  const api = loadWithDb('./routes-payout-reports',db,{
    './routes-auth':{requireAuth:()=>()=>({id:7})},
    './http-utils':{sendJson(res,status,data){res.status=status;res.data=data;}}
  });
  api.registerPayoutReportRoutes({get(path,fn){handlers.set(path,fn);},post(path,fn){handlers.set(path,fn);}});
  const invoke=(path,ctx)=>{const res={setHeader(){}};handlers.get(path)({},res,ctx);return res;};
  const body={role:'partner',recipient_id:1,start:'2026-09-01',end:'2026-09-15',metadata:{contract_number:'ABC'}};
  assert.equal(invoke('/api/payout-reports/period',{body}).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM payout_reports').get().n,0);
  const saved=invoke('/api/payout-reports/period',{body:{...body,save:true}});
  assert.equal(saved.status,201);
  assert.equal(invoke('/api/payout-reports/:id',{params:{id:saved.data.report.id}}).data.report.metadata.contract_number,'ABC');
  assert.equal(invoke('/api/payout-reports',{query:{role:'partner'}}).data.reports.length,1);
  assert.equal(invoke('/api/payout-reports/recipients',{query:{role:'owner'}}).data.recipients[0].full_name,'Владелец');
  db.close();
});

test('admin UI wires reports and both inline and external scripts compile', () => {
  const html=fs.readFileSync(require.resolve('../public/taiga-admin.html'),'utf8');
  assert.ok(html.includes("openPayoutReports('owner')"));
  assert.ok(html.includes("openPayoutReports('partner')"));
  assert.ok(html.includes("openPayoutReports('manager')"));
  assert.ok(html.includes('src="/payout-reports.js"'));
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
  new vm.Script(fs.readFileSync(require.resolve('../public/payout-reports.js'),'utf8'));
});

function accrue(db, date='2026-09-10 12:00:00') {
  db.prepare(`UPDATE manager_points SET bonus_paid=1,bonus_manager_amount=1000,
    referred_owner_id=1,referred_owner_amount=1000,referred_groomer_id=1,referred_groomer_amount=1000,bonus_accrued_at=? WHERE id=1`).run(date);
}

test('all roles include bonus accrual without mistaking accrued flag for payment', () => {
  const db=fixture();accrue(db);
  for (const [role,commission] of [['owner',10],['partner',33],['manager',84]]) {
    const r=reports.generatePeriodReport(db,role,1,'2026-09-01','2026-09-15');
    assert.equal(r.commission_accrued,commission);assert.equal(r.bonus_accrued,1000);
    assert.equal(r.accrued,1000+commission);assert.equal(r.already_paid,0);assert.equal(r.unpaid,1000+commission);
    assert.equal(r.bonus_payments.length,0);
  }
  db.close();
});
test('old undated bonuses are visible but excluded from arbitrary period totals', () => {
  const db=fixture();accrue(db,null);
  const r=reports.generatePeriodReport(db,'owner',1,'2026-09-01','2026-09-15');
  assert.equal(r.undated_bonuses.length,1);assert.equal(r.bonus_accrued,0);assert.equal(r.accrued,10);
  assert.ok(reports.printableReport(r).includes('старые начисления без даты'));db.close();
});
test('actual referral payouts have immutable documents and cannot be paid twice', () => {
  for (const role of ['owner','partner']) {
    const db=fixture();accrue(db);
    const result=bonusLedger.createReferralBonusPayout(db,role,1,1,1000,{id:1,login:'admin'});
    assert.equal(result.report.payout_amount,1000);assert.equal(result.report.bonus_accrued,1000);
    assert.equal(result.report.payout_type,'referral_bonus');assert.equal(result.report.items.length,0);
    assert.throws(()=>bonusLedger.createReferralBonusPayout(db,role,1,1,1000,{id:1}),e=>e.statusCode===409);
    db.exec("UPDATE manager_points SET point_name='Changed',referred_owner_amount=2000,referred_groomer_amount=2000;UPDATE partners SET full_name='Changed';UPDATE salon_owners SET full_name='Changed'");
    assert.deepEqual(reports.fromPayout(db,role,result.payout.id,1,'referral_bonus'),result.report);
    const day=result.payout.paid_at.slice(0,10);
    const period=reports.generatePeriodReport(db,role,1,day,day);
    assert.equal(period.bonus_payments.length,1);assert.equal(period.bonus_payments[0].amount,1000);
    assert.equal(period.bonus_accrued, day==='2026-09-10' ? 1000 : 0);
    db.close();
  }
});
test('bonus payment rejects mismatched recipients, changed amount and unaccrued reward', () => {
  const db=fixture();accrue(db);
  assert.throws(()=>bonusLedger.createReferralBonusPayout(db,'owner',1,2,1000,{}),e=>e.statusCode===404);
  assert.throws(()=>bonusLedger.createReferralBonusPayout(db,'owner',1,1,900,{}),e=>e.statusCode===409);
  db.exec('UPDATE manager_points SET bonus_paid=0');
  assert.throws(()=>bonusLedger.createReferralBonusPayout(db,'owner',1,1,1000,{}),e=>e.statusCode===409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM referral_bonus_payouts').get().n,0);db.close();
});
test('failed snapshot rolls back referral payment', () => {
  const db=fixture();accrue(db);db.exec('DROP TABLE payout_reports');
  assert.throws(()=>bonusLedger.createReferralBonusPayout(db,'owner',1,1,1000,{id:1}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM referral_bonus_payouts').get().n,0);db.close();
});
test('manager commission and bonus with identical payout ids keep separate reports', () => {
  const db=fixture();accrue(db);
  const api=loadWithDb('./manager-payouts',db);
  const commission=api.createManagerCommissionPayout(1,{id:1,login:'admin'});
  const bonus=api.createManagerLaunchBonusPayout(1,{id:1,login:'admin'});
  assert.equal(commission.id,bonus.id);assert.notEqual(commission.report_id,bonus.report_id);
  const r1=reports.fromPayout(db,'manager',commission.id,1);
  const r2=reports.fromPayout(db,'manager',bonus.id,1,'launch_bonus');
  assert.equal(r1.payout_amount,91);assert.equal(r2.payout_amount,1000);
  assert.equal(r2.items.length,0);assert.equal(r2.bonuses.length,1);
  const day=bonus.paid_at.slice(0,10);
  const period=reports.generatePeriodReport(db,'manager',1,day,day);
  assert.equal(period.bonus_payments.length,1);
  assert.throws(()=>api.createManagerLaunchBonusPayout(1,{id:1}),e=>e.code==='ALREADY_PAID');db.close();
});
test('paid manager commission stays with original recipient after reassignment', () => {
  const db=fixture();const api=loadWithDb('./manager-payouts',db);api.createManagerCommissionPayout(1,{id:1});
  db.exec("INSERT INTO managers VALUES(2,'New manager','M2','456');UPDATE points SET manager_id=2;UPDATE manager_points SET manager_id=2");
  const old=reports.generatePeriodReport(db,'manager',1,'2026-09-01','2026-09-15');
  const next=reports.generatePeriodReport(db,'manager',2,'2026-09-01','2026-09-15');
  assert.equal(old.accrued,84);assert.equal(old.already_paid,84);assert.equal(next.accrued,0);db.close();
});
test('legacy version-one report is never recalculated or extended retroactively', () => {
  const db=fixture();const legacy={version:1,role:'owner',recipient:{id:1,name:'Historic'},payout_id:8,items:[],accrued:77};
  db.prepare('INSERT INTO payout_reports(role,recipient_id,payout_id,snapshot_json) VALUES(?,?,?,?)').run('owner',1,8,JSON.stringify(legacy));
  accrue(db);reports.initializeReports(db);
  assert.deepEqual(reports.fromPayout(db,'owner',8,1),{...legacy,id:1});db.close();
});

test('bonus payment endpoint requires actual-transfer confirmation and emits printable snapshot', () => {
  const db=fixture(),handlers=new Map();accrue(db);
  const api=loadWithDb('./routes-payout-reports',db,{
    './routes-auth':{requireAuth:()=>()=>({id:1,login:'admin'})},
    './http-utils':{sendJson(res,status,data){res.status=status;res.data=data;}}
  });
  api.registerPayoutReportRoutes({get(path,fn){handlers.set(path,fn);},post(path,fn){handlers.set(path,fn);}});
  const call=body=>{const res={setHeader(){}};handlers.get('/api/payout-reports/bonus-payouts')({},res,{body});return res;};
  const body={role:'owner',recipient_id:1,manager_point_id:1,expected_amount:1000};
  assert.equal(call(body).status,400);
  const result=call({...body,confirm_transferred:true});assert.equal(result.status,201);
  assert.ok(result.data.html.includes('Бонусы за привлечение точек'));
  assert.equal(result.data.report.payout_amount,1000);
  assert.equal(call({...body,confirm_transferred:true}).status,409);db.close();
});

test('mobile period presets use 14 complete days and previous closed half month', () => {
  const elements={'pr-start':{},'pr-end':{}};
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-10-07T00:01:00Z']));} }
  const ctx={Date:FixedDate,document:{getElementById:id=>elements[id]}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../public/payout-reports.js'),'utf8'),ctx);
  ctx.setReportPeriod('14');
  assert.equal(elements['pr-start'].value,'2026-09-23');assert.equal(elements['pr-end'].value,'2026-10-06');
  ctx.setReportPeriod('previous');
  assert.equal(elements['pr-start'].value,'2026-09-16');assert.equal(elements['pr-end'].value,'2026-09-30');
});
