'use strict';
// Deferred classic script: inline QR controls and admin-point.js share its global bindings.
// ── QR-КОДЫ ДЛЯ ТОЧЕК ─────────────────────────────────────────────
// Та же логика, что и в кабинете менеджера — здесь без ограничения по
// "своим" точкам, админ видит и генерирует QR для всех точек сразу.
const QR_SITE_URL = (window.TAIGA_CONFIG && window.TAIGA_CONFIG.SITE_URL) ? window.TAIGA_CONFIG.SITE_URL : 'https://хвостмаркет.рф';
let QR_POINTS = [];
let QR_PRODUCTS = [];
let qrLibLoaded = false;
let qrSelectsPopulated = false;
let qrGenerated = [];

function qrLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(src);
    s.onerror = () => reject(new Error('Не удалось загрузить: ' + src));
    document.head.appendChild(s);
  });
}
function qrLoadLibrary() {
  if (qrLibLoaded) return Promise.resolve();
  const sources = [
    'qrcode.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js',
  ];
  return sources.reduce((chain, src) => chain.catch(() => qrLoadScript(src)), Promise.reject())
    .then(() => { qrLibLoaded = true; });
}

async function qrInitSection() {
  try {
    if (!QR_POINTS.length || !QR_PRODUCTS.length) {
      const [pointsRes, productsRes] = await Promise.all([
        fetch('/api/points'),
        fetch('/api/products'),
      ]);
      const pointsData = await pointsRes.json();
      const productsData = await productsRes.json();
      QR_POINTS = (pointsData.points || []).map(p => ({ id: p.id, name: p.name, icon: p.icon, city_id: p.city_id }));
      QR_PRODUCTS = (productsData.products || [])
        .filter(p => (p.variants || []).length > 0)
        .map(p => { const v = p.variants[0]; return { id: p.slug, name: p.name, price: v.price, icon: p.icon, weight: v.weight }; });
    }
    if (!qrSelectsPopulated) {
      await loadCitiesIntoSelect('qr-sel-city');
      const qrCitySel = document.getElementById('qr-sel-city');
      qrCitySel.insertAdjacentHTML('afterbegin', '<option value="">Все города</option>');
      qrCitySel.value = ''; // insertAdjacentHTML не меняет уже выбранное значение — фиксируем явно
      qrRenderPointOptions();
      const sprod = document.getElementById('qr-sel-product');
      QR_PRODUCTS.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.icon + ' ' + p.name;
        sprod.appendChild(o);
      });
      qrSelectsPopulated = true;
    }
    await qrLoadLibrary();
    document.getElementById('qr-sel-size').value = '140';
    qrGenerate();
  } catch (e) {
    console.error('Не удалось запустить генератор QR:', e);
    document.getElementById('qr-lib-error').style.display = 'block';
  }
}

// Перерисовывает список точек с учётом выбранного города (или все города,
// если фильтр не задан) — вызывается при первой загрузке и при смене города.
function qrRenderPointOptions() {
  const cityFilter = document.getElementById('qr-sel-city').value;
  const cityName = (id) => (ADMIN_CITIES_CACHE || []).find((c) => c.id === id)?.name || id;
  const sp = document.getElementById('qr-sel-point');
  sp.innerHTML = '<option value="all">Все точки</option>';
  QR_POINTS
    .filter((p) => !cityFilter || p.city_id === cityFilter)
    .forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.icon + ' ' + p.name + (cityFilter ? '' : ' — ' + cityName(p.city_id));
      sp.appendChild(o);
    });
}

function qrCityChanged() {
  qrRenderPointOptions();
  qrGenerate();
}

function qrBuildURL(pointId, productId, cityId) {
  if (productId === '__sample__') return QR_SITE_URL + '/api/sample-qr/scan?point=' + encodeURIComponent(pointId);
  // В админке создаются только товарные QR: каждый сразу открывает лёгкую
  // карточку покупки конкретного товара на конкретной точке.
  return QR_SITE_URL + '/p/' + encodeURIComponent(pointId) + '/' + encodeURIComponent(productId);
}
function qrToSafeUrl(rawUrl) {
  try { return new URL(rawUrl).href; }
  catch (e) { return rawUrl; }
}

