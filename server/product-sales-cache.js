'use strict';

// Aggregate paid (non-refunded) sales at most once per minute per process.
// Only the popularity counter is cached: stock and prices stay live.
const DEFAULT_TTL_MS = 60 * 1000;
function createSalesCountCache(loadRows, { ttlMs = DEFAULT_TTL_MS, clock = Date.now } = {}) {
  if (typeof loadRows !== 'function') throw new TypeError('loadRows must be a function');
  let cached = null;
  let expiresAt = 0;
  return {
    get() {
      const now = clock();
      if (cached !== null && now < expiresAt) return cached;
      const rows = loadRows();
      const fresh = new Map(rows.map(row =>
        [Number(row.product_id), Number(row.sales_count) || 0]));
      cached = fresh;
      expiresAt = now + ttlMs;
      return fresh;
    },
    invalidate() { cached = null; expiresAt = 0; },
  };
}
module.exports = { createSalesCountCache, DEFAULT_TTL_MS };
