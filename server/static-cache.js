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
  const rendering = new Set();
  const MISSING = '__missing__';

  function read(filePath) {
    const stat = fs.statSync(filePath);
    const stamp = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size;
    const old = files.get(filePath);
    if (old && old.stamp === stamp) return old;
    const body = fs.readFileSync(filePath);
    const entry = { stamp, body, version: digest(body), rendered: null };
    files.set(filePath, entry);
    return entry;
  }

  function assetVersion(filePath) {
    try {
      // A stylesheet version must include nested references (e.g. fonts).
      return path.extname(filePath).toLowerCase() === '.css'
        ? rendered(filePath).version : read(filePath).version;
    } catch (_) {
      return MISSING;
    }
  }

  function versionUrl(url, dependencies) {
    const parsed = new URL(url, 'https://static.local');
    if (parsed.pathname.startsWith('/images/uploads/')) return url;
    const filePath = path.resolve(publicDir, '.' + parsed.pathname);
    if (!filePath.startsWith(publicDir + path.sep)) return url;
    const version = assetVersion(filePath);
    if (dependencies) dependencies.set(filePath, version);
    if (version === MISSING) return url;
    parsed.searchParams.set('v', version);
    const pathname = url.startsWith('/') ? parsed.pathname : parsed.pathname.slice(1);
    return pathname + parsed.search + parsed.hash;
  }

  function versionHtml(html, dependencies) {
    // Literal asset references in markup, CSS and embedded JS only.
    // API URLs, uploaded photos and interpolated URLs are not rewritten.
    let result = html.replace(/(["'(])((?:\/?(?:images|fonts)\/)[^"'()\s\x60<>?\x24{}]+)(?:\?[^"'()\s\x60<>]*)?/g,
      (match, prefix, url) => prefix + versionUrl(url, dependencies));
    result = result.replace(/((?:src|href)=["'])(\/?[^/"'<>\s?]+\.(?:css|js))(?:\?[^"'<>\s]*)?/g,
      (match, prefix, url) => prefix + versionUrl(url, dependencies));
    return result;
  }

  function rendered(filePath) {
    const entry = read(filePath);
    // Avoid dependency cycles in stylesheets. Circular references still serve
    // the original file without blocking all HTTP requests.
    if (rendering.has(filePath)) return { body: entry.body, version: entry.version };
    if (entry.rendered && [...entry.rendered.dependencies].every(
      ([dependency, version]) => assetVersion(dependency) === version
    )) return entry.rendered;

    rendering.add(filePath);
    try {
      const dependencies = new Map();
      const body = Buffer.from(versionHtml(entry.body.toString('utf8'), dependencies));
      entry.rendered = {body,version:digest(body),dependencies};
      return entry.rendered;
    } finally {
      rendering.delete(filePath);
    }
  }

  function response(filePath, req, mime) {
    const entry = read(filePath);
    const name = path.basename(filePath);
    const html = path.extname(filePath) === '.html';
    const css = path.extname(filePath) === '.css';
    const privatePage = html && name.startsWith('taiga-');
    // Do not let Telegram WebViews retain an old signed-login shell after a deploy.
    // Other HTML continues to use validating ETags, as before.
    const noStore = privatePage || name === 'miniapp.html' ||
      name === 'config.js' || name === 'sw.js';
    // Cache transformed HTML/CSS bytes and ETags; revalidate asset stamps.
    const representation = html || css ? rendered(filePath) : entry;
    const body = representation.body;
    const representationVersion = representation.version;
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
