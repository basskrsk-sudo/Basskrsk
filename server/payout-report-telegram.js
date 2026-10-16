'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function workReportTarget() {
  const chatId = String(process.env.TG_CHAT_ID || '').trim();
  return { configured:!!(process.env.TG_TOKEN && chatId), chatId,
    key:crypto.createHash('sha256').update('payout-work-chat:' + chatId).digest('hex'),
    label:'Рабочий Telegram-бот ХвостМаркета (служебный чат)' };
}
function deliveryStatus(db, reportId, target = workReportTarget()) {
  const previous = db.prepare('SELECT status, sent_at FROM payout_report_deliveries WHERE report_id = ? AND target_chat_id = ?').get(reportId, target.chatId);
  return { configured:target.configured, target_label:target.label, target_key:target.key,
    status:previous?.status || null, sent_at:previous?.sent_at || null };
}
function error(message, statusCode, code) { return Object.assign(new Error(message), {statusCode,code}); }

async function sendWorkReport(db, report, admin, options, dependencies = {}) {
  if (options?.confirm !== true) throw error('Подтвердите отправку отчёта в рабочий Telegram-бот',400);
  const target = (dependencies.target || workReportTarget)();
  if (!target.configured) throw error('Рабочий Telegram-бот не настроен: нужны TG_TOKEN и TG_CHAT_ID',503);
  if (options.target_key !== target.key) throw error('Настройки рабочего чата изменились. Повторно выберите отправку.',409,'TARGET_CHANGED');
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT *, updated_at < datetime(\'now\', \'-10 minutes\') AS stale FROM payout_report_deliveries WHERE report_id = ? AND target_chat_id = ?').get(report.id,target.chatId);
    if (prior?.status === 'sent') { db.exec('COMMIT'); return {already_sent:true,sent_at:prior.sent_at,target_label:target.label}; }
    if (prior?.status === 'pending' && !prior.stale) throw error('Этот отчёт уже формируется или отправляется. Дождитесь результата.',409,'DELIVERY_PENDING');
    if ((prior?.status === 'unknown' || (prior?.status === 'pending' && prior.stale)) && options.force !== true) {
      throw error('Доставка предыдущей попытки не подтверждена. Проверьте рабочий чат перед повтором.',409,'DELIVERY_UNCERTAIN');
    }
    db.prepare(`INSERT INTO payout_report_deliveries (report_id,target_chat_id,admin_id,admin_login)
      VALUES (?, ?, ?, ?) ON CONFLICT(report_id,target_chat_id) DO UPDATE SET status='pending',
      admin_id=excluded.admin_id,admin_login=excluded.admin_login,error=NULL,updated_at=datetime('now')`)
      .run(report.id,target.chatId,admin.id || null,admin.login || null);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  let dir, providerStarted = false;
  const setFailure = (status, message) => db.prepare("UPDATE payout_report_deliveries SET status=?,error=?,updated_at=datetime('now') WHERE report_id=? AND target_chat_id=?")
    .run(status,String(message || '').slice(0,500),report.id,target.chatId);
  try {
    const render = dependencies.renderPdf || require('./payout-report-pdf').renderPayoutPdf;
    const send = dependencies.sendDocument || require('./telegram').sendTelegramDocument;
    const pdf = await render(report);
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(),'hvost-payout-telegram-'));
    const file = path.join(dir,'HvostMarket_report_' + report.id + '.pdf');
    await fs.promises.writeFile(file,pdf);
    const rub = value => Number(value || 0).toLocaleString('ru-RU') + ' ₽';
    const caption = ['Отчёт ' + (report.role === 'owner' ? 'владельца салона' : report.role === 'manager' ? 'менеджера' : 'грумера') + ' — ХвостМаркет','Отчёт № ' + report.id,
      'Получатель: ' + report.recipient.name,
      'Период расчёта: ' + (report.period_start || 'по составу выплаты') + ' — ' + (report.period_end || ''),
      'Заказов: ' + report.items.length,'Начислено: ' + rub(report.accrued),
      report.kind === 'payout' ? 'Сумма выплаты: ' + rub(report.payout_amount) : 'К выплате: ' + rub(report.unpaid)].join('\n');
    providerStarted = true;
    const result = await send(file,caption);
    if (!(result.ok && result.data?.ok === true && result.data?.result?.message_id)) {
      const uncertain = !result.skipped && (!result.status || result.status >= 500);
      setFailure(uncertain ? 'unknown' : 'failed', result.error || result.data?.description || 'Telegram не подтвердил отправку');
      throw error(uncertain ? 'Telegram не подтвердил доставку. Проверьте рабочий чат перед повторной отправкой.' : 'Не удалось отправить PDF в рабочий бот. Проверьте настройки бота и доступ к чату.',502,uncertain ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_FAILED');
    }
    db.prepare("UPDATE payout_report_deliveries SET status='sent',message_id=?,error=NULL,sent_at=datetime('now'),updated_at=datetime('now') WHERE report_id=? AND target_chat_id=?")
      .run(String(result.data.result.message_id),report.id,target.chatId);
    return {already_sent:false,target_label:target.label,sent_at:db.prepare('SELECT sent_at FROM payout_report_deliveries WHERE report_id=? AND target_chat_id=?').get(report.id,target.chatId).sent_at};
  } catch(e) {
    if (!e.code?.startsWith('DELIVERY_')) setFailure(providerStarted ? 'unknown' : 'failed',e.message);
    throw e;
  } finally { if (dir) await fs.promises.rm(dir,{recursive:true,force:true}); }
}
module.exports = { workReportTarget, deliveryStatus, sendWorkReport };
