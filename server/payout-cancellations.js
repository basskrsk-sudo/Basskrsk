'use strict';
// A cancellation is not a bank refund. Archive original ledger rows and
// release their claims on orders/accruals in one synchronous transaction.
const failure=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const config={
  partner:{table:'partner_payouts',items:'partner_payout_items',id:'partner_id',name:'partner_name'},
  owner:{table:'owner_payouts',items:'owner_payout_items',id:'owner_id',name:'owner_name'},
  manager:{table:'manager_commission_payouts',items:'manager_commission_payout_items',id:'manager_id',name:'manager_name'}
};
function initializePayoutCancellations(db){
  db.exec(`CREATE TABLE IF NOT EXISTS payout_cancellations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL, payout_type TEXT NOT NULL, payout_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL, recipient_name TEXT NOT NULL, amount INTEGER NOT NULL,
    paid_at TEXT, reason TEXT NOT NULL, admin_id INTEGER NOT NULL, admin_login TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, snapshot_json TEXT NOT NULL,
    UNIQUE(role,payout_type,payout_id)
  );
  CREATE TABLE IF NOT EXISTS payout_cancelled_reports (
    report_id INTEGER PRIMARY KEY REFERENCES payout_reports(id),
    cancellation_id INTEGER NOT NULL REFERENCES payout_cancellations(id)
  );
  CREATE TABLE IF NOT EXISTS payout_invalidated_confirmations (
    confirmation_id TEXT PRIMARY KEY, cancellation_id INTEGER NOT NULL REFERENCES payout_cancellations(id)
  );`);
}
function payoutConfig(role,type){
  if(typeof role!=='string'||!Object.hasOwn(config,role))throw failure('Неизвестная роль',400);
  if(type==='commission')return config[role];
  if(type==='launch_bonus'&&role==='manager')return {table:'manager_launch_bonus_payouts',id:'manager_id',name:'manager_name'};
  if(type==='referral_bonus'&&role!=='manager')return {table:'referral_bonus_payouts',id:'recipient_id',name:'recipient_name',filterRole:true};
  throw failure('Неизвестный вид выплаты',400);
}
function cancellationForReport(db,id){
  return db.prepare('SELECT c.id,c.created_at,c.reason FROM payout_cancelled_reports r JOIN payout_cancellations c ON c.id=r.cancellation_id WHERE r.report_id=?').get(id);
}
function assertReportActive(db,id){
  if(cancellationForReport(db,id))throw failure('Отчёт аннулирован: выплата отменена. Сформируйте актуальную справку.');
}
function assertPaymentActive(db,role,type,id){
  if(db.prepare('SELECT 1 FROM payout_cancellations WHERE role=? AND payout_type=? AND payout_id=?').get(role,type,id))throw failure('Эта выплата уже отменена.');
}
function invalidateConfirmations(db,cancellationId,role,type,id,recipientId){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payout_brief_confirmations'").get())return;
  // Old actionable PDFs must never become payable again merely because a
  // ledger claim has been removed. Invalidate pending statements for this
  // recipient/role, and completed statements that included this exact payout.
  db.prepare(`INSERT OR IGNORE INTO payout_invalidated_confirmations(confirmation_id,cancellation_id)
    SELECT b.id,? FROM payout_brief_confirmations b
    WHERE (b.state IN ('ready','confirming') AND EXISTS (
      SELECT 1 FROM json_each(b.snapshot_json,'$.statements') s
      WHERE json_extract(s.value,'$.role')=? AND json_extract(s.value,'$.account_id')=?
    )) OR (b.state='paid' AND EXISTS (
      SELECT 1 FROM json_each(COALESCE(b.result_json,'[]')) r
      WHERE json_extract(r.value,'$.role')=? AND json_extract(r.value,'$.type')=?
      AND json_extract(r.value,'$.payout_id')=?
    ))`).run(cancellationId,role,recipientId,role,type,id);
}
function cancelPayout(db,body,adminId){
  const {role,payout_type:type='commission'}=body||{};
  const c=payoutConfig(role,type);
  const id=Number(body.payout_id),expected=Number(body.expected_amount);
  const reason=typeof body.reason==='string'?body.reason.trim():'';
  if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(expected)||expected<=0||
     reason.length<3||reason.length>500||body.confirm_not_transferred!==true)
    throw failure('Укажите выплату, сумму, причину (3–500 символов) и подтвердите, что деньги не переводились.',400);
  db.exec('BEGIN IMMEDIATE');
  try{
    const admin=db.prepare("SELECT id,login FROM admins WHERE id=? AND active=1 AND role='super'").get(adminId);
    if(!admin)throw failure('Отменять выплаты может только действующий суперадминистратор.',403);
    assertPaymentActive(db,role,type,id);
    const payout=db.prepare('SELECT * FROM '+c.table+' WHERE id=?'+(c.filterRole?' AND role=?':'')).get(...(c.filterRole?[id,role]:[id]));
    if(!payout)throw failure('Выплата не найдена.',404);
    if(Number(payout.amount)!==expected)throw failure('Сумма выплаты изменилась. Обновите данные.');
    const recipientId=Number(payout[c.id]);
    if(!Number.isSafeInteger(recipientId)||recipientId<=0)throw failure('Получатель удалён. Нужна ручная сверка.');
    const items=c.items?db.prepare('SELECT * FROM '+c.items+' WHERE payout_id=? ORDER BY id').all(id):[];
    // Reject historical claims whose source is now missing or whose recipient
    // changed: reopening those would assign the debt to someone else.
    if(c.items){
      if(!items.length||items.length!==Number(payout.orders_count)||items.some(x=>x.order_id==null))
        throw failure('Состав исторической выплаты неполный. Нужна ручная сверка.');
      const invalid=items.some(item=>{
        const order=db.prepare('SELECT id,point_id,partner_id,status FROM orders WHERE id=?').get(item.order_id);
        if(!order||order.status!=='paid')return true;
        if(role==='partner')return Number(order.partner_id)!==recipientId;
        if(role==='owner')return !db.prepare('SELECT 1 FROM salon_owners WHERE id=? AND point_id=?').get(recipientId,order.point_id);
        return !db.prepare('SELECT 1 FROM points WHERE id=? AND manager_id=?').get(order.point_id,recipientId);
      });
      if(invalid)throw failure('Заказ или получатель изменился. Нужна ручная сверка перед отменой.');
      // A later confirmed payout may already have recovered money from this
      // payout after a refund. Never silently undo another cash operation.
      if(db.prepare('SELECT 1 FROM commission_refund_offsets WHERE role=? AND original_payout_id=? LIMIT 1').get(role,id))
        throw failure('Есть связанные удержания в других выплатах. Сначала сверяйте эти выплаты.');
    }else{
      const point=db.prepare('SELECT * FROM manager_points WHERE id=?').get(payout.manager_point_id);
      const field=role==='manager'?'manager_id':role==='owner'?'referred_owner_id':'referred_groomer_id';
      if(!point||Number(point[field])!==recipientId)throw failure('Получатель бонуса изменился. Нужна ручная сверка.');
    }
    const offsets=c.items?db.prepare('SELECT * FROM commission_refund_offsets WHERE role=? AND payout_id=?').all(role,id):[];
    const reports=type==='commission'
      ?db.prepare('SELECT id FROM payout_reports WHERE role=? AND payout_id=?').all(role,id)
      :db.prepare("SELECT id FROM payout_reports WHERE role=? AND (source_key=? OR (json_extract(snapshot_json,'$.payout_type')=? AND json_extract(snapshot_json,'$.bonus_payout_id')=?))").all(role,role+':'+type+':'+id,type,id);
    for(const report of reports){
      if(db.prepare("SELECT 1 FROM payout_report_deliveries WHERE report_id=? AND status='pending' AND updated_at>=datetime('now','-10 minutes')").get(report.id))
        throw failure('Отчёт сейчас отправляется. Повторите отмену после окончания отправки.');
    }
    const archive={payout,items,offsets,report_ids:reports.map(r=>r.id)};
    const cancellationId=Number(db.prepare(`INSERT INTO payout_cancellations
      (role,payout_type,payout_id,recipient_id,recipient_name,amount,paid_at,reason,admin_id,admin_login,snapshot_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(role,type,id,recipientId,payout[c.name],expected,payout.paid_at||null,reason,admin.id,admin.login,JSON.stringify(archive)).lastInsertRowid);
    const mark=db.prepare('INSERT INTO payout_cancelled_reports(report_id,cancellation_id) VALUES(?,?)');
    for(const report of reports)mark.run(report.id,cancellationId);
    invalidateConfirmations(db,cancellationId,role,type,id,recipientId);
    if(c.items){
      db.prepare('DELETE FROM commission_refund_offsets WHERE role=? AND payout_id=?').run(role,id);
      db.prepare('DELETE FROM '+c.items+' WHERE payout_id=?').run(id);
    }
    if(db.prepare('DELETE FROM '+c.table+' WHERE id=?'+(c.filterRole?' AND role=?':'')).run(...(c.filterRole?[id,role]:[id])).changes!==1)
      throw failure('Выплата изменилась. Повторите сверку.');
    db.exec('COMMIT');
    return {ok:true,cancellation_id:cancellationId,role,payout_type:type,payout_id:id,amount:expected};
  }catch(error){try{db.exec('ROLLBACK')}catch(_){}throw error;}
}
module.exports={initializePayoutCancellations,cancelPayout,cancellationForReport,assertReportActive,assertPaymentActive};
