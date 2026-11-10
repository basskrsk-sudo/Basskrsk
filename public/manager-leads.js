/* Shared manager call-list UI for desktop manager cabinet and Telegram Mini App.
 * Uses the very same /api/partner-leads endpoints as the administrator CRM. */
(function () {
  'use strict';
  var statuses = [
    ['to_call', 'Нужно позвонить'],
    ['no_answer', 'Не дозвонились'],
    ['meeting_scheduled', 'Встреча назначена'],
    ['meeting_held', 'Встреча прошла'],
    ['signed', 'Партнёр подключён'],
    ['declined', 'Отказ'],
  ];
  var categories = [
    ['groomer', 'Груминг-салон'],
    ['vet', 'Ветклиника'],
    ['training_center', 'Кинологический центр / центр дрессировки'],
    ['kennel', 'Кинолог'],
    ['hotel', 'Зоогостиница'],
    ['other', 'Другое'],
  ];
  var instances = new WeakMap();
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dateLabel(date) {
    if (!date) return 'Дата не назначена';
    var parts = String(date).slice(0, 10).split('-');
    return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : String(date);
  }
  function timeLabel(value) {
    if (!value) return '';
    var date = new Date(String(value).replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ru-RU');
  }
  function label(items, value) {
    var item = items.find(function (pair) { return pair[0] === value; });
    return item ? item[1] : (value || '—');
  }
  function selectOptions(items, value, empty) {
    return (empty ? '<option value="">' + esc(empty) + '</option>' : '') +
      items.map(function (pair) {
        return '<option value="' + esc(pair[0]) + '"' + (pair[0] === value ? ' selected' : '') + '>' + esc(pair[1]) + '</option>';
      }).join('');
  }
  function mount(container, options) {
    if (!container || !options || typeof options.token !== 'function') return null;
    var previous = instances.get(container);
    if (previous) { previous.reload(); return previous; }
    var panel = document.createElement('div');
    panel.className = 'hmleads';
    container.textContent = '';
    container.appendChild(panel);
    var state = { leads: [], current: null, notes: [], view: 'list', ownership: 'all',
      q: '', status: '', loading: false, message: '', error: '' };
    var alive = true;
    function token() { return String(options.token() || ''); }
    async function api(path, method, body) {
      if (!token()) throw new Error('Сессия менеджера не найдена. Повторите вход.');
      var response = await fetch(path, {
        method: method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + token(),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || ('Ошибка сервера: ' + response.status));
      return data;
    }
    function hint(message, error) {
      return message ? '<p class="hmleads-message' + (error ? ' hmleads-error' : '') + '" role="status">' + esc(message) + '</p>' : '';
    }
    function isFree(lead) { return lead && lead.assigned_manager_id == null; }
    function matchesOwner(lead) {
      return state.ownership === 'all' ||
        (state.ownership === 'mine' && !isFree(lead)) ||
        (state.ownership === 'free' && isFree(lead));
    }
    function renderList() {
      var filtered = state.leads.filter(matchesOwner);
      var total = state.leads.length;
      var today = new Date().toISOString().slice(0, 10);
      panel.innerHTML = '<div class="hmleads-head">' +
        '<div><h2>📞 Прозвон партнёров</h2><p>Общая CRM с админкой. Видны ваши заведения и свободные заявки вашего города.</p></div>' +
        '<button class="hmleads-primary" type="button" data-hm-action="new">+ Добавить</button></div>' +
        '<form class="hmleads-filters" data-hm-form="search">' +
        '<label class="hmleads-field">Поиск<input name="q" placeholder="Салон, контакт, телефон" value="' + esc(state.q) + '"></label>' +
        '<label class="hmleads-field">Статус<select name="status">' + selectOptions(statuses, state.status, 'Все статусы') + '</select></label>' +
        '<button class="hmleads-secondary" type="submit">Найти</button>' +
        '<button class="hmleads-secondary" type="button" data-hm-action="refresh">Обновить</button>' +
        '</form>' +
        '<div class="hmleads-tabs">' +
        [['all', 'Все доступные'], ['mine', 'Мои'], ['free', 'Свободные']].map(function (pair) {
          return '<button type="button" data-hm-action="filter" data-hm-value="' + pair[0] +
            '" class="' + (state.ownership === pair[0] ? 'selected' : '') + '">' + pair[1] + '</button>';
        }).join('') + '</div>' +
        hint(state.message, false) + hint(state.error, true) +
        '<p class="hmleads-count">Найдено: ' + filtered.length + ' из ' + total + '</p>' +
        '<div class="hmleads-grid">' + (filtered.length ? filtered.map(function (lead) {
          var late = lead.next_contact_date && lead.next_contact_date < today &&
            !['signed', 'declined'].includes(lead.status);
          return '<button type="button" class="hmleads-item" data-hm-action="open" data-hm-id="' + lead.id + '">' +
            '<div class="hmleads-item-title"><strong>' + esc(lead.salon_name) + '</strong>' +
            '<span class="hmleads-status">' + esc(label(statuses, lead.status)) + '</span></div>' +
            '<div class="hmleads-sub">' + esc(label(categories, lead.category)) +
            (lead.contact_name ? ' · ' + esc(lead.contact_name) : '') + '</div>' +
            '<div class="hmleads-sub">' + esc(lead.phone || 'Телефон не указан') + '</div>' +
            '<div class="hmleads-item-end"><span class="' + (late ? 'hmleads-overdue' : '') + '">' +
              'Следующий контакт: ' + esc(dateLabel(lead.next_contact_date)) + '</span>' +
              '<span>' + (isFree(lead) ? 'Свободная заявка' : 'Назначено вам') + '</span></div>' +
            '</button>';
        }).join('') : '<p class="hmleads-empty">Заявок по выбранным фильтрам нет.</p>') + '</div>';
    }

    function sourceLink(lead) {
      var source=String(lead.yandex_url||lead.dgis_url||'');
      var trusted=/^https:\/\/yandex\.ru\/maps\/org\/[a-z0-9_-]+\/\d{5,20}$/i.test(source) ||
        /^https:\/\/yandex\.ru\/maps\/org\/\d{5,20}$/i.test(source) ||
        /^https:\/\/2gis\.ru\/[a-z0-9-]+\/(?:firm|geo)\/\d{10,20}$/i.test(source);
      if(!trusted) return '';
      var label=lead.yandex_url?'Открыть в Яндекс Картах':'Открыть в 2ГИС';
      return '<p class="hmleads-sub"><a href="'+esc(source)+
        '" target="_blank" rel="noopener noreferrer">'+label+'</a></p>';
    }

    function detailField(title, control) {
      return '<label class="hmleads-field">' + title + control + '</label>';
    }
    function renderDetail() {
      var lead = state.current || {};
      var isNew = state.view === 'new';
      var free = !isNew && isFree(lead);
      var disabled = free ? ' disabled' : '';
      var notes = state.notes || [];
      panel.innerHTML = '<div class="hmleads-detail-head"><button type="button" class="hmleads-secondary" data-hm-action="back">← К списку</button>' +
        '<h2>' + (isNew ? 'Новое заведение' : 'Карточка заведения') + '</h2></div>' +
        hint(state.message, false) + hint(state.error, true) +
        (free ? '<div class="hmleads-notice">Эта заявка ещё не закреплена за вами. Чтобы редактировать и вести прозвон, возьмите её в работу.<button type="button" class="hmleads-primary" data-hm-action="claim">Взять в работу</button></div>' : '') +
        '<form data-hm-form="lead">' +
          detailField('Название заведения *', '<input name="salon_name" required maxlength="200" value="' + esc(lead.salon_name || '') + '"' + disabled + '>') +
          '<div class="hmleads-two">' +
            detailField('Категория', '<select name="category"' + disabled + '>' + selectOptions(categories, lead.category || 'groomer') + '</select>') +
            detailField('Телефон', '<input name="phone" type="tel" value="' + esc(lead.phone || '') + '"' + disabled + '>') +
          '</div>' +
          detailField('Адрес', '<input name="address" value="' + esc(lead.address || '') + '"' + disabled + '>') +
          detailField('Контактное лицо', '<input name="contact_name" value="' + esc(lead.contact_name || '') + '"' + disabled + '>') +
          '<div class="hmleads-two">' +
            detailField('Статус', '<select name="status"' + disabled + '>' + selectOptions(statuses, lead.status || 'to_call') + '</select>') +
            detailField('Следующий контакт', '<input name="next_contact_date" type="date" value="' + esc(lead.next_contact_date || '') + '"' + disabled + '>') +
          '</div>' +
          (isNew ? detailField('Первый комментарий', '<textarea name="note" rows="3" placeholder="Откуда контакт, что обсудили"></textarea>') : '') +
          (!free ? '<button class="hmleads-primary" type="submit">' + (isNew ? 'Добавить в прозвон' : 'Сохранить изменения') + '</button>' : '') +
        '</form>' + (!isNew ? sourceLink(lead) : '') +
        (!isNew ? '<section class="hmleads-history"><h3>История переговоров</h3>' +
          (notes.length ? notes.map(function (note) {
            return '<div class="hmleads-note"><small>' + esc(timeLabel(note.created_at)) + ' · ' + esc(note.author) +
              '</small><p>' + esc(note.note) + '</p></div>';
          }).join('') : '<p class="hmleads-empty">Записей пока нет.</p>') +
          (!free ? '<form data-hm-form="note"><label class="hmleads-field">Новая запись<textarea name="note" rows="3" required placeholder="Итог звонка, договорённость"></textarea></label>' +
            '<button class="hmleads-secondary" type="submit">Добавить в историю</button></form>' : '') +
          '</section>' : '');
    }
    async function reload() {
      state.view = 'list';
      state.message = '';
      state.error = '';
      panel.innerHTML = '<p class="hmleads-empty">Загружаем актуальную базу прозвона…</p>';
      try {
        var qs = new URLSearchParams();
        if (state.q) qs.set('q', state.q);
        if (state.status) qs.set('status', state.status);
        var data = await api('/api/partner-leads' + (qs.toString() ? '?' + qs.toString() : ''));
        if (!alive || state.view !== 'list') return;
        state.leads = data.leads || [];
        renderList();
      } catch (error) {
        if (!alive) return;
        state.error = error.message;
        renderList();
      }
    }
    async function open(id) {
      state.view = 'detail';
      state.message = '';
      state.error = '';
      panel.innerHTML = '<p class="hmleads-empty">Загружаем карточку…</p>';
      try {
        var data = await api('/api/partner-leads/' + encodeURIComponent(id));
        if (!alive || state.view !== 'detail') return;
        state.current = data.lead;
        state.notes = data.notes || [];
        renderDetail();
      } catch (error) {
        if (!alive) return;
        state.error = error.message;
        await reload();
        state.error = error.message;
        renderList();
      }
    }
    async function claim() {
      if (!state.current || !isFree(state.current)) return;
      try {
        await api('/api/partner-leads/' + state.current.id + '/claim', 'POST');
        await open(state.current.id);
        state.message = 'Заведение закреплено за вами. Администратор увидит это изменение.';
        renderDetail();
      } catch (error) {
        state.error = error.message;
        renderDetail();
      }
    }
    function formData(form) {
      var data = new FormData(form);
      var out = {};
      ['salon_name', 'category', 'address', 'contact_name', 'phone', 'status', 'next_contact_date', 'note'].forEach(function (key) {
        if (data.has(key)) out[key] = String(data.get(key) || '').trim() || null;
      });
      return out;
    }
    async function save(form) {
      var body = formData(form);
      if (!body.salon_name) { state.error = 'Укажите название заведения.'; renderDetail(); return; }
      var newLead = state.view === 'new';
      try {
        var result = await api(newLead ? '/api/partner-leads' : '/api/partner-leads/' + state.current.id,
          newLead ? 'POST' : 'PUT', body);
        if (newLead) {
          await open(result.id);
          state.message = 'Заведение добавлено, синхронизировано с админкой.';
        } else {
          await open(state.current.id);
          state.message = 'Изменения сохранены. В админке актуальные данные.';
        }
        renderDetail();
      } catch (error) {
        state.error = error.message;
        renderDetail();
      }
    }
    async function addNote(form) {
      var note = String(new FormData(form).get('note') || '').trim();
      if (!note || !state.current || isFree(state.current)) return;
      try {
        await api('/api/partner-leads/' + state.current.id + '/notes', 'POST', { note: note });
        await open(state.current.id);
        state.message = 'Запись добавлена в общую историю.';
        renderDetail();
      } catch (error) {
        state.error = error.message;
        renderDetail();
      }
    }
    panel.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-hm-action]');
      if (!btn || !panel.contains(btn)) return;
      var action = btn.dataset.hmAction;
      if (action === 'new') {
        state.view = 'new'; state.current = {}; state.notes = []; state.message = ''; state.error = '';
        return renderDetail();
      }
      if (action === 'back') return reload();
      if (action === 'open') return open(btn.dataset.hmId);
      if (action === 'claim') return claim();
      if (action === 'refresh') return reload();
      if (action === 'filter') { state.ownership = btn.dataset.hmValue; return renderList(); }
    });
    panel.addEventListener('submit', function (event) {
      var form = event.target.closest('[data-hm-form]');
      if (!form || !panel.contains(form)) return;
      event.preventDefault();
      if (form.dataset.hmForm === 'search') {
        state.q = String(new FormData(form).get('q') || '').trim();
        state.status = String(new FormData(form).get('status') || '');
        return reload();
      }
      if (form.dataset.hmForm === 'lead') return save(form);
      if (form.dataset.hmForm === 'note') return addNote(form);
    });
    var instance = {
      reload: reload,
      destroy: function () { alive = false; instances.delete(container); container.textContent = ''; },
    };
    instances.set(container, instance);
    reload();
    return instance;
  }
  window.HvostManagerLeads = { mount: mount };
})();