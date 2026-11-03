// Shared Telegram Mini App launch controls for the EXISTING ХвостМаркет bot.
// No extra bot, token, long-polling worker or webhook should be created.
'use strict';

const { randomBytes } = require('node:crypto');
const PUBLIC_SITE = 'https://хвостмаркет.рф';
const SHOP_URL = PUBLIC_SITE + '/miniapp.html';
const WORK_URL = SHOP_URL + '?view=work';
const SHOP_LAUNCH_URL = SHOP_URL + '?view=shop';

// Telegram may reuse a stalled/expired WebView when the same inline button
// URL is pressed repeatedly. Each NEW /start or /cabinet bot response gets
// unique URLs; it does NOT authenticate anyone or change the signed TG data.
function freshLaunchUrl(base, fresh) {
  return fresh ? base + '&launch=' + randomBytes(12).toString('hex') : base;
}

function miniAppInlineKeyboard(options = {}) {
  return [
    [{ text: '🛍 Открыть магазин', web_app: { url: freshLaunchUrl(SHOP_LAUNCH_URL, options.fresh) } }],
    [{ text: '👤 Рабочие кабинеты', web_app: { url: freshLaunchUrl(WORK_URL, options.fresh) } }],
  ];
}

// Restore Telegram's native command list in the chat menu.
// Store/workspaces stay available from /start and the /shop /cabinet commands.
function commandsMenuButton() {
  return { type: 'commands' };
}

function miniAppDirectLinkMarkup(view, options = {}) {
  const links = miniAppInlineKeyboard(options);
  return { inline_keyboard: view === 'work'
    ? [[{ text: '👤 Открыть рабочие кабинеты', web_app: links[1][0].web_app }], links[0]]
    : [[links[0][0]], links[1]] };
}

module.exports = {
  SHOP_URL, SHOP_LAUNCH_URL, WORK_URL, miniAppInlineKeyboard,
  commandsMenuButton, miniAppDirectLinkMarkup,
};