// Проставляет одно и то же количество копий сразу всем сгенерированным
// позициям — удобно, когда нужно, например, по 3 экземпляра каждой этикетки,
// а не подряд менять число в каждой карточке вручную.
function qrApplyBulkQty() {
  const parsed = parseInt(document.getElementById('qr-bulk-qty').value, 10);
  const qty = Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
  qrGenerated.forEach((item) => { item.qty = qty; });
  document.querySelectorAll('.qr-card input[type="number"]').forEach((el) => { el.value = qty; });
}

function qrGenerate() {
  const cityFilter    = document.getElementById('qr-sel-city').value;
  const pointFilter   = document.getElementById('qr-sel-point').value;
  const productFilter = document.getElementById('qr-sel-product').value;
  const qrSize         = parseInt(document.getElementById('qr-sel-size').value);

  // Сначала сужаем по городу (если выбран), затем — по конкретной точке
  // (если выбрана). "Все точки" при выбранном городе означает "все точки
  // этого города", а не вообще все точки сети.
  const cityPoints = cityFilter ? QR_POINTS.filter(p => p.city_id === cityFilter) : QR_POINTS;
  const points   = pointFilter   === 'all' ? cityPoints   : cityPoints.filter(p => p.id === pointFilter);
  const products = productFilter === '__sample__' ? [{ id: '__sample__', icon: '🎁', name: 'Бесплатный пробник', price: 0, weight: '' }] : (productFilter === 'all' ? QR_PRODUCTS : QR_PRODUCTS.filter(p => p.id === productFilter));

  qrGenerated = [];
  points.forEach(pt => { products.forEach(pr => { qrGenerated.push({ point: pt, product: pr }); }); });

  document.getElementById('qr-stats-row').innerHTML =
    `<div class="qr-stat-pill">Точек: <strong>${points.length}</strong></div>` +
    `<div class="qr-stat-pill">Товаров: <strong>${products.length}</strong></div>` +
    `<div class="qr-stat-pill">QR-кодов: <strong>${qrGenerated.length}</strong></div>`;

  const grid = document.getElementById('qr-grid');
  if (!qrGenerated.length) {
    grid.innerHTML = '<div class="qr-empty"><div class="ic">📱</div><p>Нет точек — сначала добавьте точку в разделе «Все точки».</p></div>';
    return;
  }
  grid.innerHTML = '';

  qrGenerated.forEach((item, idx) => {
    item.qty = item.qty || 1; // сколько копий этой этикетки печатать на листе А4
    const url = qrBuildURL(item.point.id, item.product.id, item.point.city_id);
    const cardId = 'qr-' + idx;
    const card = document.createElement('div');
    card.className = 'qr-card';
    card.innerHTML = `
      <div class="qr-card-head">
        <span class="qr-card-point">${item.point.icon} ${item.point.name}</span>
        <span class="qr-card-id">${item.product.id}</span>
      </div>
      <div class="qr-body">
        <img src="images/hvostmarket-logo-v3-transparent.png" alt="ХвостМаркет" class="qr-logo-full">
        <div class="qr-caption">${item.product.id === "__sample__" ? "Сканируйте QR пробника" : "Сканируйте для быстрой покупки этого товара"}</div>
        <div class="qr-box" id="${cardId}"></div>
        <div class="qr-product">${item.product.icon} ${item.product.name}</div>
        <div class="qr-price">${item.product.id === '__sample__' ? 'Бесплатно · инструкция покупки' : item.product.price + ' ₽ · ' + item.product.weight}</div>
        <div class="qr-url">${url}</div>
      </div>
      <div class="qr-actions no-print">
        <button class="qr-btn primary" onclick="qrDownloadGenerated(${idx})">⬇</button>
        <button class="qr-btn" onclick="qrCopyURL('${url}')">🔗 Ссылка</button>
      </div>
      <div class="no-print" style="display:flex;align-items:center;gap:.4rem;justify-content:center;padding:.5rem 0 0;font-size:.78rem;color:var(--muted);border-top:1px solid var(--border);margin-top:.5rem;">
        <span>Этикеток на листе А4:</span>
        <input type="number" min="0" value="${item.qty}" style="width:52px;text-align:center;padding:.2rem;border:1px solid var(--border);border-radius:4px;" onchange="const parsed = parseInt(this.value,10); qrGenerated[${idx}].qty = Number.isFinite(parsed) ? Math.max(0, parsed) : 1; this.value = qrGenerated[${idx}].qty;">
      </div>`;
    grid.appendChild(card);
    setTimeout(() => {
      try {
        new QRCode(document.getElementById(cardId), {
          text: qrToSafeUrl(url), width: qrSize, height: qrSize,
          colorDark: '#1C3A2F', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H,
        });
        qrDrawDogLogo(cardId, qrSize);
      } catch (e) {
        const box = document.getElementById(cardId);
        if (box) box.innerHTML = '<div style="color:#9B2335;font-size:.7rem;text-align:center;padding:.5rem;">⚠ Ошибка генерации</div>';
      }
    }, idx * 20);
  });
}

