'use strict';
// On-demand lightweight finance endpoints. No payout or order writes.
const db=require('./db');
const {sendJson}=require('./http-utils');
const {requireActiveAdmin}=require('./routes-auth');
const {createSqliteAnalyticsCache}=require('./analytics-cache');
const {trackSync}=require('./runtime-diagnostics');
const {periodBounds,buildFinanceSummary,buildPayoutSnapshot,queryExpenses}=require('./finance-compact');
const cache=createSqliteAnalyticsCache(db,{ttlMs:15000,maxEntries:5});
function validPage(query) {
  const parsed=Number(query?.page||1);
  if(!Number.isSafeInteger(parsed)||parsed<1||parsed>500)
    throw new RangeError('Номер страницы от 1 до 500');
  return parsed;
}
function registerCompactFinanceRoutes(router){
  router.get('/api/admin/finance/summary',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    const period=String(ctx.query?.period||'month');
    if(!['month','30d'].includes(period))
      return sendJson(res,400,{error:'Допустимые периоды: month или 30d'});
    res.setHeader('Cache-Control','private, no-store');
    // Local midnight can advance without a write, so include local date
    // in the cache key even for the current calendar month.
    const key='summary:'+period+':'+periodBounds(period).to_day;
    const value=trackSync('finance_compact_summary',()=>
      cache.get(key,()=>buildFinanceSummary(db,{period})));
    sendJson(res,200,value);
  });
  router.get('/api/admin/finance/expenses',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    const period=String(ctx.query?.period||'month');
    if(!['month','30d'].includes(period))
      return sendJson(res,400,{error:'Допустимые периоды: month или 30d'});
    let page;
    try{page=validPage(ctx.query);}catch(e){return sendJson(res,400,{error:e.message});}
    const investor=String(ctx.query?.investor||'').trim().slice(0,120);
    res.setHeader('Cache-Control','private, no-store');
    const key='expenses:'+JSON.stringify([period,periodBounds(period).to_day,page,investor]);
    const value=trackSync('finance_compact_expenses',()=>
      cache.get(key,()=>queryExpenses(db,{period,page,investor})));
    sendJson(res,200,value);
  });
  router.get('/api/admin/finance/payouts',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    res.setHeader('Cache-Control','private, no-store');
    const data=trackSync('finance_compact_payouts',()=>
      cache.get('payouts',()=>buildPayoutSnapshot(db)));
    sendJson(res,200,data);
  });
}
module.exports={validPage,registerCompactFinanceRoutes};
