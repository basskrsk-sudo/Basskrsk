'use strict';
let currentPointIdx = 0;

function openCurrentPointPageSettings() {
  const point = POINTS_INFO[currentPointIdx];
  if (point) openSalonPageModal(point.id, point.name);
}

async function openCurrentPointQr() {
  const point = POINTS_INFO[currentPointIdx];
  if (!point) return;
  await showSection('qr');
  const fullPoint = QR_POINTS.find(function(item) { return item.id === point.id; });
  const citySelect = document.getElementById('qr-sel-city');
  const pointSelect = document.getElementById('qr-sel-point');
  if (fullPoint && citySelect) citySelect.value = fullPoint.city_id || '';
  qrRenderPointOptions();
  if (pointSelect) pointSelect.value = point.id;
  qrGenerate();
}

async function savePointLocation() {
  const p = POINTS_INFO[currentPointIdx];
  const lat = parseFloat(document.getElementById('pt-lat').value);
  const lng = parseFloat(document.getElementById('pt-lng').value);
  const msgEl = document.getElementById('pt-location-msg');
  if (isNaN(lat) || isNaN(lng)) {
    msgEl.textContent = 'Укажите широту и долготу числами.';
    msgEl.style.color = '#9B2335';
    return;
  }
  const res = await authFetch('/api/points/' + p.id + '/location', { method: 'PUT', body: { lat, lng } });
  if (!res.ok) {
    const data = await res.json();
    msgEl.textContent = data.error || 'Не удалось сохранить.';
    msgEl.style.color = '#9B2335';
    return;
  }
  msgEl.textContent = '✅ Сохранено';
  msgEl.style.color = '#2D7D46';
  await loadPointLaunchChecklist(p.id);
  loadOperationsCenter();
}

