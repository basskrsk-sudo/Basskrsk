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


function proposedButton(preview, action='yes') {
  assert.equal(preview.ok,true);
  assert.equal(preview.preview,true);
  assert.match(preview.message,/НЕ добавлен|НЕ добавлено|не добавлен/i);
  const name=action==='yes'?'✅ Добавить в обзвон':action==='edit'?'✏️ Изменить':'❌ Отмена';
  const telegramButton=preview.reply_markup.inline_keyboard
    .flat().find(button=>button.text===name);
  const maxButton=preview.attachments[0].payload.buttons
    .flat().find(button=>button.text===name);
  assert.ok(telegramButton?.callback_data);
  assert.equal(maxButton?.payload,telegramButton.callback_data);
  return telegramButton.callback_data;
}
function dbLead(url) {
  return db.prepare('SELECT * FROM partner_leads WHERE dgis_url=?').get(url);
}
function qty(url) {
  return db.prepare('SELECT COUNT(*) n FROM partner_leads WHERE dgis_url=?').get(url).n;
}

test('manager link -> supplied fields -> preview -> confirmation; no earlier CRM mutation',async()=>{
  const first=await importer.handle2gisText('telegram','812003','/2gis '+ORIGINAL);
  assert.equal(first.ok,true);
  assert.match(first.message,/Название \| телефон \| адрес/);
  assert.equal(qty(ORIGINAL),0);
  const preview=await importer.handle2gisText('telegram','812003',
    'Грум Стиль | +7 900 111-22-33 | Красноярск, ул. Ленина, 7');
  const callback=proposedButton(preview);
  assert.equal(qty(ORIGINAL),0,'previews do not insert leads');
  const saved=importer.handle2gisCallback('telegram','812003',callback);
  assert.equal(saved.created,true);
  assert.match(saved.message,/Добавлено в обзвон/);
  const lead=dbLead(ORIGINAL);
  assert.equal(lead.salon_name,'Грум Стиль');
  assert.equal(lead.assigned_manager_id,mgrId);
  assert.equal(lead.city_id,'krsk');
  assert.equal(lead.phone,'+7 900 111-22-33');
  assert.equal(lead.status,'to_call');
  const note=db.prepare('SELECT note,author FROM partner_lead_notes WHERE lead_id=?').get(lead.id);
  assert.match(note.note,/Добавлено из 2ГИС/);
  assert.equal(note.author,'Менеджер 2ГИС');
  const repeatedClick=importer.handle2gisCallback('telegram','812003',callback);
  assert.equal(repeatedClick.ok,false,'approval is one-time');
  assert.equal(qty(ORIGINAL),1);
  const repeated=await importer.handle2gisText('max','812004','/2gis '+ORIGINAL);
  assert.equal(repeated.duplicate,true);
});

test('another manager cannot see a previously imported private contact',async()=>{
  const repeated=await importer.handle2gisText('telegram','812005','/2gis '+ORIGINAL);
  assert.equal(repeated.ok,true);
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.id,null);
  assert.doesNotMatch(repeated.message,/Грум Стиль|Ленина|900 111/);
});

test('automatic 2GIS API data is proposed and saved only by callback',async()=>{
  const mock=async()=>({ok:true,json:async()=>({
    meta:{code:200},result:{items:[{
      id:FIRM_C,type:'branch',name:'Салон Авто 2ГИС',
      full_address_name:'Красноярск, Мира 25',
      rubrics:[{name:'Груминг-салоны'}],
      contact_groups:[{contacts:[{type:'phone',value:'+7 999 000-00-11'}]}],
    }]},
  })});
  const preview=await importer.handle2gisText('telegram','812001',
    '/2gis https://2gis.ru/krasnoyarsk/firm/'+FIRM_C,
    {apiKey:'test-key',fetchImpl:mock});
  const callback=proposedButton(preview);
  const link='https://2gis.ru/krasnoyarsk/firm/'+FIRM_C;
  assert.equal(qty(link),0);
  assert.match(preview.message,/Салон Авто 2ГИС/);
  assert.match(preview.message,/Красноярск, Мира 25/);
  assert.match(preview.message,/\+7 999 000-00-11/);
  assert.equal(importer.handle2gisCallback('telegram','812001',callback).created,true);
  const lead=dbLead(link);
  assert.equal(lead.assigned_manager_id,null);
  assert.equal(lead.category,'groomer');
  assert.equal(lead.phone,'+7 999 000-00-11');
  assert.equal(lead.city_id,'krsk');
});

test('one-message share with full details waits for MAX confirmation',async()=>{
  const link='https://2gis.ru/krasnoyarsk/firm/'+FIRM_B;
  const preview=await importer.handle2gisText('max','812002',
    link+' | Кинолог Зверь | +7 999 555-22-11 | ул. Молокова, 18');
  const callback=proposedButton(preview);
  assert.equal(qty(link),0);
  assert.equal(importer.handle2gisCallback('max','812002',callback).created,true);
  const lead=dbLead(link);
  assert.equal(lead.salon_name,'Кинолог Зверь');
  assert.equal(lead.phone,'+7 999 555-22-11');
  assert.equal(lead.address,'ул. Молокова, 18');
});

