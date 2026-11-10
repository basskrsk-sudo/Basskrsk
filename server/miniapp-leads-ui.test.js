'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const folder=path.join(__dirname,'..','public');
const html=fs.readFileSync(path.join(folder,'miniapp.html'),'utf8');
const js=fs.readFileSync(path.join(folder,'miniapp-leads.js'),'utf8');
const style=fs.readFileSync(path.join(folder,'miniapp-leads.css'),'utf8');
const routes=fs.readFileSync(path.join(__dirname,'routes-partner-leads.js'),'utf8');

test('Telegram has dedicated bottom-tab calls, not a new independent CRM',()=>{
  assert.match(html,/id="leadsPage"/);
  assert.match(html,/data-view="leads"/);
  assert.match(html,/miniapp-leads\.js\?v=1/);
  assert.match(html,/miniapp-leads\.css\?v=1/);
  assert.match(html,/HvostMiniAppLeads\.open\(\)/);
  assert.match(html,/HvostMiniAppLeads\.available\(\)/);
  assert.match(html,/state\.view==='leads'/);
  assert.match(js,/\/api\/partner-leads/);
  assert.match(js,/\/call'/);
  assert.match(js,/\/claim'/);
  assert.match(js,/role==='admin'/);
  assert.match(js,/identity\.session\(role\)/);
  assert.match(js,/input type="date"|type="date" name="next_contact_date"/);
  assert.match(js,/href=/);
  assert.match(js,/function callHref\(phone\)/);
  assert.match(routes,/SAVEPOINT partner_lead_quick_call/);
  assert.match(style,/hmleads-mini-save/);
  assert.doesNotMatch(js,/localStorage|getItem\('taiga_manager_token'\)/);
  assert.doesNotThrow(()=>new Function(js));
});

test('phone and role gate hides CRM from buyers and groomers without a staff session',async()=>{
  const callbacks={};
  const pane={
    innerHTML:'',textContent:'',
    addEventListener(name,callback){callbacks[name]=callback;},
    replaceChildren(){this.innerHTML='';},
  };
  let status={verified:false,accounts:[{role:'manager'}]};
  const sessions=[];
  const identity={
    getStatus(){return status;},
    async session(role){sessions.push(role);return{role,token:'staff-token'};},
  };
  const requests=[];
  const ctx={
    window:{HvostMiniAppIdentity:identity},
    document:{getElementById(id){return id==='leadsPage'?pane:null;}},
    fetch:async(uri,opts)=>{
      requests.push({uri,opts});
      return {ok:true,json:async()=>({leads:[]})};
    },
    URLSearchParams,FormData,Date,console,
  };
  vm.runInNewContext(js,ctx);
  const calls=ctx.window.HvostMiniAppLeads;
  assert.ok(calls);
  assert.equal(calls.available(),false);
  await calls.open();
  assert.equal(sessions.length,0,'unverified contact must not get staff token');
  status={verified:true,accounts:[{role:'customer'},{role:'partner'}]};
  assert.equal(calls.available(),false);
  await calls.open();
  assert.equal(sessions.length,0);
  status={verified:true,accounts:[{role:'manager'}]};
  assert.equal(calls.available(),true);
  await calls.open();
  assert.deepEqual(sessions,['manager']);
  assert.equal(requests.length,1);
  assert.equal(requests[0].uri,'/api/partner-leads');
  assert.equal(requests[0].opts.headers.Authorization,'Bearer staff-token');
  status={verified:true,accounts:[{role:'admin'}]};
  assert.equal(calls.available(),true);
  await calls.open();
  assert.equal(sessions[1],'admin');
  calls.close();
  assert.equal(pane.innerHTML,'');
});
