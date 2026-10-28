'use strict';

// Only automatic Partner Club sale posts use this layout. Manual posts retain
// their Telegram entities/Markdown and do not pass through this formatter.
const { escapeTelegramHtml } = require('./telegram-formatting');

const SALE_TITLES = new Set(['🐾 Новая покупка!', '🎉 Первая продажа!']);

function saleMessage(title, venueLine, productLine, priceLine, ending) {
  return [title, '', venueLine, '', productLine, priceLine, '', ending].join('\n');
}

// Normalize older, already queued (but unpublished) automatic sale drafts.
// This does not modify their persisted text, nor a moderator's edited message.
function normalizedAutoSaleMessage(message) {
  const raw = String(message ?? '').replace(/\r\n?/g, '\n');
  const meaningful = raw.split('\n').map(line => line.trim()).filter(Boolean);
  if (meaningful.length < 5 || !SALE_TITLES.has(meaningful[0]) ||
      !meaningful[1].startsWith('🏪 ') ||
      !meaningful[2].startsWith('🦴 ') ||
      !meaningful[3].startsWith('💚 ')) {
    return raw;
  }
  return saleMessage(
    meaningful[0], meaningful[1], meaningful[2], meaningful[3],
    meaningful.slice(4).join('\n')
  );
}

function saleMessageHtml(message) {
  const normalized = normalizedAutoSaleMessage(message);
  // Telegram parses HTML. Escape untrusted salon names, product titles and
  // all other text BEFORE introducing our own trusted <b>...</b> tags.
  return normalized.split('\n').map(line => {
    if (!line.startsWith('🏪 ')) return escapeTelegramHtml(line);
    const from = line.indexOf('«');
    const to = line.lastIndexOf('»');
    if (from < 0 || to <= from) return escapeTelegramHtml(line);
    return escapeTelegramHtml(line.slice(0, from)) +
      '<b>' + escapeTelegramHtml(line.slice(from, to + 1)) + '</b>' +
      escapeTelegramHtml(line.slice(to + 1));
  }).join('\n');
}

module.exports = {
  saleMessage,
  normalizedAutoSaleMessage,
  saleMessageHtml,
};
