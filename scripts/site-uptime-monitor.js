'use strict';

// Independent public-site checks run by GitHub Actions, NOT by Amvera.
// No NPM packages, no access to production DB. GitHub Issues is the
// persistent incident ledger across scheduled workflow runs.
const BASE_URL = 'https://хвостмаркет.рф';
const INCIDENT_TITLE = '[Мониторинг] ХвостМаркет — сайт недоступен';
const PROBES = [
  {name:'Сайт',path:'/',verify:(body)=>/<html/i.test(body) && /Хвост|Маркет/i.test(body)},
  {name:'SQLite и хранилище',path:'/api/health',
    verify:(body)=>{try{const data=JSON.parse(body);return data.status==='ok' &&
      data.checks?.database==='ok'&&data.checks?.storage==='ok';}catch(_){return false;}}},
  {name:'Каталог API',path:'/api/points',
    verify:(body)=>{try{return Array.isArray(JSON.parse(body).points);}catch(_){return false;}}},
  {name:'Telegram Mini App',path:'/miniapp.html',
    verify:(body)=>/<html/i.test(body) && body.includes('miniapp-work.js')},
];

function classify(error) {
  if (error && (error.name==='TimeoutError'||error.name==='AbortError')) return 'timeout';
  return 'network';
}
async function probe(entry,{fetchImpl=fetch,origin=BASE_URL,now=Date.now}={}) {
  const start=now();
  try {
    const response=await fetchImpl(new URL(entry.path,origin),{
      method:'GET',headers:{Accept:'text/html, application/json','Cache-Control':'no-cache'},
      redirect:'follow',cache:'no-store',signal:AbortSignal.timeout(8000),
    });
    const status=response.status;
    let text='';
    try {text=(await response.text()).slice(0,150000);}catch(_){}
    const isOk=response.ok && entry.verify(text);
    return {name:entry.name,path:entry.path,ok:!!isOk,
      code:isOk?'ok':(response.ok?'invalid_content':'http_'+status),
      duration_ms:Math.min(20000,Math.max(0,now()-start))};
  }catch(e){
    return {name:entry.name,path:entry.path,ok:false,code:classify(e),
      duration_ms:Math.min(20000,Math.max(0,now()-start))};
  }
}
async function scan(options={}) {
  return Promise.all(PROBES.map(x=>probe(x,options)));
}
function confirmedFailures(first,second) {
  const bad=new Set(first.filter(x=>!x.ok).map(x=>x.path));
  return second.filter(x=>!x.ok && bad.has(x.path));
}
function renderIssueBody(failures,checkedAt) {
  return [
    '## Внешняя проверка сайта ХвостМаркет',
    '',
    '**Сбой подтверждён двумя проверками из GitHub Actions с интервалом 20 секунд.**',
    '',
    '**Обнаружен:** '+checkedAt,
    '',
    '| Проверка | Результат |',
    '|---|---|',
    ...failures.map(r=>'| '+r.name+' ('+r.path+') | '+r.code+' |'),
    '',
    'Проверьте Amvera → Логи приложения / Мониторинг / последние деплои.',
    'Этот инцидент будет закрыт автоматически после двух успешных проверок.',
    'Это внешний контроль из GitHub, а не диагностика непосредственно внутри Amvera.',
  ].join('\n');
}
function incidentMessage(failures,issueUrl) {
  return [
    '🔴 ХвостМаркет: сайт частично или полностью недоступен',
    'Проверка GitHub Actions дважды обнаружила ошибку:',
    ...failures.map(x=>'• '+x.name+': '+x.code),
    'Проверьте Amvera и последние обновления.',
    issueUrl ? 'Инцидент: '+issueUrl : '',
  ].filter(Boolean).join('\n');
}
function recoveredMessage(issueUrl,minutes) {
  return [
    '🟢 ХвостМаркет: сайт восстановлен',
    'Сайт, база, API и Mini App проходят две последовательные проверки.',
    Number.isFinite(minutes)?'Оценка длительности: '+minutes+' мин.':'',
    issueUrl?'История инцидента: '+issueUrl:'',
  ].filter(Boolean).join('\n');
}
function createApi({fetchImpl=fetch,token,repo}) {
  if(!token||!repo||!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))
    throw Error('GitHub token or repository unavailable');
  return async(method,path,body)=>{
    const url='https://api.github.com/repos/'+repo+path;
    const response=await fetchImpl(url,{
      method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json',
        'User-Agent':'HvostMarketUptimeMonitor'},
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw Error('GitHub API '+method+' failed: HTTP '+response.status);
    if(response.status===204)return {};
    return response.json();
  };
}
async function findOpenIncident(api) {
  const items=await api('GET','/issues?state=open&per_page=100');
  return items.find(x=>x.title===INCIDENT_TITLE && !x.pull_request) || null;
}
async function telegram(text,{fetchImpl=fetch,token='',chatId=''}={}) {
  if(!token||!chatId)return {sent:false,configured:false};
  try {
    const response=await fetchImpl('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true}),
      signal:AbortSignal.timeout(10000),
    });
    const result=await response.json().catch(()=>({}));
    return {sent:!!(response.ok&&result.ok),configured:true};
  }catch(_) {return {sent:false,configured:true};}
}
async function run({fetchImpl=fetch,api,notify,wait=ms=>new Promise(r=>setTimeout(r,ms)),
  logger=console,now=()=>new Date(),origin=BASE_URL}={}) {
  if(typeof api!=='function')throw Error('GitHub Issues API is required');
  if(typeof notify!=='function')throw Error('Telegram notifier is required');
  const first=await scan({fetchImpl,origin});
  await wait(20000);
  const second=await scan({fetchImpl,origin});
  const failures=confirmedFailures(first,second);
  const existing=await findOpenIncident(api);
  const checkedAt=now().toISOString();

  if(failures.length) {
    if(existing) {
      logger.log('Site remains unavailable. Open incident #'+existing.number+
        '; checks failed: '+failures.map(x=>x.name).join(', '));
      return {status:'still_down',incident:existing.number,failures};
    }
    const incident=await api('POST','/issues',{
      title:INCIDENT_TITLE,
      body:renderIssueBody(failures,checkedAt),
    });
    logger.log('Opened site outage incident #'+incident.number);
    const notification=await notify(incidentMessage(failures,incident.html_url));
    if(!notification.sent) logger.warn('Telegram notification not sent; GitHub incident remains recorded.');
    return {status:'down',incident:incident.number,failures,notified:notification.sent};
  }
  // A single successful scan cannot override an open incident; both need
  // to be fully healthy. On transient errors, keep the incident open but do
  // not create another alert.
  const fullyHealthy=first.every(x=>x.ok)&&second.every(x=>x.ok);
  if(existing && fullyHealthy) {
    await api('POST','/issues/'+existing.number+'/comments',{
      body:'✅ Сайт восстановлен: главная, SQLite, API и Mini App успешно проверены дважды. '+checkedAt,
    });
    await api('PATCH','/issues/'+existing.number,{state:'closed',state_reason:'completed'});
    const age=Date.parse(existing.created_at);
    const minutes=Number.isFinite(age)?Math.max(1,Math.round((now().getTime()-age)/60000)):null;
    logger.log('Closed recovered incident #'+existing.number);
    const notification=await notify(recoveredMessage(existing.html_url,minutes));
    if(!notification.sent)logger.warn('Recovery Telegram notification was not sent; incident is closed in GitHub.');
    return {status:'recovered',incident:existing.number,notified:notification.sent};
  }
  if(existing) {
    logger.warn('Transient probe errors; preserving open incident #'+existing.number);
    return {status:'uncertain',incident:existing.number};
  }
  if(!fullyHealthy) {
    logger.warn('Transient probe errors. No incident: failure not confirmed twice.');
    return {status:'transient'};
  }
  logger.log('All four public endpoints healthy');
  return {status:'healthy'};
}
async function main() {
  const token=process.env.GH_MONITOR_TOKEN||'';
  const repo=process.env.GH_MONITOR_REPOSITORY||'';
  const api=createApi({token,repo});
  const notify=(message)=>telegram(message,{
    token:process.env.HM_MONITOR_TELEGRAM_TOKEN||'',
    chatId:process.env.HM_MONITOR_CHAT_ID||'',
  });
  const result=await run({api,notify});
  if(['down','still_down'].includes(result.status))process.exitCode=1;
}
if(require.main===module)main().catch(e=>{
  // Never log secrets, private response bodies, or arbitrary URLs.
  console.error('[monitor] Check failed:',e.message.replace(/Bearer\s+\S+/g,'Bearer [redacted]'));
  process.exitCode=1;
});
module.exports={PROBES,INCIDENT_TITLE,probe,scan,confirmedFailures,createApi,findOpenIncident,
  run,telegram,renderIssueBody,incidentMessage,recoveredMessage};
