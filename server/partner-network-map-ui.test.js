'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('network map is available in admin, manager and both staff Mini App dashboards', () => {
  const admin = read('taiga-admin.html');
  const manager = read('taiga-manager.html');
  const adminNav = read('admin-navigation.js');
  const mini = read('miniapp.html');
  const miniWork = read('miniapp-work.js');
  for (const file of [admin, manager, mini]) {
    assert.match(file, /partner-network-map\.js/);
    assert.match(file, /partner-network-map\.css/);
  }
  assert.match(admin, /id="sec-network-map"/);
  assert.match(manager, /id="sec-network-map"/);
  assert.match(adminNav, /'network-map':'network'/);
  assert.match(manager, /data-group="map"/);
  assert.match(miniWork, /data-work-action="network-map-open"/);
  assert.match(miniWork, /role === 'admin' && adminRegisterAuthorized\(\)/);
  assert.match(miniWork, /role === 'manager' && phoneRoleAvailable\('manager'\)/);
});

test('network map statuses and popup actions are anchored to actual CRM data', () => {
  const script = read('partner-network-map.js');
  assert.match(script, /\/api\/partner-leads\/network-map/);
  for (const status of ['active','to_call','no_answer','in_progress','declined']) {
    assert.match(script, new RegExp(status));
  }
  assert.match(script, /new window\.ymaps\.Placemark/);
  assert.match(script, /network-map\/coordinates/);
  assert.match(script, /data-map-attention/);
  assert.match(script, /unplacedReason/);
  assert.match(script, /lead_ids/);
  assert.match(script, /onOpenLead/);
  assert.match(script, /escapeHtml/);
  assert.match(script, /window\.TAIGA_CONFIG\.YANDEX_MAPS_API_KEY/);
  assert.doesNotThrow(() => new Function(script));
});


test('114 external candidates use a separate purple layer with district filter', () => {
  const script = read('partner-network-map.js');
  const css = read('partner-network-map.css');
  assert.match(script, /candidate: '#8056b2'/);
  assert.match(script, /data-map-candidates/);
  assert.match(script, /data-map-district/);
  assert.match(script, /candidate_ids/);
  assert.match(script, /state\.matchedCandidates/);
  assert.match(script, /Не добавлять повторно/);
  assert.match(script, /Фиолетовые кандидаты не внесены в CRM/);
  assert.match(css, /hm-map-candidate-controls/);
  assert.doesNotThrow(() => new Function(script));
});


test('Yandex links open an organization card when ID exists; otherwise salon search, never a route', () => {
  const vm = require('node:vm');
  const script = read('partner-network-map.js');
  const context = { window: {}, URL };
  vm.runInNewContext(script, context);
  const link = context.window.HvostPartnerNetworkMap.venueYandexLink;
  assert.equal(typeof link, 'function');
  const direct = link({
    name: 'Цацагрум',
    address: 'Красноярск, улица Перенсона, 5А',
    yandex_org_id: '16856539729',
    lat: 56.0, lng: 92.0
  });
  assert.equal(direct.url, 'https://yandex.ru/maps/org/16856539729/');
  assert.equal(direct.direct, true);

  const knownUrl = link({
    name: 'Цацагрум',
    address: 'Красноярск, улица Перенсона, 5А',
    yandex_url: 'https://yandex.ru/maps/org/tsatsagrum/16856539729?si=example'
  });
  assert.equal(knownUrl.url, direct.url);
  assert.equal(knownUrl.direct, true);

  const external = link({
    name: 'Цацагрум',
    address: 'ул. Перенсона, 5А',
    city_name: 'Красноярск',
    lat: 56.01, lng: 92.80
  });
  assert.equal(external.direct, false);
  const queryUrl = new URL(external.url);
  assert.equal(queryUrl.hostname, 'yandex.ru');
  assert.equal(queryUrl.searchParams.get('mode'), 'search');
  assert.match(queryUrl.searchParams.get('text'), /Цацагрум/);
  assert.match(queryUrl.searchParams.get('text'), /Перенсона, 5А/);
  assert.match(queryUrl.searchParams.get('text'), /Красноярск/);
  assert.equal(queryUrl.searchParams.has('rtext'), false);
  assert.equal(queryUrl.searchParams.has('rtt'), false);
  assert.equal(queryUrl.searchParams.has('rtn'), false);

  const foreign = link({
    name: 'Цацагрум',
    address: 'Красноярск, улица Перенсона, 5А',
    yandex_url: 'https://example.com/maps/org/tsatsagrum/16856539729'
  });
  assert.equal(foreign.direct, false);
  assert.ok(foreign.url.includes('mode=search'));

  const oldRoute = link({
    name: 'Цацагрум',
    address: 'Красноярск, улица Перенсона, 5А',
    yandex_url: 'https://yandex.ru/maps/?rtext=~56.01,92.80&rtt=auto'
  });
  assert.equal(oldRoute.direct, false);
  assert.ok(!oldRoute.url.includes('rtext='));
});


