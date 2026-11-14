'use strict';

// Batch read-only relation hydration for admin/manager warehouse lists.
// The caller must first apply its existing city/manager authorization filter
// to parent rows. Children are fetched only for those authorized parent IDs.
const BATCH_SIZE = 400; // safely below SQLite's older 999 bind-variable limit

function getRelated(database, ids, sqlStart, parentKey, orderBy) {
  const result = new Map();
  for(let offset=0;offset<ids.length;offset+=BATCH_SIZE){
    const batch=ids.slice(offset,offset+BATCH_SIZE);
    const placeholders=batch.map(()=>'?').join(',');
    const rows=database.prepare(
      sqlStart+' ('+placeholders+') ORDER BY '+orderBy
    ).all(...batch);
    for(const row of rows){
      if(!result.has(row[parentKey]))result.set(row[parentKey],[]);
      result.get(row[parentKey]).push(row);
    }
  }
  return result;
}

function hydrateRestockRequests(database, requests){
  if(!requests.length)return [];
  const ids=requests.map(r=>r.id);
  const items=getRelated(database,ids,
    'SELECT rri.*,v.weight,p.name AS product_name '+
    'FROM restock_request_items rri '+
    'JOIN product_variants v ON v.id=rri.variant_id '+
    'JOIN products p ON p.id=v.product_id '+
    'WHERE rri.request_id IN',
    'request_id', 'rri.request_id,rri.id'
  );
  const deliveries=getRelated(database,ids,
    'SELECT * FROM restock_deliveries WHERE request_id IN',
    'request_id', 'request_id,id'
  );
  return requests.map(r=>({
    ...r,items:items.get(r.id)||[],deliveries:deliveries.get(r.id)||[],
  }));
}
function hydrateStockMovements(database,movements){
  if(!movements.length)return [];
  const ids=movements.map(m=>m.id);
  const items=getRelated(database,ids,
    'SELECT smi.*,v.weight,p.name AS product_name '+
    'FROM stock_movement_items smi '+
    'JOIN product_variants v ON v.id=smi.variant_id '+
    'JOIN products p ON p.id=v.product_id '+
    'WHERE smi.movement_id IN',
    'movement_id', 'smi.movement_id,smi.id'
  );
  return movements.map(m=>({...m,items:items.get(m.id)||[]}));
}

module.exports={BATCH_SIZE,hydrateRestockRequests,hydrateStockMovements};
