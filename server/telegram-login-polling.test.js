'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function harness(){
  const timers=new Map(),docCallbacks=new Map(),pageCallbacks=new Map();
  let tickTime=0,nextId=0;
  const on=(map,key,cb)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(cb)};
  const off=(map,key,cb)=>map.get(key)?.delete(cb);
  const doc={hidden:false,
    addEventListener:(k,cb)=>on(docCallbacks,k,cb),
    removeEventListener:(k,cb)=>off(docCallbacks,k,cb)};
  const win={addEventListener:(k,cb)=>on(pageCallbacks,k,cb),
    removeEventListener:(k,cb)=>off(pageCallbacks,k,cb)};
  const setTimer=(cb,ms)=>{const id=++nextId;timers.set(id,{cb,ms});return id};
  const clearTimer=id=>timers.delete(id);
  vm.runInNewContext(read('public/telegram-login-polling.js'),{
    window:win,document:doc,setTimeout:setTimer,clearTimeout:clearTimer,
    Date:{now:()=>tickTime},console,
  });
  const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()};
  return {
    poll:win.HvostTelegramLoginPolling,
    doc,timers,now:()=>tickTime,
    advance:async(ms)=>{
      tickTime+=ms;
      const snapshot=[...timers.entries()].filter(([,t])=>t.ms<=ms);
      for(const [id,t] of snapshot){timers.delete(id);t.cb();}
      await flush();
    },
    show:()=>{doc.hidden=false;for(const cb of docCallbacks.get('visibilitychange')||[])cb()},
    hide:()=>{doc.hidden=true;for(const cb of docCallbacks.get('visibilitychange')||[])cb()},
    pageShow:()=>{for(const cb of pageCallbacks.get('pageshow')||[])cb()},
  };
}
test('shared Telegram polling stops after five minutes even after a hidden tab',async()=>{
  // A fake event loop verifies no network work while the tab is hidden.
  const x=harness();let count=0,expiredCount=0;
  x.poll.start({check:async()=>{count++;return null},onExpired:()=>expiredCount++,
    now:x.now,document:x.doc});
  await x.advance(0);
  assert.equal(count,1);
  x.hide();
  assert.equal(x.timers.size,0,'background tabs must have no polling timer');
  await x.advance(5*60*1000+1000);
  assert.equal(count,1,'hidden tab must not hit the server');
  x.show();
  assert.equal(expiredCount,1);
  assert.equal(x.timers.size,0);
});
test('a verified session cancels timers, no duplicate checks and no stale events',async()=>{
  const h=harness();let count=0,success=0;
  h.poll.start({check:async()=>{count++;return {done:true,data:'session'}},
    onSuccess:data=>{assert.equal(data,'session');success++},now:h.now});
  await h.advance(0);
  assert.equal(count,1);
  assert.equal(success,1);
  assert.equal(h.timers.size,0);
  h.pageShow();
  await h.advance(4000);
  assert.equal(count,1,'resolved login cannot restart after pageshow');
});
test('customer, checkout, groomer and manager share the bounded login poller',()=>{
  for(const file of ['public/index.html','public/taiga-groomer.html','public/taiga-manager.html']){
    const html=read(file);
    assert.match(html,/telegram-login-polling\.js\?v=1/);
    assert.match(html,/HvostTelegramLoginPolling\.start\(/);
  }
  const index=read('public/index.html');
  assert.match(index,/function pollCheckoutTelegramConnection/);
  assert.doesNotMatch(index,/telegramPollTimer = setInterval/);
  assert.doesNotMatch(index,/checkoutTelegramPollTimer = setInterval/);
  assert.doesNotMatch(read('public/taiga-groomer.html'),/partnerTgPollTimer = setInterval/);
  assert.doesNotMatch(read('public/taiga-manager.html'),/mgrTgPollTimer = setInterval/);
  assert.match(read('public/taiga-groomer.html'),/submitTelegramCode/);
  assert.match(read('public/taiga-manager.html'),/submitTelegramCode/);
});