// Рисует компактный знак «ХвостМаркет» с собакой поверх центра QR-кода.
// генерируется с высоким уровнем коррекции ошибок (H, до 30% повреждений),
// поэтому логотип в центре не мешает сканированию. Белая подложка под
// знаком держит контраст и не даёт QR-паттерну «просвечивать» под ним.
//
// Кэшируем именно ПРОМИС загрузки, а не просто готовую картинку — карточки
// генерируются почти одновременно (со сдвигом по 20мс), и раньше каждая из
// них, видя пустой кэш, запускала СВОЮ отдельную загрузку картинки, что
// приводило к гонке и знак прорисовывался не на всех карточках. Теперь
// все вызовы дожидаются одной и той же загрузки.
let qrDogLogoPromise = null;
function qrGetDogLogo() {
  if (!qrDogLogoPromise) {
    qrDogLogoPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'images/hvostmarket-mark-v3-transparent.png';
    });
  }
  return qrDogLogoPromise;
}
function qrDrawDogLogo(cardId, qrSize) {
  const box = document.getElementById(cardId);
  const canvas = box && box.querySelector('canvas');
  if (!canvas) return Promise.resolve(false);
  const ctx = canvas.getContext('2d');
  return qrGetDogLogo().then((img) => {
    const logoWidth = Math.round(qrSize * 0.19);
    const logoHeight = Math.round(logoWidth * img.naturalHeight / img.naturalWidth);
    const cx = qrSize / 2, cy = qrSize / 2;
    const pad = Math.max(3, Math.round(qrSize * 0.018));
    const plateWidth = logoWidth + pad * 2;
    const plateHeight = logoHeight + pad * 2;
    const plateX = cx - plateWidth / 2;
    const plateY = cy - plateHeight / 2;
    const radius = Math.max(4, Math.round(qrSize * 0.025));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(plateX + radius, plateY);
    ctx.lineTo(plateX + plateWidth - radius, plateY);
    ctx.quadraticCurveTo(plateX + plateWidth, plateY, plateX + plateWidth, plateY + radius);
    ctx.lineTo(plateX + plateWidth, plateY + plateHeight - radius);
    ctx.quadraticCurveTo(plateX + plateWidth, plateY + plateHeight, plateX + plateWidth - radius, plateY + plateHeight);
    ctx.lineTo(plateX + radius, plateY + plateHeight);
    ctx.quadraticCurveTo(plateX, plateY + plateHeight, plateX, plateY + plateHeight - radius);
    ctx.lineTo(plateX, plateY + radius);
    ctx.quadraticCurveTo(plateX, plateY, plateX + radius, plateY);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.drawImage(img, cx - logoWidth / 2, cy - logoHeight / 2, logoWidth, logoHeight);
    ctx.restore();
    return true;
  }).catch(() => false);
}

