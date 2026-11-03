// Read-only boardroom view for business founders of ХвостМаркет.
// Explicitly distinct from salon owners and site administrators.
(function(){
  'use strict';

  var period = '30d';
  var names = { '30d': '30 дней', month: 'Этот месяц', year: 'Этот год' };
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
  function render(data) {
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
    html += '<p class="founder-updated">Обновлено: ' + clean(data.updated_at ? data.updated_at.slice(0,16).replace('T',' ')+' UTC' : '—') +
      '. Данные из системы ХвостМаркет.</p>';
    return html;
  }
  window.HvostBusinessFounder = {
    render:render,
    getPeriod:function(){return period;},
    setPeriod:function(value){if(Object.prototype.hasOwnProperty.call(names,value))period=value;},
  };
})();
