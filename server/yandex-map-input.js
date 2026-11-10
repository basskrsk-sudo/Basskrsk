'use strict';

// Yandex Maps business URLs are identifiers, not permission to scrape or
// persist provider data. Only user-submitted business details enter the CRM.
const YANDEX_HOSTS = new Set([
  'yandex.ru', 'www.yandex.ru', 'yandex.com', 'www.yandex.com',
  'maps.yandex.ru', 'maps.yandex.com',
]);
const RX = /(?:https?:\/\/)?(?:(?:www|maps)\.)?yandex\.(?:ru|com)\/(?:maps\/)?org\/[^\s|<>"']+/gi;

function stripTrailing(value) {
  return String(value || '').trim().replace(/[.,;!?…)\]\u00bb]+$/, '');
}
function parseYandexLink(raw) {
  const text = stripTrailing(raw);
  if (!text || text.length > 1200) return null;
  let value;
  try { value = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); }
  catch (_) { return null; }
  if (!['https:', 'http:'].includes(value.protocol) ||
      !YANDEX_HOSTS.has(value.hostname.toLowerCase()) ||
      (value.port && value.port !== '80' && value.port !== '443') ||
      value.username || value.password) return null;
  const path = value.pathname;
  // "org/slug/123" and "org/123" are supported; reject routes/search.
  const m = path.match(/^\/(?:maps\/)?org\/(?:(?<slug>[a-z0-9_-]{1,150})\/)?(?<id>\d{5,20})\/?$/i);
  if (!m || !m.groups) return null;
  // Only a Yandex-provided id is treated as an organizational identifier.
  // A readable slug is optional and never used as the name.
  const orgId = m.groups.id;
  const slug = m.groups.slug && !/^\d+$/.test(m.groups.slug) ? m.groups.slug : null;
  const canonical = 'https://yandex.ru/maps/org/' + (slug ? slug + '/' : '') + orgId;
  return {
    firmId: null, geoId: null, yandexOrgId: orgId,
    cityAlias: '', url: canonical, short: false, source: 'yandex',
  };
}

function extractYandexLink(message) {
  const raw = String(message || '');
  RX.lastIndex = 0;
  let match;
  while ((match = RX.exec(raw)) !== null) {
    // Don't extract the middle of an attacker-controlled longer hostname.
    const prev = raw.slice(Math.max(0, match.index - 1), match.index);
    if (prev && /[\w.@/-]/.test(prev)) continue;
    const candidate = stripTrailing(match[0]);
    if (parseYandexLink(candidate)) return candidate;
  }
  return null;
}

function parseMapShareFields(message, link) {
  const src = String(message || '');
  const i = src.indexOf(link);
  if (i < 0) return null;
  let remainder = (src.slice(0, i) + '\n' + src.slice(i + link.length)).trim();
  if (!remainder) return {name:'',phone:'',address:''};
  remainder = remainder.replace(/^\s*\|\s*/, '').trim();
  if (remainder.includes('|')) {
    const parts = remainder.split('|').map(v => v.trim());
    if (parts.length > 3) return null;
    return {
      name:parts[0] || '',
      phone:parts[1] || '',
      address:parts[2] || '',
    };
  }
  const lines = remainder.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 3) return null;
  if (lines.length === 0) return {name:'',phone:'',address:''};
  const phoneLike = v => /^\+?[\d ()-]{7,30}$/.test(v) &&
    (v.match(/\d/g) || []).length >= 7;
  let phone = '', address = '';
  for (const line of lines.slice(1)) {
    if (phoneLike(line) && !phone) phone = line;
    else address = address ? address + ', ' + line : line;
  }
  return {name:lines[0],phone,address};
}

function cityAliasFromAddress(address) {
  const a = String(address || '').toLowerCase();
  if (/красноярск/i.test(a)) return 'krasnoyarsk';
  if (/новосибирск/i.test(a)) return 'novosibirsk';
  if (/москва/i.test(a)) return 'moscow';
  if (/санкт[- ]петербург/i.test(a)) return 'spb';
  return '';
}

module.exports = {
  parseYandexLink, extractYandexLink, parseMapShareFields,
  cityAliasFromAddress,
};
