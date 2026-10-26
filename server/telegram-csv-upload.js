// Reliable Telegram CSV attachments for management reports.
// Observe chat rate limits and retry ONLY explicitly rejected (HTTP 429) calls.
// Never retry an unknown network outcome: the document may already be delivered.
'use strict';

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 60;
const HTTP_TIMEOUT_MS = 30000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTelegramUploadError(description, status, code, retryAfter) {
  const error = new Error(String(description || 'Telegram rejected a document upload'));
  error.name = 'TelegramUploadError';
  error.status = status;
  error.telegramCode = code;
  error.retryAfter = retryAfter;
  return error;
}

/**
 * @param {{token:string, chatId:string|number, csvText:string,
 *          filename:string, caption:string, fetchImpl?:Function, sleep?:Function}} options
 */
async function sendTelegramCsvDocument(options) {
  const { token, chatId, csvText, filename, caption } = options;
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || pause;
  if (!token || !chatId) throw new Error('Telegram token or chat ID is missing');
  if (typeof csvText !== 'string') throw new Error('CSV text has not been generated');
  const contents = new Blob([csvText], { type: 'text/csv;charset=utf-8' });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', String(caption || '').slice(0, 900));
    form.append('document', contents, String(filename));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response;
    let body;
    try {
      response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendDocument', {
        method: 'POST', body: form, signal: controller.signal,
      });
      body = await response.json().catch(() => ({}));
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok && body && body.ok) return { ok: true, attempts: attempt + 1 };

    const code = Number(body?.error_code || response.status) || response.status;
    const seconds = Number(body?.parameters?.retry_after);
    const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
    if (code === 429 && attempt < MAX_RETRIES) {
      const waitSeconds = retryAfter ?? 2;
      if (waitSeconds <= MAX_RETRY_AFTER_SECONDS) {
        console.warn('[telegram-csv] Too Many Requests (429), retry in ' +
          waitSeconds + ' sec; attempt ' + (attempt + 2) + '/' + (MAX_RETRIES + 1));
        await sleep(waitSeconds * 1000 + 300);
        continue;
      }
    }
    throw createTelegramUploadError(body?.description || ('Telegram API HTTP ' + response.status),
      response.status, code, retryAfter);
  }
  throw new Error('Telegram CSV upload was not completed');
}

module.exports = {
  sendTelegramCsvDocument,
  createTelegramUploadError,
};
