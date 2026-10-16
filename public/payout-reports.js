'use strict';

let payoutReportRole = 'partner';
let payoutReportDocument = null;
let payoutReportData = null;
let payoutReportEpoch = 0;

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
  modal.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="pr-title" style="background:#fff;border-radius:12px;max-width:1120px;margin:20px auto;padding:20px;color:#222;">
    <button class="row-btn" style="float:right;" onclick="document.getElementById('payout-report-modal').style.display='none'">Закрыть</button>
    <h2 id="pr-title">Отчёт партнёру за период</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;"><button class="row-btn" onclick="openPayoutReports('partner')">Грумеры</button><button class="row-btn" onclick="openPayoutReports('owner')">Владельцы салонов</button><button class="row-btn" onclick="openPayoutReports('manager')">Менеджеры</button></div>
    <p id="pr-description" style="font-size:.85rem;">Выберите получателя и период расчёта.</p>
    <div id="pr-form"><label><span id="pr-recipient-label">Получатель</span> <select id="pr-recipient" onchange="changeReportRecipient()" style="width:100%;margin-bottom:12px;"></select></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="row-btn" onclick="setReportPeriod('previous')">Последняя закрытая половина месяца</button>
      <button class="row-btn" onclick="setReportPeriod('14')">Последние 14 полных дней</button>
      <button class="row-btn" onclick="setReportPeriod('first')">1–15 текущего месяца</button>
      <button class="row-btn" onclick="setReportPeriod('second')">16–конец месяца</button>
    </div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
      <label>С <input id="pr-start" type="date"></label><label>По <input id="pr-end" type="date"></label>
      <label>Договор № <input id="pr-contract-number" maxlength="120"></label><label>Дата договора <input id="pr-contract-date" type="date"></label>
    </div>
    <p style="font-size:.8rem;">Даты включаются полностью, по времени UTC. Формирование отчёта сохраняет расчёт и не отмечает перевод денег.</p>
    <details><summary>Договор, реквизиты и дополнительные сведения</summary>
    <label>Заказчик / принципал и реквизиты <textarea id="pr-principal" style="width:100%;" maxlength="1200"></textarea></label>
    <label>Реквизиты получателя <textarea id="pr-recipient-details" style="width:100%;" maxlength="1200"></textarea></label>
    <label>Фактически выполненные действия или услуги <textarea id="pr-actions" style="width:100%;" maxlength="5000" placeholder="Заполните по реальным действиям; продажи сами по себе не заменяют отчёт об услугах."></textarea></label>
    <label>Налоговый статус и удержания по данным бухгалтера <input id="pr-tax-note" style="width:100%;" maxlength="1200"></label>
    <label>Банковский платёж при наличии <input id="pr-payment-reference" style="width:100%;" maxlength="1200"></label></details>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;"><button class="row-btn" onclick="generatePayoutReport(false)">Предпросмотр</button><button class="row-btn" onclick="generatePayoutReport(true)">Сформировать и сохранить</button></div></div>
    <p id="pr-error" role="alert" style="color:#a22;"></p><div id="pr-result"></div>
    <div id="pr-bonuses"></div>
    <h3>Сохранённые отчёты</h3><div id="pr-archive"></div>
  </div>`;
  document.body.appendChild(modal);
}

async function reportRequest(url, options) {
  const res = await authFetch(url, options);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Не удалось загрузить отчёт'), {code:data.code});
  return data;
}

async function openPayoutReports(role) {
  ensureReportModal(); payoutReportRole = role; payoutReportDocument = null; payoutReportData = null;
  const epoch = ++payoutReportEpoch;
  document.getElementById('payout-report-modal').style.display = 'block';
  document.getElementById('pr-form').style.display = 'block';
  document.getElementById('pr-title').textContent = role === 'owner' ? 'Отчёт владельца салона' : role === 'manager' ? 'Отчёт менеджера' : 'Отчёт грумера';
  document.getElementById('pr-recipient-label').textContent = role === 'owner' ? 'Владелец салона' : role === 'manager' ? 'Менеджер' : 'Грумер';
  document.getElementById('pr-description').textContent = role === 'owner'
    ? 'Выберите владельца и период. В отчёте будут оплаченные заказы его точки, процент с продаж, начисления, бонусы за привлечение точек и остаток к выплате.'
    : role === 'manager'
      ? 'Выберите менеджера и период. В отчёте будут заказы по его точкам, сводка по каждой точке, проценты, бонусы запуска и итог к выплате.'
      : 'Выберите грумера и период. В отчёте будут заказы, ставки по каждому заказу, начисления, бонусы за привлечение точек и итог к выплате.';
  document.getElementById('pr-result').innerHTML = '';
  document.getElementById('pr-error').textContent = '';
  document.getElementById('pr-recipient').innerHTML = '';
  document.getElementById('pr-bonuses').innerHTML = '';
  for (const field of ['contract-number','contract-date','principal','recipient-details','actions','tax-note','payment-reference']) document.getElementById('pr-' + field).value = '';
  setReportPeriod('previous');
  try {
    const data = await reportRequest('/api/payout-reports/recipients?role=' + role);
    if (epoch !== payoutReportEpoch) return;
    document.getElementById('pr-recipient').innerHTML = data.recipients.map(r => `<option value="${Number(r.id)}">${reportEscape(r.full_name)} · ${reportEscape(r.code)}</option>`).join('');
    await loadRecipientBonuses();
    await loadPayoutReportArchive();
  } catch (error) { document.getElementById('pr-error').textContent = error.message; }
}

async function loadPayoutReportArchive() {
  const epoch = payoutReportEpoch;
  const id = document.getElementById('pr-form').style.display === 'none' ? 0 : Number(document.getElementById('pr-recipient').value);
  const data = await reportRequest('/api/payout-reports?role=' + payoutReportRole + (id ? '&recipient_id=' + id : ''));
  if (epoch !== payoutReportEpoch) return;
  document.getElementById('pr-archive').innerHTML = data.reports.length ? data.reports.map(r => `<p><button class="row-btn" onclick="loadSavedPayoutReport(${Number(r.id)})">Отчёт № ${Number(r.id)}</button> ${reportEscape(r.recipient_name)} · ${reportEscape(r.period_start || 'по выплате')} — ${reportEscape(r.period_end || '')}${r.payout_id ? ' · выплата № ' + Number(r.payout_id) : ''}</p>`).join('') : '<p>Сохранённых отчётов пока нет.</p>';
}

function displayPayoutReport(data) {
  payoutReportDocument = data.html;
  const r = data.report;
  payoutReportData = r;
  document.getElementById('pr-result').innerHTML = `<h3>${reportEscape(r.recipient.name)} · ${reportEscape(r.period_start || 'по составу выплаты')} — ${reportEscape(r.period_end || '')}</h3>
  <div style="display:flex;gap:12px;flex-wrap:wrap;padding:16px;background:#edf5ef;border-radius:10px;margin:12px 0;"><span>Заказов: <strong>${r.items.length}</strong></span><span>Начислено: <strong>${Number(r.accrued).toLocaleString('ru-RU')} ₽</strong></span><span>${r.kind === 'payout' ? 'Выплата' : 'К выплате'}: <strong>${Number(r.kind === 'payout' ? r.payout_amount : r.unpaid).toLocaleString('ru-RU')} ₽</strong></span></div>
  <p>${r.id ? 'Сохранён отчёт № ' + Number(r.id) + '. Расчёт зафиксирован.' : 'Предпросмотр. При скачивании PDF будет сформирован и сохранён актуальный расчёт.'}</p>
  <button class="row-btn" id="pr-pdf-download" onclick="downloadPayoutPdf()">${r.id ? 'Скачать PDF' : 'Сохранить и скачать PDF'}</button> <button class="row-btn" onclick="openPrintablePayoutReport()">Открыть для печати</button> <button class="row-btn" onclick="downloadPayoutReport()">Скачать HTML</button>
  ${r.id ? '<button class="row-btn" id="pr-telegram-send" onclick="sendPayoutReportToWorkTelegram()">Отправить PDF в рабочий ТГ-бот</button><p id="pr-telegram-status" role="status" style="font-size:.85rem;"></p>' : '<p style="font-size:.8rem;">Для отправки в рабочий ТГ-бот сначала сохраните отчёт.</p>'}
  <iframe id="pr-preview" title="Предпросмотр отчёта партнёру" sandbox="" style="display:block;width:100%;height:620px;border:1px solid #ddd;border-radius:8px;margin:16px 0;background:#fff;"></iframe>
  <ul style="padding-left:20px;font-size:.8rem;">${r.warnings.map(w => '<li>' + reportEscape(w) + '</li>').join('')}</ul>`;
  document.getElementById('pr-preview').srcdoc = data.html.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '');
  if (r.version >= 2) document.getElementById('pr-result').insertAdjacentHTML('beforeend', `<p>Комиссия: ${Number(r.commission_accrued).toLocaleString('ru-RU')} ₽; бонусы: ${Number(r.bonus_accrued).toLocaleString('ru-RU')} ₽.${r.kind==='period' ? '<br>Фактические выплаты бонусов за период: '+(r.bonus_payments || []).reduce((s,b)=>s+Number(b.amount),0).toLocaleString('ru-RU')+' ₽ (показаны отдельно от начислений).' : ''}</p>`);
}

let reportGenerationRunning = false;
async function generatePayoutReport(save) {
  if (reportGenerationRunning) return;
  reportGenerationRunning = true;
  const epoch = ++payoutReportEpoch;
  document.getElementById('pr-error').textContent = '';
  try {
    const meta = {};
    for (const field of ['contract-number','contract-date','principal','recipient-details','actions','tax-note','payment-reference']) meta[field.replaceAll('-', '_')] = document.getElementById('pr-' + field).value;
    const data = await reportRequest('/api/payout-reports/period', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:payoutReportRole,recipient_id:Number(document.getElementById('pr-recipient').value),start:document.getElementById('pr-start').value,end:document.getElementById('pr-end').value,metadata:meta,save}) });
    if (epoch !== payoutReportEpoch) return;
    displayPayoutReport(data);
    if (save) await loadPayoutReportArchive();
    return data;
  } catch (error) { document.getElementById('pr-error').textContent = error.message; }
  finally { reportGenerationRunning = false; }
}

async function loadSavedPayoutReport(id) {
  const epoch = ++payoutReportEpoch;
  try { const data = await reportRequest('/api/payout-reports/' + id); if (epoch === payoutReportEpoch) displayPayoutReport(data); }
  catch (error) { document.getElementById('pr-error').textContent = error.message; }
}

async function openPayoutReportForPayment(role, id, payoutType = 'commission') {
  ensureReportModal(); payoutReportRole = role; payoutReportDocument = null; payoutReportData = null;
  const epoch = ++payoutReportEpoch;
  document.getElementById('payout-report-modal').style.display = 'block';
  document.getElementById('pr-form').style.display = 'none';
  document.getElementById('pr-result').textContent = 'Загружаем…';
  document.getElementById('pr-bonuses').innerHTML = '';
  document.getElementById('pr-error').textContent = '';
  document.getElementById('pr-title').textContent = 'Отчёт по выплате № ' + id;
  try {
    const data = await reportRequest('/api/payout-reports/from-payout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,payout_id:id,payout_type:payoutType})});
    if (epoch !== payoutReportEpoch) return;
    displayPayoutReport(data);
    await loadPayoutReportArchive();
  } catch (error) { document.getElementById('pr-result').textContent = ''; document.getElementById('pr-error').textContent = error.message; }
}

async function loadRecipientBonuses() {
  const role=payoutReportRole, recipient=Number(document.getElementById('pr-recipient').value);
  if (!recipient) return;
  try {
    const data=await reportRequest('/api/payout-reports/bonuses?role='+role+'&recipient_id='+recipient);
    if (role!==payoutReportRole || recipient!==Number(document.getElementById('pr-recipient').value)) return;
    const pending=data.pending.map(b=>`<p>${reportEscape(b.point_name)} · ${Number(b.amount).toLocaleString('ru-RU')} ₽ · начислено, не выплачено ${role==='manager' ? '(фиксация в разделе менеджеров)' : `<button class="row-btn" onclick="markReferralBonusPaid(${Number(b.manager_point_id)},${Number(b.amount)})">Зафиксировать перевод</button>`}</p>`).join('');
    const paid=data.paid.map(b=>`<p>${reportEscape(b.point_name)} · ${Number(b.amount).toLocaleString('ru-RU')} ₽ · ${reportEscape(b.paid_at)} <button class="row-btn" onclick="openPayoutReportForPayment('${role}',${Number(b.payout_id)},'${role==='manager'?'launch_bonus':'referral_bonus'}')">Отчёт по выплате</button></p>`).join('');
    document.getElementById('pr-bonuses').innerHTML='<h3>Бонусы за привлечение точек</h3>'+ (pending||'<p>Невыплаченных начисленных бонусов нет.</p>')+paid+'<p style="font-size:.8rem">Фиксируйте только уже выполненный перевод. Эта кнопка не отправляет деньги или сообщения.</p>';
  } catch(error) {document.getElementById('pr-error').textContent=error.message;}
}

let referralBonusSaving=false;
async function markReferralBonusPaid(managerPointId,amount) {
  if (referralBonusSaving) return;
  const select=document.getElementById('pr-recipient'), role=payoutReportRole,recipient=Number(select.value);
  if (!confirm('Подтвердите, что '+amount.toLocaleString('ru-RU')+' ₽ уже переведены получателю '+select.options[select.selectedIndex].text+'. Записать выплату бонуса и сохранить отчёт?')) return;
  referralBonusSaving=true;
  try {
    const data=await reportRequest('/api/payout-reports/bonus-payouts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,recipient_id:recipient,manager_point_id:managerPointId,expected_amount:amount,confirm_transferred:true})});
    displayPayoutReport(data); await loadRecipientBonuses(); await loadPayoutReportArchive();
  } catch(error) {document.getElementById('pr-error').textContent=error.message;}
  finally {referralBonusSaving=false;}
}

function payoutReportBlob() { return URL.createObjectURL(new Blob([payoutReportDocument], {type:'text/html;charset=utf-8'})); }
async function changeReportRecipient() {
  ++payoutReportEpoch; payoutReportDocument = null; payoutReportData = null;
  document.getElementById('pr-result').innerHTML = '';
  document.getElementById('pr-error').textContent = '';
  await Promise.all([loadRecipientBonuses(), loadPayoutReportArchive()]).catch(e => { document.getElementById('pr-error').textContent = e.message; });
}
let payoutPdfDownloading = false;
let payoutTelegramSending = false;
async function sendPayoutReportToWorkTelegram() {
  if (payoutTelegramSending || !payoutReportData?.id) return;
  const report = payoutReportData;
  const reportId = report.id;
  const button = document.getElementById('pr-telegram-send');
  const status = document.getElementById('pr-telegram-status');
  payoutTelegramSending = true;
  if (button) button.disabled = true;
  if (status) status.textContent = 'Проверяем рабочий Telegram-бот…';
  try {
    const target = await reportRequest('/api/payout-reports/' + reportId + '/telegram');
    if (!target.configured) throw new Error('Рабочий Telegram-бот не настроен. Проверьте TG_TOKEN и TG_CHAT_ID на сервере.');
    if (payoutReportData?.id !== reportId) return;
    if (target.status === 'sent') { if (status) status.textContent = 'Этот отчёт уже отправлен в рабочий ТГ-бот: ' + target.sent_at + ' UTC.'; return; }
    if (!confirm('Отправить PDF отчёта № ' + reportId + '?\nКуда: ' + target.target_label + '\nОтчёт для: ' + report.recipient.name + '\nПериод: ' + (report.period_start || 'по выплате') + ' — ' + (report.period_end || '') + '\nОтправка не фиксирует выплату денег.')) { if (status) status.textContent = ''; return; }
    if (status) status.textContent = 'Формируем и отправляем PDF…';
    const send = force => reportRequest('/api/payout-reports/' + reportId + '/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true,target_key:target.target_key,force})});
    let result;
    try { result = await send(false); }
    catch(e) {
      if (e.code !== 'DELIVERY_UNCERTAIN') throw e;
      if (!confirm('Предыдущая доставка не подтверждена. Проверьте рабочий чат. Если PDF там есть, нажмите «Отмена». Повторить отправку с возможным дубликатом?')) throw e;
      result = await send(true);
    }
    if (status) status.textContent = (result.already_sent ? 'Отчёт уже был отправлен' : 'PDF отправлен') + ' в рабочий ТГ-бот. ' + result.sent_at + ' UTC.';
  } catch(e) { if (status) status.textContent = e.message; }
  finally { payoutTelegramSending = false; if (button) button.disabled = false; }
}
async function downloadPayoutPdf() {
  if (payoutPdfDownloading || !payoutReportData) return;
  payoutPdfDownloading = true;
  const button = document.getElementById('pr-pdf-download');
  if (button) { button.disabled = true; button.textContent = 'Формируем PDF…'; }
  const epochBefore = payoutReportEpoch;
  try {
    let r = payoutReportData;
    if (!r.id) {
      const saved = await generatePayoutReport(true);
      if (!saved) return;
      r = saved.report;
    } else if (epochBefore !== payoutReportEpoch) return;
    const res = await authFetch('/api/payout-reports/' + r.id + '/pdf');
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Не удалось скачать PDF'); }
    const blob = await res.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'HvostMarket_report_' + r.id + '.pdf'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { document.getElementById('pr-error').textContent = e.message; }
  finally {
    payoutPdfDownloading = false;
    const current = document.getElementById('pr-pdf-download');
    if (current) { current.disabled = false; current.textContent = payoutReportData?.id ? 'Скачать PDF' : 'Сохранить и скачать PDF'; }
  }
}
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
