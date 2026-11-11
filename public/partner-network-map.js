/* Shared, read-only partnership map for admin and manager (desktop + Mini App).
 * Source: authenticated /api/partner-leads/network-map, not demo or external candidates. */
(function () {
  'use strict';
  var API_SCRIPT = null;
  var current = null;
  var colors = {
    active: '#208357', declined: '#ce4b50', to_call: '#2776c7',
    no_answer: '#ee8d3d', in_progress: '#e3aa30', candidate: '#8056b2'
  };
  var labels = {
    active: 'Минимаркет работает', declined: 'Отказ',
    to_call: 'Ещё не звонили', no_answer: 'Не дозвонились',
    in_progress: 'Звонили · в проработке', candidate: 'Найдены, не в CRM'
  };
  var rawLabels = {
    to_call: 'Нужно позвонить', no_answer: 'Не дозвонились',
    meeting_scheduled: 'Встреча назначена', meeting_held: 'Встреча прошла',
    signed: 'Сотрудничество согласовано', declined: 'Отказ'
  };
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function validCoordinate(value, min, max) {
    return value !== null && value !== undefined && value !== '' &&
      Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
  }
  function position(item) {
    return validCoordinate(item.lat, -90, 90) && validCoordinate(item.lng, -180, 180)
      ? [Number(item.lat), Number(item.lng)] : null;
  }
  function colorKey(item) {
    if (item.type === 'point') return 'active';
    if (item.type === 'candidate') return 'candidate';
    if (item.status === 'declined') return 'declined';
    if (item.status === 'to_call') return 'to_call';
    if (item.status === 'no_answer') return 'no_answer';
    return 'in_progress';
  }
  function addressQuery(item) {
    var address = String(item.address || '').trim();
    if (!address) return '';
    var city = String(item.city_name || '').trim();
    // A full city+street query is much less prone to false geocoding matches.
    if (!city && !/Красноярск|Москва|Петербург|Новосибирск|Россия/i.test(address))
      return ''; // unknown city: don't guess a position
    return (city && !address.toLowerCase().includes(city.toLowerCase()))
      ? city + ', ' + address : address;
  }
  // Open the organization profile when its verified Yandex organization
  // ID is available. Coordinates are NOT a profile ID.
  function venueYandexLink(item) {
    var id = String(item.yandex_org_id || '').trim();
    if (/^\d{5,20}$/.test(id)) {
      return { url: 'https://yandex.ru/maps/org/' + id + '/', direct: true };
    }
    // Existing CRM can store a direct Yandex organization URL.
    // Ignore navigation, generic map, and non-Yandex URLs.
    var stored = String(item.yandex_url || '').trim();
    if (stored) {
      try {
        var parsed = new URL(stored);
        if (parsed.protocol === 'https:' &&
            (parsed.hostname === 'yandex.ru' || parsed.hostname === 'www.yandex.ru')) {
          var matched = parsed.pathname.match(/^\/maps\/org\/(?:[^/]+\/)?(\d{5,20})\/?$/);
          if (matched) {
            return { url: 'https://yandex.ru/maps/org/' + matched[1] + '/', direct: true };
          }
        }
      } catch (_) {}
    }
    // Unverified external listings do not all include Yandex profile IDs.
    // Search using the organization name and address rather than routing.
    var name = String(item.name || '').trim();
    var address = addressQuery(item) || String(item.city_name || '').trim();
    var query = [name, address].filter(Boolean).join(', ') || 'Красноярск';
    return {
      url: 'https://yandex.ru/maps/?mode=search&text=' + encodeURIComponent(query),
      direct: false
    };
  }
  function mapsScript(key) {
    if (window.ymaps && typeof window.ymaps.ready === 'function')
      return new Promise(function(resolve) { window.ymaps.ready(function() { resolve(window.ymaps); }); });
    if (!API_SCRIPT) {
      API_SCRIPT = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://api-maps.yandex.ru/2.1/?apikey=' +
          encodeURIComponent(key) + '&lang=ru_RU';
        script.async = true;
        script.onload = function () {
          if (!window.ymaps) return reject(new Error('Яндекс.Карты недоступны'));
          window.ymaps.ready(function () { resolve(window.ymaps); });
        };
        script.onerror = function () { reject(new Error('Не удалось загрузить Яндекс.Карты')); };
        document.head.appendChild(script);
      }).catch(function (error) { API_SCRIPT = null; throw error; });
    }
    return API_SCRIPT;
  }
  function mount(node, options) {
    if (!node || !options || typeof options.token !== 'function') return null;
    if (current && current.node === node) { current.refresh(); return current; }
    if (current) current.destroy();
    var initialLimit = Number(options.maxInitialGeocode);
    initialLimit = Number.isFinite(initialLimit) && initialLimit >= 5
      ? Math.min(160, Math.floor(initialLimit)) : 160;
    var root = document.createElement('div');
    root.className = 'hm-network-map';
    node.textContent = '';
    node.appendChild(root);
    var state = {
      node: node, map: null, records: [], city: '', status: 'all',
      district: '', showCandidates: true, candidateTotal: 0, matchedCandidates: [],
      reviewedCandidates: [], showReviewed: false, reviewBusy: false, notice: '',
      cache: Object.create(null), geocodeStates: Object.create(null),
      markers: Object.create(null), generation: 0,
      limit: initialLimit, loading: false, cities: [], shown: [], error: ''
    };
    function token() { return String(options.token() || ''); }
    function isAlive() { return current === instance && node.isConnected; }
    function items() {
      return state.records.filter(function (i) {
        return (!state.city || String(i.city_id || '') === state.city) &&
          (state.status === 'all' || colorKey(i) === state.status) &&
          (i.type !== 'candidate' || (state.showCandidates &&
            (!state.district || String(i.district || '') === state.district))) &&
          (!state.district || i.type === 'candidate' || state.status !== 'candidate');
      });
    }
    function resetMap() {
      if (state.map) {
        try { state.map.destroy(); } catch (_) {}
      }
      state.map = null;
      state.markers = Object.create(null);
    }
    function cityOptions() {
      var all = Object.create(null);
      state.records.forEach(function (i) {
        if (i.city_id) all[String(i.city_id)] = String(i.city_name || i.city_id);
      });
      return Object.keys(all).sort(function (a, b) { return all[a].localeCompare(all[b], 'ru'); })
        .map(function (id) {
          return '<option value="' + escapeHtml(id) + '"' + (state.city === id ? ' selected' : '') +
            '>' + escapeHtml(all[id]) + '</option>';
        }).join('');
    }
    function legend() {
      return Object.keys(colors).map(function (key) {
        var count = items().filter(function (i) { return colorKey(i) === key; }).length;
        return '<span class="hm-map-legend-item"><i style="background:' + colors[key] +
          '"></i>' + escapeHtml(labels[key]) + ' <b>' + count + '</b></span>';
      }).join('');
    }
    function itemId(i) {
      return (i.type === 'point' ? 'p:' : i.type === 'candidate' ? 'c:' : 'l:') +
        String(i.id);
    }
    function itemPosition(item) { return position(item) || state.cache[itemId(item)] || null; }
    var reviewReasons = {
      not_grooming: 'Нет груминг-салона',
      duplicate: 'Дубль / уже есть в базе',
      closed: 'Заведение закрыто',
      not_suitable: 'Не подходит для сотрудничества',
      other: 'Другое'
    };
    function reasonName(key) { return reviewReasons[key] || 'Отработано'; }
    function reviewedListMarkup() {
      if (!state.reviewedCandidates.length) return '';
      return '<div class="hm-map-reviewed">' +
        '<button type="button" class="hm-map-reviewed-toggle" data-map-reviewed-toggle ' +
        'aria-expanded="' + (state.showReviewed ? 'true' : 'false') + '">' +
        '✅ Отработанные и скрытые (' + state.reviewedCandidates.length + ')' +
        (state.showReviewed ? ' ▲' : ' ▼') + '</button>' +
        (state.showReviewed ? '<div class="hm-map-reviewed-items">' +
          state.reviewedCandidates.map(function (item) {
            return '<div class="hm-map-reviewed-item"><span><b>' +
              escapeHtml(item.name) + '</b><small>' +
              escapeHtml(item.address || 'Адрес отсутствует') + ' · ' +
              escapeHtml(reasonName(item.review_reason)) +
              (item.review_note ? ' · ' + escapeHtml(item.review_note) : '') +
              '</small></span><button type="button" data-map-review-restore="' +
              escapeHtml(item.id) + '">Вернуть</button></div>';
          }).join('') + '</div>' : '') + '</div>';
    }
    function unplacedReason(item) {
      if (itemPosition(item)) return '';
      var key = itemId(item);
      var result = state.geocodeStates[key];
      if (!String(item.address || '').trim()) return item.type === 'candidate'
        ? 'Адрес отсутствует в исходной базе — требуется проверка'
        : 'Адрес отсутствует — добавьте улицу и дом в CRM';
      if (result === 'needs_address') return 'Нужны город, улица и номер дома';
      if (result === 'needs_verification') return 'Адрес не удалось определить до дома — проверьте его в CRM';
      if (result === 'unavailable') return 'Сервис адресов недоступен — нажмите «Обновить»';
      if (item.type === 'point') return 'Для точки не заданы координаты — проверьте настройки минимаркета';
      return result === 'loading' ? 'Определяем адрес…' : 'Ожидает определения координат';
    }
    function renderUnplaced() {
      var holder = root.querySelector('[data-map-attention]');
      if (!holder) return;
      var missing = items().filter(function(item) { return !itemPosition(item); });
      if (!missing.length) { holder.hidden = true; holder.innerHTML = ''; return; }
      holder.hidden = false;
      holder.innerHTML = '<strong>⚠ Не отображаются на карте: ' + missing.length + '</strong>' +
        '<p>Статусы CRM сохранены. Фиолетовые карточки — внешний реестр, не подтверждённый CRM. ' +
        'Для точной метки нужен адрес с номером дома; нажмите карточку, чтобы увидеть детали.</p>' +
        '<div class="hm-map-unplaced">' + missing.slice(0, 35).map(function(item) {
          return '<button type="button" class="hm-map-missing" data-map-item="' +
            escapeHtml(itemId(item)) + '"><i style="background:' + colors[colorKey(item)] +
            '"></i><span><b>' + escapeHtml(item.name) + '</b><small>' +
            escapeHtml(labels[colorKey(item)]) + ' · ' + escapeHtml(unplacedReason(item)) +
            '</small></span></button>';
        }).join('') + '</div>' +
        (missing.length > 35 ? '<p>Ещё ' + (missing.length - 35) +
          ' карточек доступны в полном списке ниже.</p>' : '');
    }
    function details(i, inBalloon) {
      var yandex = venueYandexLink(i);
      var phone = String(i.phone || '').replace(/[^\d+]/g, '');
      var html = '<div class="hm-map-card">' +
        '<div class="hm-map-card-title">' + escapeHtml(i.name) + '</div>' +
        '<span class="hm-map-tag" style="--hm-map-color:' + colors[colorKey(i)] + '">' +
        escapeHtml(i.type === 'point' ? 'Минимаркет работает' :
          i.type === 'candidate' ? labels.candidate : rawLabels[i.status] || labels[colorKey(i)]) +
        '</span>' +
        '<p>📍 ' + escapeHtml(i.address || 'Адрес не указан') + '</p>' +
        (i.type === 'candidate' ? '<p>Район: ' + escapeHtml(i.district || 'Уточняется') +
          ' · ' + escapeHtml(i.category || 'Организация') + '</p>' +
          '<p><strong>Внешняя карточка, не CRM.</strong> ' +
          escapeHtml(i.recommendation || 'Нужно сверить перед прозвоном') + '</p>' : '') +
        (i.type === 'candidate' && !i.hidden ?
          '<button type="button" class="hm-map-action hm-map-review-start" ' +
          'data-map-review-start="' + escapeHtml(i.id) +
          '">✅ Отработано — скрыть с карты</button>' : '') +
        (phone.length >= 10 && (i.type === 'lead' || i.type === 'candidate') ? '<p>☎️ <a href="tel:' +
          escapeHtml(phone) + '">' + escapeHtml(i.phone) + '</a></p>' : '') +
        (i.next_contact_date && i.type === 'lead' ?
          '<p>Следующий контакт: ' + escapeHtml(i.next_contact_date) + '</p>' : '') +
        '<a target="_blank" rel="noopener noreferrer" href="' + escapeHtml(yandex.url) +
        '">' + (yandex.direct ? 'Открыть карточку в Яндекс Картах' :
          'Найти организацию в Яндекс Картах') + '</a>' +

        (!inBalloon && i.type === 'lead' && typeof options.onOpenLead === 'function' ?
          '<button type="button" class="hm-map-action" data-map-open-lead="' +
          escapeHtml(i.id) + '">Открыть в базе обзвона</button>' : '') +
        '</div>';
      return html;
    }
    function startReview(item) {
      if (!item || item.type !== 'candidate' || item.hidden) return;
      var detail = root.querySelector('[data-map-detail]');
      if (!detail) return;
      detail.innerHTML = details(item, false) +
        '<form data-map-review-form="' + escapeHtml(item.id) + '" class="hm-map-review-form">' +
        '<label>Причина проверки<select required data-map-review-reason>' +
        '<option value="">Выберите причину</option>' +
        Object.keys(reviewReasons).map(function(key) {
          return '<option value="' + key + '">' + escapeHtml(reviewReasons[key]) + '</option>';
        }).join('') + '</select></label>' +
        '<label>Комментарий (необязательно)<textarea data-map-review-note ' +
        'maxlength="300" rows="2" placeholder="Что проверили?"></textarea></label>' +
        '<p class="hm-map-review-hint">После подтверждения организация исчезнет с карты у всей команды. ' +
        'Её можно будет вернуть из списка «Отработанные и скрытые».</p>' +
        '<p data-map-review-error role="alert" class="hm-map-review-error"></p>' +
        '<div class="hm-map-review-actions"><button type="submit" class="hm-map-action">' +
        'Подтвердить и скрыть</button><button type="button" data-map-review-cancel>' +
        'Отмена</button></div></form>';
      if (typeof detail.scrollIntoView === 'function') {
        detail.scrollIntoView({behavior:'smooth',block:'nearest'});
      }
    }
    function applyReview(item, review) {
      item.hidden = !!review.hidden;
      item.review_reason = review.review_reason || null;
      item.review_note = review.review_note || null;
      item.reviewed_at = review.reviewed_at || null;
      if (item.hidden) {
        state.records = state.records.filter(function(row) {
          return !(row.type === 'candidate' && Number(row.id) === Number(item.id));
        });
        state.reviewedCandidates = state.reviewedCandidates.filter(function(row) {
          return Number(row.id) !== Number(item.id);
        });
        state.reviewedCandidates.unshift(item);
        state.notice = '✅ «' + item.name + '» отмечена как отработанная и скрыта с карты.';
      } else {
        state.reviewedCandidates = state.reviewedCandidates.filter(function(row) {
          return Number(row.id) !== Number(item.id);
        });
        if (!item.matched && item.recommendation !== 'Не добавлять повторно') {
          state.records.push(item);
        }
        state.notice = '↩ «' + item.name + '» возвращена на карту.';
      }
      ++state.generation;
      resetMap();
      renderShell();
      draw();
    }
    async function saveReview(item, action, form) {
      if (state.reviewBusy || !item || item.type !== 'candidate') return;
      var reason = action === 'hide' ? String(
        form && form.querySelector('[data-map-review-reason]') &&
        form.querySelector('[data-map-review-reason]').value || ''
      ) : '';
      var note = action === 'hide' ? String(
        form && form.querySelector('[data-map-review-note]') &&
        form.querySelector('[data-map-review-note]').value || ''
      ).trim() : '';
      var errorEl = form && form.querySelector('[data-map-review-error]');
      if (action === 'hide' && !reviewReasons[reason]) {
        if (errorEl) errorEl.textContent = 'Выберите причину проверки.';
        return;
      }
      if (!token()) {
        if (errorEl) errorEl.textContent = 'Сессия сотрудника истекла. Войдите снова.';
        return;
      }
      state.reviewBusy = true;
      var buttons = form ? Array.from(form.querySelectorAll('button')) :
        Array.from(root.querySelectorAll('[data-map-review-restore]'))
          .filter(function(btn) { return btn.dataset.mapReviewRestore === String(item.id); });
      buttons.forEach(function(btn) { btn.disabled = true; });
      try {
        var response = await fetch(
          '/api/partner-leads/network-map/candidates/' + encodeURIComponent(item.id) + '/review', {
            method: 'POST', cache: 'no-store',
            headers: {
              'Authorization': 'Bearer ' + token(),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action: action, reason: reason, note: note })
          }
        );
        var result = await response.json().catch(function() { return {}; });
        if (!response.ok) throw new Error(result.error || 'Не удалось сохранить результат проверки');
        if (current === instance && node.isConnected) applyReview(item, result);
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message;
        else if (current === instance && node.isConnected) {
          state.notice = '⚠ ' + String(error.message || 'Не удалось сохранить');
          var msg = root.querySelector('[data-map-review-notice]');
          if (msg) msg.textContent = state.notice;
        }
      } finally {
        state.reviewBusy = false;
        buttons.forEach(function(btn) { btn.disabled = false; });
      }
    }
    function statusText() {
      var all = items();
      var mapped = all.filter(function (i) { return !!itemPosition(i); }).length;
      var missing = all.length - mapped;
      return 'На карте: ' + mapped + ' из ' + all.length +
        (missing ? ' · Не нанесены: ' + missing : ' · Все объекты нанесены');
    }
    function updateCount() {
      var counter = root.querySelector('[data-map-count]');
      if (counter) counter.textContent = statusText();
      renderUnplaced();
    }
    function updateList() {
      var target = root.querySelector('[data-map-list]');
      if (!target) return;
      var all = items();
      target.innerHTML = all.length ? all.map(function (item) {
        return '<button class="hm-map-row" type="button" data-map-item="' +
          escapeHtml(itemId(item)) + '"><span class="hm-map-dot" style="background:' +
          colors[colorKey(item)] + '"></span><span><strong>' + escapeHtml(item.name) +
          '</strong><small>' + escapeHtml(item.address || 'Адрес отсутствует') +
          ' · ' + escapeHtml(labels[colorKey(item)]) + '</small></span></button>';
      }).join('') : '<p class="hm-map-muted">По выбранным фильтрам объектов нет.</p>';
    }
    function renderShell() {
      root.innerHTML = '<div class="hm-map-top"><div><h2>🗺️ Карта партнёрской сети</h2>' +
        '<p>CRM со статусами и отдельный реестр 114 найденных салонов. ' +
        'Фиолетовые кандидаты не внесены в CRM и требуют сверки перед прозвоном.</p></div>' +
        '<button type="button" class="hm-map-reload" data-map-refresh>↻ Обновить</button></div>' +
        '<p class="hm-map-review-notice" data-map-review-notice role="status">' +
        escapeHtml(state.notice) + '</p>' +
        '<div class="hm-map-controls"><label>Город <select data-map-city><option value="">Все города</option>' +
        cityOptions() + '</select></label><label>Статус <select data-map-status>' +
        '<option value="all">Все статусы</option>' + Object.keys(colors).map(function (key) {
          return '<option value="' + key + '"' + (state.status === key ? ' selected' : '') +
            '>' + labels[key] + '</option>';
        }).join('') + '</select></label></div>' +
        '<div class="hm-map-candidate-controls">' +
        (state.candidateTotal
          ? '<label><input type="checkbox" data-map-candidates ' +
              (state.showCandidates ? 'checked' : '') +
              '> Показывать найденных кандидатов (' + state.candidateTotal + ')</label>' +
            '<label>Район (кандидаты) <select data-map-district>' +
            '<option value="">Все районы</option>' +
            ['Советский','Свердловский','Центральный','Октябрьский',
              'Железнодорожный','Кировский','Ленинский'].map(function(x) {
              return '<option value="' + escapeHtml(x) + '"' +
                (x === state.district ? ' selected' : '') + '>' + escapeHtml(x) + '</option>';
            }).join('') + '</select></label>'
          : '') + '</div>' +
        (state.candidateTotal ? '<p class="hm-map-sources">' +
          'Внешний реестр: <b>' + state.candidateTotal + ' карточек</b> · ' +
          'возможных совпадений с CRM: <b>' + state.matchedCandidates.length +
          '</b>. Совпадения не дублируются фиолетовыми метками. ' +
          'Статус «ещё не звонили» присваивается только в CRM.' +
          (state.reviewedCandidates.length ? ' Скрыто после проверки: <b>' +
            state.reviewedCandidates.length + '</b>.' : '') + '</p>' : '') +
        reviewedListMarkup() +
        '<div class="hm-map-legend">' + legend() + '</div>' +
        '<section class="hm-map-attention" data-map-attention hidden></section>' +
        '<div class="hm-map-canvas" data-map-canvas><p class="hm-map-muted">Загружаем карту…</p></div>' +
        '<div class="hm-map-counter" data-map-count>' + statusText() + '</div>' +
        '<button type="button" class="hm-map-more" data-map-more hidden>📍 Разместить ещё адреса</button>' +
        '<div class="hm-map-bottom"><div><h3>Объекты на карте и без координат</h3>' +
        '<div class="hm-map-list" data-map-list></div></div>' +
        '<div class="hm-map-detail" data-map-detail>Выберите объект на карте или в списке.</div></div>';
      updateList();
    }
    function recordById(id) {
      return state.records.find(function (item) { return itemId(item) === id; });
    }
    function selectItem(item, focus) {
      var detail = root.querySelector('[data-map-detail]');
      if (detail) detail.innerHTML = details(item, false);
      if (focus && state.map) {
        var coords = itemPosition(item);
        if (coords) {
          state.map.setCenter(coords, Math.max(state.map.getZoom(), 15), { duration: 250 });
          var marker = state.markers[itemId(item)];
          if (marker) marker.balloon.open();
        }
      }
    }
    function addMarker(item, coords) {
      if (!state.map || !coords) return;
      var marker = new window.ymaps.Placemark(coords, {
        hintContent: String(item.name || ''),
        balloonContent: details(item, true)
      }, {
        preset: 'islands#circleDotIcon',
        iconColor: colors[colorKey(item)]
      });
      marker.events.add('click', function () { selectItem(item, false); });
      state.map.geoObjects.add(marker);
      state.markers[itemId(item)] = marker;
    }
    async function draw() {
      var generation = ++state.generation;
      Object.keys(state.geocodeStates).forEach(function (key) {
        if (state.geocodeStates[key] === 'loading') delete state.geocodeStates[key];
      });
      var filtered = items();
      updateList();
      var legendEl = root.querySelector('.hm-map-legend');
      if (legendEl) legendEl.innerHTML = legend();
      updateCount();
      var canvas = root.querySelector('[data-map-canvas]');
      var more = root.querySelector('[data-map-more]');
      if (!filtered.length) {
        resetMap();
        canvas.innerHTML = '<p class="hm-map-muted">Нет объектов с этим статусом.</p>';
        more.hidden = true;
        return;
      }
      var key = window.TAIGA_CONFIG && window.TAIGA_CONFIG.YANDEX_MAPS_API_KEY;
      if (!key) {
        resetMap();
        canvas.innerHTML = '<p class="hm-map-muted">Для отображения карты нужен ключ Яндекс.Карт ' +
          'YANDEX_MAPS_API_KEY в конфигурации сайта. Список объектов доступен ниже.</p>';
        more.hidden = true;
        return;
      }
      try {
        await mapsScript(key);
        if (!isAlive() || generation !== state.generation) return;
        if (!state.map) {
          canvas.innerHTML = '';
          var first = filtered.map(itemPosition).find(Boolean) || [56.0097, 92.8526];
          state.map = new window.ymaps.Map(canvas, {
            center: first, zoom: 11, controls: ['zoomControl']
          });
        } else state.map.geoObjects.removeAll();
        state.markers = Object.create(null);
        filtered.forEach(function (item) {
          var coords = itemPosition(item);
          if (coords) addMarker(item, coords);
        });
        function fit() {
          if (!state.map || !state.map.geoObjects.getLength()) return;
          if (state.map.geoObjects.getLength() === 1) {
            var marker = state.map.geoObjects.get(0);
            state.map.setCenter(marker.geometry.getCoordinates(), 13);
          } else state.map.setBounds(state.map.geoObjects.getBounds(),
            { checkZoomRange: true, zoomMargin: 42, duration: 180 });
        }
        fit();

        // IDs are resolved on the server: the browser never passes arbitrary
        // untrusted addresses to a geocoder or exposes other managers' CRM.
        var pending = filtered.filter(function(item) {
          return (item.type === 'lead' || item.type === 'candidate') &&
            !itemPosition(item) && !state.geocodeStates[itemId(item)];
        });
        var batch = pending.slice(0, state.limit);
        more.hidden = pending.length <= batch.length;
        for (var offset = 0; offset < batch.length; offset += 5) {
          if (!isAlive() || generation !== state.generation) return;
          var page = batch.slice(offset, offset + 5);
          page.forEach(function(item) { state.geocodeStates[itemId(item)] = 'loading'; });
          updateCount();
          try {
            var response = await fetch('/api/partner-leads/network-map/coordinates', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                lead_ids: page.filter(function(item) { return item.type === 'lead'; })
                  .map(function(item) { return Number(item.id); }),
                candidate_ids: page.filter(function(item) { return item.type === 'candidate'; })
                  .map(function(item) { return Number(item.id); })
              })
            });
            var result = await response.json().catch(function() { return {}; });
            if (!response.ok) throw new Error(result.error || 'Ошибка определения адреса');
            if (!isAlive() || generation !== state.generation) return;
            (result.results || []).forEach(function(entry) {
              var item = page.find(function(x) {
                return x.type === (entry.type || 'lead') && Number(x.id) === Number(entry.id);
              });
              if (!item) return;
              var id = itemId(item);
              state.geocodeStates[id] = entry.status || 'needs_verification';
              if (entry.status === 'mapped' &&
                  validCoordinate(entry.lat, -90, 90) &&
                  validCoordinate(entry.lng, -180, 180)) {
                var coords = [Number(entry.lat), Number(entry.lng)];
                state.cache[id] = coords;
                addMarker(item, coords);
              }
            });
            // Mark unknown response records as unresolved, not permanently loading.
            page.forEach(function(item) {
              if (state.geocodeStates[itemId(item)] === 'loading')
                state.geocodeStates[itemId(item)] = 'unavailable';
            });
          } catch (_) {
            if (!isAlive() || generation !== state.generation) return;
            page.forEach(function(item) {
              state.geocodeStates[itemId(item)] = 'unavailable';
            });
          }
          updateCount();
        }
        if (isAlive() && generation === state.generation) {
          fit();
          var left = filtered.filter(function(item) {
            return (item.type === 'lead' || item.type === 'candidate') &&
              !itemPosition(item) && !state.geocodeStates[itemId(item)];
          });
          more.hidden = !left.length;
          if (left.length) more.textContent = '📍 Проверить ещё ' +
            Math.min(40, left.length) + ' адресов';
          updateCount();
        }
      } catch (error) {
        if (!isAlive() || generation !== state.generation) return;
        resetMap();
        canvas.innerHTML = '<p class="hm-map-muted">' +
          escapeHtml(error.message || 'Не удалось открыть карту') +
          '. Список и контакты доступны ниже.</p>';
        updateCount();
      }
    }
    async function refresh() {
      ++state.generation;
      state.error = '';
      state.geocodeStates = Object.create(null);
      state.cache = Object.create(null);
      resetMap(); // A refreshed panel has a new map DIV; never reuse the old instance.
      root.innerHTML = '<p class="hm-map-muted">Загружаем актуальные записи CRM…</p>';
      try {
        if (!token()) throw new Error('Нужен вход в кабинет сотрудника');
        var response = await fetch('/api/partner-leads/network-map', {
          headers: { 'Authorization': 'Bearer ' + token() }
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
        if (!isAlive()) return;
        var candidates = data.candidates || [];
        state.candidateTotal = Number(data.candidate_source_total || candidates.length);
        state.matchedCandidates = candidates.filter(function(item) {
          return !!item.matched || item.recommendation === 'Не добавлять повторно';
        });
        state.reviewedCandidates = candidates.filter(function(item) { return !!item.hidden; });
        // Only unmapped candidate cards are plotted; known operating points and
        // strong CRM matches are shown through their original live CRM markers.
        state.records = (data.points || []).concat(data.leads || []).concat(
          candidates.filter(function(item) {
            return !item.hidden && !item.matched && item.recommendation !== 'Не добавлять повторно';
          })
        );
        renderShell();
        await draw();
      } catch (error) {
        if (isAlive()) root.innerHTML = '<p class="hm-map-muted">' +
          escapeHtml(error.message) + '</p><button class="hm-map-reload" ' +
          'data-map-refresh>Повторить</button>';
      }
    }
    root.addEventListener('change', function (event) {
      if (event.target.matches('[data-map-city]')) state.city = event.target.value;
      else if (event.target.matches('[data-map-status]')) state.status = event.target.value;
      else if (event.target.matches('[data-map-district]')) {
        state.district = event.target.value;
        // District applies only to the external 114-card registry; do not
        // suggest CRM has verified district labels when it does not.
        state.status = 'candidate';
        var status = root.querySelector('[data-map-status]');
        if (status) status.value = state.status;
      } else if (event.target.matches('[data-map-candidates]')) {
        state.showCandidates = !!event.target.checked;
      } else return;
      state.limit = initialLimit;
      draw();
    });
    root.addEventListener('click', function (event) {
      var toggleReviewed = event.target.closest('[data-map-reviewed-toggle]');
      if (toggleReviewed) {
        state.showReviewed = !state.showReviewed;
        var reviewedSection = root.querySelector('.hm-map-reviewed');
        if (reviewedSection) reviewedSection.outerHTML = reviewedListMarkup();
        return;
      }
      var startBtn = event.target.closest('[data-map-review-start]');
      if (startBtn) {
        var candidate = recordById('c:' + startBtn.dataset.mapReviewStart);
        if (candidate) startReview(candidate);
        return;
      }
      var restoreBtn = event.target.closest('[data-map-review-restore]');
      if (restoreBtn) {
        var restoreItem = state.reviewedCandidates.find(function(row) {
          return String(row.id) === restoreBtn.dataset.mapReviewRestore;
        });
        if (restoreItem) saveReview(restoreItem, 'restore', null);
        return;
      }
      var cancelBtn = event.target.closest('[data-map-review-cancel]');
      if (cancelBtn) {
        var form = cancelBtn.closest('[data-map-review-form]');
        var cancelItem = form && recordById('c:' + form.dataset.mapReviewForm);
        if (cancelItem) selectItem(cancelItem, false);
        return;
      }
      var refreshButton = event.target.closest('[data-map-refresh]');
      if (refreshButton) { refresh(); return; }
      var more = event.target.closest('[data-map-more]');
      if (more) { state.limit += initialLimit; draw(); return; }
      var leadBtn = event.target.closest('[data-map-open-lead]');
      if (leadBtn && typeof options.onOpenLead === 'function') {
        options.onOpenLead(leadBtn.dataset.mapOpenLead);
        return;
      }
      var row = event.target.closest('[data-map-item]');
      if (row) {
        var item = recordById(row.dataset.mapItem);
        if (item) selectItem(item, true);
      }
    });
    root.addEventListener('submit', function(event) {
      var form = event.target.closest('[data-map-review-form]');
      if (!form) return;
      event.preventDefault();
      var candidate = recordById('c:' + form.dataset.mapReviewForm);
      if (candidate) saveReview(candidate, 'hide', form);
    });
    var instance = {
      node: node, refresh: refresh,
      destroy: function () {
        ++state.generation;
        resetMap();
        if (current === instance) current = null;
      }
    };
    current = instance;
    refresh();
    return instance;
  }
  window.HvostPartnerNetworkMap = { mount: mount, venueYandexLink: venueYandexLink };
})();
