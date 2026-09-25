(function () {
  'use strict';

  const timers = new Map();
  const roleCopy = {
    partner: 'Получайте уведомления о продажах и вознаграждениях прямо в Telegram.',
    manager: 'Получайте уведомления о продажах на ваших точках и важных событиях.',
    owner: 'Получайте личные уведомления по вашей точке и выплатам.',
    admin: 'Подключите личный Telegram администратора для служебных уведомлений.',
  };

  function stop(containerId) {
    if (timers.has(containerId)) clearTimeout(timers.get(containerId));
    timers.delete(containerId);
  }

  function authHeaders(tokenGetter) {
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
          '<div class="tg-connect-title"><span class="tg-connect-icon">➤</span>Telegram</div>' +
          '<span class="tg-connect-status"></span>' +
        '</div>' +
        '<div class="tg-connect-copy">' + (roleCopy[options.role] || 'Получайте личные уведомления в Telegram.') + '</div>' +
        '<div class="tg-connect-actions">' +
          '<button type="button" class="tg-connect-button"></button>' +
          '<a class="tg-connect-link" target="_blank" rel="noopener" style="display:none;">Открыть бота вручную →</a>' +
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
      button.textContent = connected ? 'Переподключить Telegram' : 'Подключить Telegram';
    }

    async function poll(token, attempt) {
      if (attempt > 150) {
        message.textContent = 'Время ожидания истекло. Нажмите кнопку и создайте новую ссылку.';
        message.className = 'tg-connect-message is-error';
        button.disabled = false;
        return;
      }
      try {
        const res = await fetch('/api/telegram/connect/check?token=' + encodeURIComponent(token), {
          headers: authHeaders(options.tokenGetter),
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
          message.textContent = '✓ Telegram успешно подключён к этому кабинету.';
          message.className = 'tg-connect-message is-ok';
          stop(options.containerId);
          return;
        }
      } catch (error) {
        button.disabled = false;
        message.textContent = error.message || 'Ошибка подключения Telegram.';
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
        const res = await fetch('/api/telegram/connect/start', {
          method: 'POST',
          headers: authHeaders(options.tokenGetter),
          body: '{}',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Не удалось создать ссылку подключения.');
        link.href = data.deep_link;
        link.style.display = 'inline';
        if (botWindow) botWindow.location.href = data.deep_link;
        message.textContent = 'В Telegram нажмите «Запустить» или отправьте /start. Эта страница подтвердит подключение автоматически.';
        poll(data.token, 0);
      } catch (error) {
        if (botWindow) botWindow.close();
        button.disabled = false;
        message.textContent = error.message || 'Ошибка подключения Telegram.';
        message.className = 'tg-connect-message is-error';
      }
    });

    renderStatus();
  }

  window.HvostTelegramConnect = { mount: mount };
})();
