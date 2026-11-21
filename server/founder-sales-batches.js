'use strict';

// Index-based keyset pagination bounds the number of paid-sale objects
// materialized by Node.js during founder analysis. A fresh iterator is
// created for each pass; callers do not retain order history in RAM.
// Existing index: idx_orders_status_created(status,created_at,id).
const MAX_PAGE=200;
const PAID_PAGE_SQL=`
  SELECT id,point_id,partner_id,total,commission_rate,refund_status,
    refunded_amount,created_at
  FROM orders INDEXED BY idx_orders_status_created
  WHERE status='paid' AND created_at>=? AND created_at<?
    AND (created_at,id)>(?,?)
  ORDER BY created_at,id
  LIMIT ?
`;

function createFounderPaidSalesReader(database,period,{pageSize=MAX_PAGE}={}){
  if(!period || typeof period.from!=='string' || typeof period.to!=='string' ||
    period.to<=period.from)throw new RangeError('Expected a valid sales period');
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>MAX_PAGE)
    throw new RangeError('Founder sales page must be between 1 and 200');
  const stmt=database.prepare(PAID_PAGE_SQL);
  function* pages(){
    let lastDate=period.from,lastId=-1;
    while(true){
      const page=stmt.all(period.from,period.to,lastDate,lastId,pageSize);
      if(!page.length)return;
      yield page;
      const last=page[page.length-1];
      lastDate=last.created_at;
      lastId=last.id;
      if(page.length<pageSize)return;
    }
  }
  return {
    pages,
    *[Symbol.iterator](){ for(const page of pages())yield* page; },
  };
}
module.exports={createFounderPaidSalesReader,PAID_PAGE_SQL,MAX_PAGE};
