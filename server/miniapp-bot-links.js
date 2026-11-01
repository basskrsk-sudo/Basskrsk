// Shared Telegram Mini App launch controls for the EXISTING ХвостМаркет bot.
// No extra bot, token, long-polling worker or webhook should be created.
'use strict';

const PUBLIC_SITE = 'https://хвостмаркет.рф';
const SHOP_URL = PUBLIC_SITE + '/miniapp.html';
const WORK_URL = SHOP_URL + '?view=work';

function miniAppInlineKeyboard() {
  return [
    [{ text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } }],
    [{ text: '👤 Рабочие кабинеты', web_app: { url: WORK_URL } }],
  ];
}

// Restore Telegram's native command list in the chat menu.
// Store/workspaces stay available from /start and the /shop /cabinet commands.
function commandsMenuButton() {
  return { type: 'commands' };
}

function miniAppDirectLinkMarkup(view) {
  const target = view === 'work'
    ? { text: '👤 Открыть рабочие кабинеты', web_app: { url: WORK_URL } }
    : { text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } };
  return { inline_keyboard: [
    [target],
    // The second entry is a different destination to make switching easy.
    [view === 'work' ? miniAppInlineKeyboard()[0][0] : miniAppInlineKeyboard()[1][0]],
  ] };
}

module.exports = {
  SHOP_URL, WORK_URL, miniAppInlineKeyboard,
  commandsMenuButton, miniAppDirectLinkMarkup,
};
