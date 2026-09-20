// email.js — минимальный SMTP-клиент на встроенном node:tls (без внешних
// библиотек — сеть для npm install недоступна в этом окружении). Отправляет
// копию каждого оплаченного заказа на почту компании (BUSINESS_COPY_EMAIL).
'use strict';

const tls = require('node:tls');
const net = require('node:net');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false'; // по умолчанию TLS сразу (порт 465)
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const BUSINESS_COPY_EMAIL = process.env.BUSINESS_COPY_EMAIL || '';

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD);
}

// Читает одну (возможно многострочную) SMTP-реакцию вида:
//   250-PIPELINING\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n
// Последняя строка отличается пробелом после кода вместо дефиса.
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: parseInt(last.slice(0, 3), 10), text: buffer });
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onTimeout = () => { cleanup(); reject(new Error('Тайм-аут ожидания ответа SMTP-сервера')); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  });
}

function sendLine(socket, line) {
  socket.write(line + '\r\n');
}

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function b64Buffer(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

// Кодирует не-ASCII тему письма по RFC 2047 (=?UTF-8?B?...?=), иначе кириллица
// в теме письма будет отображаться некорректно у части почтовых клиентов.
function encodeSubject(subject) {
  return '=?UTF-8?B?' + b64(subject) + '?=';
}

function buildMessage({ from, to, subject, text, attachments }) {
  const headerBase = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
  ];

  if (!attachments || attachments.length === 0) {
    return [
      ...headerBase,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(text).replace(/(.{76})/g, '$1\r\n'),
      '.',
    ].join('\r\n');
  }

  // С вложениями — multipart/mixed: текстовая часть + один или несколько файлов.
  const boundary = 'taiga-boundary-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ];
  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      b64Buffer(att.content)
    );
  }
  parts.push(`--${boundary}--`, '.');

  return [
    ...headerBase,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
  ].join('\r\n');
}

async function sendEmail({ to, subject, text, attachments }) {
  const recipient = to || BUSINESS_COPY_EMAIL;
  if (!isConfigured() || !recipient) {
    console.warn('Email не настроен (SMTP_HOST/SMTP_USER/SMTP_PASSWORD/BUSINESS_COPY_EMAIL пусты) — письмо пропущено');
    return { ok: false, skipped: true };
  }

  return new Promise((resolve) => {
    const connectFn = SMTP_SECURE ? tls.connect : net.connect;
    const socket = connectFn({ host: SMTP_HOST, port: SMTP_PORT, timeout: 10000 });
    socket.setTimeout(10000);

    let settled = false;
    const fail = (err) => {
      if (settled) return; // соединение уже успешно завершилось — поздняя ошибка при закрытии не считается
      settled = true;
      console.error('Ошибка отправки письма:', err.message);
      try { socket.destroy(); } catch (e) {}
      resolve({ ok: false, error: err.message });
    };
    const succeed = (result) => {
      settled = true;
      resolve(result);
    };

    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('Тайм-аут соединения с SMTP-сервером')));

    socket.on(SMTP_SECURE ? 'secureConnect' : 'connect', async () => {
      try {
        await readResponse(socket); // 220 приветствие сервера

        sendLine(socket, 'EHLO taiga-korm.ru');
        await readResponse(socket);

        sendLine(socket, 'AUTH LOGIN');
        await readResponse(socket); // 334 запрос логина (base64)

        sendLine(socket, b64(SMTP_USER));
        await readResponse(socket); // 334 запрос пароля (base64)

        sendLine(socket, b64(SMTP_PASSWORD));
        const authRes = await readResponse(socket); // 235 успешная авторизация
        if (authRes.code !== 235) throw new Error('Не удалось авторизоваться на SMTP-сервере: ' + authRes.text.trim());

        sendLine(socket, `MAIL FROM:<${SMTP_USER}>`);
        await readResponse(socket);

        sendLine(socket, `RCPT TO:<${recipient}>`);
        await readResponse(socket);

        sendLine(socket, 'DATA');
        await readResponse(socket); // 354 продолжайте, завершите точкой на отдельной строке

        const message = buildMessage({ from: SMTP_USER, to: recipient, subject, text, attachments });
        sendLine(socket, message);
        const dataRes = await readResponse(socket); // 250 письмо принято к отправке

        sendLine(socket, 'QUIT');
        succeed({ ok: dataRes.code === 250, code: dataRes.code });
        socket.end();
      } catch (e) {
        fail(e);
      }
    });
  });
}

module.exports = { sendEmail, isConfigured };