test('exact /geo/ link asks name, then proposes draft; confirmation alone stores it',async()=>{
  const first=await importer.handle2gisText('telegram','812003','/2gis '+GEO_URL);
  assert.equal(first.ok,true);
  assert.match(first.message,/геообъект/);
  assert.equal(qty(GEO_URL),0);
  const preview=await importer.handle2gisText('telegram','812003',
    'Груминг для хвостиков | +7 900 111-22-44 | Красноярск, ул. Весны, 1');
  const callback=proposedButton(preview);
  assert.equal(qty(GEO_URL),0);
  assert.equal(importer.handle2gisCallback('telegram','812003',callback).created,true);
  const lead=dbLead(GEO_URL);
  assert.equal(lead.dgis_firm_id,null,'geo ID is not a verified company');
  assert.equal(lead.assigned_manager_id,mgrId);
  assert.equal(lead.phone,'+7 900 111-22-44');
  const duplicated=await importer.handle2gisText('max','812004',GEO_URL+'?extra=1');
  assert.equal(duplicated.duplicate,true);
  assert.equal(qty(GEO_URL),1);
});

test('a /geo/ ID can become a firm only if official Places API says branch',async()=>{
  let calls=0;
  const link='https://2gis.ru/krasnoyarsk/geo/'+GEO_BRANCH;
  const preview=await importer.handle2gisText('max','812002','/2gis '+link,{
    apiKey:'test-key',fetchImpl:async(url)=>{
      calls++;
      assert.equal(new URL(url).searchParams.get('id'),GEO_BRANCH);
      return {ok:true,json:async()=>({
        meta:{code:200},result:{items:[{
          id:GEO_BRANCH,type:'branch',name:'Зоосалон API',
          full_address_name:'Красноярск, Мира 20',rubrics:[{name:'Груминг-салоны'}],
        }]},
      })};
    },
  });
  const callback=proposedButton(preview);
  assert.equal(calls,1);
  assert.equal(qty(link),0);
  const saved=importer.handle2gisCallback('max','812002',callback);
  assert.equal(saved.created,true);
  const lead=db.prepare('SELECT * FROM partner_leads WHERE dgis_firm_id=?').get(GEO_BRANCH);
  assert.equal(lead.salon_name,'Зоосалон API');
  assert.equal(lead.dgis_url,link);
  const duplicate=await importer.handle2gisText('telegram','812001',
    '/2gis https://2gis.ru/krasnoyarsk/firm/'+GEO_BRANCH);
  assert.equal(duplicate.duplicate,true);
});

test('a building /geo/ is not mislabeled as a salon or inserted before confirmation',async()=>{
  const id='70000001113304167',link='https://2gis.ru/krasnoyarsk/geo/'+id;
  const asked=await importer.handle2gisText('max','812002','/2gis '+link,{
    apiKey:'test-key',fetchImpl:async()=>({ok:true,json:async()=>({
      meta:{code:200},result:{items:[{id,type:'building',name:'Жилой дом',address_name:'Ленина, 1'}]},
    })}),
  });
  assert.equal(asked.ok,true);
  assert.match(asked.message,/Название организации/);
  assert.equal(qty(link),0);
  const preview=await importer.handle2gisText('max','812002','Салон внутри здания');
  const callback=proposedButton(preview);
  assert.equal(qty(link),0);
  const cancel=importer.handle2gisCallback('max','812002',proposedButton(preview,'no'));
  assert.equal(cancel.cancelled,true);
  assert.equal(qty(link),0);
  const replay=importer.handle2gisCallback('max','812002',callback);
  assert.equal(replay.ok,false);
});

test('Edit invalidates old button, allows corrected name and again waits for approval',async()=>{
  const link='https://2gis.ru/krasnoyarsk/firm/70000001012345695';
  const preview=await importer.handle2gisText('telegram','812003',
    '/2gis '+link+' | Старое название | +7 900 555-11-22 | Старый адрес');
  const oldAccept=proposedButton(preview);
  assert.equal(qty(link),0);
  const edit=importer.handle2gisCallback('telegram','812003',proposedButton(preview,'edit'));
  assert.equal(edit.edit,true);
  assert.equal(importer.handle2gisCallback('telegram','812003',oldAccept).ok,false);
  const changed=await importer.handle2gisText('telegram','812003',
    'Исправленное название | +7 900 333-44-55 | Новый адрес');
  const newAccept=proposedButton(changed);
  assert.notEqual(newAccept,oldAccept);
  assert.equal(qty(link),0);
  assert.equal(importer.handle2gisCallback('telegram','812003',newAccept).created,true);
  assert.equal(dbLead(link).salon_name,'Исправленное название');
  assert.equal(dbLead(link).phone,'+7 900 333-44-55');
});

