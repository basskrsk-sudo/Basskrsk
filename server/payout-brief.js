// On-demand payout preparation. No payout rows or payment status are changed.
'use strict';
const db=require('./db');
const {getUnpaidOrders}=require('./partner-payouts');
const {getOwnerUnpaidOrders}=require('./owner-payouts');
const {getManagerUnpaidOrders}=require('./manager-payouts');
const {getBonuses}=require('./report-bonuses');
const {createHash}=require('node:crypto');
const {PAYOUT_METHODS,payoutMethodCode,payoutMethodLabel}=require('./payout-methods');

const ROLES=Object.freeze({partner:'Грумер',owner:'Владелец салона',manager:'Менеджер'});
const formatter=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const num=value=>Number(value)||0;
const money=value=>formatter.format(Math.round(num(value)))+' ₽';
const clean=(value,max=120)=>String(value||'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
function normalizeName(value){
  return clean(value,200).toLowerCase().replace(/ё/g,'е')
    .replace(/[^\p{L}\p{N} ]/gu,'').split(/\s+/).filter(Boolean).sort();
}
function namesCompatible(a,b){
  const left=normalizeName(a),right=normalizeName(b);
  if(!left.length||!right.length)return false;
  if(left.join('|')===right.join('|'))return true;
  const common=left.filter(part=>right.includes(part));
  return Math.min(left.length,right.length)===1?common.length===1:common.length>=2;
}
function normalizePhone(value){
  const digits=String(value||'').replace(/\D/g,'');
  if(digits.length===10)return digits;
  return digits.length===11&&/^[78]/.test(digits)?digits.slice(1):null;
}
function chatId(value){const id=String(value||'');return /^[1-9]\d{3,15}$/.test(id)?id:null;}
function inn(value){const id=String(value||'').replace(/\D/g,'');return [10,12].includes(id.length)?id:null;}
function sameRecipient(a,b){
  const aChat=chatId(a.telegram_chat_id),bChat=chatId(b.telegram_chat_id);
  if(aChat&&aChat===bChat)return true; // Verified private Telegram account.
  if(!namesCompatible(a.full_name,b.full_name))return false;
  const aPhone=normalizePhone(a.phone),bPhone=normalizePhone(b.phone);
  if(aPhone&&aPhone===bPhone)return true;
  const aInn=inn(a.inn),bInn=inn(b.inn);
  return !!(aInn&&aInn===bInn);
}

const LOCAL_TIME_ZONE='Asia/Krasnoyarsk';
const saleDateTimeFormatter=new Intl.DateTimeFormat('ru-RU',{timeZone:LOCAL_TIME_ZONE,
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const saleDateFormatter=new Intl.DateTimeFormat('ru-RU',{timeZone:LOCAL_TIME_ZONE,
  year:'numeric',month:'2-digit',day:'2-digit'});
function parseSaleMoment(input){
  const raw=String(input||'').trim();
  if(!raw)return null;
  const utc=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)
    ?raw.replace(' ','T')+'Z':raw;
  const ms=Date.parse(utc);
  return Number.isFinite(ms)?ms:null;
}
function formatSaleDateTime(input){
  const ms=parseSaleMoment(input);
  if(ms===null)return 'Дата не указана';
  return saleDateTimeFormatter.format(new Date(ms));
}
function formatSaleDate(ms){
  if(ms===null || !Number.isFinite(ms))return 'не указана';
  return saleDateFormatter.format(new Date(ms));
}
// The last fully closed monthly cycle is the 25th through the 24th, in
// Krasnoyarsk. Never derive its boundaries from transaction activity.
function monthlyPayoutPeriod(now=new Date()){
  const parts=saleDateFormatter.formatToParts(now);
  const part=key=>Number(parts.find(p=>p.type===key).value);
  const y=part('year'),m=part('month')-1,d=part('day');
  // Krasnoyarsk is UTC+07 throughout the operating life of HvostMarket.
  const offset=7*60*60*1000;
  const endExclusive=Date.UTC(y,m-(d<25?1:0),25)-offset;
  const start=Date.UTC(y,m-(d<25?2:1),25)-offset;
  const end=endExclusive-1;
  return {start:new Date(start).toISOString(),end:new Date(end).toISOString(),
    end_exclusive:new Date(endExclusive).toISOString(),key:formatSaleDate(end),
    label:formatSaleDate(start)+' — '+formatSaleDate(end)};
}
function payoutPeriodPart(value,cycle){
  if(!cycle)return 'all';
  const ms=parseSaleMoment(value);
  if(ms===null)return 'undated';
  if(ms>=Date.parse(cycle.end_exclusive))return 'future';
  if(ms<Date.parse(cycle.start))return 'prior';
  return 'current';
}
function personPeriod(statements){
  const timestamps=[];
  for(const section of statements){
    for(const sale of section.sales||[]){
      const ms=parseSaleMoment(sale.created_at);
      if(ms!==null)timestamps.push(ms);
    }
    for(const bonus of section.bonuses||[]){
      const ms=parseSaleMoment(bonus.accrued_at);
      if(ms!==null)timestamps.push(ms);
    }
  }
  if(!timestamps.length)return {start:null,end:null,label:'Дата начислений не указана'};
  const start=Math.min(...timestamps),end=Math.max(...timestamps);
  return {start:new Date(start).toISOString(),end:new Date(end).toISOString(),
    label:formatSaleDate(start)+(formatSaleDate(start)===formatSaleDate(end)?'':' — '+formatSaleDate(end))};
}
function itemListLabel(items){
  if(!items.length)return 'Состав заказа не сохранён';
  return items.map(item=>
    clean(item.name,90)+(item.weight?' ('+clean(item.weight,24)+')':'')+
    ' ×'+item.qty+' по '+money(item.price)).join('; ');
}

function accounts(){
  return [
    ...db.prepare('SELECT id,full_name,phone,inn,telegram_chat_id,point_name,point_id,payout_method FROM partners ORDER BY id')
      .all().map(row=>({...row,role:'partner'})),
    ...db.prepare('SELECT o.id,o.full_name,o.phone,NULL AS inn,o.telegram_chat_id,p.name AS point_name,o.point_id,o.payout_method FROM salon_owners o LEFT JOIN points p ON p.id=o.point_id ORDER BY o.id')
      .all().map(row=>({...row,role:'owner'})),
    ...db.prepare('SELECT id,full_name,phone,inn,telegram_chat_id,NULL AS point_name,NULL AS point_id FROM managers ORDER BY id')
      .all().map(row=>({...row,role:'manager'})),
  ];
}
function pendingOrders(account){
  if(account.role==='partner')return getUnpaidOrders(account.id);
  if(account.role==='owner')return getOwnerUnpaidOrders(account.id);
  if(account.role==='manager')return getManagerUnpaidOrders(account.id);
  throw new Error('Неизвестная роль');
}
function groupedPoints(account,orders){
  const result=new Map();
  for(const order of orders){
    const point=clean(order.point_name||account.point_name||'Без точки');
    const rate=num(order.commission_rate);
    const key=JSON.stringify([order.point_id||account.point_id||point,rate]);
    if(!result.has(key))result.set(key,{point,rate,orders:0,revenue:0,amount:0});
    const row=result.get(key);
    row.orders++;row.revenue+=num(order.total);row.amount+=num(order.commission_amount);
  }
  return [...result.values()].sort((a,b)=>b.amount-a.amount||a.point.localeCompare(b.point,'ru'));
}

function createOrderItemReader(){
  const stmt=db.prepare('SELECT name,weight,price,qty FROM order_items WHERE order_id=? ORDER BY id');
  const cache=new Map();
  return function getItems(orderId){
    if(!cache.has(orderId)){
      cache.set(orderId,stmt.all(orderId).map(row=>({
        name:clean(row.name,100),weight:clean(row.weight,25),
        price:num(row.price),qty:num(row.qty),
      })));
    }
    return cache.get(orderId);
  };
}
function formatSale(account,order,getItems){
  const items=getItems(order.id);
  return {
    order_id:order.id,order_code:clean(order.order_code,60),
    created_at:order.created_at, date:formatSaleDateTime(order.created_at),
    point:clean(order.point_name||account.point_name||'Без точки'),
    items, items_label:itemListLabel(items),
    sale_total:num(order.total),original_total:num(order.original_total??order.total),refunded_amount:num(order.return_amount),commission_rate:num(order.commission_rate),
    commission_amount:num(order.commission_amount),
  };
}

const {isPayable,planCommission}=require('./commission-refunds');
function roleStatement(account,getItems,detail=true,cycle=null){
  const pending=pendingOrders(account).filter(o=>payoutPeriodPart(o.created_at,cycle)!=='future');
  const eligible=pending.filter(isPayable);
  // Fully returned unpaid orders have no remuneration. Keep the manager's
  // existing report, but do not list these orders for groomers or owners.
  const returned=pending.filter(o=>(o.return_amount>0||o.refund_status==='refunded') && (account.role==='manager'||isPayable(o)));
  const plan=planCommission(db,account.role,account.id,eligible);
  const bonuses=getBonuses(db,account.role,account.id).pending
    .filter(b=>Number.isFinite(Number(b.amount))&&Number(b.amount)>0&&payoutPeriodPart(b.accrued_at,cycle)!=='future')
    .map(b=>({manager_point_id:b.manager_point_id,point:clean(b.point_name||account.point_name||'Точка'),
      amount:num(b.amount),type:account.role==='manager'?'launch_bonus':'referral_bonus',
      accrued_at:b.accrued_at||null,...(cycle?{period_part:payoutPeriodPart(b.accrued_at,cycle)}:{})}));
  const commission=plan.amount;
  const bonus=bonuses.reduce((sum,b)=>sum+b.amount,0);
  const breakdown={current:0,prior:0,undated:0};
  if(cycle){
    for(const o of eligible)breakdown[payoutPeriodPart(o.created_at,cycle)]+=num(o.commission_amount);
    for(const b of bonuses)breakdown[b.period_part]+=b.amount;
  }
  return {
    role:account.role,role_label:ROLES[account.role],account_id:account.id,
    name:clean(account.full_name),point:clean(account.point_name),
    payout_method:payoutMethodCode(account.payout_method),payout_method_label:payoutMethodLabel(account.payout_method),
    orders:eligible.length,commission,bonus,total:commission+bonus,
    ...(cycle?{period_accrued:breakdown.current,prior_accrued:breakdown.prior,undated_accrued:breakdown.undated,
      adjustments_applied:plan.adjustments.reduce((n,x)=>n+num(x.amount),0),
      deferred_commission:plan.carried?plan.gross:0}:{}),
    gross_commission:plan.gross,refund_adjustments:plan.adjustments,refund_outstanding:plan.outstanding,refund_carried:plan.carried,
    refund_orders:returned.map(o=>({order_id:o.id,order_code:o.order_code,original_total:o.original_total,refunded_amount:o.return_amount,net:o.total,commission:o.commission_amount})),
    held_orders:plan.review.length,held_order_ids:plan.review.map(o=>o.order_id),
    held_amount:plan.review.reduce((sum,o)=>sum+Math.max(0,o.paid_commission-o.recovered),0),refund_review:plan.review,
    points:detail?groupedPoints(account,eligible):[],
    sales:detail?eligible.map(order=>({...formatSale(account,order,getItems),...(cycle?{period_part:payoutPeriodPart(order.created_at,cycle)}:{})})).sort((a,b)=>
      String(a.created_at||'').localeCompare(String(b.created_at||'')) || a.order_id-b.order_id):[],
    bonuses,
  };
}
// Stable, opaque selection key for a person who may have multiple roles.
// Never select by display index: payout totals can change between button
// creation and confirmation.
function recipientKeyForAccounts(accounts){
  const identities=(accounts||[]).map(account=>String(account.role)+':'+String(account.id)).sort();
  return createHash('sha256').update(identities.join('|')).digest('hex').slice(0,16);
}
function payoutMethodGroups(people){
  const map=new Map();
  for(const person of people||[]){
    for(const s of person.statements||[]){
      const amount=num(s.total);
      if(amount<=0)continue;
      const method=payoutMethodCode(s.payout_method);
      if(!map.has(method))map.set(method,{method,label:payoutMethodLabel(method),amount:0,people:[]});
      const row=map.get(method);row.amount+=amount;
      const key=person.selection_key||person.index||person.name;
      let payee=row.people.find(x=>x.key===key);
      if(!payee){payee={key,name:person.name,amount:0,roles:[]};row.people.push(payee);}
      payee.amount+=amount;
      if(!payee.roles.includes(s.role_label||ROLES[s.role]))payee.roles.push(s.role_label||ROLES[s.role]);
    }
  }
  return [...Object.keys(PAYOUT_METHODS),null].filter(m=>map.has(m)).map(m=>map.get(m));
}
function payoutMethodDescription(person){
  const groups=person.payout_method_groups||payoutMethodGroups([person]);
  if(!groups.length)return payoutMethodLabel(person.payout_method);
  if(groups.length===1)return groups[0].label;
  return groups.map(g=>g.label+' — '+money(g.amount)).join('; ');
}
function groupStatements(entries,cycle=null){
  const people=[];
  for(const entry of entries){
    const matches=people.filter(person=>person.accounts.some(other=>sameRecipient(other,entry.account)));
    if(!matches.length){
      people.push({name:clean(entry.account.full_name),accounts:[entry.account],statements:[entry.statement]});
      continue;
    }
    const primary=matches[0];
    primary.accounts.push(entry.account);primary.statements.push(entry.statement);
    for(const extra of matches.slice(1)){
      primary.accounts.push(...extra.accounts);primary.statements.push(...extra.statements);
      people.splice(people.indexOf(extra),1);
    }
  }
  return people.map(p=>{
    const roles=[...new Set(p.statements.map(s=>s.role))];
    const total=key=>p.statements.reduce((sum,s)=>sum+num(s[key]),0);
    return {name:p.name,roles,roles_label:roles.map(role=>ROLES[role]).join(' + '),
      selection_key:recipientKeyForAccounts(p.accounts),
      period:cycle||personPeriod(p.statements),
      ...(cycle?{monthly:true,period_accrued:total('period_accrued'),prior_accrued:total('prior_accrued'),
        undated_accrued:total('undated_accrued'),adjustments_applied:total('adjustments_applied'),deferred_commission:total('deferred_commission')}:{}),
      statements:p.statements,payout_method_groups:payoutMethodGroups([p]),commission:total('commission'),bonus:total('bonus'),
      total:total('total'),held_orders:new Set(p.statements.flatMap(s=>s.held_order_ids)).size,
      held_order_ids:[...new Set(p.statements.flatMap(s=>s.held_order_ids))],
      held_amount:total('held_amount')};
  }).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,'ru'))
    .map((p,index)=>({...p,index:index+1}));
}
function formatMoment(iso){
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Krasnoyarsk',day:'2-digit',
    month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
}
function collectPayoutBrief(now=new Date(),{recipientKey=null,summaryOnly=false,monthly=false}={}){
  const cycle=monthly?monthlyPayoutPeriod(now):null;
  let entries=[];
  const getItems=createOrderItemReader();
  for(const account of accounts()){
    const statement=roleStatement(account,getItems,!recipientKey&&!summaryOnly,cycle);
    if(statement.total>0||statement.held_orders||statement.refund_carried)entries.push({account,statement});
  }
  // Determine the exact current grouping from unpaid totals first (including
  // newly active roles/refunds). Only then read product details for the chosen
  // recipient. This preserves selection keys and stale-approval protection.
  if(recipientKey){
    const selected=groupStatements(entries,cycle).find(person=>person.selection_key===recipientKey);
    const roles=new Set((selected?.statements||[]).map(s=>s.role+':'+s.account_id));
    entries=entries.filter(e=>roles.has(e.account.role+':'+e.account.id))
      .map(e=>({account:e.account,statement:roleStatement(e.account,getItems,true,cycle)}));
  }
  const people=groupStatements(entries,cycle);
  const sum=key=>people.reduce((result,p)=>result+num(p[key]),0);
  const role_totals={partner:0,owner:0,manager:0};
  for(const person of people)for(const section of person.statements)role_totals[section.role]+=section.total;
  const identities_to_verify=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i].account,b=entries[j].account;
    if(a.role===b.role)continue;
    if(normalizeName(a.full_name).join('|')===normalizeName(b.full_name).join('|')&&!sameRecipient(a,b)){
      const label=clean(a.full_name,60);
      if(!identities_to_verify.includes(label))identities_to_verify.push(label);
    }
  }
  return {
    generated_at:now.toISOString(),people,total:sum('total'),commission:sum('commission'),
    ...(cycle?{period:cycle,period_accrued:sum('period_accrued'),prior_accrued:sum('prior_accrued'),undated_accrued:sum('undated_accrued'),
      adjustments_applied:sum('adjustments_applied'),deferred_commission:sum('deferred_commission')}:{}),
    bonus:sum('bonus'),held_orders:new Set(people.flatMap(p=>p.held_order_ids)).size,
    held_amount:sum('held_amount'),
    role_totals,identities_to_verify,payout_method_groups:payoutMethodGroups(people),
    note:'Справка предварительная. Выплаты не отмечены. Возвраты учитываются автоматически; исторические выплаты без подтверждённой ставки выделены отдельно. Суммы до налоговых удержаний.',
  };
}
function monthlyBreakdownLines(person){
  if(!person.monthly&&!person.period?.key)return [];
  // Gross accrual buckets reconcile to the net payable total. Current
  // refunds use the live ledger; deductions do not change the cycle dates.
  return ['Начислено за период: '+money(person.period_accrued),
    ...(person.prior_accrued?['Долг прошлых периодов: '+money(person.prior_accrued)]:[]),
    ...(person.undated_accrued?['Начисления без даты (ранее): '+money(person.undated_accrued)]:[]),
    ...(person.adjustments_applied?['Корректировки: −'+money(person.adjustments_applied)]:[]),
    ...(person.deferred_commission?['Комиссия перенесена: −'+money(person.deferred_commission)]:[])];
}
function formatPayoutBriefMessage(report){
  const lines=['💸 ХвостМаркет — справка для выплат',
    '🗓 '+formatMoment(report.generated_at)+' (Красноярск)',
    report.period?'Расчётный период: '+report.period.label:'Невыплаченные начисления за всё время',
    ...monthlyBreakdownLines(report),'',
    '👥 Получателей: '+report.people.length,
    '💚 Предварительно к выплате: '+money(report.total),
    '• Грумерам: '+money(report.role_totals.partner),
    '• Владельцам: '+money(report.role_totals.owner),
    '• Менеджерам: '+money(report.role_totals.manager),
    'В том числе бонусы: '+money(report.bonus),'','По способам выплаты:'];
  const groups=report.payout_method_groups||payoutMethodGroups(report.people);
  for(const g of groups)lines.push('• '+g.label+': '+money(g.amount));
  lines.push('','Получатели по способам:');
  if(!report.people.length)lines.push('Сейчас невыплаченных начислений нет.');
  let truncated=false;
  for(const g of groups){
    if(truncated)break;
    lines.push(g.label+':');
    for(const payee of g.people){
      const line='• '+clean(payee.name,44)+' — '+money(payee.amount)+' ('+payee.roles.join(' + ')+')';
      if((lines.join('\n')+'\n'+line).length>3000){lines.push('… остальные получатели — в CSV.');truncated=true;break;}
      lines.push(line);
    }
  }
  lines.push('','📊 CSV: общая детализация по получателям, ролям и точкам.',
    '📄 Персональные PDF: только после выбора получателя и отдельного подтверждения.');
  if(report.held_orders)lines.push('⚠️ Исторических возвратов без сохранённой ставки: '+report.held_orders+'. Требуется проверка.');
  if(report.identities_to_verify.length)lines.push('⚠️ ФИО совпадают, но личность не подтверждена: '+
    report.identities_to_verify.slice(0,5).join(', ')+'. Не объединены.');
  lines.push('','Это НЕ подтверждение перевода денег. Выплаты в базе не меняются.');
  return lines.join('\n').slice(0,3900);
}

