'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-2gis-import-'));
process.env.TG_TOKEN='test-telegram-token';
process.env.MAX_BOT_TOKEN='test-max-token';
process.env.MAX_BOT_USERNAME='test-max-bot';
process.env.MAX_WEBHOOK_SECRET='test-max-webhook-secret';
const db=require('./db');
const importer=require('./2gis-lead-bot');
const telegram=require('./telegram-login-poller');
const max=require('./max-bot');

function addStaff() {
  db.prepare('INSERT INTO admins(login,password_hash,role,active,telegram_chat_id,max_chat_id) VALUES(?,?,?,?,?,?)')
    .run('2gis-admin','hash','super',1,'812001','812002');
  const mgr=Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active,telegram_chat_id,max_chat_id) '+
    'VALUES(?,?,?,?,?,?,?,?,?)'
  ).run('2gis-mgr-a','2gis-mgr-a','hash','Менеджер 2ГИС','79001234567','krsk',1,'812003','812004').lastInsertRowid);
  db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active,telegram_chat_id) '+
    'VALUES(?,?,?,?,?,?,?,?)'
  ).run('2gis-mgr-b','2gis-mgr-b','hash','Другой менеджер','79001234568','spb',1,'812005');
  db.prepare('INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES(?,?,?,?,?)')
    .run('2gis-inactive-admin','hash','admin',0,'812006');
  return mgr;
}
const mgrId=addStaff();
const FIRMA='70000001012345678';
const FIRM_B='70000001012345679';
const FIRM_C='70000001012345680';
const ORIGINAL='https://2gis.ru/krasnoyarsk/firm/'+FIRMA;
const GEO='70000001113304165';
const GEO_URL='https://2gis.ru/krasnoyarsk/geo/'+GEO;
const GEO_BRANCH='70000001113304166';


test('accepts only 2GIS firm cards or supported 2GIS short links',()=>{
  const parsed=importer.parseLink(ORIGINAL+'?m=56.03,92.8/14');
  assert.equal(parsed.firmId,FIRMA);
  assert.equal(parsed.cityAlias,'krasnoyarsk');
  assert.equal(parsed.url,ORIGINAL);
  assert.equal(importer.parseLink('go.2gis.ru/aBcDE').short,true);
  for(const invalid of [
    'javascript:alert(1)','https://evil.com/krasnoyarsk/firm/'+FIRMA,
    'https://go.2gis.ru.evil.invalid/AbCd','https://2gis.ru@evil.invalid/x',
    'https://2gis.ru/krasnoyarsk/search/zooshop',
    'https://2gis.ru/krasnoyarsk/routeSearch/rsType/car',
    'file:///etc/passwd',
  ])assert.equal(importer.parseLink(invalid),null,invalid);
});

test('accepts the exact /geo/ link from 2GIS without mistaking the geo ID for a company',()=>{
  const parsed=importer.parseLink(GEO_URL);
  assert.ok(parsed);
  assert.equal(parsed.geoId,GEO);
  assert.equal(parsed.firmId,null);
  assert.equal(parsed.short,false);
  assert.equal(parsed.cityAlias,'krasnoyarsk');
  assert.equal(parsed.url,GEO_URL);
  assert.equal(importer.parseLink(GEO_URL+'?m=92.8,56.0/16#details').url,GEO_URL);
  assert.equal(importer.parseLink(GEO_URL+'/?q=1').geoId,GEO);
  assert.equal(importer.parseLink('https://2gis.ru/krasnoyarsk/geo/not-a-number'),null);
  assert.equal(importer.parseLink('https://2gis.ru/krasnoyarsk/search/salon'),null);
});

