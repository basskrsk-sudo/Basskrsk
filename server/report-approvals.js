'use strict';
// Reports are created only after an explicit, one-use confirmation in Telegram.
// Persist small approval requests instead of eagerly generating PDFs and CSVs.
const db = require('./db');
const { sendToChat } = require('./telegram');
const { adminCanReadSales } = require('./sales-week-report');
const REPORTS = Object.freeze({
  salesweek: {title:'Продажи за 7 дней',role:'admin'},
  business: {title:'Бизнес за год',role:'admin'},
  businesspoints: {title:'Реестр точек · CSV',role:'admin'},
  stock: {title:'Остатки центрального склада',role:'admin'},
  nogroomer: {title:'Заказы без грумера',role:'admin'},
  payouts: {title:'Сводка выплат и общий CSV',role:'admin'},
  // Hidden from the seven-group menu. A recipient button requests a separate
  // one-use confirmation before its PDF is ever rendered.
  payoutpdf: {title:'Персональная справка к выплате · PDF',role:'admin'},
  taskpdf: {title:'Мои поручения · PDF',role:'assignee'},
  gdweek: {title:'Отчёт для планёрки ГД · PDF и Excel',role:'admin-record'},
  qrweek: {title:'QR-аналитика за неделю · CSV',role:'super'},
  clubdaily: {title:'Клуб партнёров · итоги дня',role:'club'},
  clubweekly: {title:'Клуб партнёров · итоги недели',role:'club'},
  clubtopweek: {title:'Клуб партнёров · топ недели',role:'club'},
  clubtopall: {title:'Клуб партнёров · топ за всё время',role:'club'},
});
// Seven report families in the bot. Legacy type IDs remain valid for
// existing messages, commands and pending one-use Telegram confirmations.
const REPORT_GROUPS = Object.freeze([
  {id:'sales', title:'📈 Продажи', types:['salesweek','nogroomer']},
  {id:'finance', title:'💰 Финансы и выплаты', types:['business','payouts']},
  {id:'network', title:'🏪 Сеть и точки', types:['businesspoints']},
  {id:'stock', title:'📦 Остатки', types:['stock']},
  {id:'qr', title:'📱 QR и маркетинг', types:['qrweek']},
  {id:'management', title:'🧭 Управление', types:['gdweek']},
  {id:'club', title:'🐾 Клуб партнёров', types:['clubdaily','clubweekly','clubtopweek','clubtopall']},
]);
db.exec(
  'CREATE TABLE IF NOT EXISTS report_approval_requests ('+
  'id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,'+
  'report_type TEXT NOT NULL,params_json TEXT NOT NULL,'+
  "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','cancelled','failed')),"+
  "created_at TEXT NOT NULL DEFAULT (datetime('now')),"+
  "expires_at TEXT NOT NULL DEFAULT (datetime('now','+20 minutes')),"+
  'completed_at TEXT)'
);
db.exec('CREATE INDEX IF NOT EXISTS idx_report_approval_chat ON report_approval_requests(chat_id,status,id)');

