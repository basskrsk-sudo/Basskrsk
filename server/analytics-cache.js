'use strict';

// Bounded short-lived cache for read-only analytic snapshots only.
// Never use for payments, payouts, reservations, or live stock checks.
function createAnalyticsCache(readRevision, {
  ttlMs = 30000, maxEntries = 3, clock = Date.now,
} = {}) {
  if (typeof readRevision !== 'function') throw new TypeError('readRevision is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 ||
      !Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid cache limits');
  const entries = new Map();
  return {
    get(key, load) {
      const now = clock();
      const revision = readRevision();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now && cached.revision === revision) return cached.value;
      // No stale-on-error: if calculations fail, propagate the failure.
      const value = load();
      // BSC initialization may seed settings; record the revision afterward.
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { value, expiresAt: clock() + ttlMs, revision: readRevision() });
      return value;
    },
    invalidate() { entries.clear(); },
    get size() { return entries.size; },
  };
}
module.exports = { createAnalyticsCache };
