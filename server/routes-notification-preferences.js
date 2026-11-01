// Account-owned notification settings. No arbitrary account id in requests.
'use strict';
const {sendJson} = require('./http-utils');
const {requireAuth} = require('./routes-auth');
const {DEFINITIONS,accountAvailable,describe,savePreferences} = require('./notification-preferences');

const ROLES=Object.keys(DEFINITIONS);
function registerNotificationPreferenceRoutes(router){
  router.get('/api/me/notifications',(req,res,ctx)=>{
    const user=requireAuth(ROLES)(req,res,ctx);
    if(!user)return;
    if(!accountAvailable(user.role,user.id))return sendJson(res,403,{error:'Учётная запись неактивна'});
    sendJson(res,200,{role:user.role,settings:describe(user.role,user.id)});
  });
  router.put('/api/me/notifications',(req,res,ctx)=>{
    const user=requireAuth(ROLES)(req,res,ctx);
    if(!user)return;
    const changes=ctx.body&&ctx.body.settings;
    const result=savePreferences(user.role,user.id,changes);
    if(!result.ok)return sendJson(res,result.status,{error:result.error});
    sendJson(res,200,result);
  });
}
module.exports={registerNotificationPreferenceRoutes};
