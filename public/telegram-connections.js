// Telegram bot connection registry in the administration panel.
'use strict';
const telegramConnectionsState={people:[],summary:null};
function telegramConnectionsEscape(value){
 return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
async function loadTelegramConnections(){
 const status=document.getElementById('tg-connections-summary');
 const tbody=document.getElementById('tg-connections-rows');
 if(!status||!tbody)return;
 status.textContent='Загружаем актуальные подключения…';
 tbody.innerHTML='<tr><td colspan="4">Загрузка…</td></tr>';
 try{
  const response=await authFetch('/api/admin/telegram-connections');
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Не удалось получить список');
  telegramConnectionsState.people=Array.isArray(data.people)?data.people:[];
  telegramConnectionsState.summary=data.summary||null;
  renderTelegramConnections();
 }catch(error){
  telegramConnectionsState.people=[];
  telegramConnectionsState.summary=null;
  status.textContent='Ошибка загрузки подключений.';
  tbody.innerHTML='<tr><td colspan="4">'+telegramConnectionsEscape(error.message||'Неизвестная ошибка')+'</td></tr>';
 }
}
function renderTelegramConnections(){
 const summary=telegramConnectionsState.summary;
 if(!summary)return;
 const search=String(document.getElementById('tg-connections-search')?.value||'')
  .trim().toLocaleLowerCase('ru');
 const role=document.getElementById('tg-connections-role')?.value||'';
 const people=telegramConnectionsState.people.filter(function(person){
  if(role&&!person.roles.includes(role))return false;
  if(!search)return true;
  const haystack=[person.name,...(person.phones||[]),...person.accounts.flatMap(function(a){
   return [a.name,a.login,a.phone,a.point_name,a.role_label];
  })].join(' ').toLocaleLowerCase('ru');
  return haystack.includes(search);
 });
 const status=document.getElementById('tg-connections-summary');
 const tbody=document.getElementById('tg-connections-rows');
 if(!status||!tbody)return;
 const countText=(summary.by_role||[]).filter(x=>x.accounts>0)
  .map(x=>x.label+': '+x.accounts).join(' · ');
 status.textContent='Подключено пользователей: '+summary.people+
  ' · Привязок к кабинетам: '+summary.accounts+
  ' · Найдено: '+people.length+(countText?'\n'+countText:'');
 if(!people.length){
  tbody.innerHTML='<tr><td colspan="4" style="text-align:center;padding:1.5rem;">'+
   (summary.people?'По выбранным условиям подключений нет.':'Пока никто не подключил Telegram-бота.')+
   '</td></tr>';
  return;
 }
 tbody.innerHTML=people.map(function(person){
  const phones=(person.phones||[]).map(telegramConnectionsEscape).join(', ');
  const badges=person.accounts.map(a=>a.role_label)
   .filter((label,i,all)=>all.indexOf(label)===i)
   .map(label=>'<span class="stock-pill stock-ok" style="display:inline-block;margin:0 .3rem .3rem 0;">'+
    telegramConnectionsEscape(label)+'</span>').join('');
  const details=person.accounts.map(function(account){
   const secondary=[
    account.name!==person.name?account.name:'',
    account.point_name?'Салон: '+account.point_name:'',
    account.login?'Логин: '+account.login:'',
   ].filter(Boolean).map(telegramConnectionsEscape).join(' · ');
   return '<div style="padding:.2rem 0;"><strong>'+telegramConnectionsEscape(account.role_label)+
    '</strong>'+(secondary?'<div style="font-size:.73rem;color:var(--muted);">'+secondary+'</div>':'')+'</div>';
  }).join('');
  const disabled=person.accounts.filter(a=>!a.active).length;
  const state=disabled?'<span class="stock-pill stock-low">Есть отключённые роли ('+disabled+')</span>':
   '<span class="stock-pill stock-ok">Привязан</span>';
  return '<tr><td><strong>'+telegramConnectionsEscape(person.name)+'</strong>'+
   (phones?'<div style="font-size:.75rem;color:var(--muted);">'+phones+'</div>':'')+
   '</td><td>'+badges+'</td><td>'+details+'</td><td>'+state+'</td></tr>';
 }).join('');
}
