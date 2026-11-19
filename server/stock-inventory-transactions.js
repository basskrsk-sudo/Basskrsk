'use strict';

// Shared by both stock-movement API registrations. These writes MUST remain
// atomic because stock is reserved while customers create payment orders.
// No external calls, notifications or async work is allowed inside a SQLite
// transaction. Replaces read/REPLACE/read/REPLACE per item with two writes.
class StockTransactionError extends Error {
  constructor(message, status, code, details={}) {
    super(message);
    this.name='StockTransactionError';
    this.status=status;
    this.code=code;
    this.details=details;
  }
}

function transaction(database,operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result=operation();
    database.exec('COMMIT');
    return result;
  } catch(error) {
    try {database.exec('ROLLBACK');} catch (_) {}
    throw error;
  }
}

function approveStockMovement(database,movementId,reviewedBy) {
  try {
    return transaction(database,()=>{
      // The state check is INSIDE the transaction so two attempts cannot
      // approve the same movement or add inventory twice.
      const movement=database.prepare(
        'SELECT id,status,point_id,city_id FROM stock_movements WHERE id=?'
      ).get(movementId);
      if(!movement)
        throw new StockTransactionError('Отчёт не найден',404,'NOT_FOUND');
      if(movement.status!=='pending')
        throw new StockTransactionError('Отчёт уже обработан',400,'ALREADY_PROCESSED');

      // Manager reports can contain the same variant several times. Group
      // before checking availability: an individual item check is not enough
      // to prevent a duplicated SKU from over-withdrawing warehouse stock.
      const items=database.prepare(
        'SELECT variant_id,SUM(qty) AS qty FROM stock_movement_items '+
        'WHERE movement_id=? GROUP BY variant_id'
      ).all(movement.id);
      if(!items.length)
        throw new StockTransactionError('В отчёте нет товаров',400,'EMPTY_MOVEMENT');

      const decrement=database.prepare(
        'UPDATE warehouse_stock SET qty=qty-? '+
        'WHERE city_id=? AND variant_id=? AND qty>=?'
      );
      const increment=database.prepare(
        'INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?) '+
        'ON CONFLICT(variant_id,point_id) DO UPDATE SET qty=stock.qty+excluded.qty'
      );
      let moved=0;
      for(const item of items) {
        const quantity=Number(item.qty);
        if(!Number.isSafeInteger(quantity) || quantity<=0)
          throw new StockTransactionError(
            'Некорректное количество товара в отчёте',400,'INVALID_QUANTITY',
            {variantId:item.variant_id,quantity}
          );
        const updated=decrement.run(quantity,movement.city_id,item.variant_id,quantity);
        if(updated.changes!==1) {
          const available=database.prepare(
            'SELECT qty FROM warehouse_stock WHERE city_id=? AND variant_id=?'
          ).get(movement.city_id,item.variant_id)?.qty||0;
          throw new StockTransactionError(
            'Недостаточно товара на складе',400,'STOCK_UNAVAILABLE',
            {variantId:item.variant_id,required:quantity,available}
          );
        }
        increment.run(item.variant_id,movement.point_id,quantity);
        moved+=quantity;
      }
      const approved=database.prepare(
        "UPDATE stock_movements SET status='approved',reviewed_at=datetime('now'),reviewed_by=? "+
        "WHERE id=? AND status='pending'"
      ).run(reviewedBy||null,movement.id);
      if(approved.changes!==1)
        throw new Error('Approval status changed during inventory transaction');
      return {ok:true,lines:items.length,quantity:moved};
    });
  } catch(error) {
    if(error instanceof StockTransactionError)
      return {ok:false,status:error.status,code:error.code,message:error.message,...error.details};
    throw error;
  }
}

// A supplier receipt must never survive without its corresponding warehouse
// increase. The UPSERT returns the authoritative new quantity in the SAME
// transaction, avoiding a preliminary stock SELECT and destructive REPLACE.
function receiveWarehouseStock(database,{variantId,quantity,supplierNote,keeperId,cityId}) {
  if(!Number.isSafeInteger(quantity)||quantity<=0)
    throw new RangeError('Expected positive integer quantity');
  return transaction(database,()=>{
    database.prepare(
      'INSERT INTO warehouse_receipts(variant_id,qty,supplier_note,keeper_id,city_id) '+
      'VALUES(?,?,?,?,?)'
    ).run(variantId,quantity,supplierNote||null,keeperId||null,cityId);
    const row=database.prepare(
      'INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES(?,?,?) '+
      'ON CONFLICT(city_id,variant_id) DO UPDATE SET qty=warehouse_stock.qty+excluded.qty '+
      'RETURNING qty'
    ).get(cityId,variantId,quantity);
    return {new_qty:row.qty};
  });
}

module.exports={approveStockMovement,receiveWarehouseStock};