test('short links are followed manually only across allowed hosts',async()=>{
  const result=await importer.resolve2gis('https://go.2gis.ru/AbCd',{
    fetchImpl:async(url,options)=>{
      assert.equal(options.redirect,'manual');
      assert.equal(new URL(url).hostname,'go.2gis.ru');
      return{status:302,headers:{get:()=>ORIGINAL}};
    },
  });
  assert.equal(result.firmId,FIRMA);
  const geo=await importer.resolve2gis('https://go.2gis.ru/AbCd',{
    fetchImpl:async()=>({status:302,headers:{get:()=>GEO_URL+'?m=55,66/15'}}),
  });
  assert.equal(geo.geoId,GEO);
  assert.equal(geo.short,false);
  const blocked=await importer.resolve2gis('https://go.2gis.ru/AbCd',{
    fetchImpl:async()=>({status:302,headers:{get:()=> 'https://private.internal/metadata'}}),
  });
  assert.equal(blocked.short,true,'redirects to unknown origins are not fetched');
});

test('official 2GIS Places response can fill category, name, address and accessible phone',async()=>{
  let endpoint='';
  const item={
    id:FIRM_C,type:'branch',name:'Груминг Тест из API',
    full_address_name:'Красноярск, ул. Мира, 1',
    rubrics:[{name:'Груминг-салоны'}],
    contact_groups:[{contacts:[{type:'phone',value:'+7 999 000-10-10'}]}],
  };
  const details=await importer.fetch2gisCard(FIRM_C,{
    key:'test-key-not-real',
    fetchImpl:async(url)=>{
      endpoint=String(url);
      return{ok:true,json:async()=>({meta:{code:200},result:{items:[item]}})};
    },
  });
  assert.equal(new URL(endpoint).hostname,'catalog.api.2gis.com');
  assert.equal(new URL(endpoint).searchParams.get('id'),FIRM_C);
  assert.equal(details.name,item.name);
  assert.equal(details.category,'groomer');
  assert.equal(details.phone,'+7 999 000-10-10');
  assert.equal(details.address,item.full_address_name);
  const missing=await importer.fetch2gisCard(FIRM_C,{key:'',fetchImpl:async()=>{throw Error('no API should be called');}});
  assert.equal(missing,null);
});

test('unlinked or inactive bot identities cannot import or start a pending draft',async()=>{
  const before=db.prepare('SELECT COUNT(*) AS n FROM partner_leads').get().n;
  for(const [channel,chat] of [['telegram','919191'],['max','919192'],['telegram','812006']]){
    const result=await importer.handle2gisText(channel,chat,'/2gis '+ORIGINAL);
    assert.equal(result.ok,false);
    assert.match(result.message,/только активным менеджерам/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_leads').get().n,before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dgis_bot_pending').get().n,0);
});

