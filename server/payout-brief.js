// On-demand payout preparation. No payout rows or payment status are changed.
'use strict';
const db=require('./db');
const {getUnpaidOrders}=require('./partner-payouts');
const {getOwnerUnpaidOrders}=require('./owner-payouts');
const {getManagerUnpaidOrders}=require('./manager-payouts');
const {getBonuses}=require('./report-bonuses');

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
function accounts(){
  return [
    ...db.prepare('SELECT id,full_name,phone,inn,telegram_chat_id,point_name,point_id FROM partners ORDER BY id')
      .all().map(row=>({...row,role:'partner'})),
    ...db.prepare('SELECT o.id,o.full_name,o.phone,NULL AS inn,o.telegram_chat_id,p.name AS point_name,o.point_id FROM salon_owners o LEFT JOIN points p ON p.id=o.point_id ORDER BY o.id')
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
function roleStatement(account,refundQuery){
  const eligible=[],held=[];
  for(const order of pendingOrders(account)){
    const refund=refundQuery.get(order.id);
    const isRefunded=refund&&(refund.refund_status==='refunded'||num(refund.refunded_amount)>0);
    (isRefunded?held:eligible).push(order);
  }
  const bonuses=getBonuses(db,account.role,account.id).pending
    .filter(b=>Number.isFinite(Number(b.amount))&&Number(b.amount)>0)
    .map(b=>({point:clean(b.point_name||account.point_name||'Точка'),
      amount:num(b.amount),type:account.role==='manager'?'launch_bonus':'referral_bonus',
      accrued_at:b.accrued_at||null}));
  const commission=eligible.reduce((sum,o)=>sum+num(o.commission_amount),0);
  const bonus=bonuses.reduce((sum,b)=>sum+b.amount,0);
  return {
    role:account.role,role_label:ROLES[account.role],account_id:account.id,
    name:clean(account.full_name),point:clean(account.point_name),
    orders:eligible.length,commission,bonus,total:commission+bonus,
    held_orders:held.length,held_amount:held.reduce((sum,o)=>sum+num(o.commission_amount),0),
    points:groupedPoints(account,eligible),bonuses,
  };
}
function groupStatements(entries){
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
      statements:p.statements,commission:total('commission'),bonus:total('bonus'),
      total:total('total'),held_orders:total('held_orders'),held_amount:total('held_amount')};
  }).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,'ru'))
    .map((p,index)=>({...p,index:index+1}));
}
function formatMoment(iso){
  return new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Krasnoyarsk',day:'2-digit',
    month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
}
function collectPayoutBrief(now=new Date()){
  const fetchRefund=db.prepare('SELECT refund_status,refunded_amount FROM orders WHERE id=?');
  const cache=new Map();
  const refundQuery={get(id){if(!cache.has(id))cache.set(id,fetchRefund.get(id)||null);return cache.get(id)}};
  const entries=[];
  for(const account of accounts()){
    const statement=roleStatement(account,refundQuery);
    if(statement.total>0||statement.held_orders)entries.push({account,statement});
  }
  const people=groupStatements(entries);
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
    bonus:sum('bonus'),held_orders:sum('held_orders'),held_amount:sum('held_amount'),
    role_totals,identities_to_verify,
    note:'Справка предварительная. Выплаты не отмечены. Заказы с возвратами исключены до сверки с администратором. Суммы до налоговых удержаний.',
  };
}
function formatPayoutBriefMessage(report){
  const lines=['💸 ХвостМаркет — справка для выплат',
    '🗓 '+formatMoment(report.generated_at)+' (Красноярск)',
    'Невыплаченные начисления за всё время','',
    '👥 Получателей: '+report.people.length,
    '💚 Предварительно к выплате: '+money(report.total),
    '• Грумерам: '+money(report.role_totals.partner),
    '• Владельцам: '+money(report.role_totals.owner),
    '• Менеджерам: '+money(report.role_totals.manager),
    'В том числе бонусы: '+money(report.bonus),'','Получатели:'];
  if(!report.people.length)lines.push('Сейчас невыплаченных начислений нет.');
  for(const p of report.people){
    const line=p.index+'. '+clean(p.name,44)+' — '+money(p.total)+' ('+
      p.roles.map(role=>ROLES[role]).join(' + ')+')'+(p.held_orders?' · ⚠️ возвраты: '+p.held_orders:'');
    if((lines.join('\n')+'\n'+line).length>3000){
      lines.push('… остальные получатели — в PDF/CSV.');break;
    }
    lines.push(line);
  }
  lines.push('','📎 PDF: одна справка на получателя с разбивкой по ролям.',
    '📊 CSV: детализация по получателям, ролям и точкам.');
  if(report.held_orders)lines.push('⚠️ Заказов с возвратами на сверке: '+report.held_orders+'. Не включены.');
  if(report.identities_to_verify.length)lines.push('⚠️ ФИО совпадают, но личность не подтверждена: '+
    report.identities_to_verify.slice(0,5).join(', ')+'. Не объединены.');
  lines.push('','Это НЕ подтверждение перевода денег. Выплаты в базе не меняются.');
  return lines.join('\n').slice(0,3900);
}
function csvCell(value){
  let text=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim();
  if(/^[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function buildPayoutBriefCsv(report){
  const rows=[['№','Получатель','Роль','Точка','Заказов','Выручка (руб.)','Ставка',
    'Комиссия (руб.)','Бонус (руб.)','Итого (руб.)','Заказов на сверке'].map(csvCell).join(';')];
  for(const p of report.people){
    for(const s of p.statements){
      for(const point of s.points){
        rows.push([p.index,p.name,s.role_label,point.point,point.orders,point.revenue,
          Math.round(point.rate*10000)/100+'%',point.amount,0,point.amount,''].map(csvCell).join(';'));
      }
      for(const bonus of s.bonuses){
        rows.push([p.index,p.name,s.role_label,'Бонус: '+bonus.point,0,0,'',0,bonus.amount,bonus.amount,''].map(csvCell).join(';'));
      }
      if(s.held_orders)rows.push([p.index,p.name,s.role_label,'Заказы с возвратами (на сверке)',
        s.held_orders,'','',0,0,0,s.held_orders].map(csvCell).join(';'));
    }
  }
  rows.push(['ИТОГО','','','','','','',report.commission,report.bonus,report.total,report.held_orders].map(csvCell).join(';'));
  return '\uFEFF'+rows.join('\r\n')+'\r\n';
}
module.exports={collectPayoutBrief,formatPayoutBriefMessage,buildPayoutBriefCsv,
  groupStatements,sameRecipient,normalizePhone,namesCompatible,money,clean};
