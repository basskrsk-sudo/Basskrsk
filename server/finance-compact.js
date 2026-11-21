'use strict';
// Read-only, deliberately small management view: recorded spending is NOT
// recognized COGS, available bank cash or accounting net profit.
const LOCAL_SHIFT=7*60*60*1000,DAY_MS=24*60*60*1000;
const FIRST_REPORT_YEAR=2026;
function isFinancePeriod(period,now=new Date()){
  if(['month','30d','all'].includes(period))return true;
  if(!/^[0-9]{4}$/.test(String(period)))return false;
  const currentYear=new Date(new Date(now).getTime()+LOCAL_SHIFT).getUTCFullYear();
  const year=Number(period);
  return year>=FIRST_REPORT_YEAR&&year<=currentYear;
}
const timestamp=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
const localDate=ms=>new Date(ms+LOCAL_SHIFT).toISOString().slice(0,10);
function periodBounds(period='month',now=new Date()){
  if(!isFinancePeriod(period,now))throw new RangeError('Неизвестный период');
  const t=new Date(now).getTime();
  if(!Number.isFinite(t))throw new TypeError('Неверная дата');
  const d=new Date(t+LOCAL_SHIFT);
  const today=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-LOCAL_SHIFT;
  // Years mean Jan 1 through Dec 31 in Krasnoyarsk, NOT last 365 days.
  // The current calendar year excludes any future-dated entries.
  const year=Number(period);
  const from=period==='all'?null:period==='month'?
    Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)-LOCAL_SHIFT:
    period==='30d'?today-29*DAY_MS:Date.UTC(year,0,1)-LOCAL_SHIFT;
  const until=/^[0-9]{4}$/.test(period)&&year<d.getUTCFullYear()
    ?Date.UTC(year+1,0,1)-LOCAL_SHIFT:today+DAY_MS;
  return {key:period,from:from===null?null:timestamp(from),
    to_exclusive:timestamp(until),
    from_day:from===null?null:localDate(from),
    to_day:localDate(until-DAY_MS),
    next_day:localDate(until),timezone:'Asia/Krasnoyarsk'};
}
const NET="CASE WHEN o.refund_status='refunded' THEN 0 "+
  "ELSE MAX(0,COALESCE(o.total,0)-COALESCE(o.refunded_amount,0)) END";
