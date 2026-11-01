// Compact meeting task panel for four HvostMarket staff members.
// All task data and update rights are rechecked by server on every request.
(function(){
  'use strict';
  var scope='mine',filter='active',selectedId=null,confirmId=null;
  var busy=false,error='',message='',showCount=30;

  function esc(value){
    return String(value == null?'':value).replace(/[&<>"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  function reset(){
    scope='mine';filter='active';selectedId=null;confirmId=null;
    busy=false;error='';message='';showCount=30;
  }
  function shortDate(value){
    return value&&/^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value.slice(8)+'.'+value.slice(5,7)+'.'+value.slice(0,4)
      : 'Без срока';
  }
  function statusName(status){
    return ({new:'Новая',in_progress:'В работе',blocked:'Ожидает решения',
      done:'Выполнена',cancelled:'Отменена'})[status]||status;
  }
  function urgency(task){
    if(task.overdue)return '<span class="mt-flag mt-overdue">Просрочено</span>';
    if(task.due_date)return '<span class="mt-flag">'+esc(shortDate(task.due_date))+'</span>';
    return '<span class="mt-flag mt-muted">Без срока</span>';
  }
  function isActive(task){return task.status!=='done'&&task.status!=='cancelled';}
  function statsBox(label,value,tone){
    return '<div class="mt-stat '+(tone||'')+'"><small>'+esc(label)+'</small><b>'+esc(value)+'</b></div>';
  }
  function navigation(current,data){
    var count=Number(data?.summary?.active||0);
    return '<nav class="mt-nav" aria-label="Разделы рабочего кабинета">' +
      '<button class="'+(current==='overview'?'active':'')+'" type="button" data-work-action="work-overview">📊 Обзор</button>' +
      '<button class="'+(current==='tasks'?'active':'')+'" type="button" data-work-action="work-tasks">📋 Поручения'+
        (count?' <span>'+count+'</span>':'')+'</button></nav>';
  }
  function overviewCard(data){
    if(!data||!data.actor)return '';
    var s=data.summary||{};
    var latest=(data.my_tasks||[]).filter(isActive).slice(0,2);
    return '<section class="work-surface mt-overview">'+
      '<div class="mt-section-head"><div><h2>📋 Мои поручения</h2><p>Планёрки и контроль выполнения</p></div>'+
      '<button type="button" data-work-action="work-tasks">Открыть →</button></div>'+
      '<div class="mt-overview-metrics"><span>Активных <b>'+esc(s.active||0)+'</b></span>'+
      '<span>Просрочено <b class="mt-danger">'+esc(s.overdue||0)+'</b></span>'+
      '<span>В работе <b>'+esc(s.in_progress||0)+'</b></span></div>'+
      (latest.length
        ? '<p class="mt-preview-tasks">'+latest.map(t=>esc(t.title)).join(' · ')+'</p>'
        : '<p class="work-note">Активных личных поручений нет.</p>')+'</section>';
  }
  function selector(){
    return '<div class="mt-filters" role="group" aria-label="Фильтр поручений">'+
      [['active','Активные'],['overdue','Просроченные'],['done','Выполненные'],['all','Все']].map(function(row){
        return '<button type="button" class="'+(filter===row[0]?'active':'')+
          '" data-mini-task-action="filter" data-task-value="'+row[0]+'">'+row[1]+'</button>';
      }).join('')+'</div>';
  }
  function scopeTabs(data){
    if(!data.team)return '';
    return '<div class="mt-scopes" role="group" aria-label="Чьи поручения">'+
      '<button type="button" class="'+(scope==='mine'?'active':'')+
      '" data-mini-task-action="scope" data-task-value="mine">Мои поручения</button>'+
      '<button type="button" class="'+(scope==='team'?'active':'')+
      '" data-mini-task-action="scope" data-task-value="team">Команда · 4</button>'+
      '</div>';
  }
  function teamSummary(team){
    if(!team)return '';
    return '<section class="work-surface mt-team"><h2>👥 Контроль поручений команды</h2>'+
      '<p class="work-note">Обзор для сооснователей. Менять чужие поручения здесь нельзя.</p>'+
      '<div class="mt-team-list">'+(team.members||[]).map(function(m){
        return '<div class="mt-team-line"><span><b>'+esc(m.name)+'</b>'+
          '<small>В работе: '+esc(m.summary?.in_progress||0)+'</small></span>'+
          '<strong>'+esc(m.summary?.active||0)+'</strong>'+
          (m.summary?.overdue?'<em>'+esc(m.summary.overdue)+' просрочено</em>':'')+
          '</div>';
      }).join('')+'</div></section>';
  }
  function taskCard(task,editable){
    var open=Number(selectedId)===Number(task.id);
    var priority=({critical:'Критический',high:'Высокий',normal:'Обычный',low:'Низкий'})[task.priority]||'';
    var card='<article class="mt-task '+(task.overdue?'is-overdue':'')+'">'+
      '<button type="button" class="mt-task-head" data-mini-task-action="open" data-task-id="'+esc(task.id)+'" aria-expanded="'+open+'">'+
      '<div class="mt-task-main"><strong>'+esc(task.title)+'</strong>'+
      '<span>'+urgency(task)+' <span class="mt-flag mt-status">'+esc(statusName(task.status))+'</span>'+
      (priority==='Критический'||priority==='Высокий'
        ?' <span class="mt-flag mt-important">'+esc(priority)+'</span>':'')+'</span></div>'+
      '<span class="mt-chevron">'+(open?'−':'+')+'</span></button>';
    if(open){
      card+='<div class="mt-task-detail">'+
        (task.description?'<p class="mt-description">'+esc(task.description)+'</p>':'')+
        '<div class="mt-task-meta">Исполнитель: <b>'+esc(task.assignee_name)+'</b>'+
        (task.recurrence_rule?' · 🔁 Повторяющееся':'')+'</div>'+
        (task.latest_report?'<div class="mt-latest"><b>Последний отчёт:</b><p>'+esc(task.latest_report)+'</p></div>':'');
      if(editable && isActive(task)){
        card+='<div class="mt-task-controls">'+
          (task.status!=='in_progress'?'<button type="button" class="mt-action" data-mini-task-action="work" data-task-id="'+esc(task.id)+'">▶️ В работу</button>':'')+
          (task.status!=='blocked'?'<button type="button" class="mt-action" data-mini-task-action="block" data-task-id="'+esc(task.id)+'">⏳ Ожидаю решения</button>':'')+
          '<button type="button" class="mt-action mt-success" data-mini-task-action="done" data-task-id="'+esc(task.id)+'">✅ Выполнено</button></div>';
        if(Number(confirmId)===Number(task.id)) card+='<div class="mt-confirm">'+
          '<strong>Подтвердить выполнение поручения?</strong>'+
          (task.recurrence_rule?'<p>Для повторяющейся задачи будет рассчитан следующий срок.</p>':'')+
          '<div><button type="button" class="mt-action mt-success" data-mini-task-action="confirm-done" data-task-id="'+esc(task.id)+'">Да, выполнено</button>'+
          '<button type="button" class="mt-action" data-mini-task-action="cancel-done" data-task-id="'+esc(task.id)+'">Отмена</button></div></div>';
        card+='<div class="mt-update-fields">'+
          '<label for="mtTaskNote">Сообщить о ходе выполнения</label>'+
          '<textarea id="mtTaskNote" placeholder="Результат, вопрос или причина задержки…" maxlength="1500" rows="3"></textarea>'+
          '<button type="button" class="mt-action" data-mini-task-action="save-note" data-task-id="'+esc(task.id)+'">💬 Отправить отчёт</button>'+
          '<label for="mtTaskDue">Изменить срок исполнения</label>'+
          '<div class="mt-date-row"><input id="mtTaskDue" type="date" value="'+esc(task.due_date||'')+'">'+
          '<button type="button" class="mt-action" data-mini-task-action="save-due" data-task-id="'+esc(task.id)+'">📅 Сохранить</button></div></div>';
      } else if(!editable){
        card+='<p class="mt-readonly">Просмотр без права изменения поручения другого сотрудника.</p>';
      }
      card+='</div>';
    }
    return card+'</article>';
  }
  function render(data){
    if(!data?.actor)return '<div class="work-message">Не удалось получить поручения.</div>';
    if(scope==='team'&&!data.team)scope='mine';
    var team=scope==='team'&&data.team,rows=team?data.team.tasks:data.my_tasks;
    var counts=team?data.team.summary:data.summary;
    rows=Array.isArray(rows)?rows:[];
    var visible=rows.filter(function(task){
      if(filter==='active')return isActive(task);
      if(filter==='overdue')return task.overdue;
      if(filter==='done')return task.status==='done';
      return true;
    });
    return '<div class="mt-panel">'+
      '<section class="mt-banner"><h2>📋 Поручения</h2>'+
      '<p>'+esc(data.actor.name)+' · задачи из единого реестра ХвостМаркета</p></section>'+
      scopeTabs(data)+
      '<div class="mt-stats">'+statsBox('Активных',counts.active||0)+
      statsBox('Просрочено',counts.overdue||0,'mt-stat-danger')+
      statsBox('Сегодня',counts.today||0)+
      statsBox('В работе',counts.in_progress||0)+'</div>'+
      (team?teamSummary(data.team):'')+
      (error?'<div class="work-message" role="alert">'+esc(error)+'</div>':'')+
      (message?'<div class="work-info" role="status">'+esc(message)+'</div>':'')+
      selector()+
      '<section class="mt-task-list" aria-label="Список поручений">'+
      (visible.length
        ? visible.slice(0,showCount).map(t=>taskCard(t,!team)).join('')
        : '<div class="mt-empty">По выбранному фильтру поручений нет 🐾</div>')+
      '</section>'+
      (visible.length>showCount
        ?'<button type="button" class="work-secondary" data-mini-task-action="more">Показать ещё ('+esc(visible.length-showCount)+')</button>':'')+
      '<p class="work-quiet">Сроки рассчитаны по времени Красноярска. Статусы и отчёты сохраняются в едином журнале поручений.</p>'+
      '</div>';
  }
  function selectedTask(data,id){
    return (data.my_tasks||[]).find(t=>Number(t.id)===Number(id))||null;
  }
  async function handle(button,data,save,repaint){
    var action=button.dataset.miniTaskAction;
    var value=button.dataset.taskValue;
    if(action==='scope'){
      if(value!=='mine'&&value!=='team'||value==='team'&&!data.team)return;
      scope=value;selectedId=null;confirmId=null;showCount=30;error='';message='';
      return repaint();
    }
    if(action==='filter'){
      if(!['active','overdue','done','all'].includes(value))return;
      filter=value;selectedId=null;confirmId=null;showCount=30;error='';message='';
      return repaint();
    }
    if(action==='more'){showCount+=30;return repaint();}
    var id=Number(button.dataset.taskId);
    if(!Number.isSafeInteger(id)||id<1)return;
    if(action==='open'){
      selectedId=selectedId===id?null:id;
      confirmId=null;error='';message='';
      return repaint();
    }
    if(action==='cancel-done'){confirmId=null;return repaint();}
    if(scope==='team'||busy)return;
    var task=selectedTask(data,id);
    if(!task||!isActive(task))return;
    if(action==='done'){selectedId=id;confirmId=id;return repaint();}
    var body={expected_status:task.status,expected_due:task.due_date||null};
    if(action==='work')body.status='in_progress';
    else if(action==='block')body.status='blocked';
    else if(action==='confirm-done')body.status='done';
    else if(action==='save-note'){
      body.comment=String(document.getElementById('mtTaskNote')?.value||'').trim();
      if(!body.comment){error='Напишите результат работы или комментарий.';return repaint();}
    }else if(action==='save-due'){
      body.due_date=String(document.getElementById('mtTaskDue')?.value||'')||null;
      if(!body.due_date&&task.recurrence_rule){
        error='У повторяющегося поручения должен быть срок.';return repaint();
      }
    }else return;
    busy=true;error='';message='';
    try{
      var result=await save(id,body);
      message=result.message||'Изменения сохранены';
      confirmId=null;
      return true;
    }catch(err){
      error=err.message||'Не удалось сохранить изменение.';
      repaint();
      return false;
    }finally{busy=false;}
  }
  window.HvostMiniAppTasks={
    reset:reset, navigation:navigation, overviewCard:overviewCard,
    render:render, handle:handle, setMessage:function(v){message=v;},
  };
})();
