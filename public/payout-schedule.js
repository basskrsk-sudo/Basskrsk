(function () {
  'use strict';

  const START_DATE = new Date(2026, 8, 9);
  const PAYOUT_DAYS = [9, 24];
  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  function dateOnly(value) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  function nextDate(from) {
    const today = dateOnly(from || new Date());
    if (today < START_DATE) return new Date(START_DATE);

    const year = today.getFullYear();
    const month = today.getMonth();
    const day = today.getDate();
    if (day <= PAYOUT_DAYS[0]) return new Date(year, month, PAYOUT_DAYS[0]);
    if (day <= PAYOUT_DAYS[1]) return new Date(year, month, PAYOUT_DAYS[1]);
    return new Date(year, month + 1, PAYOUT_DAYS[0]);
  }

  function daysUntil(target, from) {
    const current = dateOnly(from || new Date());
    const targetUtc = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
    const currentUtc = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
    return Math.max(0, Math.round((targetUtc - currentUtc) / 86400000));
  }

  function pluralDays(value) {
    const mod10 = value % 10;
    const mod100 = value % 100;
    if (mod10 === 1 && mod100 !== 11) return 'день';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
    return 'дней';
  }

  function countdownLabel(date, from) {
    const days = daysUntil(date, from);
    return days === 0 ? 'сегодня' : 'через ' + days + ' ' + pluralDays(days);
  }

  function shortLabel(from) {
    return 'Ближайшая выплата — ' + dateFormatter.format(nextDate(from));
  }

  function render(root) {
    const scope = root || document;
    const date = nextDate();
    const formattedDate = dateFormatter.format(date);
    const countdown = countdownLabel(date);
    scope.querySelectorAll('[data-next-payout-date]').forEach(function (el) {
      el.textContent = formattedDate;
    });
    scope.querySelectorAll('[data-next-payout-countdown]').forEach(function (el) {
      el.textContent = countdown;
    });
    scope.querySelectorAll('[data-next-payout-short]').forEach(function (el) {
      el.textContent = shortLabel();
    });
  }

  window.PayoutSchedule = {
    nextDate: nextDate,
    daysUntil: daysUntil,
    countdownLabel: countdownLabel,
    shortLabel: shortLabel,
    render: render,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { render(document); });
  } else {
    render(document);
  }
})();
