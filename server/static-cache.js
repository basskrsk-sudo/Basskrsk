'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Keep only a bounded number of bytes in Node's heap. Public documents and
// large pictures are served from disk; their content hashes stay in metadata.
const DEFAULT_CACHE_BYTES = 6 * 1024 * 1024;
const DEFAULT_ASSET_BYTES = 256 * 1024;

// For streamed assets, hashing the whole file synchronously would block
// all API requests. Use filesystem identity for cache busting instead.
function digestMetadata(stat) {
  return digest(Buffer.from([stat.dev, stat.ino, stat.size,
    stat.mtimeMs, stat.ctimeMs].join(':')));
}

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 20);
}

function matchesEtag(header, etag) {
  return String(header || '').split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
}

function createStaticCache(publicDir, { maxCacheBytes = DEFAULT_CACHE_BYTES, maxAssetBytes = DEFAULT_ASSET_BYTES } = {}) {
  const files = new Map();
  const rendering = new Set();
  const MISSING = '__missing__';
  const maxResidentBytes = Math.max(0, Number(maxCacheBytes) || 0);
  const maxBufferedAssetBytes = Math.max(0, Number(maxAssetBytes) || 0);
  let cachedBytes = 0;

  function entryBytes(entry) {
    return (entry.body ? entry.body.length : 0) +
      (entry.rendered ? entry.rendered.body.length : 0);
  }

  function trim(protectedPath) {
    // Evict only byte buffers, not tiny ETag metadata. The protected file may
    // temporarily exceed a tiny test budget while its HTML is being rendered.
    for (const [filePath, entry] of files) {
      if (cachedBytes <= maxResidentBytes) break;
      if (filePath === protectedPath || rendering.has(filePath)) continue;
      cachedBytes -= entryBytes(entry);
      entry.body = null;
      entry.rendered = null;
    }
  }

  function remember(filePath, entry) {
    const previous = files.get(filePath);
    if (previous) cachedBytes -= entryBytes(previous);
    files.delete(filePath);
    files.set(filePath, entry);
    cachedBytes += entryBytes(entry);
    trim(filePath);
  }

  function read(filePath, statHint = null) {
    const stat = statHint || fs.statSync(filePath);
    const stamp = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const needsBody = stat.size <= maxBufferedAssetBytes || ext === '.html' || ext === '.css';
    const old = files.get(filePath);
    if (old && old.stamp === stamp) {
      // A hit moves metadata to the newest position in our LRU order.
      files.delete(filePath);
      files.set(filePath, old);
      if (needsBody && old.body === null) {
        old.body = fs.readFileSync(filePath);
        cachedBytes += old.body.length;
        trim(filePath);
      }
      return old;
    }
    // Hash large assets in fixed 64 KiB chunks instead of keeping whole PDFs
    // and photos resident indefinitely. Preserve strong ETags and ?v= hashes.
    const body = needsBody ? fs.readFileSync(filePath) : null;
    const entry = { stamp, body, version: body ? digest(body) : digestMetadata(stat), rendered: null };
    remember(filePath, entry);
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

  function rendered(filePath, statHint = null) {
    const entry = read(filePath, statHint);
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
      const next = {body,version:digest(body),dependencies};
      if (entry.rendered) cachedBytes -= entry.rendered.body.length;
      entry.rendered = next;
      cachedBytes += body.length;
      trim(filePath);
      return next;
    } finally {
      rendering.delete(filePath);
      trim(filePath);
    }
  }

  function response(filePath, req, mime, statHint = null) {
    const entry = read(filePath, statHint);
    const name = path.basename(filePath);
    const html = path.extname(filePath) === '.html';
    const css = path.extname(filePath) === '.css';
    const privatePage = html && name.startsWith('taiga-');
    // Do not let Telegram WebViews retain an old signed-login shell after a deploy.
    // Other HTML continues to use validating ETags, as before.
    const noStore = privatePage || name === 'miniapp.html' ||
      name === 'config.js' || name === 'sw.js';
    // Cache transformed HTML/CSS bytes and ETags; revalidate asset stamps.
    const representation = html || css ? rendered(filePath, statHint) : entry;
    const body = representation.body;
    const representationVersion = representation.version;
    const etag = (body === null ? 'W/' : '') + '"' + representationVersion + '"';
    const version = new URL(req.url || '/', 'https://static.local').searchParams.get('v');
    const immutable = !html && version === representationVersion && !noStore;
    const headers = {
      'Content-Type': mime,
      'Cache-Control': noStore ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (!noStore) headers.ETag = etag;
    const notModified = !noStore && ['GET', 'HEAD'].includes(req.method) && matchesEtag(req.headers['if-none-match'], etag);
    return { status: notModified ? 304 : 200, headers, body, streamPath: body === null ? filePath : null };
  }

  function stats() {
    return { resident_bytes: cachedBytes, limit_bytes: maxResidentBytes, entries: files.size,
      streamed_assets: [...files.values()].filter(entry => entry.body === null).length };
  }
  return { response, versionHtml, stats };
}

module.exports = { createStaticCache, matchesEtag };