async function showPoint(idx) {
  currentPointIdx = idx;
  pointWorkspaceCache=null;
  pointStockLoadedForId=null;
  sections.forEach(function(s) {
    const el = document.getElementById('sec-' + s);
    if (el) el.style.display = (s === 'point') ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item[data-group]').forEach(function(el) {
    el.classList.toggle('active', el.dataset.group === 'network');
  });
  renderContextTabs('point');
  document.querySelectorAll('.topbar-right > .period-btn').forEach(function(btn) { btn.style.display = ''; });

  const p = POINTS_INFO[idx];
  if(!p){await showSection('points');return;}
  await switchPointTab('overview');
  document.getElementById('section-title').textContent = p.name;
  document.getElementById('point-breadcrumb').textContent = p.name;
  document.getElementById('point-header-name').textContent = p.name;
  document.getElementById('point-header-addr').textContent = '';
  document.getElementById('point-color-bar').style.background = p.color;

  const pointsRes = await fetch('/api/points');
  const pointsData = await pointsRes.json();
  const realPoint = (pointsData.points || []).find(function(x) { return x.id === p.id; });
  document.getElementById('point-header-addr').textContent = realPoint ? realPoint.addr : '';
  document.getElementById('pt-lat').value = realPoint && realPoint.lat !== null ? realPoint.lat : '';
  document.getElementById('pt-lng').value = realPoint && realPoint.lng !== null ? realPoint.lng : '';
  document.getElementById('pt-location-msg').textContent = '';

  await Promise.all([loadOrders(), loadPointLaunchChecklist(p.id)]);
  const days = periodDays();
  const periodOrders = ordersInPeriod(days);
  const pOrders = periodOrders.filter(function(o) { return o.point_id === p.id; });
  const totalRev = periodOrders.reduce(function(s, o) { return s + o.total; }, 0);
  const rev = pOrders.reduce(function(s, o) { return s + o.total; }, 0);
  const avgCheck = pOrders.length ? Math.round(rev / pOrders.length) : 0;
  const pct = totalRev > 0 ? Math.round(rev / totalRev * 100) : 0;

  document.getElementById('pt-kpi-rev').textContent = rev.toLocaleString('ru-RU') + ' ₽';
  document.getElementById('pt-kpi-ord').textContent = pOrders.length;
  document.getElementById('pt-kpi-avg').textContent = avgCheck.toLocaleString('ru-RU') + ' ₽';
  document.getElementById('pt-kpi-pct').textContent = pct + '%';

  const dayLabels = [], dayValues = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    dayLabels.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
    dayValues.push(pOrders.filter(function(o) { return parseOrderDate(o.created_at).toISOString().slice(0, 10) === key; })
                          .reduce(function(s, o) { return s + o.total; }, 0));
  }
  const step = days > 14 ? Math.ceil(days / 10) : 1;
  drawLineChart('chartPointSales', dayLabels.filter(function(_, i) { return i % step === 0; }),
                                    dayValues.filter(function(_, i) { return i % step === 0; }), p.color);

  const productRevenue = {};
  pOrders.forEach(function(o) { o.items.forEach(function(i) { productRevenue[i.name] = (productRevenue[i.name] || 0) + i.price * i.qty; }); });
  const topProducts = Object.entries(productRevenue).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
  drawBarChart('chartPointProducts', topProducts.map(function(x) { return x[0]; }), topProducts.map(function(x) { return x[1]; }), '#D4872A');

  document.getElementById('pt-orders-count').textContent = pOrders.length + ' шт.';
  document.getElementById('pt-orders-tbody').innerHTML = pOrders.length ? pOrders.map(function(o) {
    return '<tr>' +
      '<td style="font-family:monospace;font-size:.78rem;">' + o.order_code + '</td>' +
      '<td style="font-size:.8rem;color:var(--muted);">' + parseOrderDate(o.created_at).toLocaleString('ru-RU') + '</td>' +
      '<td>' + o.customer_name + '</td>' +
      '<td style="font-size:.8rem;">' + o.items.map(function(i) { return i.name; }).join(', ') + '</td>' +
      '<td class="r">' + o.total.toLocaleString('ru-RU') + ' ₽</td>' +
      '<td>' + (o.payment_method === 'sbp' ? 'СБП' : (o.payment_method === 'yookassa' ? 'ЮKassa' : 'Карта')) + '</td>' +
      '<td>' + o.status + '</td></tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:1.5rem;">Заказов нет</td></tr>';

  // Stock is no longer downloaded every time the point overview opens.
  // It is loaded only when the Stock tab is selected.

}

async function renderPointStockForCurrent(){
  const p=POINTS_INFO[currentPointIdx];
  if(!p)return;
  await loadAdminProducts();
  const stockRows = [];
  adminProducts.forEach(function(prod) {
    prod.variants.forEach(function(v) {
      const qty = v.stock[p.id] || 0;
      stockRows.push({ name: prod.name + ' (' + v.weight + ')', qty: qty, price: v.price });
    });
  });
  document.getElementById('pt-stock-tbody').innerHTML = stockRows.map(function(r) {
    const statusClass = r.qty === 0 ? 'stock-out' : r.qty < 3 ? 'stock-low' : 'stock-ok';
    const statusText = r.qty === 0 ? '✕ Нет' : r.qty < 3 ? '⚠ Мало' : '✓ Есть';
    return '<tr><td>' + r.name + '</td><td class="r">' + r.qty + '</td>' +
      '<td><span class="stock-pill ' + statusClass + '">' + statusText + '</span></td>' +
      '<td class="r">' + r.price.toLocaleString('ru-RU') + ' ₽</td>' +
      '<td class="r">' + (r.qty * r.price).toLocaleString('ru-RU') + ' ₽</td></tr>';
  }).join('');
}

let pointLaunchChecklistData = null;

async function loadPointLaunchChecklist(pointId) {
  const body = document.getElementById('point-launch-checklist-body');
  if (body) body.textContent = 'Загрузка чек-листа…';
  try {
    const res = await authFetch('/api/points/' + encodeURIComponent(pointId) + '/launch-checklist');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить чек-лист');
    pointLaunchChecklistData = data;
    renderPointLaunchChecklist();
  } catch (error) {
    if (body) body.innerHTML = '<span style="color:#9B2335;">' + opsEscapeHtml(error.message) + '</span>';
  }
}

function renderPointLaunchChecklist() {
  if (!pointLaunchChecklistData) return;
  const summary = pointLaunchChecklistData.summary;
  const status = document.getElementById('point-launch-status');
  status.className = 'launch-progress-pill ' + (summary.ready ? 'ready' : 'pending');
  status.textContent = summary.ready
    ? '✓ Готова к работе · 100%'
    : summary.completed + ' из ' + summary.total + ' · ' + summary.percent + '%';
  document.getElementById('point-launch-progress-bar').style.width = summary.percent + '%';

  const groups = {};
  pointLaunchChecklistData.items.forEach(function(item) {
    if (!groups[item.group]) groups[item.group] = [];
    groups[item.group].push(item);
  });
  document.getElementById('point-launch-checklist-body').innerHTML = Object.keys(groups).map(function(group) {
    return '<div class="launch-checklist-group"><div class="launch-checklist-group-title">' + opsEscapeHtml(group) + '</div>' +
      '<div class="launch-checklist-items">' + groups[group].map(function(item) {
        const important = item.key === 'referral_bonus_verified' || item.key === 'test_sale_verified';
        const completedDate = item.completed_at
          ? new Date(String(item.completed_at).replace(' ', 'T') + 'Z').toLocaleString('ru-RU')
          : '';
        const meta = item.mode === 'auto'
          ? '<div class="launch-check-meta">Обновляется автоматически</div>'
          : (item.completed
              ? '<div class="launch-check-meta">Подтвердил: ' + opsEscapeHtml(item.completed_by || 'администратор') +
                (completedDate ? ' · ' + opsEscapeHtml(completedDate) : '') +
                (item.note ? '<br>Комментарий: ' + opsEscapeHtml(item.note) : '') + '</div>'
              : '');
        const action = item.mode === 'manual'
          ? '<button class="launch-check-action" onclick="togglePointLaunchItem(\'' + item.key + '\',' + (!item.completed) + ')">' +
            (item.completed ? 'Отменить отметку' : 'Отметить выполненным') + '</button>'
          : '';
        return '<div class="launch-check-item ' + (item.completed ? 'done ' : '') + (important ? 'important' : '') + '">' +
          '<div class="launch-check-icon">' + (item.completed ? '✓' : '○') + '</div>' +
          '<div class="launch-check-body"><div class="launch-check-title">' + opsEscapeHtml(item.title) + '</div>' +
          '<div class="launch-check-desc">' + opsEscapeHtml(item.description) + '</div>' +
          (item.evidence ? '<div class="launch-check-evidence">' + opsEscapeHtml(item.evidence) + '</div>' : '') +
          meta + action + '</div></div>';
      }).join('') + '</div></div>';
  }).join('');
}

async function togglePointLaunchItem(itemKey, completed) {
  if (!pointLaunchChecklistData) return;
  let note = '';
  if (completed && itemKey === 'referral_bonus_verified') {
    const value = prompt(
      'Зафиксируйте результат проверки бонуса.\n\nЕсли точку привёл грумер — укажите его. Если реферала не было — напишите, кто это проверил.',
      ''
    );
    if (value === null) return;
    note = value.trim();
  }
  if (completed && itemKey === 'test_sale_verified') {
    const value = prompt(
      'Подтвердите результат тестовой продажи:',
      'Оплата, списание остатка, экран успеха и уведомления проверены'
    );
    if (value === null) return;
    note = value.trim();
  }
  try {
    const res = await authFetch(
      '/api/points/' + encodeURIComponent(pointLaunchChecklistData.point.id) + '/launch-checklist/' + encodeURIComponent(itemKey),
      { method: 'PUT', body: { completed: completed, note: note } }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Не удалось сохранить отметку');
    pointLaunchChecklistData = data.checklist;
    renderPointLaunchChecklist();
    loadOperationsCenter();
  } catch (error) {
    alert(error.message);
  }
}

async function openPointChecklistById(pointId) {
  await loadPointsInfo();
  const idx = POINTS_INFO.findIndex(function(point) { return point.id === pointId; });
  if (idx < 0) {
    alert('Чек-лист доступен для активной точки. Сначала включите точку.');
    return;
  }
  await showPoint(idx);
  const card = document.getElementById('point-launch-checklist-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let pointWorkspaceCache=null;

async function loadPointWorkspace(){
  const point=POINTS_INFO[currentPointIdx];
  if(!point)return null;
  if(pointWorkspaceCache?.point?.id===point.id)return pointWorkspaceCache;
  const res=await authFetch('/api/admin/points/'+encodeURIComponent(point.id)+'/workspace');
  const data=await res.json();
  if(!res.ok)throw new Error(data.error||'Не удалось загрузить данные точки');
  pointWorkspaceCache=data;
  return data;
}
async function renderPointPeopleForCurrent(){
  const target=document.getElementById('pt-people-content');
  if(!target)return;
  target.textContent='Загружаем участников точки…';
  try{
    const data=await loadPointWorkspace();
    const rows=[];
    if(data.manager)rows.push({role:'Менеджер',name:data.manager.full_name,
      active:data.manager.active});
    (data.owners||[]).forEach(a=>rows.push({
      role:'Владелец салона',name:a.full_name,active:a.active
    }));
    (data.groomers||[]).forEach(a=>rows.push({
      role:'Грумер',name:a.full_name,active:a.active,
      code:a.first_purchase_promo_code||''
    }));
    target.replaceChildren();
    if(!rows.length){
      target.textContent='На эту точку пока не назначены владельцы, менеджеры или грумеры.';
      return;
    }
    const table=document.createElement('table');table.className='tbl';
    const thead=document.createElement('thead');
    const tr=document.createElement('tr');
    ['Роль','ФИО','Промокод','Статус'].forEach(label=>{
      const th=document.createElement('th');th.textContent=label;tr.append(th);
    });thead.append(tr);table.append(thead);
    const tbody=document.createElement('tbody');
    rows.forEach(item=>{
      const row=document.createElement('tr');
      [item.role,item.name||'—',item.code||'—',item.active?'Активен':'Отключён']
        .forEach(value=>{const td=document.createElement('td');td.textContent=value;row.append(td);});
      tbody.append(row);
    });table.append(tbody);target.append(table);
  }catch(error){target.textContent='Ошибка: '+error.message;}
}
async function renderPointQrForCurrent(){
  const info=document.getElementById('pt-qr-content');
  if(!info)return;
  info.textContent='Загружаем промокоды и данные точки…';
  try{
    const data=await loadPointWorkspace();
    info.replaceChildren();
    const text=document.createElement('p');
    text.textContent='Точка: '+data.point.name+' · '+(data.point.addr||'адрес не указан');
    info.append(text);
    const promo=document.createElement('p');
    promo.style.cssText='margin-top:.75rem;font-weight:600';
    promo.textContent='Промокод точки: '+(data.point.first_purchase_promo_code||'не настроен');
    info.append(promo);
    const hint=document.createElement('p');
    hint.style.cssText='font-size:.82rem;color:var(--muted);margin:.6rem 0;';
    hint.textContent='Коды и настройки уже связаны с этой точкой. Откройте генератор для печати QR-кодов или настройки страницы.';
    info.append(hint);
  }catch(error){info.textContent='Ошибка: '+error.message;}
}
let pointStockLoadedForId=null;
async function switchPointTab(tab){
  const supported=['overview','sales','stock','people','qr'];
  const selected=supported.includes(tab)?tab:'overview';
  for(const name of supported){
    const button=document.getElementById('tab-'+name);
    const panel=document.getElementById('pt-tab-'+name);
    if(button){button.classList.toggle('active',name===selected);
      button.setAttribute('aria-selected',String(name===selected));}
    if(panel)panel.hidden=name!==selected;
  }
  if(selected==='stock'){
    const p=POINTS_INFO[currentPointIdx];
    if(p && pointStockLoadedForId!==p.id){
      const body=document.getElementById('pt-stock-tbody');
      if(body)body.textContent='Загружаем остатки…';
      try{await renderPointStockForCurrent();pointStockLoadedForId=p.id;}
      catch(error){if(body)body.textContent='Ошибка: '+error.message;}
    }
  }
  if(selected==='people')await renderPointPeopleForCurrent();
  if(selected==='qr')await renderPointQrForCurrent();
}

