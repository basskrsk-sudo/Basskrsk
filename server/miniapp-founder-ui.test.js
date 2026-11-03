'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

const client=fs.readFileSync(path.join(__dirname,'../public/miniapp-founder.js'),'utf8');
const setup=fs.readFileSync(path.join(__dirname,'../public/miniapp-founder-admin.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
function loadFounder(){
 const window={};
 vm.runInNewContext(client,{window}, {timeout:2000});
 return window.HvostBusinessFounder;
}
test('business founder dashboard contains financial growth, plan, risks, personal tasks and share',()=>{
 const view=loadFounder(),data={
  founder:{full_name:'Лакомых Алексей',share_percent:45,responsibility:'Финансы и продажи'},
  updated_at:'2026-11-01T10:00:00Z',
  sales:{revenue:6370,orders:20,avg_check:319,revenue_change_percent:15,
   orders_change_percent:20,previous:{revenue:5539,orders:17},
   last_six_months:[{month:'2026-10',revenue:6370}]},
  finance:{estimated_result:-1200,manual_expenses:5000,partner_commission_est:300,
   manager_commission_est:100,salon_owner_commission_est:70,tax_est:400,
   acquiring_est:130,expenses_by_category:[{name:'Закуп товара',amount:5000}],
   disclaimer:'Оценка, не прибыль'},
  network:{active_points:7,sold_points_period:4,silent_points_count:12,
   top_points:[{name:'БаркЛай',revenue:2500,orders:7}],
   silent_points:[{name:'Точка без продаж',revenue:0,orders:0}]},
  strategy:{goal_2031:1000,current_active_30d:4,plan_year:2027,
   year_target:20,forecast_year_end:8,required_launches_per_month:2,current_launches_per_month:1,
   scale_decision:'caution',scale_gates:[],note:'Модель, не факт'},
  capital:{my_planned_share:450000,personal_expenses_recorded:100000,
   by_investor:[{name:'Лакомых Алексей',amount:100000,entries:5}],
   note:'Расходы не равны капиталу'},
  operations:{summary:{critical:1,warning:2},issues:[{
   severity:'critical',title:'Нет товара',count:1,summary:'В одной точке'}]},
  tasks:{my_active:3,my_overdue:1,items:[{title:'Договор',status:'new',due_date:'2026-11-05'}],initiatives:[]},
 };
 const page=view.render(data);
 assert.match(page, /<small>Без продаж<\/small><strong>12<\/strong>/);
 for(const text of ['Лакомых Алексей','45%','КАБИНЕТ СОБСТВЕННИКА',
  'Выручка','Средний чек','Расчётный результат','Точка без продаж',
  'Стратегия: 1000 точек','Капитал и доли','Мои поручения','Расходы',
  'Оценка, не прибыль','100 000 ₽','1 000']){
  assert.ok(page.replace(/\u00a0/g, ' ').includes(text),text+' should render');
 }
 assert.ok(page.replace(/\u00a0/g, ' ').includes('-1 200 ₽'));
 assert.ok(!page.includes('password_hash'));
 assert.equal(view.getPeriod(),'30d');
 view.setPeriod('month');
 assert.equal(view.getPeriod(),'month');
 assert.match(view.render(data),/founder-period active/);
});
test('founder admin activation UI never prints passwords, raw phone or credentials',()=>{
 const root={addEventListener(){},querySelectorAll(){return []}};
 const fakeWindow={};
 vm.runInNewContext(setup,{window:fakeWindow,document:{getElementById:id=>id==='workPage'?root:null}});
 const view=fakeWindow.HvostBusinessFounderAdmin;
 assert.ok(view);
 const html=view.render({founders:[
  {id:1,full_name:'Лакомых Алексей',share_percent:45,phone_masked:'+7 (***) ***-**-33',
   password_hash:'SHOULD_NOT_BE_VISIBLE',login:'aleksey',active:true,configured:true},
 ]});
 assert.match(html,/Лакомых Алексей/);
 assert.match(html,/businessFounderSetupForm/);
 assert.match(html,/founderSetupPassword/);
 assert.doesNotMatch(html,/SHOULD_NOT_BE_VISIBLE/);
 assert.doesNotMatch(html,/79135554433/);
});
test('Mini App loads founder modules before workspace loader',()=>{
 const a=html.indexOf('src="/miniapp-founder.js"'),b=html.indexOf('src="/miniapp-founder-admin.js"'),c=html.indexOf('src="/miniapp-work.js"');
 assert.ok(a>0&&b>a&&c>b);
});
