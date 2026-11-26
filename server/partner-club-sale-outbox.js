'use strict';
// Transactional outbox for automatic Partner Club sale drafts. A payment
// commits this tiny non-PII job in the SAME transaction as its paid status.
// The existing Club worker, not checkout, formats and queues the drafts.
const db=require('./db');
db.exec("CREATE TABLE IF NOT EXISTS partner_club_settings(id INTEGER PRIMARY KEY CHECK(id=1),config_json TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);"+
  "CREATE TABLE IF NOT EXISTS partner_club_sale_jobs("+
  "id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,"+
  "club_started_at TEXT NOT NULL,sales INTEGER NOT NULL,first_sale INTEGER NOT NULL,record_check INTEGER NOT NULL)");
const configQuery=db.prepare('SELECT config_json FROM partner_club_settings WHERE id=1');
const insertJob=db.prepare('INSERT OR IGNORE INTO partner_club_sale_jobs(order_id,club_started_at,sales,first_sale,record_check) VALUES(?,?,?,?,?)');
const oldest=db.prepare('SELECT id FROM partner_club_sale_jobs ORDER BY id LIMIT ?');
const readJob=db.prepare('SELECT * FROM partner_club_sale_jobs WHERE id=?');
const completeJob=db.prepare('DELETE FROM partner_club_sale_jobs WHERE id=?');
let wakeHandler=null;
function enqueuePaidClubSale(order,demo=false){
  if(demo||!order||order.status!=='paid'||order.refund_status==='refunded')return false;
  let config;
  try{
    const row=configQuery.get();
    if(!row)return false;
    config={sales:true,first_sale:true,record_check:true,...JSON.parse(row.config_json)};
  }catch(error){
    // Only invalid configuration JSON is ignored, not a database error.
    if(error instanceof SyntaxError)return false;
    throw error;
  }
  if(!config.enabled||!config.chat_id||!config.club_started_at||
      !(config.sales||config.first_sale||config.record_check))return false;
  return insertJob.run(order.id,String(config.club_started_at),config.sales?1:0,
    config.first_sale?1:0,config.record_check?1:0).changes>0;
}
function setPaidClubSaleWakeHandler(handler){wakeHandler=typeof handler==='function'?handler:null;}
function signalPaidClubSaleQueued(){
  // No synchronous DB query or draft formatting after the order commits.
  // Startup will recover any persisted jobs if this process stops here.
  if(wakeHandler)wakeHandler();
}
function pendingPaidClubSaleIds(limit=6){return oldest.all(Math.max(1,Math.min(6,limit))).map(row=>row.id);}
module.exports={enqueuePaidClubSale,signalPaidClubSaleQueued,setPaidClubSaleWakeHandler,
  pendingPaidClubSaleIds,readPaidClubSaleJob:id=>readJob.get(id),completePaidClubSaleJob:id=>completeJob.run(id)};
