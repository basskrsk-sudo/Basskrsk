// MAX bot administration. Loaded with the existing admin page, but makes no
// network calls until the MAX section is opened.
'use strict';
const maxAdminState={page:1,pages:1,queryTimer:null,overview:null};

function maxAdminEsc(value){
  return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
async function maxAdminApi(url,options={}){
  const res=await authFetch(url,options);
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||'Ошибка запроса MAX ('+res.status+')');
  return data;
}
function maxAdminMessage(text){
  const node=document.getElementById('max-admin-action-result');
  if(node)node.textContent=text||'';
}
function maxAdminLabel(value){return value?'Настроено':'Не настроено';}

async function loadMaxAdmin(){
  const status=document.getElementById('max-admin-status');
  if(!status)return;
  status.textContent='Проверяем настройки MAX…';
  const [overview,connections,history]=await Promise.allSettled([
    maxAdminApi('/api/admin/max/overview'),
    loadMaxConnections(),
    loadMaxHistory(),
  ]);
  if(overview.status!=='fulfilled'){
    status.textContent='Не удалось получить состояние MAX: '+overview.reason.message;
    const config=document.getElementById('max-admin-config');if(config)config.textContent='';
    return;
  }
  const data=overview.value;
  maxAdminState.overview=data;
  const self=data.self_connection||{};
  const selfStatus=document.getElementById('max-admin-personal-status');
  const selfContainer=document.getElementById('max-admin-personal-connect');
  if(selfStatus){
    selfStatus.textContent=!self.phone_configured
      ?'Телефон администратора пока не назначен. Укажите номер в разделе управления администраторами.'
      :self.connected
        ?'✅ Личный MAX подтверждён. Откройте бота ХвостМаркет и отправьте /stock.'
        :'Подключите личный MAX и подтвердите свой номер телефона, чтобы получить доступ к /stock.';
  }
  if(selfContainer){
    if(self.phone_configured&&window.HvostMaxConnect){
      window.HvostMaxConnect.mount({
        containerId:'max-admin-personal-connect',
        role:'admin',connected:!!self.connected,tokenGetter:()=>adminToken,
      });
    }else selfContainer.textContent='';
  }
  status.textContent=data.configured
    ?'✅ Бот настроен в Amvera. Отправку проверьте кнопкой «Тестовое сообщение».'
    :'⚠️ Не все параметры MAX заданы в Amvera. Проверьте поля ниже.';
  const config=document.getElementById('max-admin-config');
  if(config){
    const items=[
      ['Токен API',data.token_configured],
      ['Имя бота',data.username_configured],
      ['Секрет webhook',data.webhook_secret_configured],
      ['Интеграция',data.configured],
    ];
    config.innerHTML=items.map(function(entry){
      return '<div style="padding:.7rem .85rem;border:1px solid var(--border);border-radius:9px;">'+
        '<div style="font-size:.73rem;color:var(--muted);">'+maxAdminEsc(entry[0])+'</div>'+
        '<strong style="font-size:.86rem;">'+maxAdminLabel(entry[1])+'</strong></div>';
    }).join('');
  }
  const link=document.getElementById('max-admin-link');
  if(link){
    const url=String(data.bot_url||'');
    link.innerHTML=(url.startsWith('https://max.ru/')?
      '<a href="'+maxAdminEsc(url)+'" target="_blank" rel="noopener noreferrer" class="row-btn" style="display:inline-block;text-decoration:none;">Открыть бота в MAX</a>':'')+
      '<span style="margin-left:.6rem;color:var(--muted);">Webhook: '+
      maxAdminEsc(data.webhook_path||'/api/max/webhook')+'</span>';
  }
  const commands=document.getElementById('max-admin-commands');
  if(commands)commands.innerHTML=(data.commands||[]).map(c=>
    '<div style="border:1px solid var(--border);border-radius:8px;padding:.7rem .8rem;display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">'+
    '<strong style="font-family:monospace;font-size:.88rem;">/'+maxAdminEsc(c.name)+'</strong>'+
    '<span style="font-size:.8rem;color:var(--muted);">'+maxAdminEsc(c.description)+'</span></div>'
  ).join('')||'Нет команд';
  const sync=document.getElementById('max-admin-sync');
  if(sync)sync.style.display=currentAdminRole==='super'?'inline-flex':'none';
  const last=document.getElementById('max-admin-sync-last');
  if(last){
    const item=data.last_manual_commands_sync;
    last.textContent=item?
      'Последняя ручная синхронизация: '+maxAdminEsc(item.created_at)+
        (item.success?' · успешно':' · ошибка') :
      'Ручная синхронизация пока не запускалась.';
  }
  if(connections.status==='rejected') {
    const sum=document.getElementById('max-admin-connection-summary');
    if(sum)sum.textContent='Не удалось загрузить подключения: '+connections.reason.message;
  }
  if(history.status==='rejected') {
    const target=document.getElementById('max-admin-history');
    if(target)target.textContent='Не удалось загрузить журнал: '+history.reason.message;
  }
}
async function loadMaxConnections(){
  const target=document.getElementById('max-admin-connections-body');
  const summary=document.getElementById('max-admin-connection-summary');
  if(!target||!summary)return;
  summary.textContent='Загружаем подключения…';
  target.innerHTML='<tr><td colspan="5">Загрузка…</td></tr>';
  const filter=document.getElementById('max-admin-role')?.value||'';
  const search=document.getElementById('max-admin-search')?.value.trim()||'';
  const params=new URLSearchParams({page:String(maxAdminState.page),role:filter,search});
  try{
    const data=await maxAdminApi('/api/admin/max/connections?'+params.toString());
    maxAdminState.pages=data.pages||1;
    summary.textContent='Привязок по фильтру: '+Number(data.total||0)+
      ' · страница '+data.page+'/'+data.pages+
      (maxAdminState.overview?.connections?
        ' · всего уникальных MAX-чата(ов): '+maxAdminState.overview.connections.people : '');
    const canDisconnect=currentAdminRole==='super';
    target.innerHTML=(data.rows||[]).length?data.rows.map(row=>{
      const label=maxAdminEsc(row.name),role=maxAdminEsc(row.role_label);
      const login=row.login?'Логин: '+maxAdminEsc(row.login):'';
      const location=row.point_name?'Салон: '+maxAdminEsc(row.point_name):'';
      const details=[login,location].filter(Boolean).join('<div style="margin-top:.2rem;"></div>');
      const action=canDisconnect?
        '<button type="button" class="row-btn" data-max-role="'+maxAdminEsc(row.role)+
        '" data-max-id="'+Number(row.account_id)+'" onclick="disconnectMaxAdminAccount(this)">Отключить</button>':
        '<span style="color:var(--muted);">—</span>';
      return '<tr><td><strong>'+label+'</strong><div style="font-size:.75rem;color:var(--muted);">'+
        maxAdminEsc(row.phone_masked)+'</div></td><td>'+role+'</td>'+
        '<td style="font-size:.77rem;">'+details+
        '<div style="font-size:.72rem;color:var(--muted);">MAX: '+maxAdminEsc(row.chat_masked)+'</div></td>'+
        '<td>'+ (row.active?'Активен':'Отключён')+'</td><td>'+action+'</td></tr>';
    }).join(''):'<tr><td colspan="5" style="text-align:center;padding:1.4rem;">Подключений по выбранным условиям нет.</td></tr>';
    document.getElementById('max-admin-page-label').textContent=
      'Страница '+data.page+' из '+data.pages;
    document.getElementById('max-admin-prev').disabled=data.page<=1;
    document.getElementById('max-admin-next').disabled=data.page>=data.pages;
  }catch(error){
    summary.textContent='Ошибка загрузки подключений: '+error.message;
    target.innerHTML='<tr><td colspan="5">Не удалось получить данные.</td></tr>';
    throw error;
  }
}
function maxAdminScheduleSearch(){
  if(maxAdminState.queryTimer)clearTimeout(maxAdminState.queryTimer);
  maxAdminState.queryTimer=setTimeout(()=>{
    maxAdminState.queryTimer=null;
    maxAdminState.page=1;
    loadMaxConnections().catch(()=>{});
  },350);
}
function maxAdminChangeFilter(){
  maxAdminState.page=1;
  loadMaxConnections().catch(()=>{});
}
function maxAdminPage(delta){
  const next=maxAdminState.page+Number(delta||0);
  if(next<1||next>maxAdminState.pages)return;
  maxAdminState.page=next;
  loadMaxConnections().catch(()=>{});
}
async function syncMaxAdminCommands(){
  if(currentAdminRole!=='super')return;
  if(!confirm('Обновить штатный список команд в MAX?'))return;
  const button=document.getElementById('max-admin-sync');
  if(button)button.disabled=true;
  maxAdminMessage('Синхронизируем меню команд MAX…');
  try{
    const r=await maxAdminApi('/api/admin/max/commands/sync',{method:'POST',body:{}});
    maxAdminMessage(r.message);
    await loadMaxAdmin();
  }catch(error){maxAdminMessage('Ошибка: '+error.message)}
  finally{if(button)button.disabled=false;}
}
async function sendMaxAdminTest(){
  const button=document.getElementById('max-admin-test-button');
  if(button)button.disabled=true;
  maxAdminMessage('Отправляем тестовое сообщение в личный MAX…');
  try{
    const r=await maxAdminApi('/api/admin/max/test',{method:'POST',body:{}});
    maxAdminMessage(r.message);
    await loadMaxHistory();
  }catch(error){maxAdminMessage('Ошибка: '+error.message)}
  finally{if(button)button.disabled=false;}
}
async function disconnectMaxAdminAccount(button){
  if(currentAdminRole!=='super')return;
  const role=button?.dataset?.maxRole;
  const accountId=Number(button?.dataset?.maxId);
  if(!role||!Number.isSafeInteger(accountId)||accountId<=0)return;
  const row=button.closest('tr');
  const name=row?.querySelector('strong')?.textContent||'этого пользователя';
  if(!confirm('Отключить MAX у '+name+'?\nПользователю потребуется повторно подключить MAX. Доступ по Telegram и паролю сохранится.'))return;
  button.disabled=true;
  maxAdminMessage('Отключаем выбранную привязку…');
  try{
    const r=await maxAdminApi('/api/admin/max/connections/disconnect',{
      method:'POST',body:{role,account_id:accountId}
    });
    maxAdminMessage(r.message);
    await Promise.all([loadMaxConnections(),loadMaxHistory()]);
    // Refresh number of unique linked MAX users after an unlink.
    const data=await maxAdminApi('/api/admin/max/overview');
    maxAdminState.overview=data;
  }catch(error){maxAdminMessage('Ошибка: '+error.message);button.disabled=false;}
}
async function loadMaxHistory(){
  const target=document.getElementById('max-admin-history');
  if(!target)return;
  const data=await maxAdminApi('/api/admin/max/history');
  const names={
    sync_commands:'Синхронизация команд',
    test_message:'Проверка доставки',
    disconnect:'Отключение аккаунта',
  };
  const rows=(data.rows||[]);
  target.innerHTML=rows.length?rows.map(item=>
    '<div style="display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;'+
    'padding:.45rem 0;border-bottom:1px solid var(--border);">'+
    '<span>'+maxAdminEsc(names[item.action]||item.action)+
    (item.target_role?' · '+maxAdminEsc(item.target_role)+' #'+Number(item.target_id):'')+
    ' · '+(item.success?'Успешно':'Ошибка')+'</span>'+
    '<span style="color:var(--muted);">'+maxAdminEsc(item.actor)+' · '+
    maxAdminEsc(item.created_at)+'</span></div>'
  ).join(''):'Действий с MAX в журнале пока нет.';
}
