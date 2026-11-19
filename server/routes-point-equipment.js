'use strict';

// Administrative settings for equipment actually placed when opening a point.
// Financial planning only: writes do not create ledger expenses or payouts.
const db=require('./db');
const {sendJson}=require('./http-utils');
const {requireActiveAdmin}=require('./routes-auth');
const {getPointEquipment,listPointEquipment,savePointEquipment}=require('./point-equipment');

function registerPointEquipmentRoutes(router) {
  router.get('/api/points/launch-equipment', (req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    res.setHeader?.('Cache-Control','no-store');
    sendJson(res,200,{points:listPointEquipment(db)});
  });
  router.get('/api/points/:id/launch-equipment', (req,res,ctx)=>{
    if(!requireActiveAdmin(req,res,ctx))return;
    const p=db.prepare('SELECT id,name FROM points WHERE id=? AND COALESCE(is_hub,0)=0').get(ctx.params.id);
    if(!p)return sendJson(res,404,{error:'Точка не найдена'});
    res.setHeader?.('Cache-Control','no-store');
    sendJson(res,200,{point_id:p.id,point_name:p.name,equipment:getPointEquipment(db,p.id)});
  });
  router.put('/api/points/:id/launch-equipment',(req,res,ctx)=>{
    const admin=requireActiveAdmin(req,res,ctx);
    if(!admin)return;
    const p=db.prepare('SELECT id,name FROM points WHERE id=? AND COALESCE(is_hub,0)=0').get(ctx.params.id);
    if(!p)return sendJson(res,404,{error:'Точка не найдена'});
    try{
      const equipment=savePointEquipment(db,p.id,ctx.body?.equipment,admin);
      res.setHeader?.('Cache-Control','no-store');
      sendJson(res,200,{ok:true,point_id:p.id,equipment});
    }catch(e){
      if(e.statusCode)return sendJson(res,e.statusCode,{error:e.message,code:e.code});
      console.error('[point-equipment] Failed to save equipment:',e);
      sendJson(res,500,{error:'Не удалось сохранить оснащение'});
    }
  });
}
module.exports={registerPointEquipmentRoutes};
