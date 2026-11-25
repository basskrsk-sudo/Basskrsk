// Shared, data-driven admin navigation. One definition for desktop + mobile.
// Script loads before taiga-admin.html's legacy inline application code.
'use strict';

const sections=[...document.querySelectorAll('[id^="sec-"]')]
  .map(el=>el.id.slice(4));

const titles={
  launch:'План запуска', 'system-health':'Состояние системы',
  notifications:'Настройки уведомлений',
  guides:'Инструкции',dashboard:'Операционный центр',
  tasks:'Контроль поручений',
  finance:'Финансы',economics:'Экономика проекта','business-expenses':'Траты бизнеса',
  'week-comparison':'Неделя к неделе','weekly-reports':'Отчёт ГД',
  'payout-reports':'Отчёты партнёрам','report-center':'Центр отчётности',
  orders:'Заказы',customers:'Покупатели', stock:'Остатки на точках',
  products:'Каталог товаров',reviews:'Отзывы',news:'Новости',
  winback:'Возврат клиентов',partners:'Грумеры и рекомендатели',managers:'Менеджеры',
  points:'Точки продаж · реестр', 'point-sales':'Продажи по точкам',owners:'Владельцы салонов',qr:'QR-коды',referrals:'Рекомендатели и бонусы',
  'qr-analytics':'Аналитика QR',leads:'Привлечение салонов', 'network-map':'Карта сети',
  warehouse:'Центральный склад',restock:'Перемещения',
  audit:'Журнал действий',admins:'Администраторы',
  'telegram-connections':'Telegram · подключения',
  max:'MAX · управление ботом',point:'',campaigns:'Акции и коммуникации',
  backup:'Резервные копии'
};

const sectionGroups={
  dashboard:'home',
  points:'network',point:'network','point-sales':'network',partners:'network',managers:'network',referrals:'network',
  owners:'network',leads:'network','network-map':'network',qr:'network',
  products:'inventory',stock:'inventory',warehouse:'inventory',restock:'inventory',
  orders:'sales',customers:'sales',
  campaigns:'promotion',news:'promotion',reviews:'promotion',winback:'promotion',
  finance:'finance','report-center':'finance',economics:'finance','business-expenses':'finance',
  'payout-reports':'finance','week-comparison':'finance','weekly-reports':'finance',
  'qr-analytics':'finance',
  tasks:'team',launch:'team',
  'system-health':'system',notifications:'system','telegram-connections':'system',
  max:'system',audit:'system',admins:'system',backup:'system',guides:'system'
};

// Exactly eight top-level business workflows; other screens stay reachable
// as context tabs or from the centralized report/point workspaces.
const contextTabs={
  inventory:[['products','Каталог'],['stock','На точках'],
    ['warehouse','Центральный склад'],['restock','Перемещения']],
  sales:[['orders','Заказы'],['customers','Покупатели']],
  promotion:[['campaigns','Акции и клуб'],['news','Новости'],
    ['winback','Возврат клиентов'],['reviews','Отзывы']],
  // Three daily finance tabs live inside the finance section.
  finance:[['finance','Финансы']],
  team:[['tasks','Поручения'],['launch','План запуска']],
  system:[['system-health','Мониторинг'],['notifications','Уведомления'],['telegram-connections','Telegram'],
    ['max','MAX'],['backup','Резервные копии'],['admins','Администраторы',true],
    ['audit','Журнал',true],['guides','Инструкции']]
};

// Network navigation has three stable business areas, each with its own screens.
const networkAreas=[
  {id:'points',label:'Точки продаж',tabs:[['points','Реестр точек'],['point-sales','Продажи'],['qr','QR-коды']]},
  {id:'partners',label:'Партнёры и команда',tabs:[['partners','Грумеры и рекомендатели'],['owners','Владельцы'],['managers','Менеджеры'],['referrals','Реферальная программа']]},
  {id:'leads',label:'Развитие сети',tabs:[['leads','Переговоры'],['network-map','Карта сети']]},
];
function networkContextMarkup(sectionId){
  const activeId=sectionId==='point'?'points':sectionId;
  const activeArea=networkAreas.find(area=>area.tabs.some(tab=>tab[0]===activeId))||networkAreas[0];
  function button(id,label,active,kind){
    return '<button type="button" class="section-context-tab '+(active?'active':'')+
      '" data-network-'+kind+'="'+id+'" '+(active?'aria-current="page" ':'')+
      'onclick="showSection(\''+id+'\')">'+label+'</button>';
  }
  return '<div class="network-area-tabs" role="group" aria-label="Направления сети">'+
    networkAreas.map(area=>button(area.id,area.label,area.id===activeArea.id,'area')).join('')+
    '</div><div class="network-sub-tabs" role="group" aria-label="Подразделы направления">'+
    activeArea.tabs.map(tab=>button(tab[0],tab[1],tab[0]===activeId,'section')).join('')+'</div>';
}

