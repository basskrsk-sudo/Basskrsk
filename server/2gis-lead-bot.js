'use strict';

// Import one 2GIS organization into the existing partner-leads CRM.
// Only verified active admin / manager bot identities can import.
// A Places API key is OPTIONAL: without it, ask for name/contact details.
const db = require('./db');

const HELP = '📍 Добавить организацию из 2ГИС:\n/2gis https://2gis.ru/krasnoyarsk/firm/70000001012345678\n\n' +
  'Если данные недоступны, бот попросит: Название | телефон | адрес\n' +
  'Можно сразу: /2gis <ссылка> | Название | +7... | Адрес';
const PENDING_TTL = 15 * 60 * 1000;
const HOSTS = new Set(['2gis.ru', 'www.2gis.ru', '2gis.com', 'www.2gis.com',
  'go.2gis.com', 'go.2gis.ru']);
const SHORT_HOSTS = new Set(['go.2gis.com','go.2gis.ru']);
const VALID_PHONE = /^\+?[\d ()-]{7,30}$/;
const COMMAND = /^\/(?:2gis|gis)(?:@[a-z0-9_]{3,50})?(?:\s+([\s\S]*))?$/i;
const URL_IN_TEXT = /(?:https?:\/\/)?(?:go\.|www\.)?2gis\.(?:ru|com)\/[^\s|<>"']+/i;

function ensureTables(database = db) {
  database.exec("CREATE TABLE IF NOT EXISTS dgis_bot_pending ("+
    "channel TEXT NOT NULL,chat_id TEXT NOT NULL,stage TEXT NOT NULL,"+
    "url TEXT,firm_id TEXT,city_alias TEXT,category TEXT,"+
    "created_at TEXT NOT NULL DEFAULT (datetime('now')),"+
    "PRIMARY KEY(channel,chat_id))");
}

function stripLink(s) {
  return String(s || '').trim().replace(/[.,;!?…)\]\u00bb]+$/, '');
}
function parseLink(text) {
  const candidate = stripLink(text);
  if (candidate.length > 1100) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate);
  } catch (_) { return null; }
  if (!['https:', 'http:'].includes(url.protocol) ||
      !HOSTS.has(url.hostname.toLowerCase()) ||
      (url.port && url.port !== '443' && url.port !== '80') ||
      url.username || url.password) return null;
  // Restrict network fetches to a fixed allowlist and https, no credentials.
  url.protocol = 'https:';
  url.port = '';
  url.hash = '';
  const path = url.pathname;
  const match = path.match(/^\/(?:(?<city>[a-z][a-z0-9-]{1,40})\/)?firm\/(?<id>\d{10,20})(?:\/|$)/i);
  const firmId = match?.groups?.id || null;
  if (!firmId && !SHORT_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!firmId && !/^\/[a-z0-9_-]{2,100}\/?$/i.test(path)) return null;
  const cityAlias = match?.groups?.city || '';
  return {
    firmId, cityAlias,
    url: firmId ? 'https://2gis.ru/' + (cityAlias ? cityAlias + '/' : '') + 'firm/' + firmId
      : url.origin + path,
    short: !firmId,
  };
}

async function resolve2gis(text, { fetchImpl = fetch } = {}) {
  let result = parseLink(text);
  if (!result) return null;
  if (!result.short) return result;
  let next = result.url;
  for (let i = 0; i < 3; i++) {
    // The short domain redirects. Never follow arbitrary external hosts.
    try {
      const response = await fetchImpl(next, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4500),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers?.get?.('location');
      if (!location) break;
      const nextUrl = new URL(location, next);
      const check = parseLink(nextUrl.toString());
      if (!check) break;
      result = check;
      if (check.firmId) return check;
      next = check.url;
    } catch (_) { break; }
  }
  return result; // Still a supported 2GIS short URL; user supplies its name.
}

function clean(s, max = 200) {
  return String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}
