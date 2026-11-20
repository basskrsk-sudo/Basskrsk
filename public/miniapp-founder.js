// Read-only boardroom view for business founders of ХвостМаркет.
// Explicitly distinct from salon owners and site administrators.
(function(){
  'use strict';

  var period = '30d';
  var names = { '30d': '30 дней', month: 'Этот месяц', year: 'Этот год' };
  var accessToken='';
  var root=typeof document!=='undefined' && document.getElementById ?
    document.getElementById('workPage') : null;
  function clean(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(value) { return Math.round(Number(value) || 0).toLocaleString('ru-RU'); }
  function rub(value) { return n(value) + ' ₽'; }
  function title(label,text) {
    return '<div class="founder-heading"><h2>' + clean(label) + '</h2>' + (text ? '<p>' + clean(text) + '</p>' : '') + '</div>';
  }
  function row(left,right,sub) {
    return '<div class="founder-row"><div><strong>' + clean(left) + '</strong>' +
      (sub ? '<small>' + clean(sub) + '</small>' : '') +
      '</div><b>' + clean(right) + '</b></div>';
  }
  function section(name,html,desc) {
    return '<section class="work-surface founder-section">' + title(name,desc) + html + '</section>';
  }
  function card(label,value,sub) {
    return '<div class="work-stat"><small>' + clean(label) + '</small><strong>' + clean(value) +
      '</strong>' + (sub ? '<span>' + clean(sub) + '</span>' : '') + '</div>';
  }
  function callout(message) { return '<p class="founder-disclaimer">' + clean(message) + '</p>'; }
  function trend(current,previous,pct) {
    if (pct === null || pct === undefined) return 'Для сравнения ещё нет базы';
    return (pct >= 0 ? '+' : '') + pct.toLocaleString('ru-RU') + '% к предыдущему периоду';
  }
  function severity(issue) {
    return issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟠' : 'ℹ️';
  }
  function shortDate(value) {
    var s = String(value || '');
    return s.match(/^\d{4}-\d{2}-\d{2}/) ? s.slice(8,10) + '.' + s.slice(5,7) : 'Без срока';
  }
  function bars(history) {
    var max = Math.max(1,...history.map(function(r){return Number(r.revenue) || 0}));
    return '<div class="founder-bars">' + history.map(function(item) {
      var percent = Math.max(2,Math.round((Number(item.revenue) || 0) / max * 100));
      return '<div class="founder-month"><span class="founder-barbox"><span class="founder-bar" style="height:' +
        percent + '%"></span></span><strong>' + clean(item.month.slice(5)) + '</strong><small>' +
        clean(item.revenue ? n(item.revenue) : '0') + '</small></div>';
    }).join('') + '</div>';
  }
  function render(data,token) {
    accessToken=String(token||'');
    if (!data || !data.founder || !data.sales) {
      return '<div class="work-message">Нет данных собственника. Попробуйте обновить кабинет.</div>';
    }
    var f=data.founder, sales=data.sales, finance=data.finance||{},
        net=data.network||{}, strategy=data.strategy||{},
        cap=data.capital||{}, ops=data.operations||{}, tasks=data.tasks||{};
    var history=sales.last_six_months||[];
    var html='<div class="founder-banner"><span>👑 КАБИНЕТ СОБСТВЕННИКА</span><h1>ХвостМаркет в цифрах</h1>' +
      '<p>' + clean(f.full_name||'Собственник') + ' · доля в бизнесе ' + clean(f.share_percent) +
      '%</p><small>' + clean(f.responsibility||'Стратегические решения') + '</small></div>' +
      '<div class="founder-periods" role="group" aria-label="Отчётный период">' +
      Object.keys(names).map(function(p) {
        return '<button class="founder-period ' + (period===p?'active':'') +
          '" type="button" data-founder-period="' + p + '">' + names[p] + '</button>';
      }).join('') + '</div>';
    html += '<div class="work-stats">' +
      card('Выручка',rub(sales.revenue),trend(sales.revenue,sales.previous.revenue,sales.revenue_change_percent)) +
      card('Оплаченных заказов',n(sales.orders),trend(sales.orders,sales.previous.orders,sales.orders_change_percent)) +
      card('Средний чек',rub(sales.avg_check),'По оплаченным заказам') +
      card('Расчётный результат',rub(finance.estimated_result),'Оценка, не чистая прибыль') +
      '</div>';
    html += section('📈 Выручка по месяцам',bars(history),'Последние шесть календарных месяцев, ₽');
    html += section('🏪 Сеть минимаркетов',
      '<div class="work-stats">' +
      card('Активных точек',n(net.active_points),'Открытых в системе') +
      card('С продажами',n(net.sold_points_period),'За выбранный период') +
      card('Без продаж',n(net.silent_points_count == null ? (net.silent_points||[]).length : net.silent_points_count),'Все действующие точки') +
      card('План 2031',n(strategy.goal_2031),'Активных точек') + '</div>' +
      '<h3 class="founder-subhead">Лидеры по выручке</h3>' +
      ((net.top_points||[]).length
        ? net.top_points.slice(0,5).map(function(p){return row(p.name,rub(p.revenue),n(p.orders)+' заказов');}).join('')
        : '<p class="work-note">Пока нет открытых точек.</p>') +
      ((net.silent_points||[]).length
        ? '<h3 class="founder-subhead">Точки без продаж</h3>' +
          net.silent_points.slice(0,5).map(function(p){return row('⚠️ '+p.name,'0 ₽','Нет продаж за выбранный период');}).join('')
        : ''));
    // Founder-only separate point economics. Public/groomer/salon owner
    // dashboards never receive this internal investment and cost breakdown.
    var pe=data.point_economics||{}, pointRows=pe.points||[], pointSummary=pe.summary||{};
    var equipmentStats='<div class="work-stats">'+
      card('Точек в модели',n(pointSummary.total_points),'Все точки, включая без продаж')+
      card('Оборудование',rub(pointSummary.equipment_cost),'Подтверждённые виды стоек и полок')+
      card('Запуск точек (оценка)',(pointSummary.incomplete_launch_points?'от ':'')+
        rub(pointSummary.estimated_investment),
        'Нет общей сметы 15–20 тыс. ₽ · неполных: '+n(pointSummary.incomplete_launch_points))+
      card('Разовые бонусы менеджерам',rub(pointSummary.launch_manager_bonus),'План запуска')+
      card('Разовые бонусы грумерам',rub(pointSummary.launch_groomer_bonus),'За приглашение точки')+
      card('Разовые бонусы владельцам',rub(pointSummary.launch_owner_bonus),'За приглашение точки')+
      card('Товар на точках по закупке (оценка)',
        pointSummary.inventory_valuation==null?
          'от '+rub(Number(pointSummary.inventory_known_value||0)+Number(pointSummary.inventory_estimated_value||0)):
          rub(pointSummary.inventory_valuation),
        n(pointSummary.inventory_qty)+' ед. · без закупочной цены = 50% розничной')+
      card('Без закупочной цены',n(pointSummary.inventory_missing_cost_qty)+' ед.',
        'Оценка по 50% цены продажи: '+rub(pointSummary.inventory_estimated_value))+
      card('Оплаченная выручка',rub(pointSummary.period_revenue),'За выбранный период')+
      card('Модельный вклад',rub(pointSummary.estimated_period_contribution),'Не бухгалтерская прибыль')+
      '</div>';
    // Desktop: separate columns for one-off manager, groomer and owner bonuses.
    // Mobile: cards keep names visible rather than forcing 1200px horizontal
    // scrolling, which previously hid the salon name on iPhone.
    var pointDisplay=pointRows.map(function(item){
      var incomplete=!!item.estimated_investment_incomplete;
      var total=item.estimated_investment==null?'—':(incomplete?'от ':'')+rub(item.estimated_investment);
      var goods=item.initial_goods_recorded?
        ((item.initial_goods_unpriced_qty?'от ':'')+rub(item.initial_goods_total_estimate)):'—';
      var goodsNote=item.initial_goods_recorded?
        ((item.initial_goods_missing_cost_qty
          ?'В т.ч. оценка 50% розничной: '+rub(item.initial_goods_estimated_value):'По закупочной цене')+
          ' · первоначальная выкладка, без пополнений'):
        'Нет подтверждённых стартовых перемещений';
      var equipment=item.type==null?'Не указано':(item.label||'Не указано');
      var equipmentCost=item.type==null?'—':rub(item.cost);
      var stock=item.inventory_valuation==null?
        'от '+rub(Number(item.inventory_known_value||0)+Number(item.inventory_estimated_value||0)):
        rub(item.inventory_valuation);
      var stockNote=n(item.inventory_qty)+' ед.'+
        (item.inventory_missing_cost_qty?' · по 50% цены '+n(item.inventory_missing_cost_qty)+' ед.':'');
      var payback=incomplete||item.payback_months_at_current_pace==null?'—':
        Number(item.payback_months_at_current_pace).toLocaleString('ru-RU')+' мес.';
      return {
        point:item.point_name||'',equipment:equipment,equipmentCost:equipmentCost,
        goods:goods,goodsNote:goodsNote,
        manager:rub(item.launch_manager_bonus),groomer:rub(item.launch_groomer_bonus),
        owner:rub(item.launch_owner_bonus),total:total,stock:stock,stockNote:stockNote,
        revenue:rub(item.period_revenue),payback:payback,
        note:incomplete?'Оценка неполная: '+(item.type==null?'тип оборудования не указан; ':'')+
          (!item.initial_goods_recorded?'стартовая выкладка не подтверждена; ':'')+
          (item.initial_goods_unpriced_qty?'есть товары без цены; ':''):''
      };
    });
    var econCss='<style>'+
      '.founder-point-econ-mobile{display:none;}'+
      '.founder-point-econ-table{overflow-x:auto;max-height:620px;overflow-y:auto;}'+
      '.founder-point-econ-mobile .econ-card{border:1px solid #dae5de;border-radius:14px;'+
        'padding:14px;margin:12px 0;background:#fff;}'+
      '.founder-point-econ-mobile .econ-card-title{font-weight:700;color:#214938;font-size:1rem;}'+
      '.founder-point-econ-mobile .econ-card-line{display:flex;justify-content:space-between;'+
        'align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid #edf2ee;font-size:.86rem;}'+
      '.founder-point-econ-mobile .econ-card-line span{color:#647b70;flex:1;}'+
      '.founder-point-econ-mobile .econ-card-line strong{text-align:right;flex-shrink:0;}'+
      '.founder-point-econ-mobile .econ-card-note{font-size:.76rem;color:#627b6d;'+
        'line-height:1.4;margin:6px 0 8px;}'+
      '@media(max-width:700px){.founder-point-econ-table{display:none;}'+
        '.founder-point-econ-mobile{display:block;}}'+
      '</style>';
    var equipmentTable=econCss+
      '<label class="work-note" for="founderPointSearch">Поиск точки</label>'+
      '<input type="search" id="founderPointSearch" placeholder="Название салона" '+
      'style="width:100%;max-width:400px;padding:.65rem;border-radius:8px;border:1px solid #CFD9D3;margin:.45rem 0 .8rem;">'+
      '<div class="founder-point-econ-table"><table style="width:100%;min-width:1340px;border-collapse:collapse;font-size:.78rem;">'+
      '<thead style="position:sticky;top:0;background:#fff;"><tr>'+
      '<th style="text-align:left;padding:.55rem;">Точка</th>'+
      '<th style="text-align:left;padding:.55rem;">Оборудование</th>'+
      '<th style="text-align:right;padding:.55rem;">Стартовый товар</th>'+
      '<th style="text-align:right;padding:.55rem;">Бонус менеджеру</th>'+
      '<th style="text-align:right;padding:.55rem;">Бонус грумеру</th>'+
      '<th style="text-align:right;padding:.55rem;">Бонус владельцу</th>'+
      '<th style="text-align:right;padding:.55rem;">Итого запуск</th>'+
      '<th style="text-align:right;padding:.55rem;">Товар сейчас</th>'+
      '<th style="text-align:right;padding:.55rem;">Выручка</th>'+
      '<th style="text-align:right;padding:.55rem;">Окупаемость</th></tr></thead><tbody>'+
      pointDisplay.map(function(item){
        function td(content,align){return '<td style="padding:.6rem;border-top:1px solid #e1e9e4;'+
          'text-align:'+(align||'right')+';">'+content+'</td>';}
        return '<tr data-founder-econ-row data-point-search="'+clean(item.point.toLowerCase())+'">'+
          td('<b>'+clean(item.point)+'</b>','left')+
          td(clean(item.equipment)+'<small style="display:block;color:#647b70;">'+clean(item.equipmentCost)+'</small>','left')+
          td(clean(item.goods)+'<small style="display:block;color:#647b70;">'+clean(item.goodsNote)+'</small>')+
          td(clean(item.manager))+td(clean(item.groomer))+td(clean(item.owner))+
          td('<b>'+clean(item.total)+'</b>'+
            (item.note?'<small style="display:block;color:#647b70;">'+clean(item.note)+'</small>':''))+
          td(clean(item.stock)+'<small style="display:block;color:#647b70;">'+clean(item.stockNote)+'</small>')+
          td(clean(item.revenue))+td(clean(item.payback))+'</tr>';
      }).join('')+'</tbody></table></div>'+
      '<div class="founder-point-econ-mobile">'+pointDisplay.map(function(item){
        function line(label,value){return '<div class="econ-card-line"><span>'+clean(label)+
          '</span><strong>'+clean(value)+'</strong></div>';}
        return '<article class="econ-card" data-founder-econ-row data-point-search="'+clean(item.point.toLowerCase())+'">'+
          '<div class="econ-card-title">'+clean(item.point)+'</div>'+
          '<p class="econ-card-note">'+clean(item.equipment)+'</p>'+
          line('Оборудование',item.equipmentCost)+
          line('Стартовый товар',item.goods)+
          '<p class="econ-card-note">'+clean(item.goodsNote)+'</p>'+
          line('Бонус менеджеру',item.manager)+
          line('Бонус грумеру',item.groomer)+
          line('Бонус владельцу',item.owner)+
          line('Всего на запуск',item.total)+
          (item.note?'<p class="econ-card-note">'+clean(item.note)+'</p>':'')+
          line('Товар сейчас',item.stock)+line('Выручка',item.revenue)+
          line('Окупаемость',item.payback)+'</article>';
      }).join('')+'</div>';
    html += section('🏪 Экономика каждой точки',
      equipmentStats+equipmentTable+callout(pe.inventory_disclaimer||'')+
        callout(pe.assumption||'')+callout(pe.profit_disclaimer||''),
      'Единый расчёт запуска: оборудование, стартовый товар, разовые бонусы. Доступно только собственникам ХвостМаркета.');
    var gates=(strategy.scale_gates||[]);
    var readiness=strategy.scale_decision;
    html += section('🎯 Стратегия: 1000 точек',
      '<div class="founder-target"><strong>' + n(strategy.current_active_30d) +
      ' <span>/ ' + n(strategy.goal_2031) + '</span></strong><div class="founder-track"><i style="width:' +
      Math.min(100,Math.max(0,Math.round((Number(strategy.current_active_30d)||0)/Math.max(1,Number(strategy.goal_2031)||1)*100))) +
      '%"></i></div><small>Активны с продажами за 30 дней</small></div>' +
      '<div class="work-stats">' +
        card('Цель на ' + strategy.plan_year,n(strategy.year_target),'По действующей модели') +
        card('Прогноз на конец года',n(strategy.forecast_year_end),'По текущему темпу') +
        card('Нужный темп',n(strategy.required_launches_per_month)+'/мес.','Для достижения плана') +
        card('Текущий темп',n(strategy.current_launches_per_month)+'/мес.','Открытия за последние 90 дней') +
      '</div>' +
      '<p class="founder-readiness">' + (readiness==='go'?'🟢':readiness==='stop'?'🔴':'🟠') +
      ' Решение о расширении: ' + clean(readiness==='go'?'Условия позволяют масштабировать':readiness==='stop'?'Нужно устранить ограничения':'Проверить показатели') +
      '</p>' +
      (gates.length?gates.slice(0,6).map(function(g){
        return row((g.status==='red'?'🔴 ':g.status==='yellow'?'🟠 ':'🟢 ')+g.name,
          g.actual==null?'—':String(g.actual)+(g.unit||''),'Целевое значение: '+g.target+(g.unit||''));
      }).join(''):'') +
      callout(strategy.note||'Прогноз зависит от принятых допущений.'));
    var bsc=data.bsc||null;
    if (bsc) {
      html += section('🧭 Система показателей BSC',
        '<div class="work-stats">'+card('Общий индекс BSC',
          bsc.overall_score==null?'—':n(bsc.overall_score)+'/100',
          bsc.period||'Предыдущая завершённая неделя')+
          card('Готовность к расширению',bsc.readiness||'Не оценена','По BSC')+
        '</div>'+
        (bsc.perspectives||[]).map(function(p) {
          return row((p.status==='red'?'🔴 ':p.status==='yellow'?'🟠 ':'🟢 ')+p.name,
            p.score==null?'—':n(p.score)+'/100',
            (p.weakest_kpis||[]).length?'В зоне внимания: '+p.weakest_kpis.join(', '):'');
        }).join(''),
        'Оценка четырёх направлений: финансы, клиенты, процессы и команда');
    }
    html += section('💰 Финансы и расходы',
      '<div class="work-stats">' +
        card('Учтённые расходы',rub(finance.manual_expenses),'Внесены в журнал') +
        card('Вознаграждения партнёрам',rub(
          (finance.partner_commission_est||0)+(finance.manager_commission_est||0)+(finance.salon_owner_commission_est||0)),
          'Расчётное начисление') +
        card('Налог, оценка',rub(finance.tax_est),'По ставке модели') +
        card('Эквайринг, оценка',rub(finance.acquiring_est),'По ставке модели') +
      '</div>' +
      '<h3 class="founder-subhead">Структура учтённых расходов</h3>' +
      ((finance.expenses_by_category||[]).length
        ? finance.expenses_by_category.slice(0,8).map(function(x){return row(x.name,rub(x.amount));}).join('')
        : '<p class="work-note">В выбранном периоде расходы не внесены.</p>') +
      (finance.incomplete_commission_orders
        ? '<p class="founder-disclaimer">Часть заказов не имеет сохранённой ставки партнёра: ' + n(finance.incomplete_commission_orders) + '.</p>' : '') +
      callout(finance.disclaimer||'Расчётный результат не равен остаткам на счетах.'));
    html += section('🚦 Риски и контроль',
      '<div class="founder-risk-count">' + n((ops.summary||{}).critical) +
      ' критических · ' + n((ops.summary||{}).warning) + ' предупреждений</div>' +
      ((ops.issues||[]).length
        ? ops.issues.filter(function(x){return x.count>0;}).slice(0,8).map(function(i){
          return row(severity(i)+' '+i.title,n(i.count),i.summary);
        }).join('') || '<p class="work-note">Активных сигналов нет.</p>'
        : '<p class="work-note">Активных сигналов нет.</p>'));
    html += section('✅ Мои поручения и инициативы',
      '<div class="work-stats">' +
      card('Мои открытые задачи',n(tasks.my_active),'По реестру поручений') +
      card('Просрочено',n(tasks.my_overdue),'Требуют внимания') +
      '</div>' +
      ((tasks.items||[]).length
        ? tasks.items.slice(0,7).map(function(t){
          return row((t.overdue?'⚠️ ':'')+t.title,
            shortDate(t.due_date),t.status);
        }).join('') : '<p class="work-note">Открытых персональных поручений нет.</p>') +
      ((tasks.initiatives||[]).length
        ? '<h3 class="founder-subhead">Стратегические инициативы</h3>' +
          tasks.initiatives.slice(0,5).map(function(t){return row(t.title,shortDate(t.due_date),t.status);}).join('') : ''));
    html += section('🤝 Капитал и доли',
      '<div class="work-stats">' +
      card('Моя доля в ХвостМаркете',f.share_percent+'%','Договорённость собственников') +
      card('Плановый вклад по доле',rub(cap.my_planned_share),'Из общей цели 1 млн ₽') +
      card('Мои оплаченные расходы',rub(cap.personal_expenses_recorded),'Из журнала расходов') +
      card('Факт внесённого капитала','—','Пока не подтверждён') + '</div>' +
      '<h3 class="founder-subhead">Расходы, записанные на инвесторов</h3>' +
      ((cap.by_investor||[]).length
        ? cap.by_investor.map(function(i){return row(i.name,rub(i.amount),n(i.entries)+' операций');}).join('')
        : '<p class="work-note">Пока нет записанных расходов.</p>') +
      callout(cap.note||'Расходы не являются подтверждением внесения доли.'));
    var myExpenses=(cap.personal_expenses||[]);
    var evidence=window.HvostExpenseEvidence;
    html += section('🧾 Мои траты и подтверждающие документы',
      '<p class="work-note">К своим тратам можно приложить чеки, счета, акты и фотографии. '+
      'Поддерживаются PDF, JPG, PNG, WebP, HEIC, Word, Excel, PowerPoint и другие форматы '+
      '(до 10 МБ за файл; не более 12 файлов на трату). Документы доступны только вам и администраторам.</p>'+
      (myExpenses.length?myExpenses.slice(0,50).map(function(exp){
        return '<details style="border-bottom:1px solid #e1e9e0;padding:11px 0">'+
          '<summary style="cursor:pointer;line-height:1.5"><b>'+clean(exp.category)+'</b>'+
          '<span style="float:right;font-weight:700">'+rub(exp.amount)+'</span>'+
          '<small style="display:block;color:#718378">'+clean(exp.expense_date)+'</small></summary>'+
          '<div style="margin-top:12px">'+(evidence?evidence.fileRows(exp.documents||[],{
            allowDelete:false,
          }):'<span>Документы недоступны</span>')+'</div>'+
          '<label style="display:inline-block;margin-top:11px;padding:8px 12px;border:1px solid #b6d4bf;'+
            'border-radius:10px;cursor:pointer;font-weight:700">'+
            '📎 Прикрепить файлы'+
            '<input type="file" data-founder-expense-upload="'+Number(exp.id)+'" '+
              'multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.pptx,.odt,.ods,.txt,.csv,.xml,.rtf,.zip" '+
              'style="display:none"></label>'+
          '<div id="founder-expense-message-'+Number(exp.id)+'" style="font-size:12px;margin-top:5px" aria-live="polite"></div>'+
          '</details>';
      }).join(''):
      '<p class="work-note">Пока нет расходов, записанных на вас. Администратор может добавить их в журнале трат.</p>')+
      (myExpenses.length>=100?'<p class="work-note">Показана часть последних трат. Полный журнал доступен администратору.</p>':''));

    html += '<p class="founder-updated">Обновлено: ' + clean(data.updated_at ? data.updated_at.slice(0,16).replace('T',' ')+' UTC' : '—') +
      '. Данные из системы ХвостМаркет.</p>';
    return html;
  }
  if (root) {
    root.addEventListener('input',function(event){
      if(!event.target||event.target.id!=='founderPointSearch')return;
      var key=String(event.target.value||'').trim().toLocaleLowerCase('ru-RU');
      root.querySelectorAll('[data-founder-econ-row]').forEach(function(tr){
        tr.style.display=(tr.dataset.pointSearch||'').toLocaleLowerCase('ru-RU').includes(key)?'':'none';
      });
    });
    root.addEventListener('change',async function(event){
      var input=event.target;
      if(!input||!input.hasAttribute||!input.hasAttribute('data-founder-expense-upload'))return;
      if(!root.querySelector('.founder-banner')||!accessToken)return;
      var id=Number(input.getAttribute('data-founder-expense-upload'));
      var status=document.getElementById('founder-expense-message-'+id);
      if(!window.HvostExpenseEvidence||!id||!input.files||!input.files.length)return;
      input.disabled=true;
      try{
        await window.HvostExpenseEvidence.upload(id,input.files,accessToken,function(message){
          if(status)status.textContent=message;
        });
        if(status)status.textContent='✅ Документы добавлены.';
        if(window.HvostMiniAppWork && window.HvostMiniAppWork.refresh)
          await window.HvostMiniAppWork.refresh();
      }catch(error){
        if(status)status.textContent='⚠️ '+error.message+
          '. Уже загруженные документы сохранены; обновите кабинет и проверьте список.';
      }finally{input.disabled=false;input.value='';}
    });
    root.addEventListener('click',async function(event){
      var button=event.target && event.target.closest &&
        event.target.closest('[data-expense-file-action="download"]');
      if(!button||!root.querySelector('.founder-banner')||!accessToken ||
         !window.HvostExpenseEvidence)return;
      event.preventDefault();
      button.disabled=true;
      try{
        await window.HvostExpenseEvidence.download(
          Number(button.dataset.expenseDocId),button.dataset.expenseDocName,accessToken);
      }catch(error){alert('Не удалось скачать файл: '+error.message);}
      finally{button.disabled=false;}
    });
  }
  window.HvostBusinessFounder = {
    render:render,
    getPeriod:function(){return period;},
    setPeriod:function(value){if(Object.prototype.hasOwnProperty.call(names,value))period=value;},
  };
})();
