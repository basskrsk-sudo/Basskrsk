// audit-log.js — безопасная запись действий ролей в общий журнал.
'use strict';

const db = require('./db');

function logManagerAction(managerId, action, target, managerSnapshot) {
  try {
    const manager = managerSnapshot || db.prepare('SELECT id, full_name, login FROM managers WHERE id = ?').get(managerId);
    if (!manager) {
      console.error('[audit] Не найден менеджер для записи действия, id:', managerId);
      return;
    }
    const value = target || {};
    db.prepare(`
      INSERT INTO manager_action_log
        (manager_id, manager_name, manager_login, action, target_type, target_id, target_name, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      manager.id || managerId,
      manager.full_name || null,
      manager.login || null,
      String(action || '').trim(),
      value.type ? String(value.type) : null,
      value.id == null ? null : String(value.id),
      value.name ? String(value.name) : null,
      value.details ? String(value.details) : null
    );
  } catch (error) {
    // Ошибка журнала не должна отменять уже выполненную бизнес-операцию,
    // но обязательно остаётся в серверных логах для диагностики.
    console.error('[audit] Не удалось записать действие менеджера:', error.message);
  }
}

module.exports = { logManagerAction };