function formatRecipientPayoutMessage(person,generatedAt){
  const output=[
    '💸 ХвостМаркет — справка к выплате',
    '👤 '+clean(person.name,75),
    'Роли: '+person.roles.map(role=>ROLES[role]).join(' + '),
    '📅 Период расчётов: '+person.period.label,
    'Способ выплаты: '+payoutMethodDescription(person),
    'Срез начислений: '+formatSaleDateTime(generatedAt)+' (Красноярск)',
    'Дата продажи указана по времени создания оплаченного заказа.',
    person.monthly?'Основа: невыплаченные начисления до конца периода; старые долги отдельно.':'Основа: все ещё невыплаченные заказы и бонусы.',
    '',
    '🛒 Продажи:',
  ];
  const messageBudget=3500;let shown=0,totalSales=0;
  for(const section of person.statements){
    totalSales+=(section.sales||[]).length;
    if(!(section.sales||[]).length)continue;
    for(const sale of section.sales){
      const products=clean(sale.items_label,195);
      const row='• '+sale.date+' · '+clean(sale.point,55)+(sale.period_part==='prior'?' · долг прошлого периода':sale.period_part==='undated'?' · без даты':'')+'\n'+
        '  '+products+'\n'+
        '  Продажа: '+money(sale.sale_total)+' · '+(sale.commission_rate*100).toLocaleString('ru-RU',{maximumFractionDigits:2})+
        '% ('+section.role_label+') · Вознаграждение: '+money(sale.commission_amount);
      if(shown>=5 || output.join('\n').length+row.length+600>messageBudget)break;
      output.push(row);shown++;
    }
  }
  if(!shown)output.push('Продаж к расчёту нет.');
  if(totalSales>shown)output.push('…ещё '+(totalSales-shown)+' продаж. Все строки — в отдельном PDF.');
  if(person.bonus){
    output.push('','🎁 Начисленные бонусы: '+money(person.bonus));
    for(const section of person.statements)for(const bonus of section.bonuses||[])
      output.push('• '+clean(bonus.point,55)+' ('+section.role_label+'): '+money(bonus.amount)+(bonus.period_part==='prior'?' · долг прошлого периода':bonus.period_part==='undated'?' · без даты':''));
  }
  const returned=new Set();
  for(const section of person.statements){
   for(const r of section.refund_orders||[])if((section.role==='manager'||Number(r.net)>0)&&!returned.has(r.order_id)){
    returned.add(r.order_id);
    if(returned.size<=3)output.push('↩️ Заказ '+r.order_code+': возврат '+money(r.refunded_amount)+', осталось '+money(r.net));
   }
   for(const x of (section.refund_adjustments||[]).slice(0,3))output.push('➖ Корректировка ('+section.role_label+') '+x.order_code+': −'+money(x.amount));
   for(const x of (section.refund_review||[]).slice(0,2))output.push('⚠️ '+x.order_code+': возврат '+money(x.refunded_amount)+', историческая ставка не сохранена.');
   if(section.refund_carried)output.push('Перенос корректировки ('+section.role_label+'): '+money(section.refund_carried));
  }
  output.push('',
    'Комиссия: '+money(person.commission),
    'Бонусы: '+money(person.bonus),
    ...monthlyBreakdownLines(person),
    '💚 ИТОГО к выплате: '+money(person.total));
  if(person.held_orders)output.push('⚠️ Исторических возвратов без подтверждённой ставки: '+person.held_orders+'. Подробности в PDF.');
  output.push('📎 Полная детализация по датам, товарам и ставкам — в персональном PDF.',
    'Справка предварительная: деньги не перечислены.');
  return output.join('\n').slice(0,3950);
}