function canRequest(chatId,type) {
  const spec=REPORTS[type],id=String(chatId==null?'':chatId);
  if(!spec||!/^[1-9][0-9]{0,19}$/.test(id))return false;
  if(spec.role==='admin')return adminCanReadSales(id);
  if(spec.role==='admin-record')return !!db.prepare(
    'SELECT 1 FROM admins WHERE telegram_chat_id=? AND active=1 LIMIT 1').get(id);
  if(spec.role==='super')return !!require('./partner-tier-approvals').activeSuperAdmin(id);
  if(spec.role==='assignee')return !!require('./task-daily-digest').assigneeByTelegram(id);
  if(spec.role==='club')return require('./routes-partner-club').isClubModerator(id);
  return false;
}
function menu(chatId){
  const groups=REPORT_GROUPS.filter(group=>group.types.some(type=>canRequest(chatId,type)));
  const tasks=canRequest(chatId,'taskpdf');
  if(!groups.length)return {message:tasks
    ? '📋 Мои поручения: /tasks — список, /taskpdf — PDF после подтверждения.'
    : 'Отчёты доступны только подключённым администраторам и модераторам.'};
  return {
    message:'📊 Выберите раздел отчётности. Файлы формируются только после подтверждения в личном Telegram.'+
      (tasks?'\n\nПоручения находятся в /tasks и /taskpdf.':''),
    reply_markup:{inline_keyboard:groups.map(group=>[
      {text:group.title,callback_data:'report:group:'+group.id}])},
  };
}
function groupMenu(chatId,groupId){
  const group=REPORT_GROUPS.find(item=>item.id===groupId);
  const types=group ? group.types.filter(type=>canRequest(chatId,type)) : [];
  if(!types.length)return {message:'Нет доступа к этому разделу отчётности.',
    reply_markup:{inline_keyboard:[[{text:'◀️ К разделам',callback_data:'report:menu'}]]}};
  return {
    message:group.title+'\nВыберите детализацию. Сначала будет запрошено подтверждение, без него расчёт не запускается.',
    reply_markup:{inline_keyboard:[
      ...types.map(type=>[{text:REPORTS[type].title,callback_data:'report:new:'+type}]),
      [{text:'◀️ К разделам',callback_data:'report:menu'}],
    ]},
  };
}
function escapeHtml(value){
  return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function details(params){
  const items=[];
  if(params.recipientName)items.push('Получатель: '+escapeHtml(String(params.recipientName).slice(0,100)));
  if(params.expectedTotal!==undefined)items.push('К выплате: '+escapeHtml(params.expectedTotal)+' ₽');
  if(params.year)items.push('Год: '+escapeHtml(params.year));
  if(params.days)items.push('Период: '+escapeHtml(params.days)+' дней');
  if(params.citySelector)items.push('Город: '+escapeHtml(params.citySelector));
  if(params.start&&params.end)items.push('Период: '+escapeHtml(params.start)+' — '+escapeHtml(params.end));
  return items.length?'\n'+items.join('\n'):'';
}
async function requestReport(chatId,type,params={},send=sendToChat){
  const id=String(chatId==null?'':chatId);
  if(!canRequest(id,type))return {ok:false,error:'Нет доступа к этому отчёту в личном Telegram.'};
  const json=JSON.stringify(params||{});
  if(json.length>500)return {ok:false,error:'Слишком длинные параметры отчёта.'};
  db.prepare("DELETE FROM report_approval_requests WHERE created_at<datetime('now','-30 days')").run();
  const existing=db.prepare(
    "SELECT id FROM report_approval_requests WHERE chat_id=? AND report_type=? AND params_json=? "+
    "AND status='pending' AND expires_at>datetime('now') ORDER BY id DESC LIMIT 1"
  ).get(id,type,json);
  const requestId=existing?Number(existing.id):Number(db.prepare(
    'INSERT INTO report_approval_requests(chat_id,report_type,params_json) VALUES(?,?,?)'
  ).run(id,type,json).lastInsertRowid);
  const message='📋 Согласовать формирование отчёта?\n\n'+REPORTS[type].title+
    details(params)+'\n\nФормирование начнётся только после подтверждения. Кнопки действуют 20 минут.';
  const reply_markup={inline_keyboard:[
    [{text:'✅ Сформировать',callback_data:'report:yes:'+requestId}],
    [{text:'❌ Отмена',callback_data:'report:no:'+requestId}]
  ]};
  let sent;
  try{sent=await send(id,message,{reply_markup})}
  catch(error){sent={ok:false,error:error.message}}
  if(!sent?.ok||sent.data?.ok===false){
    db.prepare("UPDATE report_approval_requests SET status='failed',completed_at=datetime('now') WHERE id=? AND status='pending'").run(requestId);
    return {ok:false,error:'Не удалось доставить запрос в Telegram.'};
  }
  return {ok:true,pending:true,id:requestId,message:'Подтверждение отправлено в личный Telegram. Отчёт пока не формировался.'};
}
function decideReport(chatId,action,rawId){
  const id=String(chatId==null?'':chatId),number=Number(rawId);
  if(!['yes','no'].includes(action)||!Number.isSafeInteger(number)||number<=0)
    return {ok:false,message:'Некорректная кнопка отчёта.'};
  const record=db.prepare('SELECT * FROM report_approval_requests WHERE id=?').get(number);
  if(!record||record.chat_id!==id||!canRequest(id,record.report_type))
    return {ok:false,message:'Нет доступа к этому запросу.'};
  const state=action==='yes'?'running':'cancelled';
  const claimed=db.prepare(
    "UPDATE report_approval_requests SET status=?,completed_at=datetime('now') "+
    "WHERE id=? AND chat_id=? AND status='pending' AND expires_at>datetime('now')"
  ).run(state,number,id);
  if(!claimed.changes)return {ok:false,message:'Запрос уже обработан или подтверждение просрочено.'};
  if(action==='no')return {ok:true,cancelled:true,message:'Отчёт отменён.'};
  return {ok:true,message:'Формирование разрешено.',
    request:{id:number,chatId:id,type:record.report_type,params:JSON.parse(record.params_json||'{}')}};
}
function finishReport(id,ok){
  db.prepare("UPDATE report_approval_requests SET status=?,completed_at=datetime('now') WHERE id=? AND status='running'")
    .run(ok?'done':'failed',id);
}
function cancelPendingReports(chatId){
  return db.prepare(
    "UPDATE report_approval_requests SET status='cancelled',completed_at=datetime('now') "+
    "WHERE chat_id=? AND status='pending'"
  ).run(String(chatId)).changes>0;
}
module.exports={REPORTS,REPORT_GROUPS,canRequest,menu,groupMenu,requestReport,decideReport,finishReport,cancelPendingReports};