test('manager can send 2GIS URL, then name, phone and address: shared CRM contains one lead',async()=>{
  const first=await importer.handle2gisText('telegram','812003','/2gis '+ORIGINAL);
  assert.equal(first.ok,true);
  assert.match(first.message,/Название \| телефон \| адрес/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_leads').get().n,0);
  const second=await importer.handle2gisText('telegram','812003',
    'Грум Стиль | +7 900 111-22-33 | Красноярск, ул. Ленина, 7');
  assert.equal(second.created,true);
  assert.match(second.message,/Добавлено в обзвон/);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_firm_id=?').get(FIRMA);
  assert.equal(lead.salon_name,'Грум Стиль');
  assert.equal(lead.assigned_manager_id,mgrId);
  assert.equal(lead.city_id,'krsk');
  assert.equal(lead.phone,'+7 900 111-22-33');
  assert.equal(lead.dgis_url,ORIGINAL);
  assert.equal(lead.status,'to_call');
  const note=db.prepare('SELECT note,author FROM partner_lead_notes WHERE lead_id=?').get(lead.id);
  assert.match(note.note,/Добавлено из 2ГИС/);
  assert.match(note.note,/2gis\.ru/);
  assert.equal(note.author,'Менеджер 2ГИС');
  const repeated=await importer.handle2gisText('max','812004','/2gis '+ORIGINAL);
  assert.equal(repeated.duplicate,true);
  assert.match(repeated.message,/уже есть в обзвоне/);
  const count=db.prepare('SELECT COUNT(*) AS n FROM partner_leads WHERE dgis_firm_id=?').get(FIRMA).n;
  assert.equal(count,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dgis_bot_pending WHERE chat_id=?').get('812003').n,0);
});

test('different manager sees no confidential details of a duplicate',async()=>{
  const repeated=await importer.handle2gisText('telegram','812005','/2gis '+ORIGINAL);
  assert.equal(repeated.ok,true);
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.id,null);
  assert.doesNotMatch(repeated.message,/Грум Стиль|Ленина|900 111/);
});

test('admin can import a complete 2GIS card automatically using optional API key',async()=>{
  const mock=async()=>({ok:true,json:async()=>({
    meta:{code:200},
    result:{items:[{id:FIRM_C,type:'branch',name:'Салон Авто 2ГИС',
      full_address_name:'Красноярск, Мира 25',
      rubrics:[{name:'Груминг-салоны'}],
      contact_groups:[{contacts:[{type:'phone',value:'+7 999 000-00-11'}]}]}]},
  })});
  const saved=await importer.handle2gisText('telegram','812001',
    '/2gis https://2gis.ru/krasnoyarsk/firm/'+FIRM_C,
    {apiKey:'test-key',fetchImpl:mock});
  assert.equal(saved.created,true);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_firm_id=?').get(FIRM_C);
  assert.equal(lead.assigned_manager_id,null);
  assert.equal(lead.category,'groomer');
  assert.equal(lead.phone,'+7 999 000-00-11');
  assert.equal(lead.city_id,'krsk');
});

test('support one message with full details, including direct 2GIS share link',async()=>{
  const saved=await importer.handle2gisText('max','812002',
    'https://2gis.ru/krasnoyarsk/firm/'+FIRM_B+
    ' | Кинолог Зверь | +7 999 555-22-11 | ул. Молокова, 18');
  assert.equal(saved.created,true);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_firm_id=?').get(FIRM_B);
  assert.equal(lead.salon_name,'Кинолог Зверь');
  assert.equal(lead.phone,'+7 999 555-22-11');
  assert.equal(lead.address,'ул. Молокова, 18');
});

test('the exact /geo/ link works without a Places API key and is deduplicated across bots',async()=>{
  // Do not infer the company name, phone or building from a bare /geo/ link.
  const first=await importer.handle2gisText('telegram','812003','/2gis '+GEO_URL);
  assert.equal(first.ok,true);
  assert.match(first.message,/геообъект/);
  assert.match(first.message,/Название \| телефон \| адрес/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads WHERE dgis_url=?').get(GEO_URL).n,0);
  const saved=await importer.handle2gisText('telegram','812003',
    'Груминг для хвостиков | +7 900 111-22-44 | Красноярск, ул. Весны, 1');
  assert.equal(saved.created,true);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_url=?').get(GEO_URL);
  assert.equal(lead.dgis_firm_id,null,'geo ID is not a verified organization');
  assert.equal(lead.status,'to_call');
  assert.equal(lead.assigned_manager_id,mgrId);
  assert.equal(lead.phone,'+7 900 111-22-44');
  const duplicate=await importer.handle2gisText('max','812004',GEO_URL+'?test=1');
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.id,lead.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads WHERE dgis_url=?').get(GEO_URL).n,1);
});

test('a /geo/ ID is promoted to firm ID only when official 2GIS API returns branch',async()=>{
  let calls=0;
  const result=await importer.handle2gisText('max','812002',
    '/2gis https://2gis.ru/krasnoyarsk/geo/'+GEO_BRANCH,
    {apiKey:'test-places-key',fetchImpl:async(url)=>{
      calls++;
      assert.equal(new URL(url).searchParams.get('id'),GEO_BRANCH);
      return {ok:true,json:async()=>({meta:{code:200},result:{items:[{
        id:GEO_BRANCH,type:'branch',name:'Зоосалон API',
        full_address_name:'Красноярск, Мира 20',rubrics:[{name:'Груминг-салоны'}],
      }]}})};
    }},
  );
  assert.equal(calls,1);
  assert.equal(result.created,true);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_firm_id=?').get(GEO_BRANCH);
  assert.equal(lead.salon_name,'Зоосалон API');
  assert.equal(lead.dgis_url,'https://2gis.ru/krasnoyarsk/geo/'+GEO_BRANCH);
  assert.equal(lead.category,'groomer');
  const duplicate=await importer.handle2gisText('telegram','812001',
    '/2gis https://2gis.ru/krasnoyarsk/firm/'+GEO_BRANCH);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.id,lead.id);
});

test('a /geo/ building response is never treated as a company',async()=>{
  const id='70000001113304167';
  const result=await importer.handle2gisText('max','812002',
    '/2gis https://2gis.ru/krasnoyarsk/geo/'+id,
    {apiKey:'test-places-key',fetchImpl:async()=>({ok:true,json:async()=>({
      meta:{code:200},result:{items:[{id,type:'building',name:'Жилой дом',address_name:'Ленина, 1'}]},
    })})},
  );
  assert.equal(result.ok,true);
  assert.equal(result.created,undefined);
  assert.match(result.message,/Название организации/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads WHERE dgis_url=?')
    .get('https://2gis.ru/krasnoyarsk/geo/'+id).n,0);
  // No wrong company is stored; cancel the prompt.
  assert.match((await importer.handle2gisText('max','812002','/cancel')).message,/отменено/);
});

test('draft can be cancelled and invalid entries are not created',async()=>{
  const start=await importer.handle2gisText('max','812004','/2gis');
  assert.match(start.message,/ссылку/);
  const invalid=await importer.handle2gisText('max','812004','https://evil.example/firm/'+FIRM_C);
  assert.match(invalid.message,/2ГИС/);
  const cancelled=await importer.handle2gisText('max','812004','/cancel');
  assert.match(cancelled.message,/отменено/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dgis_bot_pending WHERE chat_id=?').get('812004').n,0);
  const unrelated=await importer.handle2gisText('max','812004','/stock');
  assert.equal(unrelated,null);
});

test('Telegram handler accepts /2gis only in a personal chat; MAX handler uses same database',async()=>{
  const old=global.fetch;
  const outbound=[];
  global.fetch=async(url,options={})=>{
    outbound.push({url:String(url),body:options.body?JSON.parse(options.body):null});
    return {ok:true,status:200,json:async()=>({ok:true,result:{}})};
  };
  try{
    const groupCommand='/2gis https://2gis.ru/krasnoyarsk/firm/70000001012345692 | Группа';
    await telegram.processUpdate({message:{chat:{type:'group',id:-100500},text:groupCommand}});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_leads WHERE salon_name='Группа'").get().n,0);
    const tgCommand='/2gis https://2gis.ru/krasnoyarsk/firm/70000001012345693 | Тест Telegram';
    await telegram.processUpdate({message:{chat:{type:'private',id:812003},from:{id:812003},text:tgCommand}});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_leads WHERE salon_name='Тест Telegram'").get().n,1);
    assert.ok(outbound.some(e=>e.url.includes('api.telegram.org')&&e.body?.chat_id===812003 &&
      e.body?.text.includes('Добавлено в обзвон')));
    await max.processUpdate({update_type:'message_created',message:{
      recipient:{chat_id:'812004'},body:{text:'/2gis https://2gis.ru/krasnoyarsk/firm/70000001012345694 | Тест MAX'},
    }});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_leads WHERE salon_name='Тест MAX'").get().n,1);
    assert.ok(outbound.some(e=>e.url.includes('platform-api2.max.ru')&&
      e.body?.text.includes('Добавлено в обзвон')));
  }finally{global.fetch=old;}
});
