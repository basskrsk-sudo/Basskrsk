// Approvals for AUTOMATIC groomer commission downgrades.
// Underperforming a tier no longer changes the payable rate until a linked
// and active super-administrator explicitly approves in the Telegram bot.
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');

db.exec(
  "CREATE TABLE IF NOT EXISTS partner_tier_approval_requests (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT," +
  "partner_id INTEGER NOT NULL," +
  "partner_code TEXT NOT NULL,partner_name TEXT NOT NULL,point_name TEXT," +
  "old_rate REAL NOT NULL,new_rate REAL NOT NULL," +
  "month_key TEXT NOT NULL,confirmed_month TEXT," +
  "revenue REAL NOT NULL,referrals INTEGER NOT NULL," +
  "status TEXT NOT NULL DEFAULT 'pending' " +
  "CHECK(status IN ('pending','approved','rejected','stale'))," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "decided_at TEXT,decided_by_admin_id INTEGER,decided_by_admin_login TEXT," +
  "decision_reason TEXT);" +
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tier_approval_one_pending " +
  "ON partner_tier_approval_requests(partner_id) WHERE status='pending';" +
  "CREATE INDEX IF NOT EXISTS idx_tier_approval_status " +
  "ON partner_tier_approval_requests(status,created_at);" +
  "CREATE TABLE IF NOT EXISTS partner_tier_approval_notices (" +
  "request_id INTEGER NOT NULL,admin_id INTEGER NOT NULL," +
  "sent_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "PRIMARY KEY(request_id,admin_id));"
);

function sameRate(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.000001;
}
function asPercent(rate) {
  return Math.round(Number(rate) * 100) + '%';
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/&/g,'&amp;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function activeSuperAdmin(chatId) {
  const id = String(chatId || '');
  if (!/^\d{1,20}$/.test(id)) return null;
  return db.prepare(
    "SELECT id,login,full_name,telegram_chat_id FROM admins " +
    "WHERE role='super' AND active=1 AND telegram_chat_id=? ORDER BY id LIMIT 1"
  ).get(id) || null;
}
function markPendingStale(partnerId, reason = 'Условия автоматического понижения больше не актуальны') {
  return db.prepare(
    "UPDATE partner_tier_approval_requests SET status='stale'," +
    "decided_at=datetime('now'),decision_reason=? " +
    "WHERE partner_id=? AND status='pending'"
  ).run(String(reason).slice(0, 250), Number(partnerId)).changes;
}

