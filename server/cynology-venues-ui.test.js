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
