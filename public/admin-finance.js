(function(global){
  'use strict';
  // Loaded only on the first visit to Finance. No background pollers.
  const moneyFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
  const roles=[
    {key:'partner',title:'Грумерам',section:'partners'},
    {key:'owner',title:'Владельцам',section:'owners'},
    {key:'manager',title:'Менеджерам',section:'managers'}
  ];
  const investors=['','Лакомых Алексей','Соколов Виталий','Кучкин Николай'];
  const state={tab:'summary',period:'month',page:1,investor:'',request:0};
  let container=null, request=null, navigate=null;
  function escapeHtml(value){
    return String(value===null||value===undefined?'':value).replace(/[&<>"']/g,function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }
  function rub(value){
    const n=Number(value);
    return value===null||value===undefined||!Number.isFinite(n)?'—':moneyFormat.format(n)+' ₽';
  }
  function text(value){return escapeHtml(value);}
  function kpi(label,value,note){
    return '<div class="kpi-card" style="min-width:0;">'+
      '<div class="kpi-label">'+text(label)+'</div>'+
      '<div class="kpi-value" style="font-size:clamp(1.05rem,3.1vw,1.65rem);overflow-wrap:anywhere">'+text(value)+'</div>'+
      '<div class="kpi-delta" style="font-size:.72rem;line-height:1.45">'+text(note||'')+'</div></div>';
  }
  function frame(){
    const choice=function(tab,label){
      return '<button type="button" class="section-context-tab '+(state.tab===tab?'active':'')+
        '" data-finance-tab="'+tab+'" aria-pressed="'+(state.tab===tab?'true':'false')+'">'+label+'</button>';
    };
    const period=function(key,label){
      return '<button type="button" class="row-btn" data-finance-period="'+key+'"'+
        (state.period===key?' style="background:var(--forest);color:#fff;"':'')+'>'+label+'</button>';
    };
    // Offer individual calendar years from launch, including each new year
    // without future code changes. Match server's Asia/Krasnoyarsk calendar.
    const currentYear=new Date(Date.now()+7*60*60*1000).getUTCFullYear();
    const years=[];
    for(let year=currentYear;year>=2026;year--){
      years.push(period(String(year),year+' год'));
    }
    return '<div class="card" style="margin-bottom:1rem;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:.75rem;">'+
      '<div><div class="card-title" style="margin:0">Финансы ХвостМаркета</div>'+
      '<p style="color:var(--muted);font-size:.78rem;line-height:1.5;margin:.4rem 0 0">'+
      'Главное о продажах, тратах и обязательствах без сложных отчётов.</p></div>'+
      '<div style="display:flex;gap:.4rem;flex-wrap:wrap;">'+
      '<button type="button" class="row-btn" data-finance-action="report-center">Архив отчётов</button>'+
      '<button type="button" class="row-btn" data-finance-action="refresh">↻ Обновить</button></div></div>'+
      '<div role="tablist" aria-label="Финансовые подразделы" style="display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:1rem;">'+
      choice('summary','Сводка')+choice('expenses','Траты')+choice('payouts','Выплаты')+'</div>'+
      (state.tab!=='payouts'?'<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.85rem;align-items:center">'+
        '<span style="font-size:.79rem;color:var(--muted);margin-right:.3rem">Период:</span>'+
        period('month','С начала месяца')+period('30d','Последние 30 дней')+
        years.join('')+period('all','За всё время')+'</div>':'')+
      '<div data-finance-content role="tabpanel" aria-live="polite" style="min-height:90px;">Загружаем…</div>';
  }
  function showSummary(data){
    const p=data.period||{};
    const points=Array.isArray(data.point_rows)?data.point_rows:[];
    const rows=points.length?points.map(function(point){
      return '<tr><td>'+text(point.point_name)+'</td>'+
        '<td class="r">'+text(point.orders_count)+'</td>'+
        '<td class="r">'+text(rub(point.revenue))+'</td></tr>';
    }).join(''):'<tr><td colspan="3">Пока нет зарегистрированных точек.</td></tr>';
    return '<div class="kpi-grid">'+
      kpi('Выручка',rub(data.revenue),'После возвратов')+
      kpi('Внесённые траты',rub(data.expenses),'Расходы, записанные в журнале')+
      kpi('Оплаченные заказы',data.orders_count,'С положительной суммой после возвратов')+
      kpi('Разница до обязательств',rub(data.sales_less_recorded_spending),'Не прибыль и не деньги на счёте')+
      '</div>'+
      '<div class="card"><div class="card-title" style="display:flex;justify-content:space-between;gap:.6rem;flex-wrap:wrap;">'+
      '<span>Продажи по точкам</span><button type="button" class="row-btn" data-finance-action="points">Открыть точки</button></div>'+
      '<p style="font-size:.77rem;color:var(--muted)">Даты: '+text(p.from_day||'с начала учёта')+' — '+text(p.to_day)+
      ' (Красноярск). Неактивные точки учтены в общей выручке, но не включены в таблицу.</p>'+
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>'+
      '<th>Точка</th><th class="r">Заказов</th><th class="r">Выручка</th>'+
      '</tr></thead><tbody>'+rows+'</tbody></table></div></div>'+
      '<p style="font-size:.78rem;line-height:1.5;color:var(--muted);margin-top:.75rem;">'+
      text(data.disclaimer)+'</p>';
  }
  function showExpenses(data){
    const options=investors.map(function(name){
      return '<option value="'+text(name)+'"'+(state.investor===name?' selected':'')+'>'+
        (name?text(name):'Все инвесторы')+'</option>';
    }).join('');
    const rows=(data.expenses||[]).map(function(item){
      return '<tr><td>'+text(item.expense_date)+'</td>'+
        '<td>'+text(item.category)+'</td>'+
        '<td>'+text(item.investor_name||'Не указан')+'</td>'+
        '<td class="r">'+text(rub(item.amount))+'</td></tr>';
    }).join('')||'<tr><td colspan="4">В этом периоде трат не зафиксировано.</td></tr>';
    const earlier=state.page>1?'<button type="button" class="row-btn" data-finance-page="'+(state.page-1)+'">← Назад</button>':'';
    const later=data.has_next?'<button type="button" class="row-btn" data-finance-page="'+(state.page+1)+'">Ещё 20 →</button>':'';
    return '<div class="card" style="margin-bottom:.9rem;">'+
      '<div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center;">'+
      '<div><div style="font-size:.75rem;color:var(--muted)">Внесённые траты за период</div>'+
      '<div style="font-size:1.5rem;font-weight:800">'+text(rub(data.total_amount))+'</div>'+
      '<div style="font-size:.75rem;color:var(--muted)">Записей: '+text(data.total_count)+'</div></div>'+
      '<button type="button" class="row-btn" style="background:var(--forest);color:#fff" '+
      'data-finance-action="business-expenses">＋ Записать трату</button></div></div>'+
      '<div class="card"><div class="card-title">Журнал расходов</div>'+
      '<label style="display:block;margin-bottom:.75rem;font-size:.8rem;">Инвестор '+
      '<select class="pm-select" data-finance-investor style="min-width:190px;margin-left:.4rem">'+options+'</select></label>'+
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>'+
      '<th>Дата</th><th>Назначение</th><th>Кто оплатил</th><th class="r">Сумма</th>'+
      '</tr></thead><tbody>'+rows+'</tbody></table></div>'+
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.6rem;margin-top:1rem">'+
      '<span style="font-size:.77rem;color:var(--muted)">Страница '+text(data.page)+
      ' · по 20 записей, без загрузки документов</span>'+
      '<div style="display:flex;gap:.4rem">'+earlier+later+'</div></div>'+
      '<p style="font-size:.75rem;color:var(--muted);margin-top:.65rem">Документы, редактирование и история доступны в полном журнале.</p>'+
      '<button type="button" class="row-btn" data-finance-action="business-expenses">Открыть полный журнал</button></div>';
  }
  function showPayouts(data){
    const byRole=data.roles||{};
    const summary='<div class="kpi-grid">'+
      kpi('К выплате по заказам',rub(data.pending_total),'Предварительная оценка')+
      kpi('Выплачено за всё время',rub(data.paid_total),'По основным реестрам')+
      kpi('Возвраты на проверке',rub(data.review_total),'Не переводить автоматически')+
      kpi('Плановый день',String(data.next_scheduled_day_of_month||25)+'-е число','Дату платежа уточняйте по реестру')+
      '</div>';
    const lines=roles.map(function(role){
      const item=byRole[role.key]||{};
      return '<tr><td>'+role.title+'</td><td class="r">'+text(rub(item.pending))+'</td>'+
        '<td class="r">'+text(rub(item.paid_total))+'</td>'+
        '<td><button type="button" class="row-btn" data-finance-action="'+role.section+'">Получатели</button></td></tr>';
    }).join('');
    return summary+'<div class="card"><div class="card-title">Начисления по ролям</div>'+
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Кому</th>'+
      '<th class="r">К выплате</th><th class="r">Выплачено</th><th>Реестр</th></tr></thead>'+
      '<tbody>'+lines+'</tbody></table></div>'+
      '<p style="font-size:.78rem;line-height:1.55;color:var(--muted);margin-top:.8rem">'+
      text(data.disclaimer)+'</p>'+
      '<button type="button" class="row-btn" data-finance-action="report-center">'+
      'Отчёты и архив выплат</button></div>';
  }
  async function reload(){
    if(!container||!request)return;
    const current=++state.request;
    container.innerHTML=frame();
    const target=container.querySelector('[data-finance-content]');
    let url=state.tab==='summary'?'/api/admin/finance/summary?period='+state.period:
      state.tab==='expenses'?'/api/admin/finance/expenses?period='+state.period+
        '&page='+state.page+'&investor='+encodeURIComponent(state.investor):
        '/api/admin/finance/payouts';
    try{
      const response=await request(url);
      if(!response.ok){
        const problem=await response.json().catch(function(){return {};});
        throw new Error(problem.error||'Ошибка загрузки финансов');
      }
      const data=await response.json();
      if(current!==state.request)return;
      target.innerHTML=state.tab==='summary'?showSummary(data):
        state.tab==='expenses'?showExpenses(data):showPayouts(data);
    }catch(error){
      if(current!==state.request)return;
      target.innerHTML='<div class="card" role="alert"><strong>Не удалось получить финансы.</strong>'+
        '<p style="color:var(--muted);font-size:.8rem">'+text(error.message||'Ошибка сети')+'</p>'+
        '<button class="row-btn" type="button" data-finance-action="refresh">Повторить</button></div>';
    }
  }
  function mount(options){
    if(!options||!options.root||typeof options.authFetch!=='function'||
       typeof options.navigate!=='function')throw new TypeError('Нужен корневой элемент и действия администратора');
    container=options.root;request=options.authFetch;navigate=options.navigate;
    if(container.dataset.financeBound!=='true'){
      container.dataset.financeBound='true';
      container.addEventListener('click',function(event){
        const target=event.target.closest('button[data-finance-tab],button[data-finance-period],button[data-finance-page],button[data-finance-action]');
        if(!target||!container.contains(target))return;
        if(target.dataset.financeTab){
          state.tab=target.dataset.financeTab;state.page=1;reload();return;
        }
        if(target.dataset.financePeriod){
          state.period=target.dataset.financePeriod;state.page=1;reload();return;
        }
        if(target.dataset.financePage){
          state.page=Number(target.dataset.financePage)||1;reload();return;
        }
        if(target.dataset.financeAction==='refresh'){reload();return;}
        if(navigate)navigate(target.dataset.financeAction);
      });
      container.addEventListener('change',function(event){
        if(!event.target.matches('[data-finance-investor]'))return;
        state.investor=event.target.value;state.page=1;reload();
      });
    }
    return reload();
  }
  global.HvostAdminFinance={mount,formatMoney:rub,escapeHtml};
})(window);