test('cancel and /cancel never change partner_leads; old buttons expire',async()=>{
  const link='https://2gis.ru/krasnoyarsk/firm/70000001012345696';
  const preview=await importer.handle2gisText('telegram','812003','/2gis '+link+' | Отменён');
  const accept=proposedButton(preview);
  const cancelled=await importer.handle2gisText('telegram','812003','/cancel');
  assert.equal(cancelled.cancelled,true);
  assert.equal(qty(link),0);
  assert.equal(importer.handle2gisCallback('telegram','812003',accept).ok,false);
  const again=await importer.handle2gisText('telegram','812003','/2gis '+link+' | Отменён');
  assert.equal(importer.handle2gisCallback('telegram','812003',proposedButton(again,'no')).ok,true);
  assert.equal(qty(link),0);
});

test('expired or stolen approvals are refused even if button is still visible',async()=>{
  const link='https://2gis.ru/krasnoyarsk/firm/70000001012345697';
  const preview=await importer.handle2gisText('telegram','812003','/2gis '+link+' | Истёкший');
  const yes=proposedButton(preview);
  assert.equal(importer.handle2gisCallback('telegram','812001',yes).ok,false);
  assert.equal(importer.handle2gisCallback('max','812004',yes).ok,false);
  assert.equal(qty(link),0);
  db.prepare("UPDATE dgis_bot_pending SET created_at=datetime('now','-16 minutes') WHERE channel='telegram' AND chat_id='812003'").run();
  const expired=importer.handle2gisCallback('telegram','812003',yes);
  assert.equal(expired.ok,false);
  assert.equal(qty(link),0);
});

test('unlinked or inactive accounts cannot confirm another user’s draft',async()=>{
  const link='https://2gis.ru/krasnoyarsk/firm/70000001012345698';
  const preview=await importer.handle2gisText('telegram','812003','/2gis '+link+' | Нет доступа');
  const yes=proposedButton(preview);
  assert.equal(importer.handle2gisCallback('telegram','812006',yes).ok,false);
  assert.equal(importer.handle2gisCallback('telegram','919191',yes).ok,false);
  assert.equal(qty(link),0);
  await importer.handle2gisText('telegram','812003','/cancel');
});

test('invalid link does not create proposals; /2gis help, cancel and other commands coexist',async()=>{
  const start=await importer.handle2gisText('max','812004','/2gis');
  assert.match(start.message,/ссылку/);
  const invalid=await importer.handle2gisText('max','812004','https://evil.example/firm/'+FIRM_C);
  assert.match(invalid.message,/2ГИС/);
  const cancelled=await importer.handle2gisText('max','812004','/cancel');
  assert.match(cancelled.message,/отменено/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dgis_bot_pending WHERE chat_id='812004'").get().n,0);
  assert.equal(await importer.handle2gisText('max','812004','/stock'),null);
});

test('Telegram and MAX bot buttons call approval handlers, not automatic insert',async()=>{
  const prior=global.fetch;
  const outbound=[];
  global.fetch=async(url,options={})=>{
    outbound.push({url:String(url),body:options.body?JSON.parse(options.body):null});
    return {ok:true,status:200,json:async()=>({ok:true,result:{}})};
  };
  try{
    const groupCmd='/2gis https://2gis.ru/krasnoyarsk/firm/70000001012345692 | Группа';
    await telegram.processUpdate({message:{chat:{type:'group',id:-100500},text:groupCmd}});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM partner_leads WHERE salon_name='Группа'").get().n,0);

    const tgLink='https://2gis.ru/krasnoyarsk/firm/70000001012345693';
    await telegram.processUpdate({message:{chat:{type:'private',id:812003},
      from:{id:812003},text:'/2gis '+tgLink+' | Тест Telegram'}});
    assert.equal(qty(tgLink),0);
    const telegramPreview=outbound.findLast(x=>x.url.includes('api.telegram.org')&&
      x.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('dgis:yes:'));
    assert.ok(telegramPreview,'Telegram must show approval buttons');
    const approve=telegramPreview.body.reply_markup.inline_keyboard[0][0].callback_data;
    await telegram.processUpdate({callback_query:{
      id:'approve-2gis-1',from:{id:812003},
      message:{chat:{type:'private',id:812003},message_id:987},
      data:approve,
    }});
    assert.equal(qty(tgLink),1);
    const ack=outbound.find(x=>x.url.includes('answerCallbackQuery'));
    assert.ok(ack);

    const maxLink='https://2gis.ru/krasnoyarsk/firm/70000001012345694';
    await max.processUpdate({update_type:'message_created',message:{
      recipient:{chat_id:'812004'},body:{text:'/2gis '+maxLink+' | Тест MAX'},
    }});
    assert.equal(qty(maxLink),0);
    const maxPreview=outbound.findLast(x=>x.url.includes('platform-api2.max.ru/messages?')&&
      x.body?.attachments?.[0]?.payload?.buttons?.[0]?.[0]?.payload?.startsWith('dgis:yes:'));
    assert.ok(maxPreview,'MAX must show approval buttons');
    const maxConfirm=maxPreview.body.attachments[0].payload.buttons[0][0].payload;
    await max.processUpdate({update_type:'message_callback',chat_id:'812004',
      callback:{callback_id:'2gis-test-max',payload:maxConfirm}});
    assert.equal(qty(maxLink),1);
    assert.ok(outbound.some(x=>x.url.includes('/answers?')&&x.body?.message?.text));
  }finally{global.fetch=prior;}
});
