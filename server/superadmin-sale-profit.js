'use strict';
// Private per-sale profit notice for currently connected SUPER administrators.
// Do not publish contribution margins or founder shares to a shared group.
const {loadSaleProfitEstimate}=require('./sale-profit-estimate');
const {sendToChat}=require('./telegram');
const {escapeTelegramHtml:esc}=require('./telegram-formatting');
const money=x=>Number(x||0).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
function formatSuperadminSaleProfit(estimate,{demo=false}={}){
  const row=estimate;
  const items=(row.items||[]).slice(0,9).map(item=>
    '• '+esc(item.name)+(item.weight?' ('+esc(item.weight)+')':'')+
    ' ×'+Number(item.qty)+' — '+money(item.price*item.qty)+
    '; себест.: '+money(item.net_cost)+(item.cost_estimated?'*':'')
  );
  if((row.items||[]).length>9)items.push('• …ещё '+(row.items.length-9)+' позиций — в админке');
  const split=row.founder_split_available
    ?row.founder_shares.map(f=>'  '+esc(f.name)+' ('+Number(f.share_percent)+'%): <b>'+money(f.profit_est)+'</b>')
    :['  ⚠️ Доли собственников не дают 100% — распределение не рассчитано'];
  return [
    ...(demo?['🧪 <b>ДЕМО — не настоящая оплата</b>','']:[]),
    '💰 <b>Новая оплаченная продажа — расчёт собственников</b>',
    'Заказ: '+esc(row.order_number),
    'Точка: '+esc(row.point_name||'Не назначена'),
    ...(row.partner_name?['Грумер: '+esc(row.partner_name)]:[]),
    '',
    'Товары:',...items,
    ...(row.items_missing?['⚠️ Строки заказа не сохранены: себестоимость оценена как 50%.']:[]),
    '',
    'Выручка: <b>'+money(row.revenue)+'</b>',
    'Себестоимость: −'+money(row.cogs_est)+
      (row.fallback_item_qty?' (частично оценка*)':''),
    'Грумер: −'+money(row.partner_commission),
    'Владелец салона: −'+money(row.salon_commission),
    'Менеджер: −'+money(row.manager_est),
    'Налог: −'+money(row.tax_est),
    'Эквайринг: −'+money(row.acquiring_est),
    'Логистика: −'+money(row.logistics_est),
    '',
    '📊 <b>Расчётная прибыль проекта: '+money(row.founder_profit_est)+'</b>',
    'Доли собственников (расчётно):',...split,
    '',
    'ℹ️ *Закупочная цена из текущего каталога; неизвестная — оценка 50%. '+
      'Без общесетевых постоянных расходов и отдельных бонусов. '+
      'Не является начислением или выплатой собственникам.',
  ].join('\n').slice(0,3990);
}
async function sendSuperadminSaleProfit(database,order,options={}){
  if(!order||order.status!=='paid')return {skipped:'not_paid',attempted:0};
  const recipients=database.prepare(
    "SELECT DISTINCT CAST(telegram_chat_id AS TEXT) AS chat "+
    "FROM admins WHERE active=1 AND role='super' "+
    "AND telegram_chat_id IS NOT NULL AND TRIM(telegram_chat_id)<>''"
  ).all().map(x=>String(x.chat||'').trim()).filter(x=>/^[0-9]{1,20}$/.test(x));
  if(recipients.length===0)return {skipped:'no_connected_superadmin',attempted:0};
  const estimate=loadSaleProfitEstimate(database,order,options.assumptions);
  const text=formatSuperadminSaleProfit(estimate,{demo:options.demo===true});
  const send=options.send||sendToChat;
  const outcomes=await Promise.allSettled(recipients.map(chat=>send(chat,text)));
  let successes=0;
  for(const outcome of outcomes)if(outcome.status==='fulfilled'&&outcome.value?.ok===true)successes++;
  if(successes!==recipients.length)
    console.warn('[paid-order] Не все личные уведомления суперадминистраторам доставлены',
      {attempted:recipients.length,delivered:successes});
  return {attempted:recipients.length,delivered:successes};
}
module.exports={formatSuperadminSaleProfit,sendSuperadminSaleProfit};
