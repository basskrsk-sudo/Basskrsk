// Shared, data-driven admin navigation. One definition for desktop + mobile.
// Script loads before taiga-admin.html's legacy inline application code.
'use strict';

const sections=[...document.querySelectorAll('[id^="sec-"]')]
  .map(el=>el.id.slice(4));

const titles={
  launch:'План запуска', 'system-health':'Состояние системы',
  guides:'Инструкции',dashboard:'Операционный центр',
  tasks:'Контроль поручений',
  economics:'Экономика проекта','business-expenses':'Траты бизнеса',
  'week-comparison':'Неделя к неделе','weekly-reports':'Отчёт ГД',
  'payout-reports':'Отчёты партнёрам','report-center':'Центр отчётности',
  orders:'Заказы',customers:'Покупатели', stock:'Остатки на точках',
  products:'Каталог товаров',reviews:'Отзывы',news:'Новости',
  winback:'Возврат клиентов',partners:'Грумеры',managers:'Менеджеры',
  points:'Сеть точек',owners:'Владельцы салонов',qr:'QR-коды',
  'qr-analytics':'Аналитика QR',leads:'Привлечение салонов', 'network-map':'Карта сети',
  warehouse:'Центральный склад',restock:'Перемещения',
  audit:'Журнал действий',admins:'Администраторы',
  'telegram-connections':'Telegram · подключения',
  max:'MAX · управление ботом',point:'',campaigns:'Акции и коммуникации',
  backup:'Резервные копии'
};

const sectionGroups={
  dashboard:'home',
  points:'network',point:'network',partners:'network',managers:'network',
  owners:'network',leads:'network','network-map':'network',qr:'network',
  products:'inventory',stock:'inventory',warehouse:'inventory',restock:'inventory',
  orders:'sales',customers:'sales',
  campaigns:'promotion',news:'promotion',reviews:'promotion',winback:'promotion',
  'report-center':'finance',economics:'finance','business-expenses':'finance',
  'payout-reports':'finance','week-comparison':'finance','weekly-reports':'finance',
  'qr-analytics':'finance',
  tasks:'team',launch:'team',
  'system-health':'system','telegram-connections':'system',
  max:'system',audit:'system',admins:'system',backup:'system',guides:'system'
};

// Exactly eight top-level business workflows; other screens stay reachable
// as context tabs or from the centralized report/point workspaces.
const contextTabs={
  network:[['points','Точки'],['partners','Грумеры'],['owners','Владельцы'],
    ['managers','Менеджеры'],['leads','Привлечение'],['network-map','Карта сети'],['qr','QR-коды']],
  inventory:[['products','Каталог'],['stock','На точках'],
    ['warehouse','Центральный склад'],['restock','Перемещения']],
  sales:[['orders','Заказы'],['customers','Покупатели']],
  promotion:[['campaigns','Акции и клуб'],['news','Новости'],
    ['winback','Возврат клиентов'],['reviews','Отзывы']],
  finance:[['report-center','Центр отчётов'],['economics','Экономика'],
    ['business-expenses','Расходы']],
  team:[['tasks','Поручения'],['launch','План запуска']],
  system:[['system-health','Мониторинг'],['telegram-connections','Telegram'],
    ['max','MAX'],['backup','Резервные копии'],['admins','Администраторы',true],
    ['audit','Журнал',true],['guides','Инструкции']]
};

const reportDetailSections=new Set([
  'payout-reports','week-comparison','weekly-reports','qr-analytics'
]);

function renderContextTabs(sectionId){
  const holder=document.getElementById('section-context-tabs');
  if(!holder)return;
  const group=sectionGroups[sectionId];
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
  renderContextTabs(id);
  const titleEl = document.getElementById('section-title');
  if (titleEl && titles[id]) titleEl.textContent = titles[id];

  const showGlobalPeriod = ['dashboard', 'points', 'partners'].includes(id);
  document.querySelectorAll('.topbar-right > .period-btn').forEach(function(btn) {
    btn.style.display = showGlobalPeriod ? '' : 'none';
  });

  if (id === 'launch')      await showLaunchTab(launchActiveTab);
  if (id === 'system-health') await renderSystemHealth();
  if (id === 'dashboard')   { await Promise.all([loadOrders(), loadPointsInfo(), loadOperationsCenter()]); renderDashboard(); }
  if (id === 'tasks')       await loadTaskLinks();
  if (id === 'economics')   await renderEconomics();
  if (id === 'business-expenses') await renderBusinessExpenses();
  if (id === 'week-comparison') await renderWeekComparison();
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
  if (id === 'points')      { await Promise.all([loadOrders(), loadPointsInfo()]); renderPointsOverview(); await renderPointsManagement(); }
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
  if (id === 'report-center') await loadReportCenter();
  if (id === 'campaigns') {
    const link=document.getElementById('partner-club-admin-link');
    if(link)link.style.display=currentAdminRole==='super'?'flex':'none';
  }
}

