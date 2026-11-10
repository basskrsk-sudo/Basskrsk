'use strict';
// Lightweight read-only workspace for a single active sales point. Fetch only
// when the user opens "People" or "QR" in the point card.
const db=require('./db');
const {sendJson}=require('./http-utils');
const {requireActiveAdmin}=require('./routes-auth');

function readPointWorkspace(pointId,database=db){
  const point=database.prepare(
    'SELECT id,name,addr,icon,city_id,active,manager_id,'+
    'first_purchase_promo_code,created_at '+
    'FROM points WHERE id=? AND active=1'
  ).get(String(pointId||''));
  if(!point)return null;
  const manager=point.manager_id
    ?database.prepare('SELECT id,full_name,active FROM managers WHERE id=?').get(point.manager_id)||null
    :null;
  const owners=database.prepare(
    'SELECT id,full_name,active,groomer_partner_id FROM salon_owners WHERE point_id=? ORDER BY id'
  ).all(point.id);
  const groomers=database.prepare(
    'SELECT id,full_name,active,first_purchase_promo_code '+
    'FROM partners WHERE point_id=? ORDER BY full_name COLLATE NOCASE,id'
  ).all(point.id);
  return {point,manager,owners,groomers};
}

function registerAdminPointWorkspaceRoutes(router){
  router.get('/api/admin/points/:id/workspace',(req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    const report=readPointWorkspace(ctx.params.id);
    if(!report)return sendJson(res,404,{error:'Действующая точка не найдена'});
    sendJson(res,200,report);
  });
}

module.exports={readPointWorkspace,registerAdminPointWorkspaceRoutes};