// Печать на листах самоклеящихся этикеток А4 — 18 шт/лист (3×6), 66,7×46мм
// каждая. Использует тот же набор qrGenerated, что уже отфильтрован текущими
// настройками (город/точка/товар) — то есть печатает ровно то, что видно на
// экране. Печатные QR тоже получают компактный знак с собакой и высокий
// уровень коррекции ошибок; печать открывается только после его отрисовки.
async function printLabelSheet() {
  if (!qrGenerated.length) {
    alert('Сначала сгенерируйте QR-коды — сейчас список пуст.');
    return;
  }
  const container = document.getElementById('label-sheet-print');
  container.innerHTML = '';

  // Каждая позиция повторяется столько раз, сколько указано в поле
  // «Этикеток на листе А4» у её карточки (по умолчанию 1) — так можно
  // напечатать, например, сразу 5 наклеек одного и того же QR для одной точки.
  const expandedItems = [];
  qrGenerated.forEach((item) => {
    const copies = Number.isFinite(item.qty) ? Math.max(0, item.qty) : 1;
    for (let i = 0; i < copies; i++) expandedItems.push(item);
  });

  if (!expandedItems.length) {
    alert('Для печати укажите количество больше 0 хотя бы у одного товара.');
    return;
  }

  const PER_PAGE = 18;
  const pages = Math.ceil(expandedItems.length / PER_PAGE);
  const qrBoxIds = [];

  for (let p = 0; p < pages; p++) {
    const pageEl = document.createElement('div');
    pageEl.className = 'label-page';
    const pageItems = expandedItems.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE);
    pageItems.forEach((item, i) => {
      const idx = p * PER_PAGE + i;
      const boxId = 'lbl-qr-' + idx;
      qrBoxIds.push({ boxId, item });
      const url = qrBuildURL(item.point.id, item.product.id, item.point.city_id);
      const cell = document.createElement('div');
      cell.className = 'label-cell';
      cell.innerHTML = `
        <div class="lbl-qr" id="${boxId}"></div>
        <div class="lbl-name">${item.product.icon} ${item.product.name}</div>
        <div class="lbl-price">${item.product.id === '__sample__' ? 'Бесплатно · инструкция покупки' : item.product.price + ' ₽ · ' + item.product.weight}</div>
        <div class="lbl-point">${item.point.icon} ${item.point.name}</div>`;
      pageEl.appendChild(cell);
      cell.dataset.url = url;
    });
    while (pageEl.children.length < PER_PAGE) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'label-cell label-cell-empty';
      emptyCell.setAttribute('aria-hidden', 'true');
      pageEl.appendChild(emptyCell);
    }
    container.appendChild(pageEl);
  }

  // QR-коды в отдельном контейнере скрыты на экране (display:none у предка),
  // поэтому рисуем их сразу все — задержка между кадрами тут не нужна, как
  // в основной сетке (там она была нужна из-за одновременной прорисовки
  // видимых canvas-элементов на слабых устройствах).
  const logoDraws = [];
  qrBoxIds.forEach(({ boxId, item }) => {
    const url = qrBuildURL(item.point.id, item.product.id, item.point.city_id);
    try {
      new QRCode(document.getElementById(boxId), {
        text: qrToSafeUrl(url), width: 320, height: 320,
        colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H,
      });
      logoDraws.push(qrDrawDogLogo(boxId, 320));
    } catch (e) { /* пропускаем нечитаемую ячейку, остальные лист не портят */ }
  });

  await Promise.all(logoDraws);

  // Даём браузеру кадр на отрисовку canvas-ов перед вызовом печати.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('printing-labels');
      let pageStyle = document.getElementById('qr-label-a4-page-style');
      if (!pageStyle) {
        pageStyle = document.createElement('style');
        pageStyle.id = 'qr-label-a4-page-style';
        document.head.appendChild(pageStyle);
      }
      pageStyle.textContent = '@page { size: A4; margin: 0; }';
      window.print();
    });
  });
}

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-labels');
  document.getElementById('qr-label-a4-page-style')?.remove();
});

function qrWrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = line + ' ' + words[i];
    if (ctx.measureText(test).width > maxWidth) { lines.push(line); line = words[i]; }
    else { line = test; }
  }
  lines.push(line);
  if (lines.length > 1 && !lines[lines.length - 1].includes(' ')) {
    const merged = lines[lines.length - 2] + ' ' + lines[lines.length - 1];
    if (ctx.measureText(merged).width <= maxWidth) {
      lines[lines.length - 2] = merged;
      lines.pop();
    }
  }
  return lines;
}

