// One universal Telegram Mini App button for the EXISTING ХвостМаркет bot.
// Legacy ?view=shop and ?view=work links still work, but new bot messages use
// the same entry point: phone confirmation, then server-authorized capabilities.
'use strict';

const { randomBytes } = require('node:crypto');
const PUBLIC_SITE = 'https://хвостмаркет.рф';
const SHOP_URL = PUBLIC_SITE + '/miniapp.html';
const WORK_URL = SHOP_URL + '?view=work';
const SHOP_LAUNCH_URL = SHOP_URL + '?view=shop';

// Telegram can reuse an expired WebView when the same link is opened again.
// The marker is only a cache-buster: never an auth token, phone, or role.
function freshLaunchUrl(base, fresh) {
  return fresh ? base + (base.includes('?') ? '&' : '?') +
    'launch=' + randomBytes(12).toString('hex') : base;
}

function miniAppInlineKeyboard(options = {}) {
  return [[{
    text: '🐾 Открыть ХвостМаркет',
    web_app: { url: freshLaunchUrl(SHOP_URL, options.fresh) },
  }]];
}

// Keep Telegram's native command menu for all existing operational commands.
function commandsMenuButton() {
  return { type: 'commands' };
}

// /shop and /cabinet are backward-compatible aliases, not separate launches.
function miniAppDirectLinkMarkup(_view, options = {}) {
  return { inline_keyboard: miniAppInlineKeyboard(options) };
}

module.exports = {
  SHOP_URL, SHOP_LAUNCH_URL, WORK_URL, miniAppInlineKeyboard,
  commandsMenuButton, miniAppDirectLinkMarkup,
};