// Search the rendered registry locally: typing never triggers another API request.
function filterNetworkTable(inputId,bodyId){
  const input=document.getElementById(inputId),body=document.getElementById(bodyId);
  if(!input||!body)return;
  const terms=input.value.trim().toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
  let count=0;
  Array.from(body.rows).forEach(row=>{
    const isPlaceholder=row.cells.length===1&&row.cells[0].colSpan>1;
    if(isPlaceholder){row.hidden=terms.length>0;return;}
    const value=row.textContent.toLocaleLowerCase('ru-RU');
    row.hidden=!terms.every(term=>value.includes(term));
    if(!row.hidden)count++;
  });
  const status=document.getElementById(inputId+'-status');
  if(status)status.textContent=terms.length?'Найдено: '+count:'';
}
async function renderAdminReferralControl(){
  const module=window.HvostAdminReferralControl;
  if(!module)return;
  const note=document.getElementById('referral-control-error');
  if(note)note.textContent='Загрузка…';
  try{
    const response=await authFetch('/api/admin/referral-control');
    if(!response.ok)throw new Error('Не удалось загрузить реферальную программу');
    module.render(await response.json());
    if(note)note.textContent='';
  }catch(error){
    module.render(null);
    if(note)note.textContent=error.message||'Ошибка загрузки';
  }
}
const reportDetailSections=new Set([
  'payout-reports','week-comparison','weekly-reports','qr-analytics'
]);

function renderContextTabs(sectionId){
  const holder=document.getElementById('section-context-tabs');
  if(!holder)return;
  const group=sectionGroups[sectionId];
  holder.classList.toggle('network-context',group==='network');
  if(group==='network'){
    holder.style.display='flex';
    holder.innerHTML=networkContextMarkup(sectionId);
    return;
  }
  const tabs=(contextTabs[group]||[]).filter(tab=>!tab[2]||currentAdminRole==='super');
  holder.style.display=tabs.length>1?'flex':'none';
  const activeId=sectionId==='point'?'points':
    reportDetailSections.has(sectionId)?'report-center':sectionId;
  holder.innerHTML=tabs.map(tab=>
    '<button type="button" class="section-context-tab '+(tab[0]===activeId?'active':'')+
    '" onclick="showSection(\''+tab[0]+'\')">'+tab[1]+'</button>'
  ).join('');
}

function setAdminMenuOpen(open) {
  const sidebar = document.getElementById('admin-sidebar');
  const overlay = document.getElementById('admin-sidebar-overlay');
  const button = document.querySelector('.mobile-menu-btn');
  if (sidebar) sidebar.classList.toggle('mobile-open', open);
  if (overlay) overlay.classList.toggle('mobile-open', open);
  document.body.classList.toggle('admin-menu-open', open);
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleAdminMenu() {
  const sidebar = document.getElementById('admin-sidebar');
  setAdminMenuOpen(!(sidebar && sidebar.classList.contains('mobile-open')));
}

function closeAdminMenu() { setAdminMenuOpen(false); }

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') closeAdminMenu();
});
window.addEventListener('resize', function() {
  if (window.innerWidth > 768) closeAdminMenu();
});


// Advanced reports are rare. Defer parsing old reporting/weekly-chart
// scripts until a user explicitly opens their archived screen.
const archivedFinanceScripts={};
function loadDeferredFinanceScript(section){
  const config=section==='report-center'
    ?{src:'/admin-report-center.js?v=2',ready:function(){return typeof loadReportCenter==='function';}}
    :section==='week-comparison'
      ?{src:'/week-over-week.js?v=2',ready:function(){return typeof renderWeekComparison==='function';}}
      :null;
  if(!config)return Promise.reject(new Error('Неизвестный архив отчётов'));
  if(config.ready())return Promise.resolve();
  if(!archivedFinanceScripts[section]){
    archivedFinanceScripts[section]=new Promise(function(resolve,reject){
      const script=document.createElement('script');
      script.src=config.src;
      script.async=true;
      script.onload=function(){
        if(config.ready())resolve();
        else {
          delete archivedFinanceScripts[section];
          reject(new Error('Архивный отчёт не загрузился'));
        }
      };
      script.onerror=function(){
        delete archivedFinanceScripts[section];
        if(script.remove)script.remove();
        reject(new Error('Ошибка загрузки архивного отчёта'));
      };
      document.head.appendChild(script);
    });
  }
  return archivedFinanceScripts[section];
}

let adminFinanceModulePromise=null;
function loadAdminFinanceModule(){
  if(window.HvostAdminFinance)return Promise.resolve(window.HvostAdminFinance);
  if(!adminFinanceModulePromise){
    adminFinanceModulePromise=new Promise(function(resolve,reject){
      const script=document.createElement('script');
      script.src='/admin-finance.js?v=20261121-calendar-years';
      script.async=true;
      script.onload=function(){
        if(window.HvostAdminFinance)resolve(window.HvostAdminFinance);
        else reject(new Error('Финансовый модуль не загрузился'));
      };
      script.onerror=function(){
        adminFinanceModulePromise=null;
        reject(new Error('Не удалось загрузить финансовый модуль'));
      };
      document.head.appendChild(script);
    });
  }
  return adminFinanceModulePromise;
}

