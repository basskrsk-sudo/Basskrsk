'use strict';
// Telegram passes rich formatting separately in message.entities (UTF-16 offsets).
// Store and render only allow-listed Telegram HTML, never raw user-provided tags.
function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeMarkdownHtml(text) {
  const escaped = escapeTelegramHtml(text);
  // Support pasted/copied Markdown, such as **bold heading**, in manual posts.
  return escaped.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
}
function telegramTag(entity) {
  switch (entity.type) {
    case 'bold': return ['<b>', '</b>'];
    case 'italic': return ['<i>', '</i>'];
    case 'underline': return ['<u>', '</u>'];
    case 'strikethrough': return ['<s>', '</s>'];
    case 'spoiler': return ['<tg-spoiler>', '</tg-spoiler>'];
    case 'code': return ['<code>', '</code>'];
    case 'pre': return ['<pre>', '</pre>'];
    case 'blockquote': return ['<blockquote>', '</blockquote>'];
    case 'expandable_blockquote': return ['<blockquote expandable>', '</blockquote>'];
    case 'text_link': {
      const url=String(entity.url||'');
      if (!/^https?:\/\//i.test(url) || url.length>2048) return null;
      return ['<a href="'+escapeTelegramHtml(url)+'">', '</a>'];
    }
    default: return null;
  }
}
function htmlFromTelegramEntities(text, entities) {
  const raw=String(text??'');
  if (!Array.isArray(entities)||!entities.length) return safeMarkdownHtml(raw);
  const valid=[];
  for (const entity of entities) {
    if (!entity||!Number.isInteger(entity.offset)||!Number.isInteger(entity.length)) continue;
    const from=entity.offset,to=from+entity.length,tag=telegramTag(entity);
    if (!tag||from<0||to>raw.length||to<=from) continue;
    valid.push({from,to,tag,id:valid.length});
  }
  if (!valid.length) return safeMarkdownHtml(raw);
  const boundaries=[...new Set([0,raw.length,...valid.flatMap(x=>[x.from,x.to])])].sort((a,b)=>a-b);
  let html='',opened=[];
  for(let i=0;i<boundaries.length-1;i++){
    const from=boundaries[i],to=boundaries[i+1];
    const active=valid.filter(x=>x.from<=from&&x.to>=to)
      .sort((a,b)=>a.from-b.from||b.to-a.to||a.id-b.id);
    let shared=0;
    while(shared<opened.length&&shared<active.length&&opened[shared].id===active[shared].id)shared++;
    for(let j=opened.length-1;j>=shared;j--)html+=opened[j].tag[1];
    for(let j=shared;j<active.length;j++)html+=active[j].tag[0];
    html+=escapeTelegramHtml(raw.slice(from,to));
    opened=active;
  }
  for(let j=opened.length-1;j>=0;j--)html+=opened[j].tag[1];
  return html;
}
module.exports={escapeTelegramHtml,safeMarkdownHtml,htmlFromTelegramEntities};
