/* Shared, read-only partnership map for admin and manager (desktop + Mini App).
 * Source: authenticated /api/partner-leads/network-map, not demo or external candidates. */
(function () {
  'use strict';
  var API_SCRIPT = null;
  var current = null;
  var colors = {
    active: '#208357', declined: '#ce4b50', to_call: '#2776c7',
    no_answer: '#ee8d3d', in_progress: '#e3aa30'
  };
  var labels = {
    active: 'Минимаркет работает', declined: 'Отказ',
    to_call: 'Ещё не звонили', no_answer: 'Не дозвонились',
    in_progress: 'Звонили · в проработке'
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
    var root = document.createElement('div');
    root.className = 'hm-network-map';
    node.textContent = '';
    node.appendChild(root);
    var state = {
      node: node, map: null, records: [], city: '', status: 'all',
      cache: Object.create(null), markers: Object.create(null), generation: 0,
      limit: 48, loading: false, cities: [], shown: [], error: ''
    };
    function token() { return String(options.token() || ''); }
    function isAlive() { return current === instance && node.isConnected; }
    function items() {
      return state.records.filter(function (i) {
        return (!state.city || String(i.city_id || '') === state.city) &&
          (state.status === 'all' || colorKey(i) === state.status);
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
    function itemId(i) { return (i.type === 'point' ? 'p:' : 'l:') + String(i.id); }
    function details(i, inBalloon) {
      var coord = state.cache[addressQuery(i)] || position(i);
      var route = coord ? 'https://yandex.ru/maps/?rtext=~' +
        encodeURIComponent(coord[0] + ',' + coord[1]) + '&rtt=auto' :
        'https://yandex.ru/maps/?text=' + encodeURIComponent(addressQuery(i) || i.name || '');
      var phone = String(i.phone || '').replace(/[^\d+]/g, '');
      var html = '<div class="hm-map-card">' +
        '<div class="hm-map-card-title">' + escapeHtml(i.name) + '</div>' +
        '<span class="hm-map-tag" style="--hm-map-color:' + colors[colorKey(i)] + '">' +
        escapeHtml(i.type === 'point' ? 'Минимаркет работает' : rawLabels[i.status] || labels[colorKey(i)]) +
        '</span>' +
        '<p>📍 ' + escapeHtml(i.address || 'Адрес не указан') + '</p>' +
        (phone.length >= 10 && i.type === 'lead' ? '<p>☎️ <a href="tel:' +
          escapeHtml(phone) + '">' + escapeHtml(i.phone) + '</a></p>' : '') +
        (i.next_contact_date && i.type === 'lead' ?
          '<p>Следующий контакт: ' + escapeHtml(i.next_contact_date) + '</p>' : '') +
        '<a target="_blank" rel="noopener noreferrer" href="' + escapeHtml(route) +
        '">Открыть в Яндекс Картах</a>' +
        (!inBalloon && i.type === 'lead' && typeof options.onOpenLead === 'function' ?
          '<button type="button" class="hm-map-action" data-map-open-lead="' +
          escapeHtml(i.id) + '">Открыть в базе обзвона</button>' : '') +
        '</div>';
      return html;
    }
    function statusText() {
      var all = items();
      var mapped = all.filter(function (i) {
        return !!(position(i) || state.cache[addressQuery(i)]);
      }).length;
      var withoutAddress = all.filter(function (i) {
        return !(position(i) || addressQuery(i));
      }).length;
      var pending = all.length - mapped - withoutAddress;
      return 'На карте: ' + mapped + ' из ' + all.length +
        (withoutAddress ? ' · Без точного адреса: ' + withoutAddress : '') +
        (pending ? ' · Ожидают определения координат: ' + pending : '');
    }
    function updateCount() {
      var counter = root.querySelector('[data-map-count]');
      if (counter) counter.textContent = statusText();
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
        '<p>Действующие минимаркеты и подтверждённые карточки единой CRM обзвона. ' +
        'Новые контакты из внешних реестров появятся только после согласования и добавления.</p></div>' +
        '<button type="button" class="hm-map-reload" data-map-refresh>↻ Обновить</button></div>' +
        '<div class="hm-map-controls"><label>Город <select data-map-city><option value="">Все города</option>' +
        cityOptions() + '</select></label><label>Статус <select data-map-status>' +
        '<option value="all">Все статусы</option>' + Object.keys(colors).map(function (key) {
          return '<option value="' + key + '"' + (state.status === key ? ' selected' : '') +
            '>' + labels[key] + '</option>';
        }).join('') + '</select></label></div>' +
        '<div class="hm-map-legend">' + legend() + '</div>' +
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
        var coords = state.cache[addressQuery(item)] || position(item);
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
      ++state.generation;
      var generation = state.generation;
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
          var first = filtered.map(position).find(Boolean) || [56.0097, 92.8526];
          state.map = new window.ymaps.Map(canvas, {
            center: first, zoom: 11, controls: ['zoomControl']
          });
        } else state.map.geoObjects.removeAll();
        state.markers = Object.create(null);
        filtered.forEach(function (item) {
          var coords = position(item) || state.cache[addressQuery(item)];
          if (coords) addMarker(item, coords);
        });
        function fit() {
          if (state.map && state.map.geoObjects.getLength()) {
            if (state.map.geoObjects.getLength() === 1) {
              var marker = state.map.geoObjects.get(0);
              state.map.setCenter(marker.geometry.getCoordinates(), 13);
            } else state.map.setBounds(state.map.geoObjects.getBounds(),
              { checkZoomRange: true, zoomMargin: 42, duration: 180 });
          }
        }
        fit();
        var unknown = filtered.filter(function (i) {
          var query = addressQuery(i);
          return !position(i) && query && !Object.prototype.hasOwnProperty.call(state.cache, query);
        });
        var batch = unknown.slice(0, state.limit);
        more.hidden = unknown.length <= batch.length;
        // Bounded queue, only when this tab is opened; never hammer API at page load.
        for (var offset = 0; offset < batch.length; offset += 3) {
          if (!isAlive() || generation !== state.generation) return;
          await Promise.all(batch.slice(offset, offset + 3).map(async function (item) {
            var query = addressQuery(item);
            try {
              var result = await window.ymaps.geocode(query, { results: 1 });
              var geo = result.geoObjects.get(0);
              var coords = geo && geo.geometry && geo.geometry.getCoordinates();
              // Reject unusable coordinates: never make up a pin on failed geocode.
              var meta = geo && geo.properties &&
                geo.properties.get('metaDataProperty.GeocoderMetaData');
              var precision = meta && meta.precision;
              var line = geo && typeof geo.getAddressLine === 'function' ?
                String(geo.getAddressLine() || '') : '';
              var targetCity = String(item.city_name || '').toLowerCase();
              var cityMatch = !targetCity || !line || line.toLowerCase().includes(targetCity);
              var addressMatch = !precision || precision === 'exact' || precision === 'number';
              state.cache[query] = cityMatch && addressMatch && Array.isArray(coords) &&
                validCoordinate(coords[0], -90, 90) &&
                validCoordinate(coords[1], -180, 180) ? coords : null;
            } catch (_) {
              state.cache[query] = null;
            }
            if (!isAlive() || generation !== state.generation) return;
            if (state.cache[query]) addMarker(item, state.cache[query]);
            updateCount();
          }));
        }
        if (isAlive() && generation === state.generation) {
          fit();
          var left = filtered.filter(function (i) {
            return !position(i) && addressQuery(i) &&
              !Object.prototype.hasOwnProperty.call(state.cache, addressQuery(i));
          });
          more.hidden = !left.length;
          if (left.length) more.textContent = '📍 Разместить ещё ' +
            Math.min(state.limit, left.length) + ' адресов';
          // Null entries are intentionally not retried on every filter change.
          updateCount();
        }
      } catch (error) {
        if (!isAlive() || generation !== state.generation) return;
        resetMap();
        canvas.innerHTML = '<p class="hm-map-muted">' +
          escapeHtml(error.message || 'Не удалось открыть карту') +
          '. Список и контакты доступны ниже.</p>';
      }
    }
    async function refresh() {
      ++state.generation;
      state.error = '';
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
        state.records = (data.points || []).concat(data.leads || []);
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
      else return;
      state.limit = 48;
      draw();
    });
    root.addEventListener('click', function (event) {
      var refreshButton = event.target.closest('[data-map-refresh]');
      if (refreshButton) { refresh(); return; }
      var more = event.target.closest('[data-map-more]');
      if (more) { state.limit += 48; draw(); return; }
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
  window.HvostPartnerNetworkMap = { mount: mount };
})();