function csvCell(value){
  let text=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim();
  if(/^[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function buildPayoutBriefCsv(report){
  const rows=[['Получатель','Роль','Период расчётов','Дата заказа/продажи (Красноярск)',
    'Заказ','Точка','Наименования товаров','Стоимость продажи (руб.)',
    'Процент партнёра','Вознаграждение (руб.)','Тип начисления','Способ выплаты'].map(csvCell).join(';')];
  for(const person of report.people){
    for(const section of person.statements){
      const method=payoutMethodLabel(section.payout_method);
      const first=rows.length;
      for(const sale of section.sales||[]){
        rows.push([person.name,section.role_label,person.period.label,
          sale.date,sale.order_code,sale.point,sale.items_label,sale.sale_total,
          (sale.commission_rate*100).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%',
          sale.commission_amount,(sale.refunded_amount?'Продажа после возврата '+money(sale.refunded_amount):'Продажа')+(sale.period_part==='prior'?' — долг прошлого периода':sale.period_part==='undated'?' — без даты':'')].map(csvCell).join(';'));
      }
      for(const r of section.refund_orders||[])if(section.role==='manager'&&r.net<=0)rows.push([person.name,section.role_label,person.period.label,'',r.order_code,section.point,'Полный возврат '+money(r.refunded_amount),0,'',0,'Возврат'].map(csvCell).join(';'));
      for(const x of section.refund_adjustments||[])rows.push([person.name,section.role_label,person.period.label,'',x.order_code,section.point,(section.role==='manager'?'Возврат ранее выплаченной комиссии':'Корректировка ранее выплаченной комиссии'),'','',-x.amount,'Корректировка'].map(csvCell).join(';'));
      if(section.refund_carried)for(const x of section.refund_outstanding||[])rows.push([person.name,section.role_label,person.period.label,'',x.order_code,section.point,'Перенос корректировки '+money(x.amount),'','','','Не удержано'].map(csvCell).join(';'));
      for(const x of section.refund_review||[])rows.push([person.name,section.role_label,person.period.label,'',x.order_code,section.point,'Историческая ставка не сохранена','','','','Проверка'].map(csvCell).join(';'));
      for(const bonus of section.bonuses||[]){
        rows.push([person.name,section.role_label,person.period.label,
          formatSaleDateTime(bonus.accrued_at),'',bonus.point,'Бонус за подключение / рекомендацию',
          '', '',bonus.amount,(bonus.type==='launch_bonus'?'Бонус за запуск':'Реферальный бонус')+(bonus.period_part==='prior'?' — долг прошлого периода':bonus.period_part==='undated'?' — без даты':'')]
          .map(csvCell).join(';'));
      }
      for(let i=first;i<rows.length;i++)rows[i]+=';'+csvCell(method);
    }
    rows.push([person.name,'ИТОГО',person.period.label,'','','','', '',
      '',person.total,'Итого к выплате',payoutMethodDescription(person)].map(csvCell).join(';'));
  }
  for(const g of report.payout_method_groups||payoutMethodGroups(report.people)){
    for(const payee of g.people)rows.push([payee.name,payee.roles.join(' + '),report.period?.label||'','','','','','','',payee.amount,'К выплате по способу',g.label].map(csvCell).join(';'));
    rows.push(['ИТОГО ПО СПОСОБУ','',report.period?.label||'','','','','','','',g.amount,'Итого по способу',g.label].map(csvCell).join(';'));
  }
  rows.push(['ОБЩИЙ ИТОГ','','','','','','','',
    '',report.total,'Все получатели',''].map(csvCell).join(';'));
  return '\uFEFF'+rows.join('\r\n')+'\r\n';
}
module.exports={collectPayoutBrief,formatPayoutBriefMessage,buildPayoutBriefCsv,
  groupStatements,recipientKeyForAccounts,sameRecipient,normalizePhone,namesCompatible,money,clean,
  formatRecipientPayoutMessage,formatSaleDateTime,personPeriod,itemListLabel,monthlyPayoutPeriod,monthlyBreakdownLines,payoutMethodGroups,payoutMethodDescription};