function normalizePhone(s) {
  const value = clean(s, 40);
  if (!value) return '';
  if (!VALID_PHONE.test(value) || (value.match(/\d/g)||[]).length > 15) return null;
  return value;
}
function categoryFor(rubrics) {
  const names = Array.isArray(rubrics) ? rubrics.map(r => clean(r?.name).toLowerCase()).join(' ') : '';
  if (/грум|салон.*живот|стрижк.*живот/.test(names)) return 'groomer';
  if (/ветеринар|ветклиник/.test(names)) return 'vet';
  if (/кинолог|дрессиров|тренировк.*собак/.test(names)) return 'training_center';
  if (/зоогостиниц|гостиниц.*живот/.test(names)) return 'hotel';
  if (/питомник/.test(names)) return 'kennel';
  return null;
}
async function fetch2gisCard(firmId, { key = process.env.DGIS_API_KEY || '', fetchImpl = fetch } = {}) {
  if (!/^\d{10,20}$/.test(String(firmId || '')) || !key) return null;
  const endpoint = new URL('https://catalog.api.2gis.com/3.0/items/byid');
  endpoint.searchParams.set('id', String(firmId));
  endpoint.searchParams.set('locale', 'ru_RU');
  endpoint.searchParams.set('fields', 'items.full_address_name,items.rubrics,items.contact_groups');
  endpoint.searchParams.set('key', key);
  try {
    const response = await fetchImpl(endpoint, {signal: AbortSignal.timeout(6000)});
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.meta?.code !== 200) return null;
    const item = body?.result?.items?.find(row => String(row.id) === String(firmId) && row.type === 'branch');
    if (!item || !clean(item.name)) return null;
    const contacts = Array.isArray(item.contact_groups) ?
      item.contact_groups.flatMap(g => Array.isArray(g.contacts) ? g.contacts : []) : [];
    const phoneRow = contacts.find(contact =>
      contact.type === 'phone' &&
      normalizePhone(contact.value || contact.text || contact.print_text));
    return {
      name: clean(item.name),
      address: clean(item.full_address_name || item.address_name || '', 250),
      phone: phoneRow ? normalizePhone(phoneRow.value || phoneRow.text || phoneRow.print_text) : '',
      category: categoryFor(item.rubrics),
      cityAlias: clean(item.city_alias || '', 60),
    };
  } catch (_) {
    // Never expose the API key or personal data in bot responses/logs.
    return null;
  }
}

function identity(channel, chatId, database = db) {
  if (!['telegram','max'].includes(channel) || !/^\d{1,20}$/.test(String(chatId || ''))) return null;
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  const admin = database.prepare(
    'SELECT id,login,role FROM admins WHERE active=1 AND ' + column + '=? LIMIT 1'
  ).get(String(chatId));
  if (admin) return {role:'admin',id:admin.id,cityId:null,author:'Администратор'};
  const manager = database.prepare(
    'SELECT id,full_name,city_id FROM managers WHERE active=1 AND ' + column + '=? LIMIT 1'
  ).get(String(chatId));
  if (manager) return {role:'manager',id:manager.id,cityId:manager.city_id,
    author:clean(manager.full_name || 'Менеджер', 80)};
  return null;
}
function cityFromAlias(alias, database = db) {
  const name = clean(alias, 40).toLowerCase();
  const mapping = {krasnoyarsk:'krsk',moscow:'msk',novosibirsk:'nsk',
    saint_petersburg:'spb',spb:'spb'};
  const id = mapping[name];
  return id && database.prepare('SELECT id FROM cities WHERE id=?').get(id) ? id : null;
}
function pending(channel, chatId, database = db) {
  ensureTables(database);
  return database.prepare("SELECT * FROM dgis_bot_pending WHERE channel=? AND chat_id=? "+
    "AND created_at>datetime('now','-15 minutes')").get(channel,String(chatId));
}
function remember(channel, chatId, data, database = db) {
  ensureTables(database);
  database.prepare("INSERT INTO dgis_bot_pending(channel,chat_id,stage,url,firm_id,city_alias,category,created_at) "+
    "VALUES(?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(channel,chat_id) DO UPDATE SET "+
    "stage=excluded.stage,url=excluded.url,firm_id=excluded.firm_id,"+
    "city_alias=excluded.city_alias,category=excluded.category,created_at=datetime('now')")
    .run(channel,String(chatId),data.stage,data.url||null,data.firmId||null,
      data.cityAlias||null,data.category||null);
}
function clear(channel,chatId,database=db) {
  ensureTables(database);
  database.prepare('DELETE FROM dgis_bot_pending WHERE channel=? AND chat_id=?')
    .run(channel,String(chatId));
}
function existingLead(link, database = db) {
  return database.prepare('SELECT id,salon_name,assigned_manager_id,city_id FROM partner_leads '+
    'WHERE (? IS NOT NULL AND dgis_firm_id=?) OR dgis_url=? ORDER BY id LIMIT 1')
    .get(link.firmId,link.firmId,link.url);
}

