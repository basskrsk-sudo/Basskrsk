'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(base,'public/max-miniapp.html'),'utf8');
const js=fs.readFileSync(path.join(base,'public/max-miniapp.js'),'utf8');
const css=fs.readFileSync(path.join(base,'public/max-miniapp.css'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');

test('MAX pilot page uses its own bridge, branded UI and documented backend',()=>{
  assert.match(html,/src="https:\/\/st\.max\.ru\/js\/max-web-app\.js"/);
  assert.match(html,/src="\/max-miniapp\.js/);
  assert.match(html,/href="\/max-miniapp\.css/);
  assert.match(html,/id="point-select"/);
  assert.match(html,/id="products"/);
  assert.match(html,/ТЕСТ/);
  assert.match(js,/window\.WebApp\.initData/);
  assert.match(js,/getAll\('WebAppData'\)/);
  assert.match(js,/\/api\/max\/miniapp\/verify/);
  assert.match(js,/\/api\/points/);
  assert.match(js,/\/api\/products/);
  assert.match(css,/\.product\{/);
  assert.match(server,/registerMaxMiniAppRoutes\(router\)/);
});
test('pilot never links customer or staff accounts and performs no checkout',()=>{
  for(const s of [html,js]){
    assert.doesNotMatch(s,/telegram-web-app\.js|miniapp-identity\.js|telegram-init-data/i);
    assert.doesNotMatch(s,/\/api\/create-payment|\/api\/orders|\/api\/miniapp\/session/);
    assert.doesNotMatch(s,/юкасса|Оплатить|Добавить в корзину/);
  }
  assert.doesNotMatch(js,/['"](?:PUT|DELETE|PATCH)['"]/);
  assert.doesNotMatch(js,/localStorage\.setItem\(['"]token/);
});
