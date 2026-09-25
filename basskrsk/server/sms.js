// sms.js — отправка SMS через SMS.ru (простой HTTP API, без внешних библиотек).
'use strict';

const SMS_RU_API_ID = process.env.SMS_RU_API_ID || '';

function isConfigured() {
  return Boolean(SMS_RU_API_ID);
}

async function sendSms({ to, text }) {
  if (!isConfigured()) {
    console.warn('SMS не настроено (нет SMS_RU_API_ID) — сообщение пропущено');
    return { ok: false, skipped: true };
  }
  const digits = String(to).replace(/\D/g, '');
  const params = new URLSearchParams({ api_id: SMS_RU_API_ID, to: digits, msg: text, json: '1' });
  try {
    const res = await fetch('https://sms.ru/sms/send?' + params.toString());
    const data = await res.json();
    if (data.status !== 'OK') {
      console.error('Ошибка SMS.ru:', data.status_text || JSON.stringify(data));
      return { ok: false, error: data.status_text || 'Ошибка отправки SMS' };
    }
    // sms.ru возвращает статус по каждому номеру отдельно в data.sms[digits]
    const perNumber = data.sms && data.sms[digits];
    if (perNumber && perNumber.status !== 'OK') {
      console.error('SMS.ru отклонил номер:', perNumber.status_text);
      return { ok: false, error: perNumber.status_text || 'Не удалось отправить на этот номер' };
    }
    return { ok: true };
  } catch (e) {
    console.error('Ошибка сети при отправке SMS:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendSms, isConfigured };
