'use strict';

// Live, read-only week-over-week business comparison. No PDF generation,
// Telegram publishing or background polling takes place in this section.
let weekComparisonOffset=0;
let weekComparisonRequest=0;
let weekComparisonCustomDates=null;

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
  const value=money?wcMoney(number):wcNum(number,['conversion_pct','avg_daily_orders'].includes(key)?1:0)+suffix;
  return '<div class="kpi-card" style="min-width:0">'+
    '<div class="kpi-label">'+wcEsc(label)+'</div>'+
    '<div class="kpi-value" style="font-size:clamp(1.2rem,2.8vw,1.9rem)">'+wcEsc(value)+'</div>'+
    '<div class="kpi-delta" style="display:flex;gap:.35rem;flex-wrap:wrap">'+
       wcDelta(metric,lowerIsBetter) +
       '<span style="font-size:.75rem;color:var(--muted)">('+wcEsc(money?wcMoney(metric.previous):wcNum(metric.previous,['conversion_pct','avg_daily_orders'].includes(key)?1:0)+suffix)+
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
  const weekly=data.period?.mode==='completed-week';
  const top=Math.max(1,...daily.flatMap(x=>[Number(x.current||0),Number(x.previous||0)]));
  const bars=daily.map(d=>{
    const c=Math.max(2,Math.round(Number(d.current||0)/top*126));
    const p=Math.max(2,Math.round(Number(d.previous||0)/top*126));
    const label=weekly?names[d.weekday]:'День '+(d.weekday+1);
    const cur=d.date?'А: '+d.date+' · '+wcMoney(d.current)+' · '+wcNum(d.current_orders)+' заказов':'Отсутствует в периоде А';
    const prev=d.previous_date?'Б: '+d.previous_date+' · '+wcMoney(d.previous)+' · '+wcNum(d.previous_orders)+' заказов':'Отсутствует в периоде Б';
    const oldBar=d.previous==null?'':'<div title="'+wcEsc(prev)+'" aria-label="'+wcEsc(prev)+'" style="width:22px;height:'+p+'px;border-radius:4px 4px 0 0;background:#B9CBC1"></div>';
    const newBar=d.current==null?'':'<div title="'+wcEsc(cur)+'" aria-label="'+wcEsc(cur)+'" style="width:22px;height:'+c+'px;border-radius:4px 4px 0 0;background:#2D7655"></div>';
    return '<div style="min-width:58px;flex:1;display:flex;flex-direction:column;align-items:center;gap:5px" role="group" aria-label="'+wcEsc(label)+'">'+
      '<div style="height:135px;display:flex;align-items:end;justify-content:center;gap:4px">'+oldBar+newBar+'</div>'+
      '<b style="font-size:.77rem">'+wcEsc(label)+'</b>'+
      '<small style="text-align:center;color:var(--muted);font-size:.67rem">'+
       (d.date?wcEsc(d.date.slice(5)):'—')+' / '+(d.previous_date?wcEsc(d.previous_date.slice(5)):'—')+'</small></div>';
  }).join('');
  target.innerHTML='<div style="display:flex;gap:1rem;align-items:center;margin-bottom:.6rem;font-size:.79rem;flex-wrap:wrap">'+
    '<span><span style="display:inline-block;width:10px;height:10px;background:#2D7655;border-radius:2px"></span> Период А</span>'+
    '<span><span style="display:inline-block;width:10px;height:10px;background:#B9CBC1;border-radius:2px"></span> Период Б</span>'+
    (!data.period?.equal_length?'<span style="color:#8F5315">— = отсутствующий день</span>':'')+'</div>'+
    '<div style="display:flex;gap:8px;min-width:'+Math.max(550,daily.length*66)+'px;align-items:end">'+bars+'</div>';
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
const WC_DATE_FIELDS={
  current_start:'wc-current-start',
  current_end:'wc-current-end',
  previous_start:'wc-previous-start',
  previous_end:'wc-previous-end',
};
function wcSetDateFields(period) {
  const values={
    current_start:period.start_local,current_end:period.end_local,
    previous_start:period.previous_start_local,previous_end:period.previous_end_local,
  };
  for(const [key,id] of Object.entries(WC_DATE_FIELDS)){
    const input=document.getElementById(id);
    if(input)input.value=values[key]||'';
  }
}
function wcDateValues() {
  return Object.fromEntries(Object.entries(WC_DATE_FIELDS).map(([key,id])=>[
    key,String(document.getElementById(id)?.value||''),
  ]));
}
function wcDateKey(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?time:null;
}
function wcLocalToday() {
  return new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Krasnoyarsk',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(new Date());
}
function wcValidateDates(dates) {
  const values={};
  for(const [key,value] of Object.entries(dates)){
    const parsed=wcDateKey(value);
    if(parsed===null)throw Error('Выберите корректные даты начала и конца обоих периодов.');
    values[key]=parsed;
  }
  const day=86400000;
  const aDays=Math.round((values.current_end-values.current_start)/day)+1;
  const bDays=Math.round((values.previous_end-values.previous_start)/day)+1;
  if(aDays<1||bDays<1)throw Error('Дата окончания периода должна быть не раньше даты начала.');
  if(aDays>31||bDays>31)throw Error('Каждый период может включать не более 31 дня.');
  if(dates.current_end>wcLocalToday()||dates.previous_end>wcLocalToday())
    throw Error('Нельзя сравнивать будущие даты.');
  if(values.previous_end>=values.current_start)
    throw Error('Базовый период Б должен закончиться до начала периода А; пересечение не допускается.');
  return {current_days:aDays,previous_days:bDays};
}
function applyWeekComparisonDates() {
  const feedback=document.getElementById('wc-feedback');
  const dates=wcDateValues();
  try{
    wcValidateDates(dates);
    weekComparisonCustomDates=dates;
    renderWeekComparison();
  }catch(e){
    if(feedback)feedback.textContent='⚠ '+String(e.message||'Проверьте даты');
  }
}
function resetWeekComparisonDates() {
  weekComparisonOffset=0;
  weekComparisonCustomDates=null;
  renderWeekComparison();
}

