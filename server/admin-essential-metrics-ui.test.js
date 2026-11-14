'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const html=read('public/taiga-admin.html');
const nav=read('public/admin-navigation.js');
const server=read('server/server.js');

test('retired BSC is absent from admin interface, navigation, and registered API',()=>{
  const forbidden=[
    /id="sec-bsc"/, /id="bsc-perspectives"/, /id="bsc-settings"/,
    /renderBscDashboard\s*\(/, /\/api\/bsc\//, /id="wr-kpi-bsc"/,
    /id="bsc-initiatives-tbody"/, /Индекс BSC/,
    /chartPie/, /chartBar/, /point-cards-dash/, /kpi-items/,
    /chart\.umd\.js/
  ];
  for(const pattern of forbidden)assert.doesNotMatch(html,pattern);
  assert.doesNotMatch(nav,/['"]bsc['"]|Стратегия и KPI|renderBscDashboard/);
  assert.doesNotMatch(server,/registerBscRoutes|routes-bsc/);
  assert.match(nav,/if \(!sections\.includes\(id\)\) id = 'dashboard'/);
  // BSC must remain available for the separate founder scorecard and the
  // archived weekly management reports. No database migrations are removed.
  assert.match(server,/registerBusinessFounderRoutes\(router\)/);
  assert.match(server,/registerWeeklyReportRoutes\(router\)/);
  assert.match(read('server/routes-business-founders.js'),/getCachedWeeklyBsc/);
  assert.match(read('server/db.js'),/bsc_initiatives/);
});
test('main dashboard has four and only four metrics and a revenue trend',()=>{
  const dashboard=html.split('<div id="sec-dashboard">')[1]
    .split('<div id="sec-tasks"')[0];
  assert.ok(dashboard);
  const names=['kpi-rev','kpi-ord','kpi-avg','kpi-active-points'];
  for(const id of names)assert.match(dashboard,new RegExp('id="'+id+'"'));
  assert.equal((dashboard.match(/class="kpi-card"/g)||[]).length,4);
  assert.match(dashboard,/Ключевые показатели/);
  assert.match(dashboard,/id="chartRev"/);
  assert.match(dashboard,/showSection\('economics'\)/);
  assert.match(html,/id="sec-economics"/);
  assert.match(html,/id="sec-report-center"/);
  assert.match(html,/id="sec-weekly-reports"/);
  assert.match(html,/id="sec-system-health"/);
  assert.match(html,/id="ops-grid"/);
  assert.match(html,/id="sec-payout-reports"/);
});
test('simple KPIs show correct revenue, orders, average and daily series',()=>{
  const start=html.indexOf('function renderDashboard() {');
  const end=html.indexOf('// ── ЗАКАЗЫ ─',start);
  assert.ok(start>=0&&end>start);
  const source=html.slice(start,end);
  assert.doesNotMatch(source,/orders\.filter\(/);
  assert.doesNotMatch(source,/forEach.*items/);
  const labels=new Map();
  const chart=[];
  const date=new Date();
  const iso=new Date(date.getTime()-120000).toISOString().slice(0,19).replace('T',' ');
  const earlier=new Date(date.getTime()-3600000).toISOString().slice(0,19).replace('T',' ');
  const sample=[
    {total:250,created_at:iso},
    {total:140,created_at:earlier}
  ];
  const sandbox={
    Date, Map, Math, Number, Intl,
    periodDays:()=>7,
    ordersInPeriod:()=>sample,
    parseOrderDate:value=>new Date(String(value).replace(' ','T')+'Z'),
    drawLineChart:(id,x,y)=>{chart.push({id,x,y});},
    document:{getElementById:id=>{
      if(!labels.has(id))labels.set(id,{textContent:''});
      return labels.get(id);
    }}
  };
  vm.runInNewContext(source+';renderDashboard();',sandbox);
  assert.equal(labels.get('kpi-rev').textContent,'390 ₽');
  assert.equal(labels.get('kpi-ord').textContent,2);
  assert.equal(labels.get('kpi-avg').textContent,'195 ₽');
  assert.equal(chart.length,1);
  assert.equal(chart[0].id,'chartRev');
  assert.equal(chart[0].y.reduce((sum,value)=>sum+value,0),390);
});
test('script and eight navigation sections remain valid',()=>{
  const scripts=[...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m=>m[1]).sort((a,b)=>b.length-a.length);
  assert.ok(scripts[0].length>100000);
  assert.doesNotThrow(()=>new vm.Script(scripts[0],{filename:'taiga-admin-inline.js'}));
  assert.doesNotThrow(()=>new vm.Script(nav,{filename:'admin-navigation.js'}));
  assert.equal((html.match(/class="nav-item(?: active)?"/g)||[]).length,8);
  for(const section of ['dashboard','points','products','orders','campaigns',
    'report-center','tasks','system-health'])
    assert.match(html,new RegExp("showSection\\('"+section+"'\\)"));
});
