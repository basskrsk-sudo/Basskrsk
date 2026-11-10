'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-map-contact-'));
process.env.TG_TOKEN='test-map-contact-tg';
process.env.MAX_BOT_TOKEN='test-map-contact-max';
process.env.MAX_BOT_USERNAME='test-map-bot';
process.env.MAX_WEBHOOK_SECRET='test-map-hook';

const db=require('./db');
const maps=require('./yandex-map-input');
const importer=require('./2gis-lead-bot');
const telegram=require('./telegram-login-poller');
const max=require('./max-bot');

const YANDEX_ORG_ID='16856539729';
const YANDEX_URL='https://yandex.ru/maps/org/tsatsagrum/'+YANDEX_ORG_ID;
const SHARED_URL=YANDEX_URL+'?si=fq665ydvj26gdz0b8kuj1rpfeg';
const SHARED_TEXT='Цацагрум\nул. Перенсона, 5А, Красноярск\n'+SHARED_URL;
const GIS_URL='https://2gis.ru/krasnoyarsk/firm/70000001117772000';

function setupStaff(){
  db.prepare('INSERT INTO admins(login,password_hash,role,active,telegram_chat_id,max_chat_id) VALUES(?,?,?,?,?,?)')
    .run('map-contact-admin','unused','super',1,'989001','989002');
  const manager=Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active,telegram_chat_id,max_chat_id) '+
    'VALUES(?,?,?,?,?,?,?,?,?)'
  ).run('map-contact-manager','map-contact-manager','unused','Ирина','79008881122','krsk',1,'989003','989004').lastInsertRowid);
  db.prepare('INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES(?,?,?,?,?)')
    .run('map-contact-inactive','unused','admin',0,'989005');
  db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active,telegram_chat_id) '+
    'VALUES(?,?,?,?,?,?,?,?)')
    .run('map-contact-other','map-contact-other','unused','Другой','79009990011','spb',1,'989006');
  return manager;
}
const managerId=setupStaff();
const leadCount=()=>db.prepare('SELECT COUNT(*) n FROM partner_leads').get().n;
function getByYandex(id=YANDEX_ORG_ID){
  return db.prepare('SELECT * FROM partner_leads WHERE yandex_org_id=?').get(id);
}
function approval(result,action='yes') {
  assert.equal(result.ok,true);
  assert.equal(result.preview,true);
  const button=result.reply_markup.inline_keyboard.flat()
    .find(b=>b.callback_data.startsWith('dgis:'+action+':'));
  assert.ok(button,'Expected the '+action+' confirmation button');
  const matching=result.attachments[0].payload.buttons.flat()
    .find(b=>b.payload===button.callback_data);
  assert.ok(matching,'Telegram and MAX must contain the same one-time nonce');
  return button.callback_data;
}

test('Yandex Maps official business URL parsed and query removed, with URL allowlist',()=>{
  const result=maps.parseYandexLink(SHARED_URL);
  assert.deepEqual({
    id:result.yandexOrgId,source:result.source,url:result.url,
  },{id:YANDEX_ORG_ID,source:'yandex',url:YANDEX_URL});
  assert.equal(maps.parseYandexLink('https://yandex.ru/maps/org/'+YANDEX_ORG_ID).yandexOrgId,YANDEX_ORG_ID);
  assert.equal(maps.parseYandexLink('https://maps.yandex.ru/org/tsatsagrum/'+YANDEX_ORG_ID).yandexOrgId,YANDEX_ORG_ID);
  assert.equal(maps.parseYandexLink('https://yandex.com/maps/org/tsatsagrum/'+YANDEX_ORG_ID).yandexOrgId,YANDEX_ORG_ID);
  for(const invalid of [
    'https://yandex.ru.evil.invalid/maps/org/tsatsagrum/'+YANDEX_ORG_ID,
    'https://yandex.ru@attacker.example/maps/org/tsatsagrum/'+YANDEX_ORG_ID,
    'https://yandex.ru/maps/search/груминг',
    'https://yandex.ru/maps/org/not-an-id',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://maps.example.com/org/tsatsagrum/'+YANDEX_ORG_ID,
  ]) assert.equal(maps.parseYandexLink(invalid),null,invalid);
});

