'use strict';
// Loaded only on demand for a PDF or callback. No recurring work.
const db=require('./db');
const {randomBytes}=require('node:crypto');
const {staleStatement}=require('./payout-statement-orders');
const {PAYOUT_METHODS,payoutMethodCode,payoutMethodLabel}=require('./payout-methods');
const roles=new Set(['partner','owner','manager']);
let initialized=false;
function ensure(){
  if(initialized)return;
  db.exec("CREATE TABLE IF NOT EXISTS payout_brief_confirmations ("+
    "id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,admin_id INTEGER NOT NULL,recipient_name TEXT NOT NULL,"+
    "generated_at TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),snapshot_json TEXT NOT NULL,"+
    "state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','confirming','paid')),"+
    "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,confirmed_at TEXT,result_json TEXT,document_message_id INTEGER)");
  initialized=true;
}
function activeAdmin(chatId){
  const id=String(chatId||'');
  if(!/^[1-9]\d{0,19}$/.test(id))return null;
  const rows=db.prepare('SELECT id,login FROM admins WHERE active=1 AND telegram_chat_id=? LIMIT 2').all(id);
  // The read-only TG_CHAT_ID fallback is not permission to write payouts.
  return rows.length===1?rows[0]:null;
}
const rub=value=>Number(value).toLocaleString('ru-RU')+' ₽';
const sum=(rows,field)=>rows.reduce((total,row)=>total+Number(row[field]),0);
const integer=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0;
function snapshotPerson(person){
  const statements=[],keys=new Set();
  for(const section of person.statements||[]){
    if(!roles.has(section.role)||!Number.isSafeInteger(Number(section.account_id))||Number(section.account_id)<=0)throw staleStatement();
    const key=section.role+':'+section.account_id;
    if(keys.has(key))throw staleStatement();
    keys.add(key);
    const sales=(section.sales||[]).map(s=>({order_id:s.order_id,created_at:s.created_at,
      sale_total:s.sale_total,refunded_amount:Number(s.refunded_amount||0),commission_rate:s.commission_rate,commission_amount:s.commission_amount}));
    const bonuses=(section.bonuses||[]).map(b=>({manager_point_id:b.manager_point_id,amount:b.amount,accrued_at:b.accrued_at||null}));
    if(sales.some(s=>!integer(s.commission_amount)||!Number.isSafeInteger(Number(s.order_id))||Number(s.order_id)<=0||
       !Number.isFinite(Number(s.sale_total))||!Number.isFinite(Number(s.commission_rate)))||
       bonuses.some(b=>!Number.isSafeInteger(Number(b.manager_point_id))||Number(b.manager_point_id)<=0||!integer(b.amount)||Number(b.amount)<=0)||
       new Set(sales.map(s=>Number(s.order_id))).size!==sales.length||
       new Set(bonuses.map(b=>Number(b.manager_point_id))).size!==bonuses.length)throw staleStatement();
    const gross=sum(sales,'commission_amount'),bonus=sum(bonuses,'amount');
    const adjustments=section.refund_adjustments||[];
    if(!Array.isArray(adjustments)||adjustments.some(x=>!integer(x.amount)||Number(x.amount)<=0))throw staleStatement();
    const commission=Number(section.commission);
    if(!integer(commission)||commission!==Math.max(0,gross-sum(adjustments,'amount')-Number(section.refund_carried||0))||
      bonus!==Number(section.bonus)||commission+bonus!==Number(section.total))throw staleStatement();
    if(commission+bonus>0)statements.push({role:section.role,account_id:Number(section.account_id),name:section.name,commission,bonus,payout_method:payoutMethodCode(section.payout_method),sales:commission>0?sales:[],adjustments,bonuses});
  }
  const amount=statements.reduce((n,s)=>n+s.commission+s.bonus,0);
  if(!Number.isSafeInteger(amount)||amount<=0||amount!==Number(person.total))throw staleStatement();
  return {amount,statements};
}
function registerPayoutBrief(chatId,person,generatedAt){
  if(!(Number(person.total)>0))return null;
  const admin=activeAdmin(chatId);
  if(!admin)return null;
  const snapshot=snapshotPerson(person);
  ensure();
  const id=randomBytes(16).toString('hex');
  db.prepare('INSERT INTO payout_brief_confirmations(id,chat_id,admin_id,recipient_name,generated_at,amount,snapshot_json) VALUES(?,?,?,?,?,?,?)')
    .run(id,String(chatId),admin.id,String(person.name||'Получатель'),String(generatedAt),snapshot.amount,JSON.stringify(snapshot));
  return {id,reply_markup:{inline_keyboard:[[{text:'✅ Выплачено',callback_data:'payout:paid:'+id}]]}};
}
function rememberDocument(chatId,id,messageId){
  if(!Number.isSafeInteger(Number(messageId))||Number(messageId)<=0)return;
  ensure();
  db.prepare('UPDATE payout_brief_confirmations SET document_message_id=? WHERE id=? AND chat_id=?').run(Number(messageId),id,String(chatId));
}
function ownedRow(chatId,id){
  const admin=activeAdmin(chatId);
  if(!admin)return null;
  ensure();
  const row=db.prepare('SELECT * FROM payout_brief_confirmations WHERE id=? AND chat_id=? AND admin_id=?').get(id,String(chatId),admin.id);
  return row?{row,admin}:null;
}
function applyStatement(snapshot,admin,override){
  const partner=require('./partner-payouts'),owner=require('./owner-payouts'),manager=require('./manager-payouts');
  const {getBonuses,createReferralBonusPayout}=require('./report-bonuses');
  const create={partner:partner.createPartnerPayout,owner:owner.createOwnerPayout,manager:manager.createManagerCommissionPayout};
  const {roleConfig}=require('./payout-reports');
  const results=[];
  for(const section of snapshot.statements){
    const role=section.role,accountId=section.account_id;
    const options={inTransaction:true,payout_method:override===undefined?payoutMethodCode(section.payout_method):override};
    const account=db.prepare('SELECT full_name FROM '+roleConfig(role).table+' WHERE id=?').get(accountId);
    const cleanName=v=>String(v||'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
    if(!account||cleanName(account.full_name)!==section.name)throw staleStatement();
    if(section.commission>0){
      const payout=create[role](accountId,admin,{...options,statementOrders:section.sales,statementAdjustments:section.adjustments||[]});
      if(Number(payout.amount)!==section.commission)throw staleStatement();
      results.push({role,type:'commission',amount:payout.amount,payout_id:payout.id,report_id:payout.report_id});
    }
    if(section.bonuses.length){
      const pending=new Map(getBonuses(db,role,accountId).pending.map(b=>[Number(b.manager_point_id),b]));
      for(const line of section.bonuses){
        const current=pending.get(Number(line.manager_point_id));
        if(!current||Number(current.amount)!==Number(line.amount)||
          String(current.accrued_at||'')!==String(line.accrued_at||''))throw staleStatement();
        if(role==='manager'){
          const payout=manager.createManagerLaunchBonusPayout(line.manager_point_id,admin,options);
          if(Number(payout.amount)!==Number(line.amount))throw staleStatement();
          results.push({role,type:'launch_bonus',amount:payout.amount,payout_id:payout.id,report_id:payout.report_id});
        }else{
          const result=createReferralBonusPayout(db,role,line.manager_point_id,accountId,Number(line.amount),admin,options);
          results.push({role,type:'referral_bonus',amount:result.payout.amount,payout_id:result.payout.id,report_id:result.report.id});
        }
      }
    }
  }
  if(sum(results,'amount')!==snapshot.amount)throw staleStatement();
  return results;
}
function handlePayoutConfirmation(chatId,data){
  const match=/^payout:(paid|confirm|cancel|confirm-(?:sbp|card|bank_account|cash|mobile_balance|unknown)):([0-9a-f]{32})$/.exec(String(data||''));
  if(!match)return {ok:false,message:'Некорректная кнопка выплаты.'};
  const [,action,id]=match;
  const found=ownedRow(chatId,id);
  if(!found)return {ok:false,message:'Нет доступа к этой справке. Откройте свой личный Telegram, привязанный к действующему кабинету администратора.'};
  const {row}=found;
  if(db.prepare('SELECT 1 FROM payout_invalidated_confirmations WHERE confirmation_id=?').get(id))
    return {ok:false,clear:true,documentMessageId:row.document_message_id,message:'Справка аннулирована после отмены выплаты. Запросите новую /payouts.'};
  if(row.state==='paid')return {ok:true,clear:true,documentMessageId:row.document_message_id,
    message:'✅ Выплата уже зафиксирована: '+row.recipient_name+' — '+rub(row.amount)+'. Повторная фиксация не выполняется.'};
  if(action==='paid'){
    db.prepare("UPDATE payout_brief_confirmations SET state='confirming' WHERE id=? AND state='ready'").run(id);
    const snapshot=JSON.parse(row.snapshot_json);
    const labels={partner:'Грумер',owner:'Владелец салона',manager:'Менеджер'};
    const details=snapshot.statements.map(s=>labels[s.role]+': '+payoutMethodLabel(s.payout_method)+' · '+rub(s.commission+s.bonus));
    return {ok:true,message:'Подтвердите, что деньги фактически переведены.\n\nПолучатель: '+row.recipient_name+'\nСумма по справке: '+rub(row.amount)+'\n\nСпособы выплаты по справке:\n'+details.join('\n')+'\n\nПодтвердите указанные способы или выберите один фактический способ для всей суммы. Будут закрыты только начисления из этого PDF. Бот не переводит деньги.',
      reply_markup:{inline_keyboard:[[{text:'✅ Подтвердить выплату',callback_data:'payout:confirm:'+id}],
        ...Object.entries(PAYOUT_METHODS).map(([key,label])=>[{text:'✅ '+label,callback_data:'payout:confirm-'+key+':'+id}]),
        [{text:'✅ Способ не указан',callback_data:'payout:confirm-unknown:'+id}],
        [{text:'❌ Отмена',callback_data:'payout:cancel:'+id}]]}};
  }
  if(action==='cancel'){
    db.prepare("UPDATE payout_brief_confirmations SET state='ready' WHERE id=? AND state='confirming'").run(id);
    return {ok:true,clear:true,message:'Фиксация отменена. Начисления не изменены.'};
  }
  if(row.state!=='confirming')return {ok:false,message:'Сначала нажмите «Выплачено» под справкой.'};
  db.exec('BEGIN IMMEDIATE');
  try{
    const current=ownedRow(chatId,id);
    if(!current||current.row.state!=='confirming')throw staleStatement();
    const snapshot=JSON.parse(current.row.snapshot_json);
    if(snapshot.amount!==current.row.amount)throw staleStatement();
    const override=action==='confirm'?undefined:action==='confirm-unknown'?null:payoutMethodCode(action.slice('confirm-'.length));
    const results=applyStatement(snapshot,current.admin,override);
    const updated=db.prepare("UPDATE payout_brief_confirmations SET state='paid',confirmed_at=CURRENT_TIMESTAMP,result_json=? WHERE id=? AND state='confirming'").run(JSON.stringify(results),id);
    if(!updated.changes)throw staleStatement();
    db.exec('COMMIT');
    return {ok:true,clear:true,documentMessageId:current.row.document_message_id,
      message:'✅ Выплачено и зафиксировано в системе.\n\n'+current.row.recipient_name+' — '+rub(snapshot.amount)+'\nЗаписей в реестрах: '+results.length+'\nНовые начисления не закрыты. Корректировки зафиксированы только в составе этой выплаты.'};
  }catch(error){
    try{db.exec('ROLLBACK')}catch(_){}
    if(error.code!=='STALE_PAYOUT_BRIEF')console.error('[payout-brief-confirmation]',error.message);
    return {ok:false,message:error.publicMessage?error.message:'Не удалось зафиксировать выплату. Изменения отменены. Проверьте реестры и актуальную справку /payouts.'};
  }
}
module.exports={registerPayoutBrief,rememberDocument,handlePayoutConfirmation};
