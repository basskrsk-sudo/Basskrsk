'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 20);
}

function matchesEtag(header, etag) {
  return String(header || '').split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

function createStaticCache(publicDir) {
  const files = new Map();
  function read(filePath) {
    const stat = fs.statSync(filePath);
    const stamp = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size;
    const old = files.get(filePath);
    if (old && old.stamp === stamp) return old;
    const body = fs.readFileSync(filePath);
    const entry = { stamp, body, version: digest(body) };
    files.set(filePath, entry);
    return entry;
  }

  function versionUrl(url) {
    const parsed = new URL(url, 'https://static.local');
    if (parsed.pathname.startsWith('/images/uploads/')) return url;
    const file = path.resolve(publicDir, '.' + parsed.pathname);
    if (!file.startsWith(publicDir + path.sep)) return url;
    try {
      const entry = read(file);
      const version = path.extname(file) === '.css' ? digest(versionHtml(entry.body.toString('utf8'))) : entry.version;
      parsed.searchParams.set('v', version);
      const pathname = url.startsWith('/') ? parsed.pathname : parsed.pathname.slice(1);
      return pathname + parsed.search + parsed.hash;
    } catch { return url; }
  }

  function versionHtml(html) {
    // Literal asset references in markup, CSS and embedded JS only.
    // API URLs, uploaded photos and interpolated URLs are not rewritten.
    let result = html.replace(/(["'(])((?:\/?(?:images|fonts)\/)[^"'()\s`<>?${}]+)(?:\?[^"'()\s`<>]*)?/g,
      (match, prefix, url) => prefix + versionUrl(url));
    result = result.replace(/((?:src|href)=["'])(\/?[^/"'<>\s?]+\.(?:css|js))(?:\?[^"'<>\s]*)?/g,
      (match, prefix, url) => prefix + versionUrl(url));
    return result;
  }

  function response(filePath, req, mime) {
    const entry = read(filePath);
    const name = path.basename(filePath);
    const html = path.extname(filePath) === '.html';
    const css = path.extname(filePath) === '.css';
    const privatePage = html && name.startsWith('taiga-');
    const noStore = privatePage || name === 'config.js' || name === 'sw.js';
    const body = html || css ? Buffer.from(versionHtml(entry.body.toString('utf8'))) : entry.body;
    const representationVersion = html || css ? digest(body) : entry.version;
    const etag = '"' + representationVersion + '"';
    const version = new URL(req.url || '/', 'https://static.local').searchParams.get('v');
    const immutable = !html && version === representationVersion && !noStore;
    const headers = {
      'Content-Type': mime,
      'Cache-Control': noStore ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (!noStore) headers.ETag = etag;
    const notModified = !noStore && ['GET', 'HEAD'].includes(req.method) && matchesEtag(req.headers['if-none-match'], etag);
    return { status: notModified ? 304 : 200, headers, body };
  }

  return { response, versionHtml };
}

module.exports = { createStaticCache, matchesEtag };