function duplicateResult(account, existing) {
  // Managers must not see another manager's confidential contact details.
  const visible=account?.role==='admin' ||
    (account?.role==='manager' &&
      (Number(existing.assigned_manager_id)===Number(account.id) ||
       (existing.assigned_manager_id==null &&
        existing.city_id && String(existing.city_id)===String(account.cityId))));
  return {ok:true,duplicate:true,id:visible?existing.id:null,
    message:visible
      ? 'ℹ️ Это заведение уже есть в обзвоне: '+existing.salon_name+
        ' (№'+existing.id+'). Новая карточка не создана.'
      : 'ℹ️ Организация уже внесена в ХвостМаркет. Обратитесь к администратору, чтобы уточнить ответственного.'};
}
function createLead(account, link, fields, database = db) {
  if (!account || !link || !clean(fields.name)) return {ok:false,message:'Укажите название организации.'};
  if (account.role === 'manager' && !account.cityId) return {
    ok:false,message:'Для добавления контакта супер-администратор должен указать город менеджера.'
  };
  const phone=normalizePhone(fields.phone);
  if (phone === null) return {ok:false,message:'Проверьте номер телефона. Ожидается номер из 7–15 цифр.'};
  const name=clean(fields.name);
  const address=clean(fields.address,250);
  const city=account.role==='manager' ? account.cityId : cityFromAlias(
    fields.cityAlias || link.cityAlias,database);
  const category = ['groomer','vet','training_center','kennel','hotel','other']
    .includes(fields.category) ? fields.category : null;
  const existing=existingLead(link,database);
  if (existing) return duplicateResult(account,existing);
  if (phone || address) {
    const similar=database.prepare('SELECT id,salon_name,assigned_manager_id,city_id FROM partner_leads WHERE '+
      'lower(trim(salon_name))=lower(trim(?)) AND ( '+
      "(? != '' AND REPLACE(COALESCE(phone,''),' ','')=REPLACE(?,' ','')) OR "+
      "(? != '' AND lower(trim(COALESCE(address,'')))=lower(trim(?)))) ORDER BY id LIMIT 1")
      .get(name,phone||'',phone||'',address,address);
    if (similar) return duplicateResult(account,similar);
  }
  let recordId;
  database.exec('SAVEPOINT import_2gis_partner_lead');
  try {
    const insert=database.prepare(
      'INSERT OR IGNORE INTO partner_leads(salon_name,category,city_id,address,phone,status,'+
      'assigned_manager_id,dgis_firm_id,dgis_url) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(name,category,city||null,address||null,phone||null,'to_call',
      account.role==='manager' ? account.id : null,link.firmId||null,link.url);
    if (insert.changes) {
      recordId=Number(insert.lastInsertRowid);
      database.prepare('INSERT INTO partner_lead_notes(lead_id,author,note) VALUES(?,?,?)')
        .run(recordId,account.author,'Добавлено из 2ГИС: '+link.url+
          (phone?' · Контактный телефон: '+phone:' · Телефон не указан'));
    }
    database.exec('RELEASE SAVEPOINT import_2gis_partner_lead');
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT import_2gis_partner_lead');
    database.exec('RELEASE SAVEPOINT import_2gis_partner_lead');
    throw error;
  }
  if (!recordId) return createLeadDuplicate(account,link,database);
  return {ok:true,created:true,id:recordId,
    message:'✅ Добавлено в обзвон (№'+recordId+'):\n'+name+
      (address?'\n📍 '+address:'')+
      (phone?'\n📞 '+phone:'\n📞 Телефон пока не указан')+
      '\nСтатус: нужно позвонить.'+
      (account.role==='manager'?'\nОтветственный: вы.':'')+
      '\nИсточник: '+link.url};
}
function createLeadDuplicate(account,link,database) {
  const old=existingLead(link,database);
  return old ? duplicateResult(account,old) :
    {ok:false,message:'⚠️ Не удалось сохранить контакт. Повторите команду позже.'};
}
function readFields(input) {
  const parts=String(input || '').split('|');
  if (parts.length > 3) return null;
  return {name:clean(parts[0]),phone:clean(parts[1]||'',40),
    address:clean(parts[2]||'',250)};
}
function extractLink(text) {
  const found=String(text||'').match(URL_IN_TEXT);
  if (!found) return null;
  return stripLink(found[0]);
}
function prompted(link) {
  return '📍 Ссылка 2ГИС принята: '+link.url+
    '\nНазвание организации не удалось получить автоматически.'+
    '\n\nОтправьте следующим сообщением:\nНазвание | телефон | адрес\n'+
    'Достаточно названия; телефон и адрес можно добавить позже.\n/cancel — отмена.';
}

