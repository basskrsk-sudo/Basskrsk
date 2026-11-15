// Website MAX authentication for groomers. Telegram Mini App is separate.
// Reuses the bounded, visibility-aware polling helper; never sends an SMS.
(function (global) {
  'use strict';
  let polling = null;
  let submitting = false;
  const el = id => document.getElementById(id);

  function error(message) {
    const node = el('max-login-error');
    if (!node) return;
    node.textContent = message || 'Не удалось войти через MAX.';
    node.style.display = 'block';
  }
  function clearError() {
    const node = el('max-login-error');
    if (node) { node.textContent = ''; node.style.display = 'none'; }
  }
  function stage(waiting) {
    el('max-login-step-phone').style.display = waiting ? 'none' : 'block';
    el('max-login-step-waiting').style.display = waiting ? 'block' : 'none';
  }
  function stop() {
    if (polling) polling.stop();
    polling = null;
  }
  function toggle() {
    const block = el('max-login-block');
    const toggleButton = el('max-login-toggle');
    const show = global.getComputedStyle(block).display === 'none';
    block.style.display = show ? 'block' : 'none';
    toggleButton?.setAttribute('aria-expanded', String(show));
    if (!show) stop();
  }
  function reset() {
    stop();
    clearError();
    stage(false);
  }
  function normalizedPhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.startsWith('8')) digits = '7' + digits.slice(1);
    if (digits.startsWith('9')) digits = '7' + digits;
    return /^79\d{9}$/.test(digits) ? digits : null;
  }
  async function start(options = {}) {
    if (submitting) return;
    const phone = normalizedPhone(el('max-login-phone').value);
    clearError();
    if (!phone) return error('Введите мобильный номер, указанный в кабинете грумера.');
    if (typeof options.onSuccess !== 'function') return error('Вход временно недоступен.');
    submitting = true;
    const button = el('max-login-start');
    button.disabled = true;
    stop();
    try {
      const res = await fetch('/api/partners/max/start', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Не удалось запросить вход через MAX.');
      if (!/^https:\/\/max\.ru\/[A-Za-z0-9_-]{1,80}\?start=[0-9a-f]{64}$/.test(payload.deep_link)) {
        throw new Error('MAX прислал некорректную ссылку для подтверждения.');
      }
      const anchor = el('max-login-link');
      anchor.href = payload.deep_link;
      stage(true); // A real click on the link opens MAX even if popups are blocked.
      let permanentError = '';
      polling = global.HvostTelegramLoginPolling.start({
        check: async function (signal) {
          const result = await fetch('/api/partners/max/check', {
            method: 'POST', cache: 'no-store', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: payload.token }),
          });
          if ([400, 404, 410].includes(result.status)) return { expired: true };
          if ([403, 409].includes(result.status)) {
            const body = await result.json().catch(() => ({}));
            permanentError = body.error || 'Привязка MAX изменилась. Повторите вход.';
            return { expired: true };
          }
          if (!result.ok) return null;
          const data = await result.json();
          return data.verified && data.token && data.user
            ? { done: true, data } : null;
        },
        onSuccess: async function (login) {
          polling = null;
          await options.onSuccess(login);
        },
        onExpired: function () {
          polling = null;
          stage(false);
          error(permanentError || 'Подтверждение не получено за пять минут. Запросите новую ссылку MAX.');
        },
      });
    } catch (e) {
      stage(false);
      error(e.message || 'Ошибка сети. Повторите попытку.');
    } finally {
      submitting = false;
      button.disabled = false;
    }
  }
  global.HvostGroomerMaxLogin = { toggle, start, reset, stop, normalizedPhone };
})(window);