test('Yandex map share text preserves name, address, and optional phone',()=>{
  const extracted=maps.extractYandexLink(SHARED_TEXT);
  assert.equal(extracted,SHARED_URL);
  assert.deepEqual(maps.parseMapShareFields(SHARED_TEXT,extracted),{
    name:'Цацагрум',phone:'',address:'ул. Перенсона, 5А, Красноярск',
  });
  assert.equal(maps.cityAliasFromAddress('ул. Перенсона, 5А, Красноярск'),'krasnoyarsk');
  const barText='/contact '+SHARED_URL+' | Цацагрум | +7 900 222-33-44 | Красноярск';
  const mapUrl=maps.extractYandexLink(barText);
  assert.deepEqual(maps.parseMapShareFields(barText.replace(/^\/contact\s+/,''),mapUrl),{
    name:'Цацагрум',phone:'+7 900 222-33-44',address:'Красноярск',
  });
});

test('share text proposes Tsatsagrum but saves nothing until active manager confirms',async()=>{
  const before=leadCount();
  const reply=await importer.handle2gisText('telegram','989003',SHARED_TEXT,{
    apiKey:'must-not-query-yandex',
    fetchImpl:async()=>{throw Error('Provider web requests are forbidden here');},
  });
  const yes=approval(reply);
  assert.equal(leadCount(),before);
  assert.equal(getByYandex(),undefined);
  assert.match(reply.message,/Цацагрум/);
  assert.match(reply.message,/Перенсона, 5А, Красноярск/);
  assert.match(reply.message,/Яндекс Карты/);
  assert.match(reply.message,/Телефон: не указан/);
  assert.match(reply.message,/НЕ добавлен/);
  const saved=importer.handle2gisCallback('telegram','989003',yes);
  assert.equal(saved.created,true);
  const card=getByYandex();
  assert.equal(card.salon_name,'Цацагрум');
  assert.equal(card.address,'ул. Перенсона, 5А, Красноярск');
  assert.equal(card.phone,null);
  assert.equal(card.city_id,'krsk');
  assert.equal(card.assigned_manager_id,managerId);
  assert.equal(card.dgis_url,null);
  assert.equal(card.yandex_url,YANDEX_URL);
  assert.equal(card.status,'to_call');
  const note=db.prepare('SELECT note FROM partner_lead_notes WHERE lead_id=?').get(card.id).note;
  assert.match(note,/Добавлено из Яндекс Карт/);
  assert.equal(importer.handle2gisCallback('telegram','989003',yes).ok,false);
  assert.equal(leadCount(),before+1);
});

test('same org ID, changed slug and query parameters never create a duplicate',async()=>{
  const result=await importer.handle2gisText('max','989004',
    '/contact https://yandex.ru/maps/org/another_slug/'+YANDEX_ORG_ID+'?ll=1,2 | Цацагрум');
  assert.equal(result.duplicate,true);
  assert.equal(result.ok,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads WHERE yandex_org_id=?').get(YANDEX_ORG_ID).n,1);
  const denied=await importer.handle2gisText('telegram','989006',
    '/contact https://yandex.ru/maps/org/another_slug/'+YANDEX_ORG_ID);
  assert.equal(denied.duplicate,true);
  assert.equal(denied.id,null,'foreign-city manager must not see private card id');
  assert.doesNotMatch(denied.message,/Цацагрум|Перенсона/);
});

test('link alone asks for name, then sends a preview; cancel leaves the CRM unchanged',async()=>{
  const link='https://yandex.ru/maps/org/salon_veta/16856539731?si=abc';
  const canonical='https://yandex.ru/maps/org/salon_veta/16856539731';
  const first=await importer.handle2gisText('telegram','989001','/contact '+link);
  assert.equal(first.ok,true);
  assert.match(first.message,/Название \| телефон \| адрес/);
  const count=leadCount();
  const preview=await importer.handle2gisText('telegram','989001',
    'Салон Вета | +7 900 123-45-67 | Красноярск, проспект Мира 1');
  const approve=approval(preview);
  assert.equal(leadCount(),count);
  const cancellation=importer.handle2gisCallback('telegram','989001',approval(preview,'no'));
  assert.equal(cancellation.cancelled,true);
  assert.equal(leadCount(),count);
  assert.equal(importer.handle2gisCallback('telegram','989001',approve).ok,false);
  assert.equal(db.prepare('SELECT id FROM partner_leads WHERE yandex_url=?').get(canonical),undefined);
});

test('editing a Yandex proposal invalidates prior button and allows subsequent approval',async()=>{
  const link='https://yandex.ru/maps/org/salon_yabloko/16856539732';
  const before=await importer.handle2gisText('max','989002',
    '/contact '+link+' | Яблоко | +7 900 123-45-67 | Первая улица');
  const stale=approval(before);
  const edit=importer.handle2gisCallback('max','989002',approval(before,'edit'));
  assert.equal(edit.edit,true);
  assert.equal(importer.handle2gisCallback('max','989002',stale).ok,false);
  const changed=await importer.handle2gisText('max','989002',
    'Зоосалон Яблоко | +7 900 333-11-22 | Красноярск, Мира, 77');
  const accepted=approval(changed);
  assert.notEqual(stale,accepted);
  assert.equal(importer.handle2gisCallback('max','989002',accepted).created,true);
  const row=db.prepare('SELECT * FROM partner_leads WHERE yandex_org_id=?').get('16856539732');
  assert.equal(row.salon_name,'Зоосалон Яблоко');
  assert.equal(row.phone,'+7 900 333-11-22');
  assert.equal(row.address,'Красноярск, Мира, 77');
});

test('unauthorized Telegram / MAX identity is denied for /contact',async()=>{
  for(const [channel,chatId] of [
    ['telegram','0001009'],['max','0001010'],['telegram','989005']
  ]){
    const reply=await importer.handle2gisText(channel,chatId,'/contact '+SHARED_URL+' | Незнакомый');
    assert.equal(reply.ok,false);
    assert.match(reply.message,/только активным менеджерам/i);
  }
  assert.equal(importer.handle2gisCallback('telegram','989001','dgis:yes:000000000000000000').ok,false);
});

test('2GIS legacy /2gis remains accepted; cross-map duplicate by name and address',async()=>{
  const url='https://2gis.ru/krasnoyarsk/firm/70000001117772001';
  const proposed=await importer.handle2gisText('max','989004',
    '/2gis '+url+' | Цацагрум | | ул. Перенсона, 5А, Красноярск');
  const yes=approval(proposed);
  const duplicate=importer.handle2gisCallback('max','989004',yes);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.created,undefined);
  const count=db.prepare("SELECT COUNT(*) n FROM partner_leads WHERE salon_name='Цацагрум'").get().n;
  assert.equal(count,1);
});

