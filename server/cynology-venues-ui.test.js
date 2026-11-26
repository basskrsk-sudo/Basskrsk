'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pub = path.resolve(__dirname,'..','public');
const read = file => fs.readFileSync(path.join(pub,file),'utf8');

test('public homepage invites grooming salons, veterinary clinics and canine centers', () => {
  const html=read('index.html');
  assert.match(html, /У вас груминг-салон, ветклиника или кинологический центр\?/);
  assert.match(html, /Для груминг-салонов, ветклиник и кинологических центров/);
  assert.match(html, /id="partner-cynology"/);
  assert.match(html, /Специальное предложение кинологическим центрам/);
  assert.match(html, /onclick="proposeTrainingCenter\(\)"/);
  assert.match(html, /function proposeTrainingCenter\(\)/);
  assert.match(html, /select\.value = 'training_center'/);
  assert.match(html, /id="partner-working-points"/, 'only genuine API-provided venues are advertised as installed');
  assert.match(html, /приглашаем к сотрудничеству кинологические центры/);
});

test('main and referral application forms offer and submit the correct business type', () => {
  const html=read('index.html');
  const invite=read('partner-invite.html');
  for(const [name,src,id] of [['main',html,'pf-category'],['referral',invite,'category']]){
    assert.match(src,new RegExp('<select id="'+id+'"[^>]*>'));
    assert.match(src,/<option value="groomer">Груминг-салон<\/option>/);
    assert.match(src,/<option value="vet">Ветеринарная клиника<\/option>/);
    assert.match(src,/<option value="training_center">Кинологический центр \/ центр дрессировки<\/option>/);
    assert.match(src,/<option value="kennel">Кинолог \/ питомник<\/option>/);
    assert.match(src,/<option value="other">Другое<\/option>/);
    assert.match(src,/\/api\/partner-leads\/public/, name+' form must use existing shared CRM');
  }
  assert.match(html, /salon_name: salonName,\s*category: category,/);
  assert.match(html, /if \(!category\) \{ showToast\('⚠️ Выберите тип площадки'\)/);
  assert.match(invite, /category:document\.getElementById\('category'\)\.value/);
  assert.doesNotMatch(invite, /category:'groomer'/);
});

test('partner CRM and managers recognize canine center category consistently',()=>{
  const admin=read('taiga-admin.html');
  const manager=read('taiga-manager.html');
  const leads=read('manager-leads.js');
  const backend=fs.readFileSync(path.resolve(__dirname,'routes-partner-leads.js'),'utf8');
  assert.match(admin, /<option value="training_center">Кинологический центр \/ центр дрессировки<\/option>/);
  assert.match(admin, /training_center: 'Кинологический центр \/ центр дрессировки'/);
  assert.match(leads, /\['training_center', 'Кинологический центр \/ центр дрессировки'\]/);
  assert.match(backend, /training_center: 'Кинологический центр \/ центр дрессировки'/);
  assert.match(manager, /Найдите груминг-салон, ветклинику или кинологический центр/);
});

test('Mini App shopping locations use generic point descriptions rather than salon-only names',()=>{
  const html=read('miniapp.html');
  for(const text of ['Выберите минимаркет','Есть в минимаркете',
    'Товары доступны в наличии в выбранном минимаркете','Минимаркет не выбран']){
    assert.ok(html.includes(text),text);
  }
  assert.doesNotMatch(html,/Выберите салон|Выбрать салон|выбранном салоне|Есть в салоне/);
  assert.match(html,/\/api\/create-payment/,'payment flow stays wired');
});

test('inline scripts in public homepage, referral landing and Mini App remain valid JavaScript',()=>{
  for(const name of ['index.html','partner-invite.html','miniapp.html']){
    const html=read(name);
    const scripts=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length>0,name+' must include inline JavaScript');
    for(const script of scripts) assert.doesNotThrow(()=>new Function(script[1]),name+' must compile');
  }
});


test('partner hero counts only the public working-point list, with no second request or fake fallback', async () => {
  const html = read('index.html');
  const hero = html.slice(html.indexOf('id="page-partners"'), html.indexOf('class="partner-benefit-grid"'));
  assert.match(hero, /<h1>[\s\S]*?<\/h1>\s*<div class="partner-network-count" id="partner-network-count" role="status" hidden>/);
  assert.match(html, /\.partner-network-count\[hidden\]\s*\{\s*display:\s*none;/);
  const plural = html.slice(html.indexOf('function pluralRu('), html.indexOf('function renderPublicCalculator()'));
  const start = html.indexOf('async function renderPartnerWorkingPoints()');
  const render = html.slice(start, html.indexOf('let SITE_POINTS =', start));
  const vm = require('node:vm');
  for (const [n, expected] of [[0,'0 действующих минимаркетов'],[1,'1 действующий минимаркет'],[2,'2 действующих минимаркета'],[5,'5 действующих минимаркетов'],[11,'11 действующих минимаркетов'],[21,'21 действующий минимаркет']]) {
    const grid = {innerHTML:'',querySelectorAll:()=>[]};
    const block = {hidden:true};
    const value = {textContent:''};
    let requests = 0;
    const context = {
      document:{getElementById:id=>({'partner-working-points':grid,'partner-network-count':block,'partner-network-count-value':value})[id]},
      fetch:async url=>{
        assert.equal(url,'/api/partner-showcase-points');
        requests++;
        return {ok:true,json:async()=>({points:Array.from({length:n},(_,i)=>({id:String(i),name:'Point '+i}))})};
      },
      escapeHtml:s=>String(s)
    };
    vm.createContext(context);
    await vm.runInContext(plural+'\nlet partnerWorkingPointsLoaded = false;\n'+render+'\nrenderPartnerWorkingPoints()',context);
    assert.equal(block.hidden,false);
    assert.equal(value.textContent,expected);
    assert.equal((grid.innerHTML.match(/<article /g)||[]).length,n);
    await vm.runInContext('renderPartnerWorkingPoints()',context);
    assert.equal(requests,1);
  }
  for (const response of [{ok:false,json:async()=>({error:'failed'})},{ok:true,json:async()=>({})}]) {
    const block = {hidden:false}, value = {textContent:''}, grid={innerHTML:''};
    const context={
      document:{getElementById:id=>({'partner-working-points':grid,'partner-network-count':block,'partner-network-count-value':value})[id]},
      fetch:async()=>response
    };
    await vm.runInNewContext(plural+'\nlet partnerWorkingPointsLoaded = false;\n'+render+'\nrenderPartnerWorkingPoints()',context);
    assert.equal(block.hidden,true);
    assert.equal(value.textContent,'');
    assert.match(grid.innerHTML,/Не удалось загрузить точки/);
  }
});

test('public working-point showcase excludes inactive and legacy demonstration hubs', () => {
  const backend = fs.readFileSync(path.resolve(__dirname,'routes-products.js'),'utf8');
  const start = backend.indexOf("router.get('/api/partner-showcase-points'");
  assert.ok(start >= 0);
  const route = backend.slice(start,backend.indexOf('// PUT /api/products/:id/stock',start));
  assert.match(route,/WHERE p\.active = 1 AND COALESCE\(p\.is_hub, 0\) = 0/);
  assert.match(route,/sendJson\(res, 200, \{ points \}\)/);
});
