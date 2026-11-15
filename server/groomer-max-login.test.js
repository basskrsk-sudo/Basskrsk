'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hm-groomer-max-login-'));
process.env.DATA_DIR = dir;
process.env.TOKEN_SECRET = 'max-groomer-test-jwt-not-for-production';
process.env.MAX_BOT_TOKEN = 'groomer-test-bot-token';
process.env.MAX_BOT_USERNAME = 'HvostMaxTestBot';
process.env.MAX_WEBHOOK_SECRET = 'groomer-test-webhook-secret';

const db = require('./db');
const { Router } = require('./http-utils');
const { registerAuthRoutes } = require('./routes-auth');
const { verifyToken } = require('./auth');
const bot = require('./max-bot');
const router = new Router();
registerAuthRoutes(router);

function addPartner(phone, active = 1, chat = null) {
  const key = 'gm-max-' + String(Date.now()) + '-' + String(++addPartner.number);
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,active,max_chat_id) '+
    'VALUES (?,?,?,?,?,?,?,?)'
  ).run(key,key,'unused-hash','Тестовый грумер MAX',phone,'Салон',active,chat).lastInsertRowid);
}
addPartner.number = 0;
async function api(method,route,body={}) {
  const matched = router.match(method,route);
  assert.ok(matched, method+' '+route);
  const res = { status: 0, result: null, headers: {},
    setHeader(name,value){this.headers[name]=value;},
    writeHead(status){this.status=status;},
    end(value){this.result=value?JSON.parse(value):null;},
  };
  await matched.handler({headers:{}},res,{body,params:matched.params,query:{}});
  return res;
}
const oldFetch=global.fetch;
global.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true})});

function ownContact(chat,sender,contactUser,phone) {
  return {update_type:'message_created',message:{
    recipient:{chat_id:String(chat)},sender:{user_id:String(sender)},
    body:{attachments:[{type:'contact',payload:{
      max_info:{user_id:String(contactUser)},
      vcf_info:'BEGIN:VCARD\nVERSION:3.0\nTEL;TYPE=CELL:'+phone+'\nEND:VCARD',
    }}]},
  }};
}
async function confirm(token, chat, sender, phone) {
  await bot.processUpdate({update_type:'message_created',message:{
    body:{text:'/start '+token},recipient:{chat_id:String(chat)},
  }});
  await bot.processUpdate(ownContact(chat,sender,sender,phone));
}

test('MAX website login needs a unique active groomer and uses a ten-minute one-time deep link',async()=>{
  const partnerId = addPartner('+7 (913) 555-30-01');
  const r = await api('POST','/api/partners/max/start',{phone:'89135553001'});
  assert.equal(r.status,200,JSON.stringify(r.result));
  assert.match(r.result.token,/^[0-9a-f]{64}$/);
  assert.equal(r.result.deep_link,'https://max.ru/HvostMaxTestBot?start='+r.result.token);
  assert.equal(r.headers['Cache-Control'],'no-store');
  const record=db.prepare('SELECT role,account_id,verified,expires_at FROM max_login_tokens WHERE token=?').get(r.result.token);
  assert.equal(record.role,'partner_login');
  assert.equal(record.account_id,partnerId);
  assert.equal(record.verified,0);
  assert.ok(Date.parse(record.expires_at)>Date.now()+9*60*1000);

  const unknown=await api('POST','/api/partners/max/start',{phone:'+7 913 555-30-02'});
  assert.equal(unknown.status,404);
  assert.equal((await api('POST','/api/partners/max/start',{phone:'123'})).status,400);
  const disabled = addPartner('89135553003',0);
  assert.equal((await api('POST','/api/partners/max/start',{phone:'89135553003'})).status,404);
  assert.ok(disabled>0);
  addPartner('89135553001');
  assert.equal((await api('POST','/api/partners/max/start',{phone:'89135553001'})).status,404,
    'duplicate active groomer phone must not choose an arbitrary account');
  db.prepare('UPDATE partners SET active=0 WHERE id=(SELECT MAX(id) FROM partners)').run();
});

