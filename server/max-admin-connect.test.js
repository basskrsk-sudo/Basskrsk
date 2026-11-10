'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-admin-connect-'));
process.env.TOKEN_SECRET='hm-max-admin-connection-test';
process.env.MAX_BOT_TOKEN='test-max-token';
process.env.MAX_BOT_USERNAME='TestHvostBot';
process.env.MAX_WEBHOOK_SECRET='max-admin-test-hook';
const db=require('./db');
const {signToken}=require('./auth');
const {registerAuthRoutes}=require('./routes-auth');
const {Router}=require('./http-utils');
const bot=require('./max-bot');
const stock=require('./max-point-stock');
const router=new Router();
registerAuthRoutes(router);

function createAdmin(name,phone,role='admin'){
  return Number(db.prepare(
    'INSERT INTO admins(login,password_hash,phone,role,active) VALUES(?,?,?,?,1)'
  ).run(name,'unused',phone,role).lastInsertRowid);
}
const superId=createAdmin('hm-max-super','79005550011','super');
const staffId=createAdmin('hm-max-staff','79005550012');
const noPhoneId=createAdmin('hm-max-without-phone',null);
const superToken=signToken({role:'admin',id:superId,adminRole:'super'});
const staffToken=signToken({role:'admin',id:staffId,adminRole:'admin'});
const noPhoneToken=signToken({role:'admin',id:noPhoneId,adminRole:'admin'});

async function api(method,route,{token=superToken,query={},body={}}={}){
  const matched=router.match(method,route);
  assert.ok(matched,method+' '+route);
  const response={
    status:0,payload:null,
    writeHead(code){this.status=code;},
    end(value){this.payload=value?JSON.parse(value):null;},
  };
  await matched.handler({headers:{authorization:'Bearer '+token}},response,
    {params:matched.params,query,body});
  return response;
}
const contact=(chat,sender,contactUser,phone)=>({
  update_type:'message_created',
  message:{
    recipient:{chat_id:String(chat)},
    sender:{user_id:String(sender)},
    body:{attachments:[{type:'contact',payload:{
      max_info:{user_id:String(contactUser)},
      vcf_info:'BEGIN:VCARD\nVERSION:3.0\nTEL;TYPE=CELL:'+phone+'\nEND:VCARD',
    }}]},
  },
});
async function mockMax(action){
  const original=global.fetch,messages=[];
  global.fetch=async(url,options={})=>{
    if(String(url).includes('/messages?'))messages.push(JSON.parse(options.body));
    return {ok:true,status:200,json:async()=>({ok:true})};
  };
  try{return await action(messages);}finally{global.fetch=original;}
}

test('an admin needs a configured phone and can read only their own MAX link',async()=>{
  const missing=await api('POST','/api/max/connect/start',{token:noPhoneToken});
  assert.equal(missing.status,409);
  assert.match(missing.payload.error,/телефон/i);
  const started=await api('POST','/api/max/connect/start');
  assert.equal(started.status,200);
  assert.match(started.payload.deep_link,/^https:\/\/max\.ru\/TestHvostBot\?start=/);
  const other=await api('GET','/api/max/connect/check',
    {token:staffToken,query:{token:started.payload.token}});
  assert.equal(other.status,404);
  assert.equal((await api('GET','/api/max/connect/check',
    {query:{token:started.payload.token}})).payload.verified,false);
  assert.equal(stock.resolveMaxStockAccess('990001'),null);
});

test('MAX own-contact proof grants /stock immediately, never a forwarded contact',async()=>{
  const generated=await api('POST','/api/max/connect/start');
  const token=generated.payload.token;
  await mockMax(async messages=>{
    await bot.processUpdate({update_type:'message_created',message:{
      recipient:{chat_id:'990001'},body:{text:'/start '+token},
    }});
    await bot.processUpdate(contact('990001','42','99','+79005550011'));
    assert.equal(stock.resolveMaxStockAccess('990001'),null);
    await bot.processUpdate(contact('990001','42','42','+79005550999'));
    assert.equal(stock.resolveMaxStockAccess('990001'),null);
    await bot.processUpdate(contact('990001','42','42','+79005550011'));
    assert.ok(messages.some(m=>String(m.text).includes('Номер подтверждён')));
  });
  assert.equal(db.prepare('SELECT max_chat_id FROM admins WHERE id=?').get(superId).max_chat_id,'990001');
  assert.equal(stock.resolveMaxStockAccess('990001').all,true);
  const check=await api('GET','/api/max/connect/check',{query:{token}});
  assert.equal(check.status,200);
  assert.equal(check.payload.verified,true);
});

test('phone changes revoke personal MAX and invalidate previously issued links',async()=>{
  const pending=(await api('POST','/api/max/connect/start')).payload.token;
  const changed=await api('PUT','/api/admins/'+superId,
    {body:{phone:'+7 900 555-00-13'}});
  assert.equal(changed.status,200);
  assert.equal(db.prepare('SELECT max_chat_id FROM admins WHERE id=?').get(superId).max_chat_id,null);
  assert.equal(stock.resolveMaxStockAccess('990001'),null);
  const stale=await api('GET','/api/max/connect/check',{query:{token:pending}});
  assert.equal(stale.status,410);
});

test('deactivating admin clears personal MAX and blocks subsequent stock queries',async()=>{
  db.prepare("UPDATE admins SET max_chat_id='990002' WHERE id=?").run(staffId);
  assert.equal(stock.resolveMaxStockAccess('990002').all,true);
  const changed=await api('PUT','/api/admins/'+staffId,{body:{active:false}});
  assert.equal(changed.status,200);
  assert.equal(db.prepare('SELECT max_chat_id FROM admins WHERE id=?').get(staffId).max_chat_id,null);
  assert.equal(stock.resolveMaxStockAccess('990002'),null);
});
