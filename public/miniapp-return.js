// A lightweight way back to the Mini App when a staff member opens
// the original full-featured cabinet from the Telegram quick dashboard.
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  if (params.get('from') !== 'miniapp') return;
  if (document.getElementById('hm-miniapp-return')) return;
  function insertReturnLink() {
    if (document.getElementById('hm-miniapp-return')) return;
    var link = document.createElement('a');
    link.id = 'hm-miniapp-return';
    link.href = '/miniapp.html';
    link.textContent = '← В мини-приложение';
    link.setAttribute('aria-label', 'Вернуться в рабочие кабинеты ХвостМаркета');
    Object.assign(link.style, {
      position: 'fixed',
      zIndex: '2147483000',
      right: 'max(12px, env(safe-area-inset-right))',
      bottom: 'max(14px, env(safe-area-inset-bottom))',
      padding: '11px 13px',
      background: '#0b4b39',
      border: '1px solid #b3d5bd',
      borderRadius: '14px',
      boxShadow: '0 5px 20px rgba(0,0,0,.22)',
      font: '700 12px Manrope, system-ui, sans-serif',
      color: '#fff',
      textDecoration: 'none',
    });
    document.body.appendChild(link);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertReturnLink, { once: true });
  } else {
    insertReturnLink();
  }
})();
