(function () {
  'use strict';

  const timers = new Map();
  const roleCopy = {
    partner: 'Получайте в MAX уведомления о выплатах, сумме вознаграждения и показателях точки.',
    owner: 'Получайте в MAX сводку по выплате и работе вашего минимаркета.',
  };

  function stop(containerId) {
    if (timers.has(containerId)) clearTimeout(timers.get(containerId));
    timers.delete(containerId);
  }

  function headers(tokenGetter) {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + tokenGetter(),
    };
  }

  function mount(options) {
    const container = document.getElementById(options.containerId);
    if (!container) return;
    stop(options.containerId);
    let connected = !!options.connected;

    container.innerHTML =
      '<div class="tg-connect-card">' +
        '<div class="tg-connect-head">' +
          '<div class="tg-connect-title"><span class="tg-connect-icon" style="background:#7C4DFF;">M</span>MAX</div>' +
          '<span class="tg-connect-status"></span>' +
        '</div>' +
        '<div class="tg-connect-copy">' + (roleCopy[options.role] || 'Получайте личные уведомления в MAX.') + '</div>' +
        '<div class="tg-connect-actions">' +
          '<button type="button" class="tg-connect-button" style="background:#7C4DFF;"></button>' +
          '<a class="tg-connect-link" target="_blank" rel="noopener" style="display:none;color:#6740d4;">Открыть бота вручную →</a>' +
        '</div>' +
        '<div class="tg-connect-message" aria-live="polite"></div>' +
      '</div>';

    const status = container.querySelector('.tg-connect-status');
    const button = container.querySelector('.tg-connect-button');
    const link = container.querySelector('.tg-connect-link');
    const message = container.querySelector('.tg-connect-message');

    function renderStatus() {
      status.textContent = connected ? '✓ Подключён' : 'Не подключён';
      status.className = 'tg-connect-status ' + (connected ? 'is-on' : 'is-off');
      button.textContent = connected ? 'Переподключить MAX' : 'Подключить MAX';
    }

    async function poll(token, attempt) {
      if (attempt > 300) {
        message.textContent = 'Время ожидания истекло. Нажмите кнопку и создайте новую ссылку.';
        message.className = 'tg-connect-message is-error';
        button.disabled = false;
        return;
      }
      try {
        const res = await fetch('/api/max/connect/check?token=' + encodeURIComponent(token), {
          headers: headers(options.tokenGetter),
        });
        const data = await res.json();
        if (res.status === 401) throw new Error('Сессия завершена — войдите в кабинет снова.');
        if (res.status === 410) throw new Error(data.error || 'Ссылка подключения устарела.');
        if (!res.ok) throw new Error(data.error || 'Не удалось проверить подключение.');
        if (data.verified) {
          connected = true;
          renderStatus();
          button.disabled = false;
          link.style.display = 'none';
          message.textContent = '✓ MAX успешно подключён к этому кабинету.';
          message.className = 'tg-connect-message is-ok';
          stop(options.containerId);
          return;
        }
      } catch (error) {
        button.disabled = false;
        message.textContent = error.message || 'Ошибка подключения MAX.';
        message.className = 'tg-connect-message is-error';
        stop(options.containerId);
        return;
      }
      timers.set(options.containerId, setTimeout(function () { poll(token, attempt + 1); }, 2000));
    }

    button.addEventListener('click', async function () {
      stop(options.containerId);
      button.disabled = true;
      link.style.display = 'none';
      message.textContent = 'Создаём защищённую ссылку…';
      message.className = 'tg-connect-message';
      const botWindow = window.open('about:blank', '_blank');
      try {
        const res = await fetch('/api/max/connect/start', {
          method: 'POST',
          headers: headers(options.tokenGetter),
          body: '{}',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Не удалось создать ссылку подключения.');
        link.href = data.deep_link;
        link.style.display = 'inline';
        if (botWindow) botWindow.location.href = data.deep_link;
        message.textContent = 'В MAX запустите бота и нажмите «Поделиться номером». Подключение подтвердится автоматически.';
        poll(data.token, 0);
      } catch (error) {
        if (botWindow) botWindow.close();
        button.disabled = false;
        message.textContent = error.message || 'Ошибка подключения MAX.';
        message.className = 'tg-connect-message is-error';
      }
    });

    renderStatus();
  }

  window.HvostMaxConnect = { mount: mount };
})();
