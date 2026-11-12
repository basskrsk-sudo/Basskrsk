'use strict';
// One report catalogue instead of scattered entry points. Only actions
// marked "telegram" start a report-approval request. Other rows navigate
// to existing read-only analytics or the archived report workspace.
const HM_REPORTS=Object.freeze([
 {type:'salesweek',cat:'Продажи',title:'Продажи за 7 дней',
  detail:'Короткая сводка по выручке и заказам',mode:'telegram'},
 {type:'nogroomer',cat:'Продажи',title:'Заказы без грумера',
  detail:'Оплаченные заказы без назначенного грумера',mode:'telegram',days:true},
 {type:'weekcompare',cat:'Продажи',title:'Сравнение периодов',
  detail:'Интерактивная динамика двух периодов',target:'week-comparison',mode:'view'},
 {type:'business',cat:'Финансы',title:'Итоги бизнеса за год',
  detail:'Выручка, прибыль и расходы',mode:'telegram',year:true},
 {type:'payouts',cat:'Выплаты',title:'Справки для выплат',
  detail:'PDF и CSV с подтверждением в боте',mode:'telegram'},
 {type:'economics',cat:'Финансы',title:'Экономика сети',
  detail:'Действующая экономическая модель',target:'economics',mode:'view'},
 {type:'businesspoints',cat:'Сеть',title:'Реестр точек · CSV',
  detail:'Сводный реестр действующих точек',mode:'telegram',year:true},
 {type:'points',cat:'Сеть',title:'Эффективность точек',
  detail:'Список точек и их операционные показатели',target:'points',mode:'view'},
 {type:'stock',cat:'Остатки',title:'Центральный склад',
  detail:'Сводка остатков складов городов',mode:'telegram',city:true},
 {type:'pointstock',cat:'Остатки',title:'Остатки минимаркетов',
  detail:'Актуальные остатки на полках',target:'stock',mode:'view'},
 {type:'qrview',cat:'QR и маркетинг',title:'QR-воронка',
  detail:'Открытия, оплаты и конверсия по точкам',target:'qr-analytics',mode:'view',city:true,point:true,days:true},
 {type:'qrweek',cat:'QR и маркетинг',title:'Еженедельный QR-отчёт',
  detail:'CSV по точкам после подтверждения в Telegram',mode:'telegram',super:true},
 {type:'gdweek',cat:'Управление',title:'Отчёт для планёрки ГД',
  detail:'PDF и Excel за выбранный период',mode:'telegram',dates:true},
 {type:'gdarchive',cat:'Управление',title:'Архив отчётов ГД',
  detail:'Скачивание уже сформированных файлов',target:'weekly-reports',mode:'view'},
 {type:'payoutarchive',cat:'Выплаты',title:'Архив выплат партнёрам',
  detail:'История и подтверждённые выплаты',target:'payout-reports',mode:'view'},
 {type:'club',cat:'Клуб партнёров',title:'Публикации для партнёров',
  detail:'Итоги дня, недели и рейтинги товаров в одном разделе',target:'/partner-club-settings.html',mode:'link',super:true},
]);

const HM_REPORT_GROUPS=Object.freeze([
 {name:'Продажи',detail:'Выручка, сравнение периодов, заказы без грумера'},
 {name:'Финансы',detail:'Годовые итоги и экономика сети'},
 {name:'Сеть',detail:'Реестр и эффективность минимаркетов'},
 {name:'Остатки',detail:'Центральный склад и товар на полках'},
 {name:'QR и маркетинг',detail:'Сканирования, конверсия и CSV'},
 {name:'Выплаты',detail:'Справки и история перечислений'},
 {name:'Управление',detail:'Отчёт ГД и архив'},
 {name:'Клуб партнёров',detail:'Итоги дня, недели и рейтинги товаров'},
]);
const hmReportState={loaded:false,points:[],selected:'gdweek',result:''};
function visibleReportCatalog(){
 return HM_REPORTS.filter(r=>!r.super||currentAdminRole==='super');
}
// Keep the full set of report types, but expose only eight top-level cards.
// Their submenus link to existing analytics and Telegram approvals.
function renderReportCenterGroups(){
 const cards=document.getElementById('rc-categories');
 if(!cards)return;
 const selected=currentReport();
 cards.replaceChildren();
 for(const group of HM_REPORT_GROUPS){
   const members=visibleReportCatalog().filter(r=>r.cat===group.name);
   if(!members.length)continue;
   const active=selected.cat===group.name;
   const box=document.createElement('div');
   box.className='card';
   box.style.cssText='margin:0;';
   const heading=document.createElement('button');
   heading.type='button';
   heading.className='row-btn';
   heading.style.cssText='width:100%;text-align:left;white-space:normal;font-weight:700;';
   heading.textContent=group.name+(active?' · открыто':'');
   heading.setAttribute('aria-expanded',String(active));
   heading.addEventListener('click',()=>reportCenterSelect(members[0].type));
   const caption=document.createElement('p');
   caption.textContent=group.detail;
   caption.style.cssText='font-size:.8rem;color:var(--muted);margin:.4rem 0;';
   box.append(heading,caption);
   if(active){
     const submenu=document.createElement('div');
     submenu.style.cssText='display:flex;flex-direction:column;gap:.25rem;padding-top:.3rem;';
     for(const report of members){
       const button=document.createElement('button');
       button.type='button';button.className='row-btn';
       button.style.cssText='display:block;width:100%;text-align:left;white-space:normal;';
       button.textContent=(report.type===selected.type?'✓ ':'')+report.title;
       button.addEventListener('click',()=>{
         reportCenterSelect(report.type);
         document.getElementById('rc-request')?.scrollIntoView({block:'nearest',behavior:'smooth'});
       });
       submenu.append(button);
     }
     box.append(submenu);
   }
   cards.append(box);
 }
}

