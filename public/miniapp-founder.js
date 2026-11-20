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
  var orderDrilldown=null;
  function money(value) {
    var num=Number(value)||0;
    return num.toLocaleString('ru-RU',{maximumFractionDigits:2,
      minimumFractionDigits:Math.abs(num-Math.round(num))>0.0001?2:0})+' ₽';
  }
  function orderDate(value) {
    var time=new Date(String(value||'').replace(' ','T')+'Z');
    return Number.isNaN(time.getTime()) ? String(value||'') :
      time.toLocaleString('ru-RU',{timeZone:'Asia/Krasnoyarsk',
        day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function detailRow(label,value,highlight) {
    return '<div class="econ-card-line'+(highlight?' econ-order-profit':'')+'"><span>'+
      clean(label)+'</span><strong>'+clean(value)+'</strong></div>';
  }
  function orderDetailMarkup(item) {
    var list=(item.items||[]).map(function(p){
      return '<div class="econ-order-item"><b>'+clean(p.name||'Товар')+
        (p.weight?' · '+clean(p.weight):'')+'</b><small>'+
        clean(String(p.qty)+' шт. × '+money(p.unit_cost))+
        (p.cost_estimated?' · себестоимость 50% розничной':'')+
        ' = '+clean(money(p.net_cost))+' (после возвратов)</small></div>';
    }).join('');
    var status=Number(item.refund_amount)>0?
      '<p class="econ-card-note">Возврат клиенту: '+clean(money(item.refund_amount))+
      (item.refund_status==='refunded'?' · полный':' · частичный')+'</p>':'';
    var notes=(item.items_missing?
      '<p class="econ-card-note">⚠️ Нет состава заказа: себестоимость оценена как 50% оплаченной суммы.</p>':'')+
      (Number(item.partner_refund_hold||0)+Number(item.owner_refund_hold||0)>0?
      '<p class="econ-card-note">⚠️ Возврат: невыплаченные комиссии требуют сверки перед выплатой.</p>':'');
    return '<article class="econ-order"><h4>'+clean(item.number||'Заказ')+
      ' <small>'+clean(orderDate(item.created_at))+' (Красноярск)</small></h4>'+
      (item.partner_name?'<p class="econ-card-note">Грумер: '+clean(item.partner_name)+'</p>':'')+
      '<div class="econ-order-products">'+(list||'<small>Нет сохранённого состава.</small>')+'</div>'+
      detailRow('Сумма заказа',money(item.total))+status+
      detailRow('Оплаченная выручка',money(item.revenue))+
      detailRow('Себестоимость проданного', '−'+money(item.cogs_est))+
      detailRow('Грумеру ('+money(item.partner_rate_percent).replace(' ₽','%')+')','−'+money(item.partner_total))+
      (item.partner_total?'<p class="econ-card-note">Грумер: выплачено '+
        clean(money(item.partner_paid))+'; ожидает '+clean(money(item.partner_pending))+'</p>':'')+
      detailRow('Владельцу ('+money(item.owner_rate_percent).replace(' ₽','%')+')','−'+money(item.owner_total))+
      (item.owner_total?'<p class="econ-card-note">Владельцу: выплачено '+
        clean(money(item.owner_paid))+'; ожидает '+clean(money(item.owner_pending))+'</p>':'')+
      detailRow('Менеджер (модель)', '−'+money(item.manager_est))+
      detailRow('Налог 7%', '−'+money(item.tax_est))+
      detailRow('Эквайринг (модель)', '−'+money(item.acquiring_est))+
      detailRow('Логистика (модель)', '−'+money(item.logistics_est))+
      detailRow('Списания (модель)', '−'+money(item.writeoffs_est))+
      detailRow('IT и прочие бонусы (модель)', '−'+money(item.it_est))+
      detailRow('Остаётся ХвостМаркету (оценка)',money(item.founder_profit_est),true)+
      notes+'</article>';
  }
  function closePointOrders(){
    orderDrilldown=null;
    if(!root)return;
    var panel=root.querySelector('#founderPointOrderDetails');
    if(panel)panel.hidden=true;
  }
  async function loadPointOrders(view) {
    if(!root||!view||view.loading||!accessToken)return;
    var panel=root.querySelector('#founderPointOrderDetails');
    if(!panel)return;
    var target=panel.querySelector('[data-founder-order-body]');
    var more=panel.querySelector('[data-founder-order-more]');
    if(!target||!more)return;
    view.loading=true;
    more.hidden=true;
    if(view.page===0)target.innerHTML='<p class="econ-card-note">Загружаем заказы…</p>';
    try{
      var query='?point_id='+encodeURIComponent(view.pointId)+
        '&period='+encodeURIComponent(view.period)+'&page='+view.page;
      var response=await fetch('/api/business-founder/point-orders'+query,{
        headers:{Authorization:'Bearer '+accessToken},cache:'no-store'});
      if(!response.ok)throw new Error(response.status===401?
        'Сессия завершилась. Войдите в кабинет повторно.':'Не удалось загрузить заказы ('+response.status+').');
      var payload=await response.json();
      if(orderDrilldown!==view||!panel.isConnected)return;
      var rows=(payload.orders||[]).map(orderDetailMarkup).join('');
      if(view.page===0)target.innerHTML=rows||'<p class="econ-card-note">Нет оплаченных продаж за выбранный период.</p>';
      else target.insertAdjacentHTML('beforeend',rows);
      view.page++;
      more.hidden=!payload.has_more;
      var note=panel.querySelector('[data-founder-order-note]');
      if(note)note.textContent=payload.disclaimer||'';
    }catch(error){
      if(orderDrilldown===view&&panel.isConnected)
        target.insertAdjacentHTML('beforeend','<p class="econ-card-note">'+
          clean(error.message||'Ошибка загрузки')+'</p>');
    }finally{
      view.loading=false;
    }
  }
  function openPointOrders(pointId,name) {
    if(!root||!accessToken||!pointId)return;
    var panel=root.querySelector('#founderPointOrderDetails');
    if(!panel)return;
    orderDrilldown={pointId:String(pointId),period:period,page:0,loading:false};
    var heading=panel.querySelector('[data-founder-order-title]');
    if(heading)heading.textContent='Продажи: '+String(name||pointId);
    var note=panel.querySelector('[data-founder-order-note]');
    if(note)note.textContent='';
    panel.hidden=false;
    var scroll=panel.querySelector('.founder-order-dialog');
    if(scroll)scroll.scrollTop=0;
    loadPointOrders(orderDrilldown);
  }
  function render(data,token) {
    accessToken=String(token||'');
    orderDrilldown=null;
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
      card('Налог 7%',rub(pointSummary.period_tax_est),'По каждой оплаченной продаже за вычетом возвратов')+
      card('Модельный вклад после налога',rub(pointSummary.estimated_period_contribution),
        'Оценка по типовым ставкам, не бухгалтерская прибыль')+
      card('Прибыль собственников (оценка)',rub(pointSummary.founder_profit_est),
        'После комиссий и переменных расходов, без общесетевых затрат')+
      card('Грумерам выплачено',rub(pointSummary.partner_paid),
        'По продажам выбранного периода · реестр выплат')+
      card('Грумерам к выплате',rub(pointSummary.partner_pending),
        'По продажам периода, без сумм на сверке возвратов')+
      card('Владельцам выплачено',rub(pointSummary.owner_paid),
        'По продажам периода · реестр выплат')+
      card('Владельцам к выплате',rub(pointSummary.owner_pending),
        'По продажам периода, без сумм на сверке возвратов')+
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
        point:item.point_name||'',pointId:String(item.point_id||''),equipment:equipment,equipmentCost:equipmentCost,
        goods:goods,goodsNote:goodsNote,
        manager:rub(item.launch_manager_bonus),groomer:rub(item.launch_groomer_bonus),
        owner:rub(item.launch_owner_bonus),total:total,stock:stock,stockNote:stockNote,
        revenue:rub(item.period_revenue),tax:rub(item.period_tax_est),
        contribution:rub(item.estimated_period_contribution),
        founderProfit:rub(item.founder_profit_est),
        partnerPaid:rub(item.partner_paid),partnerPending:rub(item.partner_pending),
        ownerPaid:rub(item.owner_paid),ownerPending:rub(item.owner_pending),
        refundReview:rub(Number(item.partner_refund_hold||0)+Number(item.owner_refund_hold||0)),
        profitNote:Number(item.profit_missing_item_orders||0)>0?
          'Без состава заказа: оценка 50% выручки для '+n(item.profit_missing_item_orders)+' продаж.':'',
        payback:payback,
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
      '.founder-order-open{margin:8px 0;min-height:38px;padding:7px 12px;'+
        'color:#176b4f;background:#edf8f1;border:1px solid #b8d6c5;border-radius:8px;font-weight:700;}'+
      '.founder-order-modal{position:fixed;inset:0;z-index:30001;'+
        'background:rgba(15,38,27,.55);display:flex;justify-content:center;'+
        'align-items:stretch;padding:12px;}'+
      '.founder-order-modal[hidden]{display:none!important;}'+
      '.founder-order-dialog{background:#fff;max-width:680px;width:100%;margin:auto;'+
        'max-height:95vh;overflow-y:auto;overscroll-behavior:contain;border-radius:17px;'+
        'padding:16px;box-sizing:border-box;color:#213f32;}'+
      '.econ-order{border:1px solid #dbe7df;border-radius:12px;padding:13px;'+
        'margin:12px 0;background:#fff;}'+
      '.econ-order h4{margin:0 0 10px;font-size:1.05rem;}'+
      '.econ-order h4 small{display:block;font-size:.76rem;color:#648074;font-weight:400;margin-top:4px;}'+
      '.econ-order-item{padding:5px 0;border-bottom:1px solid #e6ede8;}'+
      '.econ-order-item b{display:block;font-size:.85rem;}'+
      '.econ-order-item small{display:block;color:#627b6d;}'+
      '.econ-order-profit{color:#165d40;font-weight:700;background:#f1f9f4;padding:9px 4px!important;}'+
      '.founder-order-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;}'+
      '@media(max-width:700px){.founder-point-econ-table{display:none;}'+
        '.founder-point-econ-mobile{display:block;}}'+
      '</style>';
    var equipmentTable=econCss+
      '<label class="work-note" for="founderPointSearch">Поиск точки</label>'+
      '<input type="search" id="founderPointSearch" placeholder="Название салона" '+
      'style="width:100%;max-width:400px;padding:.65rem;border-radius:8px;border:1px solid #CFD9D3;margin:.45rem 0 .8rem;">'+
      '<div class="founder-point-econ-table"><table style="width:100%;min-width:1970px;border-collapse:collapse;font-size:.78rem;">'+
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
      '<th style="text-align:right;padding:.55rem;">Налог 7%</th>'+
      '<th style="text-align:right;padding:.55rem;">Вклад после налога</th>'+
      '<th style="text-align:right;padding:.55rem;">Грумеру выплачено</th>'+
      '<th style="text-align:right;padding:.55rem;">Грумеру к выплате</th>'+
      '<th style="text-align:right;padding:.55rem;">Владельцу выплачено</th>'+
      '<th style="text-align:right;padding:.55rem;">Владельцу к выплате</th>'+
      '<th style="text-align:right;padding:.55rem;">Прибыль собственников (оценка)</th>'+
      '<th style="text-align:right;padding:.55rem;">Окупаемость</th></tr></thead><tbody>'+
      pointDisplay.map(function(item){
        function td(content,align){return '<td style="padding:.6rem;border-top:1px solid #e1e9e4;'+
          'text-align:'+(align||'right')+';">'+content+'</td>';}
        return '<tr data-founder-econ-row data-point-search="'+clean(item.point.toLowerCase())+'">'+
          td('<b>'+clean(item.point)+'</b><button type="button" class="founder-order-open" '+
            'data-founder-point-orders-open="'+clean(item.pointId)+'" data-founder-point-name="'+clean(item.point)+
            '">Чеки и прибыль</button>','left')+
          td(clean(item.equipment)+'<small style="display:block;color:#647b70;">'+clean(item.equipmentCost)+'</small>','left')+
          td(clean(item.goods)+'<small style="display:block;color:#647b70;">'+clean(item.goodsNote)+'</small>')+
          td(clean(item.manager))+td(clean(item.groomer))+td(clean(item.owner))+
          td('<b>'+clean(item.total)+'</b>'+
            (item.note?'<small style="display:block;color:#647b70;">'+clean(item.note)+'</small>':''))+
          td(clean(item.stock)+'<small style="display:block;color:#647b70;">'+clean(item.stockNote)+'</small>')+
          td(clean(item.revenue))+td(clean(item.tax))+td(clean(item.contribution))+
          td(clean(item.partnerPaid))+td(clean(item.partnerPending))+
          td(clean(item.ownerPaid))+td(clean(item.ownerPending))+
          td('<b>'+clean(item.founderProfit)+'</b>'+
            (item.refundReview!=='0 ₽'?'<small style="display:block;color:#9a6500;">К сверке по возвратам: '+clean(item.refundReview)+'</small>':'')+
            (item.profitNote?'<small style="display:block;color:#647b70;">'+clean(item.profitNote)+'</small>':''))+
          td(clean(item.payback))+'</tr>';
      }).join('')+'</tbody></table></div>'+
      '<div class="founder-point-econ-mobile">'+pointDisplay.map(function(item){
        function line(label,value){return '<div class="econ-card-line"><span>'+clean(label)+
          '</span><strong>'+clean(value)+'</strong></div>';}
        return '<article class="econ-card" data-founder-econ-row data-point-search="'+clean(item.point.toLowerCase())+'">'+
          '<div class="econ-card-title">'+clean(item.point)+'</div>'+
          '<button type="button" class="founder-order-open" data-founder-point-orders-open="'+
            clean(item.pointId)+'" data-founder-point-name="'+clean(item.point)+'">Чеки и прибыль по продажам</button>'+
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
          line('Налог 7%',item.tax)+line('Вклад после налога',item.contribution)+
          line('Грумеру выплачено',item.partnerPaid)+
          line('Грумеру к выплате',item.partnerPending)+
          line('Владельцу выплачено',item.ownerPaid)+
          line('Владельцу к выплате',item.ownerPending)+
          line('Прибыль собственников (оценка)',item.founderProfit)+
          (item.refundReview!=='0 ₽'?'<p class="econ-card-note">Возвраты: на сверке '+clean(item.refundReview)+'</p>':'')+
          (item.profitNote?'<p class="econ-card-note">'+clean(item.profitNote)+'</p>':'')+
          line('Окупаемость',item.payback)+'</article>';
      }).join('')+'</div>';
    var orderDialog='<div id="founderPointOrderDetails" class="founder-order-modal" hidden>'+
      '<div class="founder-order-dialog" role="dialog" aria-modal="true" aria-labelledby="founderOrderTitle">'+
      '<div class="founder-order-toolbar"><h3 id="founderOrderTitle" data-founder-order-title>Продажи по заказам</h3>'+
      '<button type="button" class="founder-order-open" data-founder-order-close>Закрыть ✕</button></div>'+
      '<div data-founder-order-body></div>'+
      '<button type="button" class="founder-order-open" data-founder-order-more hidden>Показать ещё 20 заказов</button>'+
      '<p class="econ-card-note" data-founder-order-note></p></div></div>';
    html += section('🏪 Экономика каждой точки',
      equipmentStats+equipmentTable+callout(pe.inventory_disclaimer||'')+
        callout(pe.assumption||'')+callout(pe.profit_disclaimer||''),
      'Выплачено и к выплате: по заказам выбранного периода, независимо от даты перечисления. Бонусы за приглашение точки выше показаны отдельно и не входят в регулярную комиссию. Прибыль собственников — расчётная после себестоимости, налога 7%, начисленных комиссий и переменных расходов, без общесетевых накладных. Только для собственников ХвостМаркета.');
    html += orderDialog;
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
      var control=event.target && event.target.closest && event.target.closest(
        '[data-founder-point-orders-open],[data-founder-order-close],[data-founder-order-more]');
      if(control){
        event.preventDefault();
        if(control.hasAttribute('data-founder-order-close'))return closePointOrders();
        if(control.hasAttribute('data-founder-order-more'))return loadPointOrders(orderDrilldown);
        if(control.hasAttribute('data-founder-point-orders-open')){
          return openPointOrders(control.dataset.founderPointOrdersOpen,
            control.dataset.founderPointName);
        }
      }
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
