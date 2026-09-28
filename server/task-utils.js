'use strict';

function nextRecurringDue(currentDue, rule) {
  const start = currentDue && /^\d{4}-\d{2}-\d{2}$/.test(currentDue)
    ? new Date(currentDue + 'T00:00:00Z')
    : new Date();
  if (rule === 'weekly:monday') {
    start.setUTCDate(start.getUTCDate() + 7);
    return start.toISOString().slice(0, 10);
  }
  if (rule === 'monthly:10,25') {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth();
    const d = start.getUTCDate();
    if (d < 10) return new Date(Date.UTC(y, m, 10)).toISOString().slice(0, 10);
    if (d < 25) return new Date(Date.UTC(y, m, 25)).toISOString().slice(0, 10);
    return new Date(Date.UTC(y, m + 1, 10)).toISOString().slice(0, 10);
  }
  return null;
}

module.exports = { nextRecurringDue };
