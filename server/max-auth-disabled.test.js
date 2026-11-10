'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-paused-'));
process.env.MAX_BOT_TOKEN='test-max-token';
process.env.MAX_BOT_USERNAME='test-bot';
process.env.MAX_WEBHOOK_SECRET='test-secret';
const { MAX_AUTH_ENABLED }=require('./max-auth-policy');
const db=require('./db');
const { signToken }=require('./auth');
const { registerAuthRoutes }=require('./routes-auth');
const handlers={post:new Map(),get:new Map(),put:new Map()};
registerAuthRoutes({
  get:(name,fn)=>handlers.get.set(name,fn),
  post:(name,fn)=>handlers.post.set(name,fn),
  put:(name,fn)=>handlers.put.set(name,fn),
});
async function invoke(method,route,{body={},query={},token=''}={}){
  const fn=handlers[method].get(route);
  assert.equal(typeof fn,'function','Missing route '+method+' '+route);
  const req={headers:{authorization:token?'Bearer '+token:''}};
  const res={
    status:0,
    writeHead(code){this.status=code;},
    setHeader(){},
    end(raw){this.data=raw?JSON.parse(raw):null;},
  };
  await fn(req,res,{body,query});
  return res;
}

test('MAX sign-in is blocked on server even on cached clients',async()=>{
  assert.equal(MAX_AUTH_ENABLED,false);
  const status=await invoke('get','/api/customer/max/status');
  assert.equal(status.status,200);
  assert.equal(status.data.enabled,false);
  const before=db.prepare('SELECT COUNT(*) AS total FROM max_login_tokens').get().total;
  const start=await invoke('post','/api/customer/max/start',{body:{phone:'+7 900 111-22-33'}});
  assert.equal(start.status,503);
  assert.match(start.data.error,/MAX/);
  const after=db.prepare('SELECT COUNT(*) AS total FROM max_login_tokens').get().total;
  assert.equal(after,before,'disabled login must not create tokens');
});

test('previously verified MAX tokens cannot issue customer sessions',async()=>{
  db.prepare("INSERT INTO max_login_tokens(token,phone,verified,chat_id,expires_at) VALUES(?,?,1,?,datetime('now','+10 minutes'))")
    .run('preverified-pause-test','79001112233','111999');
  const result=await invoke('get','/api/customer/max/check',{query:{token:'preverified-pause-test'}});
  assert.equal(result.status,503);
  const user=db.prepare('SELECT id FROM customers WHERE phone=?').get('79001112233');
  assert.equal(user,undefined);
});

test('MAX account linking is suspended for existing groomers and owners',async()=>{
  const partnerId=Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,max_chat_id) VALUES (?,?,?,?,?,?,?)'
  ).run('PAUSED-MAX-TEST','paused-max-partner','hash','Тест MAX','79001112233','Точка','998877').lastInsertRowid);
  const token=signToken({role:'partner',id:partnerId,login:'paused-max-partner'});
  const start=await invoke('post','/api/max/connect/start',{token});
  assert.equal(start.status,503);
  const check=await invoke('get','/api/max/connect/check',{token,query:{token:'preverified-pause-test'}});
  assert.equal(check.status,503);
  const saved=db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(partnerId);
  assert.equal(saved.max_chat_id,'998877','pre-existing MAX notification link must not be erased');
});

test('MAX messaging configuration is retained for already linked accounts',()=>{
  assert.equal(require('./max-bot').isConfigured(),true);
});

test('website hides MAX login and linking across all customer and partner screens',()=>{
  const root=path.join(__dirname,'..','public');
  const read=name=>fs.readFileSync(path.join(root,name),'utf8');
  const index=read('index.html'),qr=read('p.html');
  for(const marker of ['id="account-max-block"','id="account-max-step-waiting"',
    'id="checkout-max-offer"'])
    assert.equal(index.includes(marker),false,marker);
  assert.equal(qr.includes('id="successMaxCard"'),false);
  const tasks=read('tasks.html');
  assert.doesNotMatch(tasks,/connectPerson\('\+member\.id\+','\\'max\\'/);
  for(const file of ['taiga-groomer.html','taiga-owner.html']){
    const html=read(file);
    assert.doesNotMatch(html,/max-connect\.js|HvostMaxConnect\.mount|id="(?:partner|owner)-max-connect"/);
  }
  assert.match(index,/Продолжить через Telegram/);
  assert.match(qr,/successTelegramCard/);
});

test('task-page MAX activation paths are also disabled',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-task-page.js'),'utf8');
  const guards=source.match(/channel === 'max' && !MAX_AUTH_ENABLED/g)||[];
  assert.equal(guards.length,2,'both task link start and poll must be blocked');
  assert.match(source,/const \{ MAX_AUTH_ENABLED \} = require\('\.\/max-auth-policy'\)/);
});
