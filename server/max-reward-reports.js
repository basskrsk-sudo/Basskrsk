'use strict';

// This is an on-demand, read-only export. The existing payout/confirmation
// ledgers remain authoritative. No new payout, snapshot, or partner message.
function fail(message,statusCode=400){return Object.assign(new Error(message),{statusCode,publicMessage:true});}
const LABELS={partner:'Грумер / рекомендатель',owner:'Владелец салона',manager:'Менеджер'};
function listRewardReports(db,kind,collect){
  if(kind==='unpaid'){
    const report=(collect||require('./payout-brief').collectPayoutBrief)(new Date(),{summaryOnly:true});
    return {kind,recipients:report.people.map(p=>({key:p.selection_key,name:p.name,roles:p.roles_label,
      points:[...new Set(p.statements.map(s=>s.point).filter(Boolean))].join(', '),amount:p.total}))};
  }
  if(kind!=='period')throw fail('Выберите вид отчёта');
  const recipients=[];
  for(const role of Object.keys(LABELS)){
    const config=require('./payout-reports').roleConfig(role);
    const point=role==='manager'?"''":'COALESCE(p.name,\'\')';
    const join=role==='manager'?'':' LEFT JOIN points p ON p.id=r.point_id';
    const rows=db.prepare('SELECT r.id,r.full_name AS name,'+point+' AS point FROM '+config.table+' r'+join+' ORDER BY r.full_name,r.id').all();
    for(const row of rows)recipients.push({role,id:row.id,name:row.name,point:row.point,roles:LABELS[role]});
  }
  return {kind,recipients};
}
function createMaxRewardReports(db,{collect,renderBrief,generatePeriod,renderPeriod,sendFile}={}){
  let busy=false;
  const readBrief=collect||((...args)=>require('./payout-brief').collectPayoutBrief(...args));
  const readPeriod=generatePeriod||((...args)=>require('./payout-reports').generatePeriodReport(...args));
  const money=n=>Number(n||0).toLocaleString('ru-RU')+' ₽';
  function options(body){return listRewardReports(db,body?.kind,readBrief);}
  async function send(body,{userId,token,authorize}){
    if(busy)throw fail('Другой отчёт MAX ещё формируется. Повторите запрос после его завершения.',503);
    busy=true;
    try{
      authorize();
      let caption,pdf,filename;
      if(body?.kind==='unpaid'){
        if(typeof body.key!=='string'||!/^[a-f0-9]{16}$/.test(body.key)||!Number.isSafeInteger(body.expected_total)||body.expected_total<0)
          throw fail('Выберите получателя справки из списка');
        const report=readBrief(new Date(),{recipientKey:body.key});
        const person=report.people.find(p=>p.selection_key===body.key);
        if(!person||person.total!==body.expected_total)throw fail('Начисления изменились. Обновите список получателей.',409);
        const rows=person.statements.reduce((n,s)=>n+(s.sales||[]).length+(s.bonuses||[]).length+(s.refund_adjustments||[]).length+(s.refund_outstanding||[]).length+(s.refund_orders||[]).length+(s.refund_review||[]).length,0);
        if(rows>500)throw fail('Справка слишком объёмна. Используйте отчёт за более короткий период.',413);
        pdf=await (renderBrief||require('./payout-brief-pdf').renderPayoutBriefPdf)(report,{recipient:person});
        filename='HvostMarket_payout_'+body.key+'.pdf';
        caption=['ХвостМаркет — справка к выплате','Получатель: '+person.name,'Роли: '+person.roles_label,
          'Период: '+person.period.label,'К выплате: '+money(person.total),
          'Справка предварительная. Выплата не зафиксирована. Перешлите нужному партнёру самостоятельно.'].join('\n');
      }else if(body?.kind==='period'){
        if(!Object.hasOwn(LABELS,body.role)||!Number.isSafeInteger(body.recipient_id)||body.recipient_id<=0)throw fail('Выберите получателя отчёта');
        const report=readPeriod(db,body.role,body.recipient_id,body.start,body.end);
        if((report.items||[]).length+(report.bonuses||[]).length>500)throw fail('Отчёт слишком объёмный. Сократите период.',413);
        pdf=await (renderPeriod||require('./payout-report-pdf').renderPayoutPdf)(report);
        filename='HvostMarket_reward_'+body.role+'_'+body.recipient_id+'_'+body.start+'_'+body.end+'.pdf';
        caption=['ХвостМаркет — расчёт вознаграждения','Получатель: '+report.recipient.name,
          'Роль: '+LABELS[body.role],'Период: '+body.start+' — '+body.end,
          'Начислено за период: '+money(report.accrued),
          'Отчёт справочный. Перешлите нужному партнёру самостоятельно.'].join('\n');
      }else throw fail('Выберите вид отчёта');
      authorize();
      const result=await (sendFile||require('./max-reward-report-file').sendMaxRewardFile)({userId,token,pdf,filename,caption,authorize});
      if(!result?.messageId)throw fail('MAX не подтвердил отправку файла',502);
      return {ok:true,message:'PDF отправлен в ваш личный чат с ботом MAX. Партнёру отчёт не отправлялся.'};
    }finally{busy=false;}
  }
  return {options,send};
}
module.exports={createMaxRewardReports,listRewardReports};
