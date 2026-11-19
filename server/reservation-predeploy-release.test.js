'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {reconcileOldReservations} = require('./reservation-predeploy-release');

function mockOrders(data) {
  const rows = data.map((row,index)=>({id:index+1,
    order_code:'PRE-'+(index+1),yookassa_payment_id:'pay-'+(index+1),...row,
    status:'pending',reservation_status:'active'}));
  return {
    rows,
    prepare(sql) {
      if(sql.includes('SELECT id, order_code, yookassa_payment_id'))
        return {all(cursor,age,size){return rows.filter(x=>
          x.id>cursor && x.status==='pending' &&
          x.reservation_status==='active' && x.old!==false
        ).slice(0,size)}};
      if(sql.includes('SELECT status, reservation_status FROM orders WHERE id='))
        return {get(id){return rows.find(x=>x.id===id)}};
      throw Error('unexpected SQL '+sql);
    },
  };
}
function mockGateway(statuses,{configured=true,failGet=[],failCancel=[]}={}) {
  const events=[];
  return {
    events,
    isConfigured:()=>configured,
    async getPayment(id){
      events.push('get:'+id);
      if(failGet.includes(id))throw Object.assign(new Error('network offline'),{code:'NETWORK'});
      return {status:statuses[id]};
    },
    async cancelPayment(id){
      events.push('cancel:'+id);
      if(failCancel.includes(id))throw new Error('cancel offline');
      statuses[id]='canceled';
      return {status:'canceled'};
    },
  };
}
test('dry run only counts candidates; does not contact gateway or release stock',async()=>{
  const database=mockOrders([{},{},{}]);
  const gateway=mockGateway({});
  const used=[];
  const result=await reconcileOldReservations({
    database,gateway,release:id=>{used.push(id);return {released:true}},
  });
  assert.equal(result.mode,'dry-run');
  assert.equal(result.inspected,3);
  assert.equal(result.released,0);
  assert.equal(result.unchanged,3);
  assert.deepEqual(gateway.events,[]);
  assert.deepEqual(used,[]);
});
test('execute releases cancelled and cancelable payments only, keeps paid, ambiguous and unknown',async()=>{
  const database=mockOrders([
    {yookassa_payment_id:'pay-canceled'},
    {yookassa_payment_id:'pay-pending'},
    {yookassa_payment_id:'pay-succeeded'},
    {yookassa_payment_id:'pay-unknown'},
    {yookassa_payment_id:null},
    {yookassa_payment_id:'pay-offline'},
    {yookassa_payment_id:'pay-cancel-fail'},
  ]);
  const gateway=mockGateway({
    'pay-canceled':'canceled',
    'pay-pending':'pending',
    'pay-succeeded':'succeeded',
    'pay-unknown':'some-new-state',
    'pay-offline':'pending',
    'pay-cancel-fail':'pending',
  },{failGet:['pay-offline'],failCancel:['pay-cancel-fail']});
  const used=[];
  const logs=[];
  const result=await reconcileOldReservations({
    database,gateway,execute:true,batchSize:2,
    release:id=>{
      used.push(id);
      database.rows.find(x=>x.id===id).reservation_status='released';
      return {released:true};
    },
    onProgress:x=>logs.push(x),
  });
  assert.equal(result.inspected,7);
  assert.equal(result.released,2);
  assert.deepEqual(used,[1,2]);
  assert.equal(result.paid_or_succeeded,1);
  assert.equal(result.awaiting_payment_identifier,1);
  assert.equal(result.unresolved,1);
  assert.equal(result.errors,2);
  assert.equal(logs.length,2);
  assert.deepEqual(gateway.events.filter(x=>x.startsWith('cancel:')),[
    'cancel:pay-pending','cancel:pay-cancel-fail'
  ]);
  assert.equal(database.rows[2].reservation_status,'active');
  assert.equal(database.rows[4].reservation_status,'active');
});
test('does not process new orders or an already closed record found during reconciliation',async()=>{
  const database=mockOrders([
    {old:false},
    {yookassa_payment_id:'pay-canceled'},
    {yookassa_payment_id:'pay-race'},
  ]);
  const gateway=mockGateway({
    'pay-canceled':'canceled','pay-race':'canceled',
  });
  const released=[];
  const originalGet=gateway.getPayment;
  gateway.getPayment=async id=>{
    if(id==='pay-race')database.rows[2].status='paid';
    return originalGet.call(gateway,id);
  };
  const result=await reconcileOldReservations({
    database,gateway,execute:true,
    release:id=>{released.push(id);return {released:true}},
  });
  assert.equal(result.inspected,2);
  assert.equal(result.already_closed,1);
  assert.equal(result.released,1);
  assert.deepEqual(released,[2]);
});
test('execute refuses unconfigured gateway or unsafe age and batch parameters',async()=>{
  const database=mockOrders([{}]);
  const gateway=mockGateway({}, {configured:false});
  await assert.rejects(reconcileOldReservations({
    database,gateway,execute:true,release:()=>{throw Error('unexpected release')}
  }),/credentials/);
  await assert.rejects(reconcileOldReservations({
    database,gateway,minimumAgeSeconds:30,release:()=>{}
  }),/at least 60/);
  await assert.rejects(reconcileOldReservations({
    database,gateway,batchSize:1000,release:()=>{}
  }),/batch size/);
});
