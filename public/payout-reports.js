'use strict';

let payoutReportRole = 'partner';
let payoutReportDocument = null;

function reportEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function reportDateString(date) { return date.toISOString().slice(0, 10); }
function setReportPeriod(preset) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  let start, end;
  if (preset === '14') { end = new Date(Date.UTC(y, m, now.getUTCDate() - 1)); start = new Date(end.getTime() - 13 * 86400000); }
  else if (preset === 'first') { start = new Date(Date.UTC(y, m, 1)); end = new Date(Date.UTC(y, m, 15)); }
  else if (preset === 'second') { start = new Date(Date.UTC(y, m, 16)); end = new Date(Date.UTC(y, m + 1, 0)); }
  else if (now.getUTCDate() < 16) { start = new Date(Date.UTC(y, m - 1, 16)); end = new Date(Date.UTC(y, m, 0)); }
  else { start = new Date(Date.UTC(y, m, 1)); end = new Date(Date.UTC(y, m, 15)); }
  document.getElementById('pr-start').value = reportDateString(start);
  document.getElementById('pr-end').value = reportDateString(end);
}

function ensureReportModal() {
  if (document.getElementById('payout-report-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'payout-report-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1200;overflow:auto;padding:20px;';
  modal.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="pr-title" style="background:#fff;border-radius:12px;max-width:850px;margin:20px auto;padding:20px;color:#222;">
    <button class="row-btn" style="float:right;" onclick="document.getElementById('payout-report-modal').style.display='none'">Закрыть</button>
    <h2 id="pr-title">Отчёт к договору</h2><p style="font-size:.8rem;">Формирование отчёта не переводит деньги и не отмечает выплату. Для PDF откройте документ и выберите «Печать».</p>
    <div id="pr-form"><label>Получатель <select id="pr-recipient" style="width:100%;margin-bottom:12px;"></select></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="row-btn" onclick="setReportPeriod('previous')">Последняя закрытая половина месяца</button>
      <button class="row-btn" onclick="setReportPeriod('14')">Последние 14 полных дней</button>
      <button class="row-btn" onclick="setReportPeriod('first')">1–15 текущего месяца</button>
      <button class="row-btn" onclick="setReportPeriod('second')">16–конец месяца</button>
    </div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      <label>С <input id="pr-start" type="date"></label><label>По <input id="pr-end" type="date"></label>
      <label>Договор № <input id="pr-contract-number" maxlength="120"></label><label>Дата договора <input id="pr-contract-date" type="date"></label>
    </div>
    <label>Заказчик / принципал и реквизиты <textarea id="pr-principal" style="width:100%;" maxlength="1200"></textarea></label>
    <label>Реквизиты получателя <textarea id="pr-recipient-details" style="width:100%;" maxlength="1200"></textarea></label>
    <label>Фактически выполненные действия или услуги <textarea id="pr-actions" style="width:100%;" maxlength="5000" placeholder="Заполните по реальным действиям; продажи сами по себе не заменяют отчёт об услугах."></textarea></label>
    <label>Налоговый статус и удержания по данным бухгалтера <input id="pr-tax-note" style="width:100%;" maxlength="1200"></label>
    <label>Банковский платёж при наличии <input id="pr-payment-reference" style="width:100%;" maxlength="1200"></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;"><button class="row-btn" onclick="generatePayoutReport(false)">Предпросмотр</button><button class="row-btn" onclick="generatePayoutReport(true)">Сформировать и сохранить</button></div></div>
    <p id="pr-error" role="alert" style="color:#a22;"></p><div id="pr-result"></div>
    <h3>Сохранённые отчёты</h3><div id="pr-archive"></div>
  </div>`;
  document.body.appendChild(modal);
}

async function reportRequest(url, options) {
  const res = await authFetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить отчёт');
  return data;
}

async function openPayoutReports(role) {
  ensureReportModal(); payoutReportRole = role; payoutReportDocument = null;
  document.getElementById('payout-report-modal').style.display = 'block';
  document.getElementById('pr-form').style.display = 'block';
  document.getElementById('pr-title').textContent = role === 'owner' ? 'Отчёт владельца салона' : 'Отчёт грумера';
  document.getElementById('pr-result').innerHTML = '';
  document.getElementById('pr-error').textContent = '';
  document.getElementById('pr-recipient').innerHTML = '';
  for (const field of ['contract-number','contract-date','principal','recipient-details','actions','tax-note','payment-reference']) document.getElementById('pr-' + field).value = '';
  setReportPeriod('previous');
  try {
    const data = await reportRequest('/api/payout-reports/recipients?role=' + role);
    document.getElementById('pr-recipient').innerHTML = data.recipients.map(r => `<option value="${Number(r.id)}">${reportEscape(r.full_name)} · ${reportEscape(r.code)}</option>`).join('');
    await loadPayoutReportArchive();
  } catch (error) { document.getElementById('pr-error').textContent = error.message; }
}

async function loadPayoutReportArchive() {
  const data = await reportRequest('/api/payout-reports?role=' + payoutReportRole);
  document.getElementById('pr-archive').innerHTML = data.reports.length ? data.reports.map(r => `<p><button class="row-btn" onclick="loadSavedPayoutReport(${Number(r.id)})">Отчёт № ${Number(r.id)}</button> ${reportEscape(r.recipient_name)} · ${reportEscape(r.period_start || 'по выплате')} — ${reportEscape(r.period_end || '')}${r.payout_id ? ' · выплата № ' + Number(r.payout_id) : ''}</p>`).join('') : '<p>Сохранённых отчётов пока нет.</p>';
}

function displayPayoutReport(data) {
  payoutReportDocument = data.html;
  const r = data.report;
  document.getElementById('pr-result').innerHTML = `<p><strong>${r.id ? 'Сохранён отчёт № ' + Number(r.id) : 'Предпросмотр без сохранения'}.</strong> Заказов: ${r.items.length}; начислено ${Number(r.accrued).toLocaleString('ru-RU')} ₽${r.kind === 'payout' ? '; выплата ' + Number(r.payout_amount).toLocaleString('ru-RU') + ' ₽' : '; ещё не выплачено ' + Number(r.unpaid).toLocaleString('ru-RU') + ' ₽'}.</p>
  <button class="row-btn" onclick="openPrintablePayoutReport()">Открыть для печати / PDF</button> <button class="row-btn" onclick="downloadPayoutReport()">Скачать HTML</button>
  <ul style="padding-left:20px;font-size:.8rem;">${r.warnings.map(w => '<li>' + reportEscape(w) + '</li>').join('')}</ul>`;
}

let reportGenerationRunning = false;
async function generatePayoutReport(save) {
  if (reportGenerationRunning) return;
  reportGenerationRunning = true;
  document.getElementById('pr-error').textContent = '';
  try {
    const meta = {};
    for (const field of ['contract-number','contract-date','principal','recipient-details','actions','tax-note','payment-reference']) meta[field.replaceAll('-', '_')] = document.getElementById('pr-' + field).value;
    const data = await reportRequest('/api/payout-reports/period', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:payoutReportRole,recipient_id:Number(document.getElementById('pr-recipient').value),start:document.getElementById('pr-start').value,end:document.getElementById('pr-end').value,metadata:meta,save}) });
    displayPayoutReport(data);
    if (save) await loadPayoutReportArchive();
  } catch (error) { document.getElementById('pr-error').textContent = error.message; }
  finally { reportGenerationRunning = false; }
}

async function loadSavedPayoutReport(id) {
  try { displayPayoutReport(await reportRequest('/api/payout-reports/' + id)); }
  catch (error) { document.getElementById('pr-error').textContent = error.message; }
}

async function openPayoutReportForPayment(role, id) {
  ensureReportModal(); payoutReportRole = role; payoutReportDocument = null;
  document.getElementById('payout-report-modal').style.display = 'block';
  document.getElementById('pr-form').style.display = 'none';
  document.getElementById('pr-result').textContent = 'Загружаем…';
  document.getElementById('pr-error').textContent = '';
  document.getElementById('pr-title').textContent = 'Отчёт по выплате № ' + id;
  try {
    displayPayoutReport(await reportRequest('/api/payout-reports/from-payout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,payout_id:id})}));
    await loadPayoutReportArchive();
  } catch (error) { document.getElementById('pr-result').textContent = ''; document.getElementById('pr-error').textContent = error.message; }
}

function payoutReportBlob() { return URL.createObjectURL(new Blob([payoutReportDocument], {type:'text/html;charset=utf-8'})); }
function openPrintablePayoutReport() {
  if (!payoutReportDocument) return;
  const url = payoutReportBlob();
  const opened = window.open(url, '_blank');
  if (opened) opened.opener = null;
  else document.getElementById('pr-error').textContent = 'Браузер запретил новое окно. Разрешите его или скачайте HTML.';
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function downloadPayoutReport() {
  if (!payoutReportDocument) return;
  const url = payoutReportBlob(), link = document.createElement('a');
  link.href = url; link.download = 'HvostMarket_report.html'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