async function handle2gisText(channel,chatId,text,{database=db,fetchImpl=fetch,apiKey=process.env.DGIS_API_KEY||''}={}) {
  const value=String(text||'').trim();
  const command=value.match(COMMAND);
  const waiting=pending(channel,chatId,database);
  const isLinkOnly=!!extractLink(value)&&
    /^(?:https?:\/\/)?(?:go\.|www\.)?2gis\.(?:ru|com)\/[^\s|]+(?:\s*\|[\s\S]*)?$/i.test(value);
  const cancel=waiting && /^\/cancel(?:@\w+)?$/i.test(value);
  if (!command && !isLinkOnly && !waiting) return null;
  if (cancel) {
    clear(channel,chatId,database);
    return {ok:true,message:'Добавление из 2ГИС отменено.'};
  }
  if (!command && value.startsWith('/') && !isLinkOnly) return null;
  const user=identity(channel,chatId,database);
  if (!user) return {ok:false,message:'🔒 Добавление из 2ГИС доступно только активным менеджерам и администраторам с привязанным аккаунтом бота.'};
  if (user.role==='manager'&&!user.cityId)
    return {ok:false,message:'У менеджера не указан город в ХвостМаркете. Обратитесь к администратору.'};
  let extras='';
  let linkText='';
  const args=command?(command[1]||'').trim():value;
  const found=extractLink(args);
  if (found) {
    linkText=found;
    extras=args.slice(args.indexOf(found)+found.length).trim().replace(/^\|/, '').trim();
  }
  if (command && !args) {
    remember(channel,chatId,{stage:'link'},database);
    return {ok:true,message:HELP+'\n\nПришлите ссылку следующим сообщением.'};
  }
  if (linkText) {
    const link=await resolve2gis(linkText,{fetchImpl});
    if (!link) return {ok:false,message:'Пришлите ссылку именно на карточку организации 2ГИС (раздел /firm/), не на маршрут или поиск.\n\n'+HELP};
    const old=existingLead(link,database);
    if (old) {
      clear(channel,chatId,database);
      return createLeadDuplicate(user,link,database);
    }
    const fields=readFields(extras);
    if (!fields) return {ok:false,message:'Неверный формат данных. Используйте: Название | телефон | адрес'};
    const remote=link.firmId ? await fetch2gisCard(link.firmId,{key:apiKey,fetchImpl}) : null;
    const merged={
      name:fields.name||remote?.name||'',phone:fields.phone||remote?.phone||'',
      address:fields.address||remote?.address||'',
      category:remote?.category||null, cityAlias:remote?.cityAlias||link.cityAlias,
    };
    if (!merged.name) {
      remember(channel,chatId,{...link,stage:'details'},database);
      return {ok:true,message:prompted(link)};
    }
    const result=createLead(user,link,merged,database);
    if (result.ok)clear(channel,chatId,database);
    return result;
  }
  if (waiting?.stage==='link') return {ok:false,message:'Пришлите ссылку на организацию в 2ГИС.\n'+HELP};
  if (waiting?.stage==='details') {
    const fields=readFields(value);
    if (!fields||!fields.name)return {ok:false,message:'Нужно название заведения. Формат: Название | телефон | адрес'};
    const result=createLead(user,{firmId:waiting.firm_id||null,
      url:waiting.url,cityAlias:waiting.city_alias||''},
      {...fields,category:waiting.category||null},database);
    if (result.ok)clear(channel,chatId,database);
    return result;
  }
  return {ok:false,message:HELP};
}

ensureTables();
module.exports={parseLink,resolve2gis,fetch2gisCard,identity,handle2gisText,
  createLead,categoryFor,normalizePhone,HELP,ensureTables};
