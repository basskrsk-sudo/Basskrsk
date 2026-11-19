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
// A small SQLite read-only cache shared by dashboards. A local write changes
// total_changes(), while another SQLite connection changes PRAGMA data_version.
// Prepared revision statements avoid recompiling them on every cache lookup.
// Never use this for payments, stock reservations or account authorization.
function createSqliteAnalyticsCache(database, options) {
  const changes = database.prepare('SELECT total_changes() AS n');
  const external = database.prepare('PRAGMA data_version');
  return createAnalyticsCache(
    () => String(changes.get().n) + ':' + String(external.get().data_version),
    options,
  );
}
module.exports = { createAnalyticsCache, createSqliteAnalyticsCache };
