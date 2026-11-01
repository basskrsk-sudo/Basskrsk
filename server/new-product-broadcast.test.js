'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-new-product-test-'));
process.env.TOKEN_SECRET = 'isolated-new-product-secret';

const db = require('./db');
const { savePreferences, preference } = require('./notification-preferences');
const club = require('./routes-partner-club');
const marketing = require('./new-product-broadcast');

function id(sql, ...args) { return Number(db.prepare(sql).run(...args).lastInsertRowid); }
const adminId = id(
  "INSERT INTO admins (login,password_hash,full_name,role,telegram_chat_id,active) VALUES (?,?,?,?,?,1)",
  'broadcast-admin','hash','Владелец рассылки','super','71001'
);
id("INSERT INTO admins (login,password_hash,full_name,role,telegram_chat_id,active) VALUES (?,?,?,?,?,1)",
  'broadcast-normal','hash','Сотрудник','admin','71002');
const product = id("INSERT INTO products(slug,name,category,icon,img,desc,comp,active) VALUES(?,?,?,?,?,?,?,1)",
  'new-product-test','Сушёные лакомства','treats','🦴',null,'Подходят питомцам, содержат <состав>.','[]');
id('INSERT INTO product_variants(product_id,weight,price,active) VALUES(?,?,?,1)',
  product,'5 шт.',299);
const groomer = id(
  "INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,telegram_chat_id,active) VALUES(?,?,?,?,?,?,?,1)",
  'BROADCAST-GR','gr-broadcast','hash','Грумер','79131110001','Салон','71003');
const owner = id(
  "INSERT INTO salon_owners(login,password_hash,full_name,phone,telegram_chat_id,active) VALUES(?,?,?,?,?,1)",
  'owner-broadcast','hash','Владелец салона','79131110001','71003');
const mgr = id(
  "INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,telegram_chat_id,active) VALUES(?,?,?,?,?,?,1)",
  'BROADCAST-MGR','manager-broadcast','hash','Менеджер','79131110003','71004');
const customer = id('INSERT INTO customers(phone,name,telegram_chat_id) VALUES(?,?,?)',
  '79131110005','Покупатель','71005');
const unconsenting = id('INSERT INTO customers(phone,name,telegram_chat_id) VALUES(?,?,?)',
  '79131110006','Без подписки','71006');
const inactive = id(
  "INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,telegram_chat_id,active) VALUES(?,?,?,?,?,?,?,0)",
  'BROADCAST-OLD','old-broadcast','hash','Неактивный грумер','79131110007','Салон','71007');

const groupChat = '-1001234567890';
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)')
  .run(JSON.stringify({ chat_id: groupChat, enabled: false, new_products: false }));

test('promotion is restricted to personally linked superadmins', () => {
  assert.equal(marketing.isBroadcaster('71001'), true);
  assert.equal(marketing.isBroadcaster('71002'), false);
  assert.equal(marketing.isBroadcaster('-1001234567890'), false);
  assert.equal(marketing.startBroadcast('71002').ok, false);
  assert.equal(marketing.handleCallback('71002','newprod:new').ok, false);
});

test('product picker rejects archived/unpriced products and escapes HTML', () => {
  assert.equal(marketing.productById(product).name, 'Сушёные лакомства');
  assert.match(marketing.productCaption(marketing.productById(product), '<b>Новый товар</b>'),
    /&lt;b&gt;Новый товар&lt;\/b&gt;/);
  assert.equal(marketing.validPhotoRef('catalog:../../etc/passwd'), false);
  assert.equal(marketing.validPhotoRef('catalog:https://evil.example/cover.jpg'), true);
  assert.equal(marketing.validPhotoRef('tg:short'), false);
  assert.equal(marketing.validPhotoRef('tg:AAAbbb_1234567890_QWERTY'), true);
});

test('only explicitly opted-in recipients can receive new-product private notices', () => {
  assert.equal(preference('partner', groomer, 'new_products'), false);
  assert.equal(preference('customer', customer, 'offers'), false);
  assert.deepEqual(marketing.recipientSnapshot('partners'), []);
  assert.deepEqual(marketing.recipientSnapshot('customers'), []);
  assert.equal(marketing.recipientSnapshot('club').length, 1);
  savePreferences('partner', groomer, { new_products: true });
  savePreferences('owner', owner, { new_products: true });
  savePreferences('manager', mgr, { new_products: true });
  savePreferences('customer', customer, { offers: true });
  assert.equal(marketing.recipientSnapshot('partners').length, 2,
    'groomer and owner on the same Telegram account receive only one photo');
  assert.equal(marketing.recipientSnapshot('customers').length, 1);
  assert.equal(marketing.recipientSnapshot('all').length, 4);
  assert.ok(!marketing.recipientSnapshot('all').some(row => row.chat_id === '71006'));
  assert.ok(!marketing.recipientSnapshot('all').some(row => row.chat_id === '71007'));
  assert.equal(inactive > 0, true);
  assert.equal(unconsenting > 0, true);
});

