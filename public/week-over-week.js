'use strict';

// Live, read-only week-over-week business comparison. No PDF generation,
// Telegram publishing or background polling takes place in this section.
let weekComparisonOffset=0;
let weekComparisonRequest=0;

function wcEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function wcNum(value,decimals=0) {
  return Number(value||0).toLocaleString('ru-RU',{
    minimumFractionDigits:decimals,maximumFractionDigits:decimals,
  });
}
function wcMoney(value) {return wcNum(value)+' ₽';}
function wcDifference(value) {
  const n=Number(value||0);
  return (n>0?'+':'')+wcNum(n);
}
function wcDelta(change,lowerIsBetter=false) {
  const delta=Number(change?.delta||0);
  let label;
  if(change?.percent == null)label='нет базы сравнения';
  else label=(change.percent>0?'+':'')+wcNum(change.percent,1)+'%';
  const good=lowerIsBetter?delta<0:delta>0;
  const bad=lowerIsBetter?delta>0:delta<0;
  const color=good?'#237447':bad?'#B83D3D':'var(--muted)';
  return '<span style="font-size:.79rem;font-weight:650;color:'+color+'">'+
    wcEsc(label)+'</span>';
}
function wcMetric(label,data,key,{money=false,lowerIsBetter=false,suffix=''}={}) {
  const metric=data.changes?.[key]||{};
  const number=Number(data.current?.[key]||0);
  const value=money?wcMoney(number):wcNum(number,key==='conversion_pct'?1:0)+suffix;
  return '<div class="kpi-card" style="min-width:0">'+
    '<div class="kpi-label">'+wcEsc(label)+'</div>'+
    '<div class="kpi-value" style="font-size:clamp(1.2rem,2.8vw,1.9rem)">'+wcEsc(value)+'</div>'+
    '<div class="kpi-delta" style="display:flex;gap:.35rem;flex-wrap:wrap">'+
       wcDelta(metric,lowerIsBetter) +
       '<span style="font-size:.75rem;color:var(--muted)">('+wcEsc(money?wcMoney(metric.previous):wcNum(metric.previous,key==='conversion_pct'?1:0)+suffix)+
       ' ранее)</span></div></div>';
}
function wcRows(name,rows,renderRow,colspan) {
  const target=document.getElementById(name);
  if(!target)return;
  target.innerHTML=rows.length?rows.map(renderRow).join(''):
    '<tr><td colspan="'+colspan+'" style="text-align:center;padding:1.1rem;color:var(--muted)">Нет данных за выбранные недели</td></tr>';
}
function wcBars(data) {
  const target=document.getElementById('wc-daily');
  if(!target)return;
  const names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const daily=data.daily||[];
  const top=Math.max(1,...daily.flatMap(x=>[Number(x.current||0),Number(x.previous||0)]));
  const bars=daily.map(d=>{
    const c=Math.max(2,Math.round(Number(d.current||0)/top*126));
    const p=Math.max(2,Math.round(Number(d.previous||0)/top*126));
    const cur='Нов.: '+d.date+' · '+wcMoney(d.current)+' · '+wcNum(d.current_orders)+' заказов';
    const prev='Ранее: '+d.previous_date+' · '+wcMoney(d.previous)+' · '+wcNum(d.previous_orders)+' заказов';
    return '<div style="min-width:68px;flex:1;display:flex;flex-direction:column;align-items:center;gap:5px" role="group" aria-label="'+wcEsc(names[d.weekday])+'">'+
      '<div style="height:135px;display:flex;align-items:end;justify-content:center;gap:5px">'+
      '<div title="'+wcEsc(prev)+'" aria-label="'+wcEsc(prev)+'" style="width:24px;height:'+p+'px;border-radius:4px 4px 0 0;background:#B9CBC1"></div>'+
      '<div title="'+wcEsc(cur)+'" aria-label="'+wcEsc(cur)+'" style="width:24px;height:'+c+'px;border-radius:4px 4px 0 0;background:#2D7655"></div></div>'+
      '<b style="font-size:.8rem">'+wcEsc(names[d.weekday])+'</b>'+
      '<small style="text-align:center;color:var(--muted);font-size:.7rem">'+wcEsc(wcNum(d.current))+'</small></div>';
  }).join('');
  target.innerHTML='<div style="display:flex;gap:1rem;align-items:center;margin-bottom:.6rem;font-size:.79rem;flex-wrap:wrap">'+
    '<span><span style="display:inline-block;width:10px;height:10px;background:#2D7655;border-radius:2px"></span> Сравниваемая неделя</span>'+
    '<span><span style="display:inline-block;width:10px;height:10px;background:#B9CBC1;border-radius:2px"></span> Предыдущая неделя</span></div>'+
    '<div style="display:flex;gap:8px;min-width:550px;align-items:end">'+bars+'</div>';
}
function wcFillCities(cities,selected) {
  const select=document.getElementById('wc-city');
  if(!select)return;
  const current=selected||'';
  select.innerHTML='<option value="">Вся сеть</option>';
  (cities||[]).forEach(city=>{
    const opt=document.createElement('option');
    opt.value=city.id;
    opt.textContent=city.name;
    select.appendChild(opt);
  });
  select.value=current;
}
function wcRender(data) {
  document.getElementById('wc-period').textContent=
    data.period.start_local+' — '+data.period.end_local+
    '  против  '+data.period.previous_start_local+' — '+data.period.previous_end_local;
  const next=document.getElementById('wc-next');
  if(next)next.disabled=weekComparisonOffset===0;
  const kpis=document.getElementById('wc-kpis');
  if(kpis)kpis.innerHTML=[
    wcMetric('Выручка',data,'revenue',{money:true}),
    wcMetric('Оплаченные заказы',data,'paid_orders'),
    wcMetric('Средний чек',data,'avg_check',{money:true}),
    wcMetric('Покупателей',data,'customers'),
    wcMetric('Точек с продажами',data,'points_with_sales'),
    wcMetric('Расходы (внесённые)',data,'expenses',{money:true,lowerIsBetter:true}),
    wcMetric('Расчётный результат*',data,'estimated_profit',{money:true}),
    wcMetric('Конверсия в оплату',data,'conversion_pct',{suffix:'%'}),
    wcMetric('Возвраты',data,'refunds',{money:true,lowerIsBetter:true}),
  ].join('');
  wcBars(data);
  const pts=data.points||[];
  const count=document.getElementById('wc-points-count');
  if(count)count.textContent='· '+wcNum(data.points_total||pts.length)+' точек';
  wcRows('wc-points',pts,p=>{
    const change={delta:p.delta,percent:p.percent};
    return '<tr><td>'+wcEsc(p.name)+'</td>'+
      '<td class="r">'+wcMoney(p.current)+'</td>'+
      '<td class="r">'+wcMoney(p.previous)+'</td>'+
      '<td class="r">'+wcEsc(wcDifference(p.delta))+' ₽</td>'+
      '<td class="r">'+wcDelta(change)+'</td>'+
      '<td class="r">'+wcNum(p.current_orders)+' / '+wcNum(p.previous_orders)+'</td></tr>';
  },6);
  wcRows('wc-products',data.products||[],p=>
    '<tr><td>'+wcEsc(p.name)+' <small style="color:var(--muted)">'+wcEsc(p.weight)+'</small></td>'+
    '<td class="r">'+wcNum(p.current_units)+'</td>'+
    '<td class="r">'+wcNum(p.previous_units)+'</td>'+
    '<td class="r">'+wcDelta({delta:p.current_units-p.previous_units,percent:p.units_change})+'</td>'+
    '<td class="r">'+wcMoney(p.current_revenue_estimate)+'</td></tr>',5);
  wcRows('wc-expenses',data.expense_categories||[],e=>
    '<tr><td>'+wcEsc(e.name)+'</td><td class="r">'+wcMoney(e.current)+'</td>'+
    '<td class="r">'+wcMoney(e.previous)+'</td>'+
    '<td class="r">'+wcEsc(wcDifference(e.delta))+' ₽</td></tr>',4);
  const note=document.getElementById('wc-note');
  if(note)note.textContent='* '+String(data.calculation_note||'').trim()+
    ' Если предыдущая неделя имеет нулевую базу, процент роста не рассчитывается. '+
    'Новые отчётные данные учитывают только завершённые недели.';
}

async function renderWeekComparison() {
  const feedback=document.getElementById('wc-feedback');
  if(!feedback)return;
  const request=++weekComparisonRequest;
  const select=document.getElementById('wc-city');
  const city=select?select.value:'';
  feedback.textContent='Обновляем сравнение…';
  const params=new URLSearchParams({offset:String(weekComparisonOffset)});
  if(city)params.set('city',city);
  try {
    const response=await authFetch('/api/weekly-reports/comparison?'+params.toString());
    const data=await response.json();
    if(request!==weekComparisonRequest)return;
    if(!response.ok)throw Error(data.error||'Ошибка загрузки сравнения');
    wcFillCities(data.cities,city);
    wcRender(data);
    feedback.textContent='✓ Данные обновлены · '+new Date(data.generated_at).toLocaleString('ru-RU');
  }catch(error){
    if(request!==weekComparisonRequest)return;
    feedback.textContent='⚠ '+String(error?.message||'Не удалось загрузить');
  }
}

function changeWeekComparison(delta) {
  const next=weekComparisonOffset+delta;
  if(!Number.isInteger(next)||next<0||next>52)return;
  weekComparisonOffset=next;
  renderWeekComparison();
}
