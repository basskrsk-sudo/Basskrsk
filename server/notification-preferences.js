// Preferences for private, account-scoped notifications. Shared partner-club
// chats and transactional customer purchase receipts are not user-toggleable.
'use strict';
const db = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS notification_preferences (' +
  'recipient_role TEXT NOT NULL,recipient_id INTEGER NOT NULL,' +
  'notification_key TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),' +
  "updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  'PRIMARY KEY(recipient_role,recipient_id,notification_key))');

// Existing private sales/payout notices remain on unless their recipient opts
// out; newly introduced private sales notices are off until opted in.
const DEFINITIONS = Object.freeze({
  customer: [
    {key:'purchase', label:'Подтверждение оплаченных заказов', help:'Номер заказа, стоимость и получение товара', locked:true, default:true},
    {key:'offers', label:'Предложения и бонусы за возвращение', help:'Сообщения после длительного отсутствия покупок', default:false},
  ],
  partner: [
    {key:'sales', label:'Мои новые продажи', help:'Чек и начисление за рекомендации', default:true},
    {key:'payouts', label:'Проведённые выплаты', help:'Когда вознаграждение перечислено', default:true},
    {key:'new_products', label:'Новинки ассортимента', help:'Фото и анонсы новых товаров ХвостМаркета', default:false},
  ],
  manager: [
    {key:'sales', label:'Продажи закреплённых точек', help:'Оповещения о новых заказах', default:true},
    {key:'payouts', label:'Комиссии и выплаты бонусов', help:'Сведения о проведённых выплатах', default:true},
    {key:'new_products', label:'Новинки ассортимента', help:'Фото и анонсы новых товаров ХвостМаркета', default:false},
  ],
  owner: [
    {key:'sales', label:'Продажи моего салона', help:'Личные уведомления о каждом новом заказе точки', default:false},
    {key:'payouts', label:'Проведённые выплаты салону', help:'Сообщения о перечисленном вознаграждении', default:true},
    {key:'new_products', label:'Новинки ассортимента', help:'Фото и анонсы новых товаров ХвостМаркета', default:false},
  ],
  founder: [
    {key:'sales', label:'Продажи сети', help:'Личные Telegram-уведомления о новых заказах', default:false},
  ],
  admin: [
    {key:'sales', label:'Продажи сети', help:'Личные Telegram-уведомления о новых заказах', default:false},
  ],
  warehouse: [],
});

const TABLES = Object.freeze({
  customer:'customers', partner:'partners', owner:'salon_owners',
  manager:'managers', admin:'admins', founder:'business_founders',
  warehouse:'warehouse_keepers',
});

function accountAvailable(role,id) {
  const table=TABLES[role];
  const numeric=Number(id);
  if(!table || !Number.isSafeInteger(numeric) || numeric<=0)return false;
  const active=role==='customer' ? '' : ' AND active = 1';
  return !!db.prepare('SELECT id FROM '+table+' WHERE id = ?'+active).get(numeric);
}

function definitions(role) {
  return (DEFINITIONS[role]||[]).map(x=>({...x}));
}

function preference(role,id,key) {
  const def=(DEFINITIONS[role]||[]).find(x=>x.key===key);
  if(!def)return false; // no silent expansion to unknown categories
  if(def.locked)return true;
  const row=db.prepare('SELECT enabled FROM notification_preferences WHERE recipient_role=? AND recipient_id=? AND notification_key=?').get(role,id,key);
  return row ? Number(row.enabled)===1 : !!def.default;
}

function describe(role,id) {
  return definitions(role).map(item=>({
    key:item.key,label:item.label,help:item.help,locked:!!item.locked,
    enabled:preference(role,id,item.key),
  }));
}

function savePreferences(role,id,changes) {
  if(!accountAvailable(role,id))return {ok:false,status:403,error:'Кабинет неактивен или недоступен'};
  if(!changes || typeof changes!=='object' || Array.isArray(changes)) {
    return {ok:false,status:400,error:'Передайте объект настроек'};
  }
  const keys=Object.keys(changes);
  const defs=DEFINITIONS[role]||[];
  if(keys.length===0||keys.length>defs.length)return {ok:false,status:400,error:'Выберите доступные уведомления'};
  for(const key of keys){
    const def=defs.find(x=>x.key===key);
    if(!def||def.locked)return {ok:false,status:400,error:'Этот вид уведомления нельзя отключить'};
    if(typeof changes[key]!=='boolean')return {ok:false,status:400,error:'Значение должно быть включено или выключено'};
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const statement=db.prepare('INSERT INTO notification_preferences(recipient_role,recipient_id,notification_key,enabled) VALUES (?,?,?,?)' +
      " ON CONFLICT(recipient_role,recipient_id,notification_key) DO UPDATE SET enabled=excluded.enabled,updated_at=datetime('now')");
    for(const key of keys) statement.run(role,id,key,changes[key]?1:0);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {ok:true,settings:describe(role,id)};
}

module.exports={DEFINITIONS,TABLES,definitions,accountAvailable,preference,describe,savePreferences};