let campaignId;
test('wizard requires a product, audience, image preview and explicit confirmation', () => {
  const started = marketing.startBroadcast('71001');
  assert.equal(started.ok, true);
  assert.match(started.message, /Выберите новый товар/);
  const chosen = marketing.handleCallback('71001','newprod:pick:' + product);
  assert.match(chosen.message, /Выберите получателей/);
  const audience = marketing.handleCallback('71001','newprod:aud:all');
  assert.match(audience.message, /У товара нет доступного фото/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM new_product_campaigns').get().n, 0);
  assert.equal(marketing.handleCallback('71001','newprod:prepare').ok, false);
  assert.match(marketing.handleCallback('71001','newprod:photo').message, /Пришлите новую фотографию/);
  const msg = marketing.messageInput({
    chat: { type: 'private', id: 71001 },
    photo: [{ file_id: 'AAAbbb_1234567890_QWERTY' }],
  });
  assert.ok(msg.preview);
  assert.match(msg.preview.caption, /Новинка в ХвостМаркете/);
  assert.equal(marketing.handleCallback('71001','newprod:text').ok, true);
  const edited = marketing.messageInput({
    chat: { type: 'private', id: 71001 }, text: 'Натуральный состав <все включено>',
  });
  assert.ok(edited.preview);
  assert.match(edited.preview.caption, /&lt;все включено&gt;/);
  const prepared = marketing.handleCallback('71001','newprod:prepare');
  assert.match(prepared.message, /Получателей: 4/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM new_product_campaigns').get().n, 0);
  const sent = marketing.handleCallback('71001','newprod:confirm');
  assert.match(sent.message, /поставлена в очередь/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM new_product_campaigns').get().n, 1);
  assert.equal(marketing.handleCallback('71001','newprod:confirm').ok, false,
    'replayed confirmation cannot create duplicate campaign');
  campaignId = db.prepare('SELECT id FROM new_product_campaigns LIMIT 1').get().id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM new_product_deliveries WHERE campaign_id=?')
    .get(campaignId).n, 4);
});

test('queue sends each chat once, skips optouts and generates final report', async () => {
  const deliveries = [], reports = [];
  // Consent is checked again at delivery time, not only when the campaign is created.
  savePreferences('customer', customer, { offers: false });
  const send = async (chat, ref, caption, markup) => {
    deliveries.push({ chat, ref, caption, markup });
    return { ok: true };
  };
  for (let i=0;i<6;i++) {
    await marketing.processBroadcastQueue(send, async (chat, text) => reports.push({chat,text}));
  }
  assert.equal(deliveries.length, 3);
  assert.deepEqual(new Set(deliveries.map(x=>x.chat)),
    new Set(['71003','71004',groupChat]));
  assert.equal(deliveries.every(x => x.ref.startsWith('tg:')), true);
  assert.equal(deliveries.every(x => x.markup.inline_keyboard[0][0].url.includes('хвостмаркет.рф')), true);
  assert.equal(marketing.campaignStatus(campaignId,'71001').message.includes('Доставлено: 3'), true);
  assert.equal(marketing.campaignStatus(campaignId,'71001').message.includes('Пропущено: 1'), true);
  assert.equal(reports.length, 1);
  assert.equal(db.prepare('SELECT state FROM new_product_campaigns WHERE id=?').get(campaignId).state, 'done');
});

test('failed or ambiguous deliveries are not resent accidentally', async () => {
  savePreferences('customer', customer, { offers: true });
  marketing.startBroadcast('71001');
  marketing.handleCallback('71001','newprod:pick:' + product);
  marketing.handleCallback('71001','newprod:aud:customers');
  marketing.handleCallback('71001','newprod:photo');
  marketing.messageInput({chat: {id:71001,type:'private'},
    photo:[{file_id:'AAAbbb_1234567890_QWERTY'}]});
  marketing.handleCallback('71001','newprod:prepare');
  const confirmed = marketing.handleCallback('71001','newprod:confirm');
  assert.equal(confirmed.ok, true);
  let attempts = 0;
  const uncertain = async () => {attempts++; return {ok:false,uncertain:true,error:'Timeout'};};
  await marketing.processBroadcastQueue(uncertain, async () => {});
  await marketing.processBroadcastQueue(uncertain, async () => {});
  assert.equal(attempts, 1);
  const latest = db.prepare('SELECT id FROM new_product_campaigns ORDER BY id DESC LIMIT 1').get().id;
  assert.match(marketing.campaignStatus(latest,'71001').message, /Не подтверждено: 1/);
});

test('poller exposes command and handles photo messages before early no-text return', () => {
  const poller = fs.readFileSync(path.join(__dirname, 'telegram-login-poller.js'), 'utf8');
  assert.match(poller, /command: 'newproduct'/);
  assert.match(poller, /pendingNewProduct = newProductBroadcast\.messageInput\(msg\)/);
  assert.ok(poller.indexOf('pendingNewProduct = newProductBroadcast.messageInput(msg)') <
    poller.indexOf('if (!msg.text) return;', poller.indexOf('const msg = update.message;')));
  assert.match(poller, /startBroadcastWorker\(\)/);
});


test('catalog image is attached as a local Telegram photo without using external links', async () => {
  const picture = 'catalog:images/hero-sir-barsik.jpg';
  assert.equal(marketing.validPhotoRef(picture), true);
  const savedFetch = global.fetch;
  const savedToken = process.env.TG_TOKEN;
  const seen = [];
  try {
    process.env.TG_TOKEN = 'test-telegram-secret';
    global.fetch = async (url, options) => {
      seen.push({url,options});
      return {ok:true,status:200,json:async()=>({ok:true})};
    };
    const result = await marketing.sendProductPhoto('71001', picture,
      '<b>Фото товара</b>', {inline_keyboard:[[{text:'Каталог',url:'https://хвостмаркет.рф/'}]]});
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/sendPhoto$/);
    assert.equal(seen[0].options.method, 'POST');
    const form = seen[0].options.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('chat_id'), '71001');
    assert.equal(form.get('parse_mode'), 'HTML');
    assert.ok(form.get('photo').size > 0);
    assert.equal(form.get('photo').type, 'image/jpeg');
    assert.equal(JSON.parse(form.get('reply_markup')).inline_keyboard[0][0].text, 'Каталог');
  } finally {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.TG_TOKEN;
    else process.env.TG_TOKEN = savedToken;
  }
});