test('reviewing a candidate can hide and later restore it without changing CRM', () => {
  const script = read('partner-network-map.js');
  const style = read('partner-network-map.css');
  assert.match(script, /data-map-review-start/);
  assert.match(script, /data-map-review-form/);
  assert.match(script, /data-map-review-reason/);
  assert.match(script, /data-map-review-note/);
  assert.match(script, /Подтвердить и скрыть/);
  assert.match(script, /Нет груминг-салона/);
  assert.match(script, /data-map-reviewed-toggle/);
  assert.match(script, /data-map-review-restore/);
  assert.match(script, /Отработанные и скрытые/);
  assert.match(script, /\/api\/partner-leads\/network-map\/candidates\//);
  assert.match(script, /reviewedCandidates = candidates\.filter/);
  assert.match(script, /return !item\.hidden && !item\.matched/);
  assert.match(script, /showReviewed/);
  assert.match(script, /reviewBusy/);
  assert.match(script, /data-map-review-notice/);
  assert.match(style, /hm-map-review-form/);
  assert.match(style, /hm-map-reviewed-item/);
  assert.match(style, /hm-map-review-start/);
  assert.doesNotThrow(() => new Function(script));
});


test('candidate status editor exposes all CRM stages and VK, Telegram, MAX channels', () => {
  const script=read('partner-network-map.js');
  const css=read('partner-network-map.css');
  for(const status of [
    'Найден, ещё не проверен', 'Ещё не звонили', 'Не дозвонились',
    'В проработке', 'Сообщение отправлено', 'Ожидаю ответа',
    'Встреча назначена', 'Встреча состоялась',
    'Сотрудничество согласовано', 'Отказ'
  ]) assert.ok(script.includes(status),status);
  for(const name of ['ВК','Telegram','MAX'])assert.ok(script.includes(name),name);
  for(const hook of [
    'data-map-contact-start','data-map-contact-form','data-map-contact-status',
    'data-map-contact-channel','data-map-contact-date','data-map-contact-note',
    'data-map-contact-error','saveContact','candidateStatusLabels'
  ]) assert.ok(script.includes(hook),hook);
  assert.match(script,/network-map\/candidates\//);
  assert.match(script,/\/contact/);
  assert.match(css,/hm-map-contact-start/);
  assert.match(css,/hm-map-review-form input\[type=date\]/);
  assert.doesNotThrow(()=>new Function(script));
});


test('shared map name search matches visible organization names, ignoring case, ё and separators', () => {
  const vm = require('node:vm');
  const context = {window:{}};
  vm.runInNewContext(read('partner-network-map.js'), context);
  const matches = context.window.HvostPartnerNetworkMap.matchesName;
  assert.equal(matches('Дог Стиль', 'доГ'), true);
  assert.equal(matches('Дог Стиль', 'СТИЛЬ ДОГ'), true);
  assert.equal(matches('Дог-Стиль', 'дог стиль'), true);
  assert.equal(matches('Дог Стиль', 'догстиль'), true);
  assert.equal(matches('Ёжик Грум', 'ежик'), true);
  assert.equal(matches('Ёжик Грум', 'ёжик'), true);
  assert.equal(matches('Лапочки', 'дог стиль'), false);
  assert.equal(matches('Лапочки', ''), true);
  assert.equal(matches('Дог Стиль', '<img>'), false);
  const script = read('partner-network-map.js');
  const css = read('partner-network-map.css');
  assert.match(script, /data-map-name-search/);
  assert.match(script, /data-map-search-clear/);
  assert.match(script, /matchesName\(i\.name, state\.nameQuery\)/);
  assert.match(script, /root\.addEventListener\('input'/);
  assert.match(script, /setTimeout\(function \(\) \{/);
  assert.match(script, /if \(searchTimer\) \{ clearTimeout\(searchTimer\); searchTimer = null; \}/);
  assert.match(css, /hm-map-name-search input/);
});