let qrFullLogoImg = null;
function qrLoadFullLogo() {
  if (qrFullLogoImg) return Promise.resolve(qrFullLogoImg);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { qrFullLogoImg = img; resolve(img); };
    img.onerror = reject;
    img.src = 'images/hvostmarket-logo-v3-transparent.png';
  });
}

async function qrDownloadOne(cardId, name) {
  const box = document.getElementById(cardId);
  const canvas = box.querySelector('canvas');
  if (!canvas) { alert('QR ещё генерируется, подождите секунду'); return; }
  const sz = canvas.width;
  const pad = 10;

  const logoImg = await qrLoadFullLogo().catch(() => null);
  const logoW = Math.round(sz * 0.62);
  const logoH = logoImg ? Math.round(logoW * (logoImg.height / logoImg.width)) : 0;

  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = 'bold 13px Arial';
  const titleLines = qrWrapText(measureCtx, 'Для покупки отсканируйте здесь', sz - pad * 2);
  measureCtx.font = '11px Arial';
  const subLines = qrWrapText(measureCtx, 'Карточка товара откроется сразу', sz - pad * 2);

  measureCtx.font = 'bold 14px Arial';
  const nameLines = qrWrapText(measureCtx, name.replace('_', ' · '), sz - pad * 2);
  measureCtx.font = '10px Arial';
  const taglineLines = qrWrapText(measureCtx, 'Товары для питомцев рядом', sz - pad * 2);

  const headerH = 10 + logoH + 8 + titleLines.length * 17 + subLines.length * 15 + 8;
  const footerH = 10 + nameLines.length * 16 + 20 + taglineLines.length * 13 + 8;

  const c = document.createElement('canvas');
  c.width = sz; c.height = headerH + sz + footerH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center';

  let y = 10;
  if (logoImg) { ctx.drawImage(logoImg, (sz - logoW) / 2, y, logoW, logoH); y += logoH + 8; }

  ctx.fillStyle = '#1C3A2F'; ctx.font = 'bold 13px Arial';
  titleLines.forEach(l => { y += 17; ctx.fillText(l, sz / 2, y); });
  ctx.fillStyle = '#2A2218'; ctx.font = '11px Arial';
  subLines.forEach(l => { y += 15; ctx.fillText(l, sz / 2, y); });

  ctx.drawImage(canvas, 0, headerH);

  let fy = headerH + sz + 10;
  ctx.fillStyle = '#1C3A2F'; ctx.font = 'bold 14px Arial';
  nameLines.forEach(l => { fy += 16; ctx.fillText(l, sz/2, fy); });
  fy += 20;
  ctx.fillStyle = '#D4872A'; ctx.font = '12px Arial';
  ctx.fillText('хвостмаркет.рф', sz/2, fy);
  ctx.fillStyle = '#8A7D6B'; ctx.font = '10px Arial';
  taglineLines.forEach(l => { fy += 13; ctx.fillText(l, sz/2, fy); });

  const a = document.createElement('a');
  a.download = 'QR_Тайга_' + name + '.png';
  a.href = c.toDataURL('image/png');
  a.click();
}

async function qrDownloadAll() {
  if (!qrGenerated.length) { alert('Сначала нажмите «Сгенерировать»'); return; }
  for (let idx = 0; idx < qrGenerated.length; idx++) {
    await new Promise(res => setTimeout(res, 150));
    const item = qrGenerated[idx];
    await qrDownloadOne('qr-' + idx, item.point.name + '_' + item.product.name);
  }
}

async function qrDownloadGenerated(idx) {
  const item = qrGenerated[idx];
  if (!item) return;
  await qrDownloadOne('qr-' + idx, item.point.name + '_' + item.product.name);
}

function qrCopyURL(url) {
  navigator.clipboard?.writeText(url).catch(() => {});
  const toast = document.createElement('div');
  toast.textContent = '✓ Ссылка скопирована';
  toast.style.cssText = 'position:fixed;bottom:2rem;right:2rem;background:#1C3A2F;color:#fff;padding:.75rem 1.25rem;border-radius:8px;font-size:.85rem;z-index:999;';
  document.body.appendChild(toast);
  setTimeout(() => document.body.removeChild(toast), 2000);
}

// Readiness marker is assigned only after the complete script has executed.
window.HvostAdminQrReady=true;