function reportCenterEscape(value){
 return String(value==null?'':value)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function currentReport(){
 return HM_REPORTS.find(r=>r.type===hmReportState.selected)||HM_REPORTS[0];
}
function reportCenterSelect(type){
 hmReportState.selected=type;
 const selector=document.getElementById('rc-report-type');
 if(selector)selector.value=type;
 const report=currentReport();
 const helper=document.getElementById('rc-report-detail');
 if(helper)helper.textContent=report.detail+
   (report.mode==='telegram'?' · требуется подтверждение в личном Telegram.':
   ' · откроется интерактивный экран.');
 for(const field of ['dates','year','days','city','point']){
  const container=document.getElementById('rc-filter-'+field);
  if(container)container.hidden=!report[field];
 }
 const action=document.getElementById('rc-request');
 if(action)action.textContent=report.mode==='telegram'?
   'Запросить формирование в Telegram':report.mode==='link'?
   'Открыть раздел':'Открыть отчёт';
 renderReportCenterGroups();
 const result=document.getElementById('rc-result');
 if(result)result.textContent='';
}
function reportCenterCityFilter(){
 const city=document.getElementById('rpt-city')?.value||'';
 const select=document.getElementById('rc-point');
 if(!select)return;
 const previous=select.value;
 select.replaceChildren();
 const all=document.createElement('option');
 all.value='';all.textContent='Все точки';select.append(all);
 hmReportState.points.filter(p=>!city||p.city_id===city).forEach(p=>{
   const option=document.createElement('option');
   option.value=p.id;option.textContent=p.name;
   select.append(option);
 });
 if([...select.options].some(o=>o.value===previous))select.value=previous;
}
async function loadReportCenter(){
 const select=document.getElementById('rc-report-type');
 if(!select)return;
 if(!hmReportState.loaded){
  const cats=HM_REPORT_GROUPS.map(g=>g.name);
  select.replaceChildren();
  cats.forEach(cat=>{
   const members=visibleReportCatalog().filter(r=>r.cat===cat);
   if(!members.length)return;
   const group=document.createElement('optgroup');group.label=cat;
   members.forEach(r=>{
     const option=document.createElement('option');
     option.value=r.type;option.textContent=r.title;
     group.append(option);
   });
   select.append(group);
  });
  hmReportState.loaded=true;
  try{
    const res=await authFetch('/api/points?all=1');
    if(res.ok){
      const data=await res.json();
      hmReportState.points=(data.points||[]).filter(p=>p.active);
      const cities=[...new Map(hmReportState.points
        .filter(p=>p.city_id).map(p=>[p.city_id,p.city_name||p.city_id])).entries()];
      const selector=document.getElementById('rpt-city');
      if(selector){
        cities.forEach(([id,name])=>{
          const option=document.createElement('option');option.value=id;option.textContent=name;
          selector.append(option);
        });
      }
      reportCenterCityFilter();
    }
  }catch(error){console.warn('Не удалось загрузить города центра отчётности:',error.message);}
 }
 if(!document.getElementById('rc-report-type').value||
   currentAdminRole!=='super'&&currentReport().super)
   hmReportState.selected='gdweek';
 reportCenterSelect(hmReportState.selected);
}
async function reportCenterRun(){
 const report=currentReport();
 const output=document.getElementById('rc-result');
 const button=document.getElementById('rc-request');
 if(report.super&&currentAdminRole!=='super'){
   if(output)output.textContent='Этот отчёт доступен только супер-администратору';
   return;
 }
 if(report.mode==='link'){
   window.location.assign(report.target);
   return;
 }
 if(report.mode==='view'){
   if(report.target==='qr-analytics'){
     const days=Number(document.getElementById('rc-days')?.value||30);
     const point=document.getElementById('rc-point')?.value||'';
     await showSection(report.target);
     const dayEl=document.getElementById('qr-analytics-days');
     const pointEl=document.getElementById('qr-analytics-point');
     if(dayEl)dayEl.value=String([7,30,90].includes(days)?days:30);
     if(pointEl && [...pointEl.options].some(o=>o.value===point))pointEl.value=point;
     if(typeof loadQrAnalytics==='function')await loadQrAnalytics();
   } else{
     await showSection(report.target);
   }
   return;
 }
 const body={type:report.type};
 if(report.dates){
   body.start=document.getElementById('rc-start')?.value||'';
   body.end=document.getElementById('rc-end')?.value||'';
 }
 if(report.year){
   body.year=document.getElementById('rc-year')?.value||'';
 }
 if(report.days)body.days=Number(document.getElementById('rc-days')?.value||30);
 if(report.city)body.citySelector=document.getElementById('rpt-city')?.value||'';
 if(button)button.disabled=true;
 if(output)output.textContent='Отправляем запрос на согласование в Telegram…';
 try{
   const res=await authFetch('/api/admin/report-center/request',
     {method:'POST',body});
   const data=await res.json();
   if(!res.ok)throw new Error(data.error||'Не удалось запросить отчёт');
   if(output)output.textContent=data.message||
     'Подтвердите формирование в личном Telegram. До этого отчёт не создаётся.';
 }catch(error){
   if(output)output.textContent='Ошибка: '+error.message;
 }finally{if(button)button.disabled=false;}
}
