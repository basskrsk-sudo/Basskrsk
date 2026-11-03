// Promo code display for authenticated groomer / combined salon accounts.
// All values originate from the current server-verified /api/partners/me.
(function () {
  'use strict';
  var root = document.getElementById('workPage');
  if (!root) return;
  var copyValues = Object.create(null);
  var canAccess = function () { return false; };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function card(key, title, value, description) {
    if (!value) {
      return '<div class="work-promo-card"><b>' + esc(title) + '</b>' +
        '<p class="work-note">Код пока не назначен. Обратитесь к администратору.</p></div>';
    }
    copyValues[key] = String(value);
    return '<div class="work-promo-card"><b>' + esc(title) + '</b>' +
      '<strong class="work-promo-value">' + esc(value) + '</strong>' +
      '<p class="work-note">' + esc(description) + '</p>' +
      '<button class="work-secondary work-promo-copy" type="button" ' +
      'data-hm-promo-key="' + esc(key) + '">📋 Скопировать</button></div>';
  }
  function section(partner, accessCheck) {
    copyValues = Object.create(null);
    canAccess = typeof accessCheck === 'function' ? accessCheck : function () { return false; };
    if (!partner || !partner.id || partner.active === false || partner.active === 0) return '';
    // The active salon is returned by the partner's own authorized server
    // profile. Old/unassigned/closed salons never contribute a promo code.
    var point = partner.current_point &&
      String(partner.current_point.id) === String(partner.point_id)
      ? partner.current_point : null;
    var groomerCode = String(partner.first_purchase_promo_code || '').trim();
    var salonCode = point ? String(point.first_purchase_promo_code || '').trim() : '';
    var referralCode = String(partner.partner_code || '').trim();
    var buyerLink = point && groomerCode
      ? 'https://хвостмаркет.рф/?ref=' + encodeURIComponent(point.id) +
        '&partner=' + encodeURIComponent(partner.id) +
        '&promo=' + encodeURIComponent(groomerCode) +
        (point.city_id ? '&city=' + encodeURIComponent(point.city_id) : '')
      : '';
    var registrationLink = referralCode
      ? 'https://хвостмаркет.рф/taiga-register.html?ref=' + encodeURIComponent(referralCode)
      : '';
    return '<section class="work-surface"><h2>🎁 Мои промокоды</h2>' +
      '<p class="work-note">Скидка 20% на первую покупку доступна один раз ' +
      'на номер телефона покупателя. Промокоды грумера и салона отличаются.</p>' +
      '<div class="work-promo-list">' +
      card('groomer', '✂️ Персональный промокод грумера −20%', groomerCode,
        'Поделитесь с новым покупателем.') +
      card('salon', '🏪 Промокод моего салона −20%', salonCode,
        point ? 'Действующая точка: ' + point.name : 'Нет действующего назначенного салона.') +
      card('referral', '🤝 Реферальный код для привлечения точек', referralCode,
        'Пригласите нового грумера или салон.') +
      card('buyer', '🔗 Моя ссылка для покупателей', buyerLink,
        'Предвыбирает ваш салон, грумера и персональный промокод.') +
      card('registration', '🔗 Ссылка для приглашения партнёра', registrationLink,
        'Для регистрации нового партнёра по вашему реферальному коду.') +
      '</div><p class="work-promo-feedback" id="workPromoCopyStatus" role="status" aria-live="polite"></p>' +
      '</section>';
  }
  function notice(text) {
    var feedback = document.getElementById('workPromoCopyStatus');
    if (feedback) feedback.textContent = text;
  }
  async function copy(key) {
    if (!canAccess() || !Object.prototype.hasOwnProperty.call(copyValues, key)) return;
    var value = copyValues[key];
    if (!value) return;
    var copied = false;
    var nav = window.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      try {
        await nav.clipboard.writeText(value);
        copied = true;
      } catch (_) {}
    }
    if (!copied && typeof document.createElement === 'function' &&
        document.body && typeof document.execCommand === 'function') {
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly','');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      try {
        textarea.focus();
        textarea.select();
        copied = document.execCommand('copy') === true;
      } catch (_) {}
      finally { textarea.remove(); }
    }
    if (copied) return notice('✅ Скопировано. Можете отправить клиенту в Telegram.');
    if (typeof window.prompt === 'function') {
      window.prompt('Скопируйте код или ссылку вручную:', value);
    }
    notice('Не удалось скопировать автоматически. Выделите код выше или скопируйте из появившегося окна.');
  }
  root.addEventListener('click', function (event) {
    var button = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-hm-promo-key]') : null;
    if (!button || !button.dataset || !button.dataset.hmPromoKey) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    return copy(button.dataset.hmPromoKey);
  });
  window.HvostMiniAppPromos = {
    section: section,
    clear: function () {
      copyValues = Object.create(null);
      canAccess = function () { return false; };
    },
  };
})();
