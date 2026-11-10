'use strict';
// Unified admin report requests. Every generated document still needs an
// explicit one-use Telegram confirmation handled by report-approvals.js.
const db=require('./db');
const {sendJson}=require('./http-utils');
const {requireActiveAdmin}=require('./routes-auth');

const SUPPORTED=new Set(['salesweek','business','businesspoints','stock',
  'nogroomer','payouts','gdweek','qrweek']);

function reportParams(type,body){
  const params={};
  if(type==='gdweek'){
    const start=String(body.start||''),end=String(body.end||'');
    if(Boolean(start)!==Boolean(end))throw Object.assign(
      new Error('Укажите обе даты периода'),{statusCode:400});
    if(start){
      const valid=/^\d{4}-\d{2}-\d{2}$/;
      if(!valid.test(start)||!valid.test(end))
        throw Object.assign(new Error('Неверный формат даты'),{statusCode:400});
      const {customPeriod}=require('./weekly-report');
      customPeriod(start,end);
      params.start=start;params.end=end;
    }
    params.skipTelegram=body.skipTelegram===true;
  }
  if(type==='business'||type==='businesspoints'){
    if(body.year!==undefined&&body.year!==''){
      const year=Number(body.year);
      if(!Number.isSafeInteger(year)||year<2024||year>2100)
        throw Object.assign(new Error('Некорректный год'),{statusCode:400});
      params.year=year;
    }
  }
  if(type==='stock' && body.citySelector){
    const code=String(body.citySelector);
    if(!/^[a-z0-9_-]{1,40}$/i.test(code))
      throw Object.assign(new Error('Неверный идентификатор города'),{statusCode:400});
    params.citySelector=code;
  }
  if(type==='nogroomer'&&body.days!==undefined){
    const days=Number(body.days);
    if(!Number.isSafeInteger(days)||days<1||days>365)
      throw Object.assign(new Error('Период должен быть от 1 до 365 дней'),{statusCode:400});
    params.days=days;
  }
  return params;
}

function registerAdminReportCenterRoutes(router){
  router.post('/api/admin/report-center/request',async(req,res,ctx)=>{
    const session=requireActiveAdmin(req,res,ctx);if(!session)return;
    const admin=db.prepare('SELECT active,role,telegram_chat_id FROM admins WHERE id=?')
      .get(session.id);
    if(!admin||Number(admin.active)!==1)
      return sendJson(res,403,{error:'Доступ администратора отключён'});
    const body=ctx.body||{},type=String(body.type||'');
    if(!SUPPORTED.has(type))
      return sendJson(res,400,{error:'Отчёт не поддерживает запуск из центра'});
    if(type==='qrweek'&&admin.role!=='super')
      return sendJson(res,403,{error:'QR-отчёт доступен супер-администратору'});
    if(!admin.telegram_chat_id)
      return sendJson(res,409,{error:'Подключите личный Telegram в системе интеграций'});
    try{
      const params=reportParams(type,body);
      const approval=await require('./report-approvals')
        .requestReport(admin.telegram_chat_id,type,params);
      if(!approval.ok)
        return sendJson(res,502,{error:approval.error||'Не удалось отправить запрос'});
      sendJson(res,202,{ok:true,pending:true,message:approval.message});
    }catch(error){
      sendJson(res,error.statusCode||400,
        {error:error.statusCode?error.message:'Проверьте параметры отчёта'});
    }
  });
}
module.exports={SUPPORTED,reportParams,registerAdminReportCenterRoutes};