// Same partner/month after a rejection must not spam the super-admin again.
// A fresh business month can generate a new review if metrics still miss.
function requestTierDowngrade(stats, tier) {
  const { partner, revenue, referralsCount, month } = stats;
  if (!partner || partner.active !== 1 ||
      !Number.isInteger(partner.id) || !sameRate(partner.commission_rate, Number(partner.commission_rate)) ||
      !(tier.rate < partner.commission_rate)) return null;

  let proposal = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rejected = db.prepare(
      "SELECT id FROM partner_tier_approval_requests WHERE partner_id=? " +
      "AND month_key=? AND status='rejected' LIMIT 1"
    ).get(partner.id, month);
    if (rejected) {
      markPendingStale(partner.id, 'Отклонено супер-администратором в этом месяце');
      db.exec('COMMIT');
      return { status:'rejected', request_id: rejected.id };
    }
    const pending = db.prepare(
      "SELECT * FROM partner_tier_approval_requests WHERE partner_id=? AND status='pending'"
    ).get(partner.id);
    if (pending && pending.month_key === month &&
        sameRate(pending.old_rate, partner.commission_rate) &&
        sameRate(pending.new_rate, tier.rate) &&
        (pending.confirmed_month || '') === (partner.tier_confirmed_month || '')) {
      db.exec('COMMIT');
      return { status:'pending', request_id: pending.id };
    }
    if (pending) markPendingStale(partner.id, 'Показатели или месяц расчёта изменились');
    const id = Number(db.prepare(
      "INSERT INTO partner_tier_approval_requests(" +
      "partner_id,partner_code,partner_name,point_name,old_rate,new_rate," +
      "month_key,confirmed_month,revenue,referrals) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).run(partner.id, partner.partner_code, partner.full_name, partner.point_name || '',
      partner.commission_rate, tier.rate, month, partner.tier_confirmed_month || null,
      revenue, referralsCount).lastInsertRowid);
    proposal = { status:'pending', request_id:id, created:true };
    db.exec('COMMIT');
    return proposal;
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reviewButtons(id) {
  return { inline_keyboard: [
    [{text:'✅ Одобрить снижение',callback_data:'tier:approve:'+id}],
    [{text:'🚫 Отклонить — оставить ставку',callback_data:'tier:reject:'+id}],
  ] };
}
function reviewMessage(proposal) {
  return [
    '⚠️ <b>Согласование снижения комиссии грумера</b>',
    '',
    '👤 ' + escapeHtml(proposal.partner_name) + ' (' + escapeHtml(proposal.partner_code) + ')',
    '🏪 ' + escapeHtml(proposal.point_name || 'Салон не указан'),
    '📉 Действующий процент: <b>' + asPercent(proposal.old_rate) + '</b>',
    'Предлагаемый процент: <b>' + asPercent(proposal.new_rate) + '</b>',
    '',
    '🗓 Расчётный месяц: ' + escapeHtml(proposal.month_key),
    'Последнее подтверждение уровня: ' + escapeHtml(proposal.confirmed_month || 'нет'),
    '💰 Выручка в этом месяце: ' + Number(proposal.revenue || 0).toLocaleString('ru-RU') + ' ₽',
    '🤝 Привлечено партнёров: ' + Number(proposal.referrals || 0),
    '',
    '<b>До вашего одобрения комиссия не меняется.</b>',
    'При согласовании показатели и действующий тариф будут проверены повторно.',
    'Заявка №' + proposal.id,
  ].join('\n');
}
function pendingApprovals(limit=20) {
  return db.prepare(
    "SELECT * FROM partner_tier_approval_requests WHERE status='pending' " +
    "ORDER BY created_at ASC,id ASC LIMIT ?"
  ).all(Math.min(100,Math.max(1,Number(limit)||20)));
}
let notifyBusy = false;
async function notifyPendingTierApprovals(sender=sendToChat) {
  if (notifyBusy) return { skipped:'busy' };
  notifyBusy = true;
  let delivered=0, failed=0;
  try {
    const admins = db.prepare(
      "SELECT id,telegram_chat_id FROM admins WHERE role='super' AND active=1 " +
      "AND TRIM(COALESCE(telegram_chat_id,'')) <> ''"
    ).all().filter(a=>/^\d{1,20}$/.test(String(a.telegram_chat_id)));
    if (!admins.length) return { delivered, failed, unlinked:true };
    for(const row of pendingApprovals(100)){
      for(const admin of admins){
        const notice=db.prepare(
          'SELECT 1 FROM partner_tier_approval_notices WHERE request_id=? AND admin_id=?'
        ).get(row.id,admin.id);
        if(notice)continue;
        let result;
        try { result=await sender(admin.telegram_chat_id,reviewMessage(row),{reply_markup:reviewButtons(row.id)}); }
        catch(error){result={ok:false,error:error.message};}
        if(result?.ok && result.data?.ok===true){
          db.prepare(
            "INSERT OR IGNORE INTO partner_tier_approval_notices(request_id,admin_id) VALUES(?,?)"
          ).run(row.id,admin.id);
          delivered++;
        } else {
          failed++;
          console.warn('[tier-approval] Could not notify super-admin:',result?.error || result?.status || 'Telegram unavailable');
        }
      }
    }
    return {delivered,failed};
  } finally{notifyBusy=false;}
}
function requestCardList(chatId) {
  if (!activeSuperAdmin(chatId)) return {ok:false,message:'🔒 Только привязанному супер-администратору доступно согласование ставок.'};
  const rows=pendingApprovals(30);
  return {
    ok:true,
    message:rows.length ? '📋 Заявки на снижение комиссии: '+rows.length+
      '\nСтавки остаются прежними до одобрения.' : '✅ Заявок на снижение комиссии нет.',
    cards:rows.map(row=>({message:reviewMessage(row),reply_markup:reviewButtons(row.id)})),
  };
}
async function decideTierDowngrade(chatId,action,requestId) {
  const admin=activeSuperAdmin(chatId);
  if (!admin) return {ok:false,message:'🔒 Решение может принять только действующий супер-администратор с привязанным Telegram.'};
  if (action!=='approve'&&action!=='reject') return {ok:false,message:'Неверное действие.'};
  const id=Number(requestId);
  if (!Number.isSafeInteger(id)||id<=0) return {ok:false,message:'Некорректная заявка.'};
  let changed=null, payload=null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row=db.prepare('SELECT * FROM partner_tier_approval_requests WHERE id=?').get(id);
    if (!row) {db.exec('COMMIT');return {ok:false,message:'Заявка не найдена.'};}
    if(row.status!=='pending'){
      db.exec('COMMIT');
      return {ok:false,message:'Заявка уже обработана ('+row.status+'). Повторное изменение ставки невозможно.'};
    }
    const partner=db.prepare('SELECT * FROM partners WHERE id=?').get(row.partner_id);
    const tiers=require('./partner-tiers');
    const stats=partner ? tiers.getPartnerStats(row.partner_id) : null;
    const eligible=stats ? tiers.getEligibleTier(stats.revenue,stats.referralsCount) : null;
    const valid=partner && partner.active===1 && stats &&
      stats.month===row.month_key &&
      sameRate(partner.commission_rate,row.old_rate) &&
      (partner.tier_confirmed_month||'')===(row.confirmed_month||'') &&
      eligible && sameRate(eligible.rate,row.new_rate) &&
      eligible.rate < partner.commission_rate &&
      tiers.monthDiff(partner.tier_confirmed_month,stats.month)>1;
    if(!valid){
      db.prepare(
        "UPDATE partner_tier_approval_requests SET status='stale'," +
        "decided_at=datetime('now'),decision_reason=? WHERE id=? AND status='pending'"
      ).run('Условия уже изменились, нужна повторная проверка',id);
      db.exec('COMMIT');
      return {ok:false,message:'⚠️ Заявка устарела: показатели или ставка изменились. Ничего не изменено. При необходимости сформируйте новую заявку командой /tierapprovals после следующей проверки.'};
    }
    const nextStatus=action==='approve'?'approved':'rejected';
    db.prepare(
      "UPDATE partner_tier_approval_requests SET status=?,decided_at=datetime('now')," +
      "decided_by_admin_id=?,decided_by_admin_login=?,decision_reason=? " +
      "WHERE id=? AND status='pending'"
    ).run(nextStatus,admin.id,admin.login,
      action==='approve'?'Подтверждено в Telegram':'Отклонено в Telegram',id);
    if(action==='approve'){
      const rateChange=db.prepare(
        "UPDATE partners SET commission_rate=?,tier_confirmed_month=? " +
        "WHERE id=? AND active=1 AND commission_rate=? " +
        "AND COALESCE(tier_confirmed_month,'')=?"
      ).run(row.new_rate,row.month_key,row.partner_id,row.old_rate,row.confirmed_month||'');
      if(rateChange.changes!==1)throw Error('Конкурентное изменение ставки, откат согласования');
      changed={partner,tier:eligible,revenue:stats.revenue,referrals:stats.referralsCount};
    }
    payload=row;
    db.exec('COMMIT');
  } catch(error){
    db.exec('ROLLBACK');
    throw error;
  }
  if(changed){
    try{
      await require('./partner-tiers').notifyTierChange(
        changed.partner,changed.tier,changed.revenue,changed.referrals,'down'
      );
    }catch(error){console.warn('[tier-approval] Approved but confirmation notice failed:',error.message);}
  }
  return action==='approve'
    ? {ok:true,message:'✅ Снижение ставки одобрено супер-администратором.\n'+
      escapeHtml(payload.partner_name)+': '+asPercent(payload.old_rate)+' → '+asPercent(payload.new_rate)+
      '. Новая ставка действует для последующих продаж. Заявка №'+id+'.'}
    : {ok:true,message:'🚫 Снижение отклонено. У '+escapeHtml(payload.partner_name)+
      ' остаётся '+asPercent(payload.old_rate)+
      '. Повторная заявка за этот месяц не создаётся. Заявка №'+id+'.'};
}
let timer=null;
function startTierApprovalNotifications(){
  if(timer)return;
  // Unsent requests remain in SQLite and are retried on the next cycle.
  notifyPendingTierApprovals().catch(e=>console.warn('[tier-approval] notify:',e.message));
  timer=setInterval(()=>notifyPendingTierApprovals().catch(e=>
    console.warn('[tier-approval] notify:',e.message)),10*60*1000);
  timer.unref?.();
}

module.exports={
  sameRate,activeSuperAdmin,markPendingStale,requestTierDowngrade,
  reviewMessage,reviewButtons,pendingApprovals,notifyPendingTierApprovals,
  requestCardList,decideTierDowngrade,startTierApprovalNotifications,
};