test('Telegram and MAX bots deliver approval buttons for Yandex Maps',async()=>{
  const old=global.fetch,outputs=[];
  global.fetch=async (url,options={})=>{
    outputs.push({url:String(url),body:options.body?JSON.parse(options.body):null});
    return {ok:true,status:200,json:async()=>({ok:true,result:{}})};
  };
  try{
    const tgUrl='https://yandex.ru/maps/org/good_groom/16856539733';
    const tgShare='Грум Отличный\nКрасноярск, ул. Ленина, 12\n'+tgUrl;
    await telegram.processUpdate({message:{chat:{type:'private',id:989003},from:{id:989003},text:tgShare}});
    assert.equal(db.prepare('SELECT id FROM partner_leads WHERE yandex_url=?').get(tgUrl),undefined);
    const message=outputs.findLast(m=>m.url.includes('api.telegram.org')&&
      m.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('dgis:yes:'));
    assert.ok(message,'Telegram must offer approval rather than insert directly');
    await telegram.processUpdate({callback_query:{
      id:'approve-tg-map',from:{id:989003},
      message:{chat:{type:'private',id:989003},message_id:447},
      data:message.body.reply_markup.inline_keyboard[0][0].callback_data,
    }});
    assert.ok(db.prepare('SELECT id FROM partner_leads WHERE yandex_url=?').get(tgUrl));

    const maxUrl='https://yandex.ru/maps/org/cat_groom/16856539734';
    await max.processUpdate({update_type:'message_created',message:{
      recipient:{chat_id:'989004'},
      body:{text:'/contact '+maxUrl+' | Котогрум | | Красноярск, Молокова, 40'},
    }});
    assert.equal(db.prepare('SELECT id FROM partner_leads WHERE yandex_url=?').get(maxUrl),undefined);
    const m=outputs.findLast(v=>v.url.includes('platform-api2.max.ru/messages?') &&
      v.body?.attachments?.[0]?.payload?.buttons?.[0]?.[0]?.payload?.startsWith('dgis:yes:'));
    assert.ok(m,'MAX must offer callback approval');
    await max.processUpdate({
      update_type:'message_callback',chat_id:'989004',
      callback:{callback_id:'approve-max-map',payload:m.body.attachments[0].payload.buttons[0][0].payload},
    });
    assert.ok(db.prepare('SELECT id FROM partner_leads WHERE yandex_url=?').get(maxUrl));
  }finally{global.fetch=old}
});

test('Yandex source is visible as a safe link in both CRM interfaces',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','public/manager-leads.js'),'utf8');
  const mini=fs.readFileSync(path.join(__dirname,'..','public/miniapp-leads.js'),'utf8');
  assert.match(src,/lead\.yandex_url/);
  assert.match(src,/Открыть в Яндекс Картах/);
  assert.match(mini,/lead\.yandex_url/);
  assert.match(mini,/Открыть в Яндекс Картах/);
});
