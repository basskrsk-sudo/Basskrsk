/* Fast mobile call log for the Telegram Mini App; shares partner_leads CRM. */
(function(){
  'use strict';
  var root=document.getElementById('leadsPage');
  if(!root)return;
  var identity=window.HvostMiniAppIdentity;
  var serial=0,token='',role='',loading=false,writing=false;
  var leads=[],current=null,mode='list',search='',filter='all',statusFilter='',notice='';
  var statuses=[
    ['to_call','Нужно позвонить'],['no_answer','Не дозвонились'],
    ['meeting_scheduled','Встреча назначена'],['meeting_held','Встреча прошла'],
    ['signed','Партнёр подключён'],['declined','Отказ']
  ];
  var categories=[
    ['groomer','Груминг-салон'],['vet','Ветклиника'],
    ['training_center','Кинологический центр'],['kennel','Кинолог'],
    ['hotel','Зоогостиница'],['other','Другое']
  ];
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });}
  function roleNow(preferred){
    var status=identity&&identity.getStatus();
    if(!status||!status.verified||!Array.isArray(status.accounts))return '';
    var allowed=function(r){return (r==='manager'||r==='admin')&&
      status.accounts.some(function(a){return a.role===r;});};
    if(allowed(preferred))return preferred;
    if(allowed(role))return role;
    if(allowed(status.preferredRole))return status.preferredRole;
    if(allowed('manager'))return 'manager';
    return allowed('admin')?'admin':'';
  }
  function label(list,value){
    var pair=list.find(function(row){return row[0]===value});
    return pair?pair[1]:'—';
  }
  function options(list,value,withEmpty){
    return (withEmpty?'<option value="">Выберите результат</option>':'')+
      list.map(function(row){return '<option value="'+esc(row[0])+'"'+
        (row[0]===value?' selected':'')+'>'+esc(row[1])+'</option>';}).join('');
  }
  function callHref(phone){
    var digits=String(phone||'').replace(/[^0-9+]/g,'');
    return /^\+?[0-9]{10,15}$/.test(digits)&&!digits.slice(1).includes('+')?'tel:'+digits:'';
  }
  function dateLabel(iso){
    if(!iso)return 'не назначена';
    var match=/^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return match?match[3]+'.'+match[2]+'.'+match[1]:String(iso).slice(0,10);
  }
  function canEdit(item){return role==='admin'||item.assigned_manager_id!=null;}
  function allowed(){return !!roleNow();}
  function close(){
    serial++;token='';role='';leads=[];current=null;loading=false;writing=false;
    mode='list';notice='';root.replaceChildren();
  }
  function error(text){
    var node=root.querySelector('[data-call-message]');
    if(node)node.textContent=text;
  }
  async function api(path,method,body){
    if(!token||!role||roleNow()!==role)throw new Error('Требуется подтвердить доступ к обзвону.');
    var response=await fetch(path,{
      method:method||'GET',cache:'no-store',
      headers:Object.assign({Authorization:'Bearer '+token},body?{'Content-Type':'application/json'}:{}),
      ...(body?{body:JSON.stringify(body)}:{})
    });
    var data=await response.json().catch(function(){return{}});
    if(!response.ok)throw new Error(data.error||'Ошибка сервера: '+response.status);
    return data;
  }
  function header(title,sub){
    return '<div class="hmleads-mini-header"><h1>'+esc(title)+'</h1>'+
      (sub?'<p>'+esc(sub)+'</p>':'')+'</div>';
  }
  function actions(item){
    var href=callHref(item.phone);
    return '<div class="hmleads-mini-actions">'+
      (href?'<a class="hmleads-mini-call" href="'+esc(href)+'" aria-label="Позвонить: '+esc(item.salon_name)+'">📞 Позвонить</a>':'')+
      (canEdit(item)?'<button type="button" class="hmleads-mini-record" data-call-action="quick" data-id="'+item.id+'">✍️ Итог звонка</button>':
        '<button type="button" class="hmleads-mini-claim" data-call-action="claim" data-id="'+item.id+'">Взять в работу</button>')+
      '</div>';
  }
  function visible(item){
    if(filter==='mine'&&item.assigned_manager_id==null)return false;
    if(filter==='free'&&item.assigned_manager_id!=null)return false;
    return true;
  }
  function list(){
    mode='list';current=null;
    var selected=leads.filter(visible);
    root.innerHTML=header('📞 Обзвон партнёров','Общая CRM с админкой. Результаты сохраняются сразу.')+
      '<div class="hmleads-mini-tools"><button type="button" class="hmleads-mini-new" data-call-action="new">+ Новое заведение</button>'+
      '<button type="button" class="hmleads-mini-refresh" data-call-action="refresh">↻ Обновить</button></div>'+
      '<form data-call-form="search" class="hmleads-mini-search">'+
      '<input name="q" aria-label="Поиск партнёра" placeholder="Салон, контакт, телефон" value="'+esc(search)+'">'+
      '<select name="status" aria-label="Статус"><option value="">Все статусы</option>'+options(statuses,statusFilter)+'</select>'+
      '<button type="submit">Найти</button></form>'+
      '<div class="hmleads-mini-filters">'+
      [['all','Все'],['mine','Мои'],['free','Свободные']].map(function(pair){
        return '<button type="button" data-call-action="filter" data-value="'+pair[0]+'"'+
          (filter===pair[0]?' aria-pressed="true" class="active"':' aria-pressed="false"')+'>'+pair[1]+'</button>';
      }).join('')+'</div>'+
      (notice?'<p class="hmleads-mini-success" role="status">'+esc(notice)+'</p>':'')+
      '<p class="hmleads-mini-caption">Заведений: '+selected.length+'</p>'+
      (selected.length?selected.map(function(item){
        var late=item.next_contact_date&&item.next_contact_date < new Date().toISOString().slice(0,10)&&
          item.status!=='signed'&&item.status!=='declined';
        return '<article class="hmleads-mini-item">'+
          '<button type="button" class="hmleads-mini-details" data-call-action="detail" data-id="'+item.id+'">'+
          '<span class="hmleads-mini-row"><strong>'+esc(item.salon_name)+'</strong><span>'+esc(label(statuses,item.status))+'</span></span>'+
          '<small>'+esc(label(categories,item.category))+(item.contact_name?' · '+esc(item.contact_name):'')+'</small>'+
          '<small>'+esc(item.phone||'Номер не указан')+'</small>'+
          '<small'+(late?' class="overdue"':'')+'>Следующий контакт: '+esc(dateLabel(item.next_contact_date))+'</small>'+
          '</button>'+actions(item)+'</article>';
      }).join(''):'<div class="hmleads-mini-empty">По выбранному фильтру заведений пока нет.</div>');
  }
  async function load(){
    var request=serial;
    if(loading)return;
    loading=true;
    if(mode==='list')root.innerHTML=header('📞 Обзвон партнёров')+'<p class="hmleads-mini-empty">Загружаем список…</p>';
    try{
      var qs=new URLSearchParams();
      if(search)qs.set('q',search);
      if(statusFilter)qs.set('status',statusFilter);
      var data=await api('/api/partner-leads'+(qs.size?'?'+qs.toString():''));
      if(request!==serial)return;
      leads=data.leads||[];
      list();
    }catch(e){
      if(request===serial){
        root.innerHTML=header('📞 Обзвон партнёров')+
          '<p data-call-message role="alert" class="hmleads-mini-error">'+esc(e.message)+'</p>'+
          '<button type="button" class="hmleads-mini-refresh" data-call-action="refresh">Повторить</button>';
      }
    }finally{loading=false;}
  }
  function quick(id){
    var item=leads.find(function(row){return String(row.id)===String(id)});
    if(!item||!canEdit(item))return;
    current=item;mode='quick';
    var href=callHref(item.phone);
    root.innerHTML=header('✍️ Итог звонка',item.salon_name)+
      '<button class="hmleads-mini-back" type="button" data-call-action="back">← К списку</button>'+
      '<div class="hmleads-mini-target"><strong>'+esc(item.salon_name)+'</strong>'+
      (item.contact_name?'<p>Контакт: '+esc(item.contact_name)+'</p>':'')+
      (href?'<a href="'+esc(href)+'" class="hmleads-mini-call">📞 '+esc(item.phone)+'</a>':'<p>Номер не указан</p>')+
      '</div><form class="hmleads-mini-form" data-call-form="quick">'+
      '<label>Результат звонка *<select name="status" required>'+options(statuses,'',true)+'</select></label>'+
      '<label>Комментарий<textarea name="note" rows="3" maxlength="2000" placeholder="С кем разговаривали, что обсудили"></textarea></label>'+
      '<label>Следующий контакт<input type="date" name="next_contact_date" value="'+esc(item.next_contact_date||'')+'"></label>'+
      '<p class="hmleads-mini-caption">Статус, дата и комментарий сохранятся одним действием.</p>'+
      '<p data-call-message class="hmleads-mini-error" role="status" aria-live="polite"></p>'+
      '<button type="submit" class="hmleads-mini-save">✅ Сохранить итог</button></form>';
  }
  function sourceAnchor(lead){
    var source=String(lead.yandex_url||lead.dgis_url||'');
    if(!/^https:\/\/yandex\.ru\/maps\/org\/(?:[a-z0-9_-]+\/)?\d{5,20}$/i.test(source) &&
       !/^https:\/\/2gis\.ru\/[a-z0-9-]+\/(?:firm|geo)\/\d{10,20}$/i.test(source)) return '';
    return '<a href="'+esc(source)+'" class="hmleads-mini-call" target="_blank" rel="noopener noreferrer">'+
      (lead.yandex_url?'📍 Открыть в Яндекс Картах':'📍 Открыть в 2ГИС')+'</a>';
  }
  async function detail(id){
    var req=serial;
    mode='detail';
    root.innerHTML=header('Карточка партнёра')+'<p class="hmleads-mini-empty">Загружаем историю…</p>';
    try{
      var data=await api('/api/partner-leads/'+encodeURIComponent(id));
      if(req!==serial||mode!=='detail')return;
      current=data.lead;
      var href=callHref(current.phone);
      root.innerHTML=header(current.salon_name,'История переговоров и быстрые действия')+
        '<button type="button" class="hmleads-mini-back" data-call-action="back">← К списку</button>'+
        '<div class="hmleads-mini-target"><p>'+esc(current.address||'Адрес не указан')+'</p>'+
        '<p>'+esc(current.contact_name||'Контактное лицо не указано')+'</p>'+
        (href?'<a href="'+esc(href)+'" class="hmleads-mini-call">📞 '+esc(current.phone)+'</a>':'')+
        sourceAnchor(current)+
        '<p>Статус: '+esc(label(statuses,current.status))+'</p></div>'+
        actions(current)+
        '<h2 class="hmleads-mini-history-title">История контактов</h2>'+
        ((data.notes||[]).length?(data.notes||[]).map(function(n){
          return '<div class="hmleads-mini-history"><small>'+esc(n.created_at)+' · '+esc(n.author)+'</small><p>'+esc(n.note)+'</p></div>';
        }).join(''):'<p class="hmleads-mini-empty">Записей пока нет.</p>');
    }catch(e){if(req===serial){notice=e.message;list();}}
  }
  function newLead(){
    mode='new';current=null;
    root.innerHTML=header('➕ Новое заведение','Добавление в общую базу ХвостМаркета')+
      '<button type="button" class="hmleads-mini-back" data-call-action="back">← К списку</button>'+
      '<form class="hmleads-mini-form" data-call-form="new">'+
      '<label>Название заведения *<input name="salon_name" required maxlength="200" placeholder="Название салона"></label>'+
      '<label>Категория<select name="category">'+options(categories,'groomer')+'</select></label>'+
      '<label>Телефон<input name="phone" type="tel" inputmode="tel" maxlength="35" placeholder="+7 999 123-45-67"></label>'+
      '<label>Контактное лицо<input name="contact_name" maxlength="160"></label>'+
      '<label>Адрес<input name="address" maxlength="255"></label>'+
      '<label>Первый комментарий<textarea name="note" rows="3" maxlength="2000"></textarea></label>'+
      '<p data-call-message class="hmleads-mini-error" role="status" aria-live="polite"></p>'+
      '<button type="submit" class="hmleads-mini-save">Добавить в прозвон</button></form>';
  }
  async function save(form){
    if(writing||!current||mode!=='quick')return;
    var values=new FormData(form);
    var status=String(values.get('status')||'');
    if(!statuses.some(function(s){return s[0]===status}))return error('Выберите результат звонка.');
    var body={status:status,note:String(values.get('note')||'').trim(),
      next_contact_date:String(values.get('next_contact_date')||'').trim()};
    var request=serial,id=current.id,button=form.querySelector('[type="submit"]');
    writing=true;if(button){button.disabled=true;button.textContent='Сохраняем…';}
    try{
      await api('/api/partner-leads/'+encodeURIComponent(id)+'/call','POST',body);
      if(request!==serial)return;
      notice='✅ Результат сохранён в CRM и доступен администратору.';
      await load();
    }catch(e){if(request===serial)error(e.message);}
    finally{writing=false;if(button){button.disabled=false;button.textContent='✅ Сохранить итог';}}
  }
  async function create(form){
    if(writing||mode!=='new')return;
    var values=new FormData(form);
    var body={};
    ['salon_name','category','phone','contact_name','address','note'].forEach(function(k){
      body[k]=String(values.get(k)||'').trim();
    });
    if(!body.salon_name)return error('Введите название заведения.');
    writing=true;var request=serial,button=form.querySelector('[type="submit"]');
    if(button){button.disabled=true;button.textContent='Добавляем…';}
    try{
      await api('/api/partner-leads','POST',body);
      if(request!==serial)return;
      notice='✅ Заведение добавлено в общую базу.';
      search='';statusFilter='';filter='all';
      await load();
    }catch(e){if(request===serial)error(e.message);}
    finally{writing=false;if(button){button.disabled=false;button.textContent='Добавить в прозвон';}}
  }
  async function claim(id){
    if(writing)return;
    writing=true;var req=serial;
    try{
      await api('/api/partner-leads/'+encodeURIComponent(id)+'/claim','POST');
      if(req!==serial)return;
      notice='✅ Заведение закреплено за вами.';
      await load();
    }catch(e){if(req===serial){notice='⚠️ '+e.message;await load();}}
    finally{writing=false;}
  }
  async function open(preferred){
    close();
    role=roleNow(preferred);
    if(!role||!identity||typeof identity.session!=='function'){
      root.innerHTML=header('📞 Обзвон')+'<p class="hmleads-mini-empty">Подтвердите номер Telegram и доступ сотрудника.</p>';
      return;
    }
    var req=serial;
    root.innerHTML=header('📞 Обзвон')+'<p class="hmleads-mini-empty">Проверяем доступ…</p>';
    try{
      var session=await identity.session(role);
      if(req!==serial||!session||session.role!==role||!session.token||roleNow()!==role)return;
      token=session.token;
      await load();
    }catch(e){if(req===serial){
      root.innerHTML=header('📞 Обзвон')+
        '<p class="hmleads-mini-error" role="alert">'+esc(e.message)+'</p>'+
        '<button type="button" class="hmleads-mini-refresh" data-call-action="retry">Повторить вход</button>';
    }}
  }
  async function openAt(id,preferred){
    if(!/^\d{1,10}$/.test(String(id||'')))return;
    await open(preferred);
    if(token&&role&&roleNow()===role)return detail(id);
  }
  root.addEventListener('click',function(event){
    var button=event.target.closest('[data-call-action]');
    if(!button||!root.contains(button))return;
    var action=button.dataset.callAction,id=button.dataset.id;
    if(action==='filter'){filter=button.dataset.value;return list();}
    if(action==='back'){notice='';return list();}
    if(action==='new')return newLead();
    if(action==='quick')return quick(id);
    if(action==='detail')return detail(id);
    if(action==='refresh')return load();
    if(action==='retry')return open();
    if(action==='claim')return claim(id);
  });
  root.addEventListener('submit',function(event){
    var form=event.target.closest('[data-call-form]');
    if(!form||!root.contains(form))return;
    event.preventDefault();
    if(form.dataset.callForm==='quick')return save(form);
    if(form.dataset.callForm==='new')return create(form);
    if(form.dataset.callForm==='search'){
      var fields=new FormData(form);
      search=String(fields.get('q')||'').trim();
      statusFilter=String(fields.get('status')||'');
      notice='';
      return load();
    }
  });
  window.HvostMiniAppLeads={available:allowed,open:open,openAt:openAt,close:close,refresh:open};
})();