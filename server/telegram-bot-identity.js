// Canonical personal Telegram bot of HvostMarket. One username for all login flows.
'use strict';

// A stale TG_BOT_USERNAME environment variable must never route invitations
// to another bot. TG_TOKEN is still supplied securely by the server environment.
const TELEGRAM_BOT_USERNAME = 'HvostMarketRusBot';
const TELEGRAM_BOT_URL = 'https://t.me/' + TELEGRAM_BOT_USERNAME;

function telegramStartLink(token) {
  return TELEGRAM_BOT_URL + '?start=' + encodeURIComponent(String(token));
}

module.exports = { TELEGRAM_BOT_USERNAME, TELEGRAM_BOT_URL, telegramStartLink };
