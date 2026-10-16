'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildReport } = require('./payout-reports');
const { payoutPdfPages, wrap } = require('./payout-report-pdf');

function sample(count) {
  return { ...buildReport('partner', {full_name:'Анна Петрова',code:'GR-TEST',point_name:'БаркЛай'},
    Array.from({length:count},(_,i)=>({order_code:'TG-TEST-'+String(i).padStart(3,'0'),created_at:'2026-10-01 10:00:00',total:250,commission_rate:0.15,commission_amount:38,already_paid:i%2 === 0})),
    {start:'2026-10-01',end:'2026-10-15'}), id:12 };
}
test('PDF layout paginates all rows and repeats table headers without clipping body text', () => {
  const pages = payoutPdfPages(sample(80), '/test/font.ttf');
  assert.ok(pages.length > 2);
  const joined = pages.join('\n');
  for (let i=0;i<80;i++) assert.ok(joined.includes('TG-TEST-'+String(i).padStart(3,'0')));
  assert.ok(joined.includes('250 ₽ × 15%'));
  for (let i=0;i<pages.length;i++) {
    assert.ok(pages[i].includes('Стр. '+(i+1)+' / '+pages.length));
    for (const line of pages[i].split('\n')) {
      const match=line.match(/text (\d+),(\d+(?:\.\d+)?) '/);
      if (match && Number(match[2]) !== 1700) assert.ok(Number(match[2]) < 1631, line);
    }
  }
});
test('unknown historic rates remain explicit and no orders still produces a useful report', () => {
  const r=sample(0);
  assert.ok(payoutPdfPages(r,'/test/font.ttf').join('\n').includes('За выбранный период заказов нет'));
  r.items=[{order_code:'OLD',base:null,rate:null,amount:12}];
  assert.ok(payoutPdfPages(r,'/test/font.ttf').join('\n').includes('Исторический'));
  assert.deepEqual(wrap('A'.repeat(80),20),Array(4).fill('A'.repeat(20)));
});
test('PDF download uses the saved snapshot endpoint and an actual PDF filename', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id,{textContent:'',disabled:false}); return elements.get(id); };
  const calls=[], downloads=[];
  const ctx=vm.createContext({
    document:{getElementById:element,createElement:()=>({click(){downloads.push(this.download);}})},
    authFetch:async url=>{calls.push(url);return {ok:true,blob:async()=>({type:'application/pdf'})};},
    URL:{createObjectURL:()=> 'blob:test-pdf',revokeObjectURL(){}},setTimeout() {},console,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../public/payout-reports.js'),'utf8'),ctx);
  vm.runInContext('payoutReportData={id:12};',ctx);
  await ctx.downloadPayoutPdf();
  assert.deepEqual(calls,['/api/payout-reports/12/pdf']);
  assert.deepEqual(downloads,['HvostMarket_report_12.pdf']);
});
test('PDF endpoint requires admin, validates ids, and exports only stored financial data', async () => {
  const handlers=new Map();let allowed=false, queried=false, rendered;
  const r=sample(1);
  const db={prepare(){queried=true;return {get:()=>({id:12,snapshot_json:JSON.stringify(r)})};}};
  const mod={exports:{}};
  const localRequire=name=>name==='./db'?db:name==='./routes-auth'?{requireAuth:()=>()=>allowed?{id:1}:null}:
    name==='./payout-report-pdf'?{renderPayoutPdf:async report=>{rendered=report;return Buffer.from('%PDF-1.4\nTEST');}}:
    name==='./http-utils'?{sendJson(res,status,data){res.status=status;res.data=data;}}:require(name);
  vm.runInNewContext(fs.readFileSync(require.resolve('./routes-payout-reports'),'utf8'),{require:localRequire,module:mod,exports:mod.exports,console});
  mod.exports.registerPayoutReportRoutes({get(p,fn){handlers.set(p,fn);},post(){}});
  const fn=handlers.get('/api/payout-reports/:id/pdf');
  const response=()=>({setHeader(){},writeHead(status,headers){this.status=status;this.headers=headers;},end(buffer){this.buffer=buffer;}});
  await fn({},response(),{params:{id:12}});assert.equal(queried,false);
  allowed=true;
  let res=response();await fn({},res,{params:{id:'../../etc'}});assert.equal(res.status,400);assert.equal(queried,false);
  res=response();await fn({},res,{params:{id:12},body:{total:999999}});
  assert.equal(res.status,200);assert.equal(res.headers['Content-Type'],'application/pdf');
  assert.ok(res.buffer.toString().startsWith('%PDF-'));assert.equal(rendered.accrued,38);
});
test('owner and manager PDFs use their correct titles and include commission and bonus totals', () => {
  for(const [role,title] of [['owner','Отчёт владельца салона'],['manager','Отчёт менеджера']]) {
    const r=buildReport(role,{id:1,full_name:'Тестовый получатель',code:'QA'},[
      {order_code:'QA-1',created_at:'2026-10-08 07:08:13',total:250,commission_rate:role==='owner'?0.05:0.07,commission_amount:role==='owner'?13:18,point_id:'qa-salon',point_name:'Тестовая точка'},
    ],{start:'2026-10-01',end:'2026-10-15',bonuses:[{point_name:'Новая точка',amount:1000,accrued_at:'2026-10-09 00:00:00'}]});
    const pages=payoutPdfPages(r,'/test/font.ttf').join('\n');
    assert.ok(pages.includes(title));assert.ok(pages.includes('1 000 ₽'));
    if(role==='manager') {assert.ok(pages.includes('Комиссия по точкам'));assert.ok(pages.includes('Тестовая точка'));}
  }
});

module.exports = { sample };