async function showSection(id) {
  // Old links to the removed BSC dashboard return to the business overview.
  if (!sections.includes(id)) id = 'dashboard';
  sections.forEach(function(s) {
    const el = document.getElementById('sec-' + s);
    if (el) el.style.display = (s === id) ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item[data-group]').forEach(function(el) {
    el.classList.toggle('active', el.dataset.group === sectionGroups[id]);
  });
  closeAdminMenu();
  if(typeof closePartnerActions==='function')closePartnerActions();
  if(id!=='referrals'&&window.HvostAdminReferralControl)window.HvostAdminReferralControl.close();
  renderContextTabs(id);
  const titleEl = document.getElementById('section-title');
  if (titleEl && titles[id]) titleEl.textContent = titles[id];

  const showGlobalPeriod = ['dashboard', 'point-sales', 'partners'].includes(id);
  document.querySelectorAll('.topbar-right > .period-btn').forEach(function(btn) {
    btn.style.display = showGlobalPeriod ? '' : 'none';
  });

  if (id === 'launch')      await showLaunchTab(launchActiveTab);
  if (id === 'system-health') await renderSystemHealth();
  // Keep the same role-scoped API and save behavior. Fetch preferences only
  // after an administrator opens the System -> Notifications tab.
  if (id === 'notifications' && window.HvostNotificationSettings) {
    const root = document.getElementById('admin-notification-settings');
    if (root && adminToken) {
      window.HvostNotificationSettings.open({
        root, roles:['admin'],tokens:{admin:adminToken},
        back:() => showSection('system-health'),
      });
    }
  }
  if (id === 'dashboard')   { await loadAdminSalesSummary(); renderDashboard(); }
  if (id === 'tasks')       await loadTaskLinks();
  if (id === 'finance') {
    const root=document.getElementById('admin-finance-root');
    if(root){
      try{
        const module=await loadAdminFinanceModule();
        await module.mount({root,authFetch:authFetch,navigate:showSection});
      }catch(error){
        root.textContent='Не удалось открыть финансы: '+(error.message||'Ошибка загрузки');
      }
    }
  }
  if (id === 'economics')   await renderEconomics();
  if (id === 'business-expenses') await renderBusinessExpenses();
  if (id === 'week-comparison') {
    try { await loadDeferredFinanceScript('week-comparison'); await renderWeekComparison(); }
    catch(error){ alert(error.message||'Не удалось открыть сравнение недель'); }
  }
  if (id === 'weekly-reports') await renderWeeklyReports();
  if (id === 'payout-reports') await openPayoutReports('partner');
  if (id === 'orders')      { await loadOrders(); renderOrders(); }
  if (id === 'customers')   { await loadCustomers(); renderCustomers(); }
  if (id === 'stock')       { await loadStockTablePoints(); await loadAdminProducts(); renderStock(); }
  if (id === 'products')    { await loadStockTablePoints(); await loadAdminProducts(); renderProducts(); }
  if (id === 'reviews')     await renderReviews();
  if (id === 'news')        await renderNews();
  if (id === 'winback')     await loadWinbackCandidates();
  if (id === 'partners')    await renderPartners();
  if (id === 'managers') await renderManagers();
  if (id === 'points')      await renderPointsManagement();
  if (id === 'point-sales') { await Promise.all([loadAdminSalesSummary(), loadPointsInfo()]); renderPointsOverview(); }
  if (id === 'referrals')    await renderAdminReferralControl();
  if (id === 'owners')      await renderOwners();
  if (id === 'qr')          await qrInitSection();
  if (id === 'qr-analytics') await loadQrAnalytics();
  if (id === 'leads')       await renderLeads();
  if (id === 'network-map' && window.HvostPartnerNetworkMap) {
    window.HvostPartnerNetworkMap.mount(document.getElementById('admin-network-map'), {
      token: function () { return adminToken; },
      onOpenLead: async function (id) {
        await showSection('leads');
        await openLeadModal(Number(id));
      },
    });
  }
  if (id === 'warehouse')   { await loadAdminProducts(); await populateReceiptForm(); await renderWarehouse(); }
  if (id === 'restock')     await Promise.all([renderStockMovements(), renderAdminCustomerRestock()]);
  if (id === 'audit')       await renderAuditLog();
  if (id === 'admins')      await renderAdmins();
  if (id === 'telegram-connections') await loadTelegramConnections();
  if (id === 'max') await loadMaxAdmin();
  if (id === 'report-center') {
    try { await loadDeferredFinanceScript('report-center'); await loadReportCenter(); }
    catch(error){ alert(error.message||'Не удалось открыть архив отчётов'); }
  }
  if (id === 'campaigns') {
    const link=document.getElementById('partner-club-admin-link');
    if(link)link.style.display=currentAdminRole==='super'?'flex':'none';
  }
}

