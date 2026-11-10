'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-telegram-connections-'));
process.env.TOKEN_SECRET='isolated-telegram-connections-test';
const db=require('./db');
require('./business-founders');
const {signToken}=require('./auth');
const {collectTelegramConnections,registerTelegramConnectionRoutes}=require('./routes-telegram-connections');

db.prepare("INSERT INTO points(id,name,addr,icon,active) VALUES ('salon-tg','Салон для теста','Мира 1','🐾',1)").run();
db.prepare("INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,point_id,telegram_chat_id,active) VALUES (?,?,?,?,?,?,?,?,1)")
 .run('GR-tg','groomer-tg','hash','Юлия Барсукова','79135550001','Салон для теста','salon-tg','81001');
db.prepare("INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,telegram_chat_id,active) VALUES (?,?,?,?,?,?,1)")
 .run('owner-tg','hash','Юлия Барсукова','79135550001','salon-tg','81001');
db.prepare("INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,telegram_chat_id,active) VALUES (?,?,?,?,?,?,1)")
 .run('M-tg','manager-tg','hash','Менеджер','79135550002','81002');
db.prepare("INSERT INTO customers(name,phone,telegram_chat_id) VALUES (?,?,?)")
 .run('Покупатель','79135550001','81003');
db.prepare("INSERT INTO customers(name,phone) VALUES (?,?)")
 .run('Не подключён','79135550004');
db.prepare("INSERT INTO task_assignees(code,full_name,phone,telegram_chat_id,active) VALUES (?,?,?,?,1)")
 .run('TEST-TG','Исполнитель','79135550005','81005');
const founder=db.prepare("SELECT id FROM business_founders WHERE full_name='Лакомых Алексей'").get();
assert.ok(founder);
db.prepare('UPDATE business_founders SET active=1,telegram_chat_id=? WHERE id=?').run('81006',founder.id);
const adminId=Number(db.prepare("INSERT INTO admins(login,password_hash,full_name,role,telegram_chat_id,active) VALUES (?,?,?,?,?,1)")
 .run('admin-tg','hash','Администратор теста','super','81004').lastInsertRowid);

test('same Telegram ID groups owner and groomer, keeps both roles and salon',()=>{
 const result=collectTelegramConnections();
 assert.equal(result.summary.people,6);
 assert.equal(result.summary.accounts,7);
 const person=result.people.find(p=>p.name==='Юлия Барсукова');
 assert.deepEqual(person.roles,['owner','partner']);
 assert.equal(person.accounts.find(a=>a.role==='owner').point_name,'Салон для теста');
 assert.equal(result.people.some(p=>p.name==='Не подключён'),false);
 assert.equal(result.summary.by_role.find(r=>r.role==='customer').accounts,1);
 assert.equal(JSON.stringify(result).includes('telegram_chat_id'),false);
 assert.equal(JSON.stringify(result).includes('"81001"'),false);
});
test('same phone with different Telegram IDs never merges identities',()=>{
 const result=collectTelegramConnections();
 assert.notEqual(result.people.find(p=>p.roles.includes('customer')),
  result.people.find(p=>p.roles.includes('partner')));
});
function invoke(token){
 const handlers={};
 registerTelegramConnectionRoutes({get(url,fn){handlers[url]=fn;}});
 const res={status:0,writeHead(status){this.status=status;},
  end(raw){this.body=JSON.parse(raw);}};
 handlers['/api/admin/telegram-connections'](
  {headers:token?{authorization:'Bearer '+token}:{}},res,{query:{}});
 return res;
}
test('only enabled administrators can inspect connections',()=>{
 assert.equal(invoke('').status,401);
 assert.equal(invoke(signToken({role:'partner',id:1})).status,401);
 const token=signToken({role:'admin',id:adminId,adminRole:'super'});
 assert.equal(invoke(token).status,200);
 assert.equal(invoke(token).body.summary.people,6);
 db.prepare('UPDATE admins SET active=0 WHERE id=?').run(adminId);
 assert.equal(invoke(token).status,403);
});
test('searchable Telegram registry is connected to the admin navigation',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
 assert.match(html,/id="sec-telegram-connections"/);
 assert.match(html,/telegram-connections\.js/);
 assert.match(html,/loadTelegramConnections\(\)/);
 const navigation=fs.readFileSync(path.join(__dirname,'../public/admin-navigation.js'),'utf8');
 assert.match(navigation,/'telegram-connections':'system'/);
 assert.match(navigation,/\['telegram-connections','Telegram'\]/);
});
