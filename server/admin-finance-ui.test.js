'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'..','public',name),'utf8');
const script=read('admin-finance.js');
const nav=read('admin-navigation.js');
const admin=read('taiga-admin.html');
function start({DateClass=Date}={}){
  const window={};
  const target={innerHTML:''};
  const listeners={};
  const root={dataset:{},innerHTML:'',querySelector:()=>target,
    contains:()=>true,addEventListener:(name,fn)=>{listeners[name]=fn;}};
  vm.runInNewContext(script,{window,Intl,Number,Promise,Date:DateClass});
  const urls=[],destinations=[];
  const summary={period:{from_day:'2026-11-01',to_day:'2026-11-21'},
    revenue:250,expenses:90,orders_count:1,sales_less_recorded_spending:160,
    point_rows:[{point_name:'Салон <script>alert(1)</script>',
      point_id:'a',orders_count:1,revenue:250}],
    disclaimer:'Не является бухгалтерской прибылью'};
  const expenses={expenses:[{id:1,expense_date:'2026-11-03',category:'Корм',
    investor_name:'Лакомых Алексей',amount:90}],page:1,total_count:1,
    total_amount:90,has_next:false};
  const payouts={pending_total:50,paid_total:20,review_total:0,
    next_scheduled_day_of_month:25,
    roles:{partner:{pending:50,paid_total:20},
      owner:{pending:0,paid_total:0},manager:{pending:0,paid_total:0}},
    disclaimer:'Предварительный ориентир'};
  const authFetch=async url=>{
    urls.push(url);
    const data=url.includes('/payouts')?payouts:url.includes('/expenses')?expenses:summary;
    return {ok:true,json:async()=>data};
  };
  const click=async dataset=>{
    listeners.click({target:{closest:()=>({dataset})}});
    await new Promise(resolve=>setImmediate(resolve));
  };
  return {app:window.HvostAdminFinance,root,target,urls,destinations,
    authFetch,click,listeners};
}
test('new Finance is default nav; historical report, expense and unit-economics pages remain',()=>{
  const menu=admin.slice(admin.indexOf('<aside class="sidebar"'),admin.indexOf('<div class="sidebar-footer">'));
  assert.match(menu,/showSection\('finance'\)/);
  assert.doesNotMatch(menu,/Финансы и аналитика/);
  for(const section of ['finance','report-center','economics','business-expenses',
    'payout-reports','weekly-reports','week-comparison','qr-analytics']){
    assert.match(admin,new RegExp('id="sec-'+section+'"'));
  }
  assert.match(nav,/adminFinanceModulePromise/);
  assert.match(nav,/\/admin-finance\.js\?v=/);
  assert.match(nav,/await loadAdminFinanceModule\(\)/);
  assert.doesNotMatch(admin,/<script src="\/admin-finance\.js/,'must not eagerly load finance JS at startup');
  assert.equal((menu.match(/class="nav-item/g)||[]).length,8);
  assert.match(nav,/loadDeferredFinanceScript/);
  assert.doesNotMatch(admin,/<script[^>]+src="[^"]*admin-report-center\.js/);
  assert.doesNotMatch(admin,/<script[^>]+src="[^"]*week-over-week\.js/);
  assert.match(nav,/await loadDeferredFinanceScript\('report-center'\)/);
  assert.match(nav,/await loadDeferredFinanceScript\('week-comparison'\)/);
});
test('UI only loads summary initially; expenses and payouts are genuinely lazy',async()=>{
 const a=start();
 await a.app.mount({root:a.root,authFetch:a.authFetch,navigate:id=>a.destinations.push(id)});
 assert.equal(a.urls.length,1);
 assert.match(a.urls[0],/\/api\/admin\/finance\/summary\?period=month/);
 assert.match(a.root.innerHTML,/Сводка/);
 assert.match(a.root.innerHTML,/Траты/);
 assert.match(a.root.innerHTML,/Выплаты/);
 assert.match(a.root.innerHTML,/2026 год/);
 assert.match(a.root.innerHTML,/За всё время/);
 assert.doesNotMatch(a.root.innerHTML,/365 дней|Последние 12 месяцев/);
 assert.match(a.target.innerHTML,/250 ₽/);
 assert.doesNotMatch(a.target.innerHTML,/<script>alert\(1\)<\/script>/);
 assert.match(a.target.innerHTML,/&lt;script&gt;/);
 await a.click({financeTab:'expenses'});
 assert.equal(a.urls.length,2);
 assert.match(a.urls[1],/\/api\/admin\/finance\/expenses/);
 assert.match(a.target.innerHTML,/20 записей/);
 await a.click({financeTab:'payouts'});
 assert.equal(a.urls.length,3);
 assert.match(a.urls[2],/\/api\/admin\/finance\/payouts/);
 assert.match(a.target.innerHTML,/Предварительная оценка/);
 await a.click({financeAction:'report-center'});
 assert.equal(a.destinations[0],'report-center');
 assert.match(a.target.innerHTML,/Вся задолженность · за всё время/);
 await a.click({financeAction:'debt-report'});
 assert.equal(a.destinations[1],'report-center');
});
test('repeated mount binds at most one set of listeners and escapes XSS',async()=>{
 const a=start();
 const settings={root:a.root,authFetch:a.authFetch,navigate:id=>a.destinations.push(id)};
 await a.app.mount(settings);await a.app.mount(settings);
 assert.equal(Object.keys(a.listeners).length,2);
 assert.equal(a.app.escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
 assert.equal(a.app.formatMoney(null),'—');
});

test('Finance provides calendar 2026, every subsequent year, and all-time',async()=>{
 const a=start();
 await a.app.mount({root:a.root,authFetch:a.authFetch,navigate:id=>a.destinations.push(id)});
 await a.click({financePeriod:'2026'});
 assert.match(a.urls.at(-1),/\/api\/admin\/finance\/summary\?period=2026$/);
 await a.click({financePeriod:'all'});
 assert.match(a.urls.at(-1),/\/api\/admin\/finance\/summary\?period=all$/);
 await a.click({financeTab:'expenses'});
 assert.match(a.urls.at(-1),/\/api\/admin\/finance\/expenses\?period=all&page=1/);
 await a.click({financePeriod:'2026'});
 assert.match(a.urls.at(-1),/\/api\/admin\/finance\/expenses\?period=2026&page=1/);
 class NextYear extends Date{
   static now(){return Date.parse('2027-04-10T08:00:00Z');}
 }
 const b=start({DateClass:NextYear});
 await b.app.mount({root:b.root,authFetch:b.authFetch,navigate:id=>b.destinations.push(id)});
 assert.match(b.root.innerHTML,/2027 год/);
 assert.match(b.root.innerHTML,/2026 год/);
 await b.click({financePeriod:'2027'});
 assert.match(b.urls.at(-1),/\/api\/admin\/finance\/summary\?period=2027$/);
});


test('five optional admin modules are not requested at login; QR implementation stays intact',()=>{
  const optional=['partner-network-map.js','max-admin.js','telegram-connections.js','admin-referral-control.js','admin-qr.js'];
  for(const file of optional){
    assert.doesNotMatch(admin,new RegExp('<script[^>]+src="[^"]*'+file.replace('.','\\.')+'\\b'));
    assert.ok(nav.includes('/'+file+'?v='));
    assert.doesNotThrow(()=>new Function(read(file)));
  }
  const qr=read('admin-qr.js');
  assert.doesNotMatch(admin,/async function qrInitSection\(/);
  for(const name of ['qrInitSection','qrGenerate','printLabelSheet','qrDownloadAll','qrCopyURL']){
    assert.match(qr,new RegExp('function '+name+'\\('));
  }
  assert.match(qr,/window\.HvostAdminQrReady=true/);
  assert.match(qr,/\/api\/sample-qr\/scan\?point=/);
  assert.match(qr,/\/p\//);
  assert.match(read('admin-point.js'),/if\(await showSection\('qr'\)===false\)return;/);
});

test('optional section scripts load once, share concurrent requests and allow retry after failure',async()=>{
  const appended=[],window={};
  const document={querySelectorAll:()=>[],addEventListener(){},
    createElement:()=>({remove(){this.removed=true;}}),
    head:{appendChild(script){appended.push(script);}}};
  window.addEventListener=()=>{};
  const ctx=vm.createContext({document,window,console,Promise});
  vm.runInContext(nav,ctx);
  assert.equal(appended.length,0);
  await ctx.loadAdminSectionScript('dashboard');
  assert.equal(appended.length,0);
  const a=ctx.loadAdminSectionScript('network-map'),b=ctx.loadAdminSectionScript('network-map');
  assert.strictEqual(a,b);
  assert.equal(appended.length,1);
  assert.match(appended[0].src,/partner-network-map\.js/);
  window.HvostPartnerNetworkMap={};
  appended[0].onload();await a;
  await ctx.loadAdminSectionScript('network-map');
  assert.equal(appended.length,1);
  const bad=ctx.loadAdminSectionScript('max');
  appended[1].onerror();
  await assert.rejects(bad,/Не удалось загрузить/);
  assert.equal(appended[1].removed,true);
  const retry=ctx.loadAdminSectionScript('max');
  assert.equal(appended.length,3);
  vm.runInContext('function loadMaxAdmin(){}',ctx);
  appended[2].onload();await retry;
  const missing=ctx.loadAdminSectionScript('referrals');
  appended[3].onload();
  await assert.rejects(missing,/не запустился/);
  assert.equal(appended[3].removed,true);
});

test('a late optional module cannot switch the screen after another navigation',async()=>{
  const appended=[],alerts=[],window={addEventListener(){}};
  const elements={
    'sec-network-map':{id:'sec-network-map',style:{display:'none'}},
    'sec-dashboard':{id:'sec-dashboard',style:{display:'block'}},
    'sec-guides':{id:'sec-guides',style:{display:'none'}},
    'section-title':{textContent:'Главная'},
    'admin-section-load-status':{hidden:true,textContent:''},
  };
  const document={querySelectorAll:selector=>selector==='[id^="sec-"]'?Object.values(elements).filter(x=>x.id):[],
    getElementById:id=>elements[id]||null,addEventListener(){},
    createElement:()=>({remove(){}}),
    head:{appendChild(script){appended.push(script);}}};
  const ctx=vm.createContext({document,window,console,Promise,alert:s=>alerts.push(s)});
  vm.runInContext(nav,ctx);
  vm.runInContext('closeAdminMenu=function(){};renderContextTabs=function(){};',ctx);
  const pending=ctx.showSection('network-map');
  assert.equal(elements['sec-dashboard'].style.display,'block');
  assert.equal(elements['admin-section-load-status'].hidden,false);
  assert.equal(await ctx.showSection('guides'),true);
  window.HvostPartnerNetworkMap={mount(){throw Error('stale map must not mount');}};
  appended[0].onload();
  assert.equal(await pending,false);
  assert.equal(elements['sec-guides'].style.display,'block');
  assert.equal(elements['sec-network-map'].style.display,'none');
  assert.equal(elements['admin-section-load-status'].hidden,true);
  assert.deepEqual(alerts,[]);
});