function buildFinanceSummary(database,{period='month',now=new Date()}={}){
  const range=periodBounds(period,now);
  const orderWindow=range.from?'o.created_at>=? AND o.created_at<?':'o.created_at<?';
  const orderDates=range.from?[range.from,range.to_exclusive]:[range.to_exclusive];
  const expenseWindow=range.from_day?'expense_date>=? AND expense_date<?':'expense_date<?';
  const expenseDates=range.from_day?[range.from_day,range.next_day]:[range.next_day];
  const points=database.prepare(
    'SELECT p.id AS point_id,p.name AS point_name,'+
    'COALESCE(SUM(CASE WHEN '+NET+' > 0 THEN 1 ELSE 0 END),0) AS orders_count,'+
    'COALESCE(SUM('+NET+'),0) AS revenue '+
    'FROM points p LEFT JOIN orders o ON o.point_id=p.id AND o.status=? '+
    'AND '+orderWindow+' '+
    'WHERE p.active=1 AND COALESCE(p.is_hub,0)=0 '+
    'GROUP BY p.id,p.name ORDER BY revenue DESC,p.name'
  ).all('paid',...orderDates).map(r=>({
    point_id:String(r.point_id),point_name:String(r.point_name),
    orders_count:Number(r.orders_count)||0,revenue:Number(r.revenue)||0,
  }));
  // Include revenue from points subsequently archived/inactivated.
  const sales=database.prepare(
    'SELECT COALESCE(SUM(CASE WHEN '+NET+' > 0 THEN 1 ELSE 0 END),0) AS orders_count,'+
    'COALESCE(SUM('+NET+'),0) AS revenue '+
    'FROM orders o WHERE o.status=? AND '+orderWindow
  ).get('paid',...orderDates);
  const spent=database.prepare(
    'SELECT COUNT(*) AS entries,COALESCE(SUM(amount),0) AS amount FROM expenses '+
    'WHERE '+expenseWindow
  ).get(...expenseDates);
  const revenue=Number(sales.revenue)||0,expenses=Number(spent.amount)||0;
  return {period:range,revenue,expenses,orders_count:Number(sales.orders_count)||0,
    // Cash spending overlaps stock purchases and may omit future obligations.
    sales_less_recorded_spending:Math.round((revenue-expenses)*100)/100,
    active_points:points.length,point_rows:points,expense_entries:Number(spent.entries)||0,
    disclaimer:'Выручка после возвратов минус внесённые траты. Не является чистой прибылью и остатком на счёте. Закупки запасов и обязательства учитываются отдельно.'};
}
function sumUnpaid(rows){
  const result={pending:0,refund_review:0,unpaid_orders:0};
  for(const row of rows){
    const value=Math.round(Number(row.total||0)*Number(row.rate||0));
    // Do not call a refunded transaction immediately payable.
    if(row.refund_status==='refunded'||Number(row.refunded_amount||0)>0){
      result.refund_review+=Math.max(0,value);continue;
    }
    if(value>0){result.pending+=value;result.unpaid_orders++;}
  }
  return result;
}
function buildPayoutSnapshot(database){
  const partner=sumUnpaid(database.prepare(
    'SELECT o.total,COALESCE(o.commission_rate,p.commission_rate,0) AS rate,'+
    'o.refund_status,o.refunded_amount FROM orders o '+
    'JOIN partners p ON p.id=o.partner_id '+
    'LEFT JOIN partner_payout_items pi ON pi.order_id=o.id '+
    "WHERE o.status='paid' AND pi.id IS NULL"
  ).all());
  const owner=sumUnpaid(database.prepare(
    'SELECT o.total,so.commission_rate AS rate,o.refund_status,o.refunded_amount '+
    'FROM orders o JOIN salon_owners so ON so.id=('+ 
    'SELECT so2.id FROM salon_owners so2 WHERE so2.point_id=o.point_id AND so2.active=1 '+
    'ORDER BY so2.id DESC LIMIT 1) '+
    'LEFT JOIN owner_payout_items opi ON opi.order_id=o.id '+
    "WHERE o.status='paid' AND opi.id IS NULL"
  ).all());
  const manager=sumUnpaid(database.prepare(
    'SELECT o.total,o.refund_status,o.refunded_amount,'+
    'COALESCE((SELECT mp.commission_rate FROM manager_points mp '+
    'WHERE mp.point_id=p.id AND mp.manager_id=p.manager_id '+
    'ORDER BY mp.active DESC,mp.id DESC LIMIT 1),0.07) AS rate '+
    'FROM orders o JOIN points p ON p.id=o.point_id AND p.manager_id IS NOT NULL '+
    'LEFT JOIN manager_commission_payout_items mpi ON mpi.order_id=o.id '+
    "WHERE o.status='paid' AND mpi.id IS NULL"
  ).all());
  const roles={partner,owner,manager};
  for(const [key,table] of [['partner','partner_payouts'],
    ['owner','owner_payouts'],['manager','manager_commission_payouts']]){
    roles[key].paid_total=Number(database.prepare(
      'SELECT COALESCE(SUM(amount),0) AS amount FROM '+table
    ).get().amount)||0;
  }
  return {roles,paid_total:partner.paid_total+owner.paid_total+manager.paid_total,
    pending_total:partner.pending+owner.pending+manager.pending,
    review_total:partner.refund_review+owner.refund_review+manager.refund_review,
    next_scheduled_day_of_month:25,
    disclaimer:'Предварительный ориентир начислений; возвраты вынесены на проверку, отдельные бонусы и ручные корректировки здесь не включены. Итоговые суммы сверяйте в карточках получателей и платёжных реестрах.'};
}
function queryExpenses(database,{period='month',page=1,investor='',now=new Date()}={}){
  const b=periodBounds(period,now);
  if(!Number.isSafeInteger(page)||page<1||page>500)
    throw new RangeError('Неверная страница');
  const person=String(investor||'').trim().slice(0,120);
  const where=(b.from_day?'expense_date>=? AND expense_date<?':'expense_date<?')+
    (person?' AND investor_name=?':'');
  const args=[...(b.from_day?[b.from_day]:[]),b.next_day,...person?[person]:[]];
  const totals=database.prepare(
    'SELECT COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount '+
    'FROM expenses WHERE '+where
  ).get(...args);
  const rows=database.prepare(
    'SELECT id,expense_date,category,amount,investor_name,note,city_id '+
    'FROM expenses WHERE '+where+' ORDER BY expense_date DESC,id DESC LIMIT 20 OFFSET ?'
  ).all(...args,(page-1)*20);
  // Do not preload proof documents, or the full historic expense ledger.
  // Older admin detail screen can open individual expenses on demand.
  return {period:b,page,page_size:20,total_count:Number(totals.count)||0,
    total_amount:Number(totals.amount)||0,
    has_next:page*20<Number(totals.count),
    expenses:rows};
}
module.exports={FIRST_REPORT_YEAR,isFinancePeriod,periodBounds,buildFinanceSummary,buildPayoutSnapshot,queryExpenses};