test('MAX token alone cannot grant any groomer session',async()=>{
  const link=(await api('POST','/api/partners/max/start',{phone:'89135553001'})).result.token;
  const before=await api('POST','/api/partners/max/check',{token:link});
  assert.equal(before.status,200);
  assert.deepEqual(before.result,{verified:false});
  assert.equal(router.match('GET','/api/partners/max/check'),null,
    'MAX tokens cannot be submitted via URL query strings');
  assert.equal((await api('POST','/api/partners/max/check',{token:'x'})).status,400);
  const customerLink='a'.repeat(64);
  db.prepare("INSERT INTO max_login_tokens(token,phone,role,expires_at,verified) VALUES (?,?,?,datetime('now','+10 minutes'),1)")
    .run(customerLink,'79135553001','customer');
  assert.equal((await api('POST','/api/partners/max/check',{token:customerLink})).status,404,
    'customer MAX token cannot be exchanged for groomer credentials');
});

test('MAX requires own sent contact, rejects other user and wrong phone, then issues only partner JWT once',async()=>{
  const partner=addPartner('8 913 555-34-01');
  const token=(await api('POST','/api/partners/max/start',{phone:'79135553401'})).result.token;
  await bot.processUpdate({update_type:'message_created',message:{
    body:{text:'/start '+token},recipient:{chat_id:'901321'},
  }});
  await bot.processUpdate(ownContact('901321','901322','777777','+79135553401'));
  assert.equal(db.prepare('SELECT verified FROM max_login_tokens WHERE token=?').get(token).verified,0);
  await bot.processUpdate(ownContact('901321','901322','901322','+79135553402'));
  assert.equal(db.prepare('SELECT verified FROM max_login_tokens WHERE token=?').get(token).verified,0);
  await bot.processUpdate(ownContact('901321','901322','901322','+79135553401'));
  assert.equal(db.prepare('SELECT verified FROM max_login_tokens WHERE token=?').get(token).verified,1);
  const login=await api('POST','/api/partners/max/check',{token});
  assert.equal(login.status,200,JSON.stringify(login.result));
  assert.equal(login.result.verified,true);
  assert.equal(login.result.user.id,partner);
  assert.equal(login.result.user.max_connected,true);
  assert.ok(!('password_hash' in login.result.user));
  assert.ok(!('max_chat_id' in login.result.user));
  assert.ok(!('telegram_chat_id' in login.result.user));
  assert.equal(verifyToken(login.result.token).role,'partner');
  assert.equal(verifyToken(login.result.token).id,partner);
  assert.equal(db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(partner).max_chat_id,'901321');
  assert.equal((await api('POST','/api/partners/max/check',{token})).status,404);
});

test('account phone change, deactivation and binding conflict revoke unfinished MAX login',async()=>{
  const changed=addPartner('79135554001');
  const changedToken=(await api('POST','/api/partners/max/start',{phone:'79135554001'})).result.token;
  await confirm(changedToken,'909001','909001','+79135554001');
  db.prepare('UPDATE partners SET phone=? WHERE id=?').run('79135554002',changed);
  assert.equal((await api('POST','/api/partners/max/check',{token:changedToken})).status,410);

  const inactive=addPartner('79135554003');
  const inactiveToken=(await api('POST','/api/partners/max/start',{phone:'79135554003'})).result.token;
  await confirm(inactiveToken,'909003','909003','+79135554003');
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(inactive);
  assert.equal((await api('POST','/api/partners/max/check',{token:inactiveToken})).status,410);

  const bound=addPartner('79135554004',1,'original-chat');
  const boundToken=(await api('POST','/api/partners/max/start',{phone:'79135554004'})).result.token;
  await confirm(boundToken,'909004','909004','+79135554004');
  assert.equal((await api('POST','/api/partners/max/check',{token:boundToken})).status,403);
  assert.equal(db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(bound).max_chat_id,'original-chat');
});

test('an expired verified MAX link cannot be used or replayed',async()=>{
  addPartner('79135554005');
  const token=(await api('POST','/api/partners/max/start',{phone:'79135554005'})).result.token;
  db.prepare("UPDATE max_login_tokens SET verified=1,chat_id='99999',expires_at=datetime('now','-1 second') WHERE token=?").run(token);
  assert.equal((await api('POST','/api/partners/max/check',{token})).status,410);
});

test.after(()=>{
  global.fetch=oldFetch;
  try{db.close();}catch(_){}
  fs.rmSync(dir,{recursive:true,force:true});
});
