'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-expense-date-'));
process.env.TOKEN_SECRET='expense-date-correction-test-token';

const db=require('./db');
const {Router}=require('./http-utils');
const {signToken}=require('./auth');
const {registerEconomicsRoutes}=require('./routes-economics');
const {registerAuditRoutes}=require('./routes-audit');
const {localDate}=require('./task-reminders');

db.prepare('INSERT OR IGNORE INTO cities(id,name,active) VALUES(?,?,1)').run('krsk','Красноярск');
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,1)')
 .run(88001,'expense-date-super','test','super');
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,1)')
 .run(88002,'expense-date-admin','test','admin');
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,1)')
 .run(88003,'expense-date-revokable','test','super');

const info=db.prepare(
  "INSERT INTO expenses(expense_date,category,amount,investor_name,created_by,source,city_id) " +
  "VALUES('2026-11-04','Закуп лакомств у Хвостика',16850,'Соколов Виталий','Telegram','telegram','krsk')"
).run();
const expenseId=Number(info.lastInsertRowid);
// A document link must stay attached to this expense even when its date changes.
db.prepare(
  'INSERT INTO expense_documents(expense_id,filename,storage_name,mime_type,size_bytes,sha256,uploaded_by_role,uploaded_by_id) '+
  'VALUES(?,?,?,?,?,?,?,?)'
).run(expenseId,'Счёт.pdf','11111111111111111111111111111111.pdf',
  'application/pdf',25,'1'.repeat(64),'admin',88001);

const router=new Router();
registerEconomicsRoutes(router);
registerAuditRoutes(router);
function call(method,route,who,body={},query={}){
  const matched=router.match(method,route);
  assert.ok(matched,'missing '+method+' '+route);
  const token=who?signToken({role:'admin',id:who.id,login:'test',adminRole:who.super?'super':'admin'}):'';
  const req={headers:{authorization:token?'Bearer '+token:''}};
  const res={
    status:null,data:null,headers:{},
    setHeader(name,value){this.headers[name]=value;},
    writeHead(status,headers){this.status=status;Object.assign(this.headers,headers||{});return this;},
    end(text){this.data=JSON.parse(text||'{}');},
  };
  matched.handler(req,res,{params:matched.params,body,query});
  return res;
}
const superAdmin={id:88001,super:true};
const normalAdmin={id:88002,super:false};
const revokableAdmin={id:88003,super:true};
function correction(date,expected='2026-11-04',reason='Счёт датирован 02.11.2026') {
  return {expense_date:date,expected_date:expected,reason};
}

test('only an active super-admin can change historical expense dates',()=>{
  for(const actor of [null,normalAdmin]){
    const reply=call('PUT','/api/economics/expenses/'+expenseId+'/date',actor,
      correction('2026-11-02'));
    assert.ok([401,403].includes(reply.status));
  }
  db.prepare("UPDATE admins SET active=0 WHERE id=88003").run();
  assert.equal(call('PUT','/api/economics/expenses/'+expenseId+'/date',revokableAdmin,
    correction('2026-11-02')).status,403);
  db.prepare("UPDATE admins SET active=1,role='admin' WHERE id=88003").run();
  assert.equal(call('PUT','/api/economics/expenses/'+expenseId+'/date',revokableAdmin,
    correction('2026-11-02')).status,403,'a previously signed super token cannot bypass demotion');
  assert.equal(db.prepare('SELECT expense_date FROM expenses WHERE id=?').get(expenseId).expense_date,'2026-11-04');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_date_change_log').get().n,0);
});

test('invalid dates, future dates, stale edits, and missing explanation are rejected',()=>{
  const bad=[
    correction('2026-02-30'),
    correction('2999-01-01'),
    correction('2026-11-04'),
    correction('2026-11-02','2026-11-03'),
    correction('2026-11-02','2026-11-04',''),
    correction('2026-11-02','2026-11-04','позд'),
  ];
  const expected=[400,400,400,409,400,400];
  for(let i=0;i<bad.length;i++){
    const reply=call('PUT','/api/economics/expenses/'+expenseId+'/date',superAdmin,bad[i]);
    assert.equal(reply.status,expected[i],JSON.stringify(bad[i]));
  }
  assert.equal(call('PUT','/api/economics/expenses/99999999/date',superAdmin,
    correction('2026-11-02')).status,404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_date_change_log').get().n,0);
});

test('corrected accounting month changes, amount/investor/document do not, audit is immutable',()=>{
  const old=db.prepare('SELECT * FROM expenses WHERE id=?').get(expenseId);
  const before=call('GET','/api/economics/dashboard',normalAdmin,{},{
    from:'2026-10-01',to:'2026-10-31',city:'krsk'
  });
  assert.equal(before.status,200);
  const result=call('PUT','/api/economics/expenses/'+expenseId+'/date',superAdmin,
    correction('2026-10-30'));
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual([result.data.old_date,result.data.new_date],['2026-11-04','2026-10-30']);
  const updated=db.prepare('SELECT * FROM expenses WHERE id=?').get(expenseId);
  assert.equal(updated.expense_date,'2026-10-30');
  for(const key of ['id','amount','investor_name','category','created_by','source','city_id'])
    assert.equal(updated[key],old[key],key+' must remain unchanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_documents WHERE expense_id=?')
    .get(expenseId).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,1);

  const after=call('GET','/api/economics/dashboard',normalAdmin,{},{
    from:'2026-10-01',to:'2026-10-31',city:'krsk'
  });
  assert.equal(after.status,200);
  assert.equal(after.data.costs.cogs-before.data.costs.cogs,16850);

  const audit=call('GET','/api/admin/audit-log',superAdmin,{},{
    type:'expense_date_change',limit:'20'
  });
  assert.equal(audit.status,200);
  assert.equal(audit.data.events.length,1);
  const change=audit.data.events[0];
  assert.deepEqual([change.expense_id,change.old_date,change.new_date],
    [expenseId,'2026-11-04','2026-10-30']);
  assert.equal(change.admin_login,'expense-date-super');
  assert.equal(change.reason,'Счёт датирован 02.11.2026');

  assert.equal(call('PUT','/api/economics/expenses/'+expenseId+'/date',superAdmin,
    correction('2026-10-29','2026-11-04')).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expense_date_change_log').get().n,1);
});

test('the admin interface exposes edit controls only to super-admin and lists audit changes',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
  assert.match(html,/currentAdminRole === 'super' \? '<button class="row-btn" title="Исправить дату траты"/);
  assert.match(html,/biz-exp-date-correction-modal/);
  assert.match(html,/\/api\/economics\/expenses\/'\+id\+'\/date/);
  assert.match(html,/event.type === 'expense_date_change'/);
  assert.match(html,/value="expense_date_change"/);
  const inline=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inline.length,'at least one admin inline script');
  for(const match of inline) assert.doesNotThrow(()=>new Function(match[1]));
  assert.ok(localDate() >= '2026-11-04','test expects known historical fixture date');
});