function wcRender(data) {
  document.getElementById('wc-period').textContent=
    data.period.start_local+' — '+data.period.end_local+
    '  против  '+data.period.previous_start_local+' — '+data.period.previous_end_local;
  const next=document.getElementById('wc-next');
  if(next)next.disabled=!!weekComparisonCustomDates||weekComparisonOffset===0;
  const earlier=document.getElementById('wc-earlier');
  if(earlier)earlier.disabled=!!weekComparisonCustomDates||weekComparisonOffset===52;
  wcSetDateFields(data.period);
  const warning=document.getElementById('wc-length-warning');
  if(warning) {
    warning.style.display=data.period.equal_length?'none':'block';
    warning.textContent=data.period.equal_length?'':'⚠ Периоды разной длины: А — '+
      data.period.current_days+' дн., Б — '+data.period.previous_days+
      ' дн. Для объективного сравнения смотрите среднедневные показатели.';
  }
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
    wcMetric('Выручка в день',data,'avg_daily_revenue',{money:true}),
    wcMetric('Заказов в день',data,'avg_daily_orders'),
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
    ' При нулевой базе процент роста не рассчитывается. '+
    'Если периоды имеют разную длительность, для сопоставления темпов используйте показатели за день.';
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
  if(weekComparisonCustomDates){
    for(const [key,value] of Object.entries(weekComparisonCustomDates))params.set(key,value);
  }
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
  if(weekComparisonCustomDates)return;
  const next=weekComparisonOffset+delta;
  if(!Number.isInteger(next)||next<0||next>52)return;
  weekComparisonOffset=next;
  renderWeekComparison();
}
