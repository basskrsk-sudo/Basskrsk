'use strict';

// In-process, fixed-size latency samples. Route TEMPLATES, never actual URLs,
// are recorded, so private IDs, phone numbers and tokens cannot enter metrics.
function createApiPerformanceTracker({ maxRoutes = 128, samplesPerRoute = 32 } = {}) {
  const limit = Math.max(1, Math.floor(maxRoutes));
  const windowSize = Math.max(1, Math.floor(samplesPerRoute));
  const routes = new Map();
  let totalRequests = 0;
  function record(route, durationMs, statusCode) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const label = String(route || 'UNMATCHED').slice(0, 140);
    const key = routes.has(label) || routes.size < limit ? label : 'OTHER';
    let entry = routes.get(key);
    if (!entry) {
      entry = { count: 0, errors: 0, samples: [] };
      routes.set(key, entry);
    }
    entry.count++;
    if (Number(statusCode) >= 500) entry.errors++;
    entry.samples.push(Math.round(durationMs * 10) / 10);
    if (entry.samples.length > windowSize) entry.samples.shift();
    totalRequests++;
  }
  function snapshot() {
    const slowRoutes = [...routes.entries()].map(([route, entry]) => {
      const sorted = [...entry.samples].sort((a, b) => a - b);
      const sum = entry.samples.reduce((acc, value) => acc + value, 0);
      return {
        route,
        requests: entry.count,
        server_errors: entry.errors,
        samples: sorted.length,
        avg_ms: Math.round(sum / sorted.length),
        p95_ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
        max_ms: sorted[sorted.length - 1],
      };
    }).sort((a, b) => b.p95_ms - a.p95_ms);
    return { total_requests: totalRequests, tracked_routes: routes.size,
      sample_window_per_route: windowSize, slow_routes: slowRoutes.slice(0, 12) };
  }
  return { record, snapshot };
}
const tracker = createApiPerformanceTracker();
module.exports = { createApiPerformanceTracker,
  recordApiRequest: tracker.record, snapshotApiPerformance: tracker.snapshot };
