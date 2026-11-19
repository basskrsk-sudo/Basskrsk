// Admin view for inviter attribution and the 1,000 RUB referral campaign.
// Read-only until an administrator explicitly saves an attribution.
// Real transfers remain in "Отчёты к договорам" / "Бонусы за привлечение точек".
(function(){
  'use strict';
  var data={points:[],partners:[],counts:{},bonus_by_partner:{}};
  var selectedPointId='';
  var busy=false;
  var E=function(id){return document.getElementById(id);};
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });};
  var money=function(n){return Number(n||0).toLocaleString('ru-RU')+' ₽';};
  var labels={
    unassigned:'Не назначен',other_referral:'Пригласил владелец (другая программа)',
    awaiting:'Ожидает выручку',needs_reconcile:'Порог достигнут — проверить',
    payable:'Начислено к выплате',on_hold:'После возврата — проверка',paid:'Бонус выплачен',
  };
  function paint(){
    var body=E('referral-control-body'),summary=E('referral-control-summary');
    if(!body||!summary)return;
    var c=data.counts||{};
    summary.textContent='Закреплено: '+Number(c.linked||0)+
      ' · Ожидают порога: '+Number(c.awaiting||0)+
      ' · Готовы к выплате: '+Number(c.payable||0)+' ('+money(c.payable_amount)+')'+
      ' · Уже выплачено: '+Number(c.paid||0);
    body.innerHTML=(data.points||[]).map(function(p){
      var pct=Math.min(100,Math.round(100*Number(p.revenue||0)/Number(data.threshold||1000)));
      var status=labels[p.status]||p.status;
      var next=p.status==='needs_reconcile'
        ?'<button type="button" class="row-btn" data-ref-reconcile="'+esc(p.point_id)+'">Проверить начисление</button>'
        :p.status==='unassigned'&&p.manager_assigned
          ?'<button type="button" class="row-btn" data-ref-open="'+esc(p.point_id)+'">Выбрать грумера</button>'
          :p.status==='awaiting'&&!p.invited_partner_id
            ?'<button type="button" class="row-btn" data-ref-open="'+esc(p.point_id)+'">Указать приглашённого</button>'
            :p.status==='payable'
              ?'<button type="button" class="row-btn" data-ref-report="'+Number(p.inviter_partner_id)+'">К выплатам</button>'
              :'';
      return '<tr>'+
        '<td><b>'+esc(p.point_name)+'</b><div style="font-size:.73rem;color:var(--muted)">'+esc(p.point_address||'')+'</div></td>'+
        '<td>'+esc(p.invited_name||'—')+'</td>'+
        '<td>'+esc(p.inviter_name||'—')+'</td>'+
        '<td style="min-width:155px;"><b>'+money(p.revenue)+'</b> / '+money(data.threshold)+
          '<div style="height:6px;border-radius:6px;background:#E9E5DE;overflow:hidden;margin-top:6px"><div style="width:'+pct+'%;height:100%;background:var(--deep);"></div></div></td>'+
        '<td>'+esc(status)+(p.status==='unassigned'&&!p.manager_assigned
          ?'<div style="font-size:.73rem;color:var(--muted)">Сначала назначьте менеджера</div>':'')+'</td>'+
        '<td>'+next+'</td></tr>';
    }).join('') || '<tr><td colspan="6" style="color:var(--muted);padding:1rem">Точек пока нет.</td></tr>';
  }
  function options(partners, selected, placeholder){
    return '<option value="">'+esc(placeholder)+'</option>'+partners.map(function(p){
      return '<option value="'+Number(p.id)+'"'+(Number(selected)===Number(p.id)?' selected':'')+'>'+
        esc(p.full_name)+' ('+esc(p.partner_code||'')+')</option>';
    }).join('');
  }
  function open(pointId){
    var point=(data.points||[]).find(function(p){return p.point_id===pointId;});
    if(!point||!point.manager_assigned||!['unassigned','awaiting','needs_reconcile'].includes(point.status))return;
    selectedPointId=pointId;
    E('referral-control-dialog').style.display='flex';
    E('referral-modal-point').textContent=point.point_name;
    E('referral-modal-status').textContent='';
    var invitees=(data.partners||[]).filter(function(g){return g.active&&g.point_id===pointId;});
    var inviters=(data.partners||[]).filter(function(g){return g.active&&g.point_id!==pointId;});
    var inviter=E('referral-inviter');
    inviter.innerHTML=options(inviters,point.inviter_partner_id,'— Выберите пригласившего —');
    inviter.disabled=point.role==='partner';
    E('referral-invited').innerHTML=options(invitees,point.invited_partner_id,'— Приглашённый ещё не зарегистрирован —');
    E('referral-modal-note').textContent=point.role==='partner'
      ?'Пригласивший уже зафиксирован. Можно указать приглашённого грумера, если связь ещё не была указана.'
      :'При наличии ранее оплаченных заказов потребуется отдельно подтвердить назначение задним числом.';
  }
  function close(){selectedPointId='';E('referral-control-dialog').style.display='none';}
  async function save(){
    if(busy||!selectedPointId)return;
    var invited=E('referral-invited').value,inviter=E('referral-inviter').value;
    var status=E('referral-modal-status'),button=E('referral-modal-save');
    if(!inviter){status.textContent='Выберите пригласившего грумера.';return;}
    busy=true;button.disabled=true;status.textContent='Сохраняем связь…';
    var base={inviter_partner_id:Number(inviter),invited_partner_id:invited?Number(invited):null};
    try{
      async function submit(historical){
        var r=await authFetch('/api/admin/referral-control/points/'+encodeURIComponent(selectedPointId),{
          method:'PUT',body:{...base,confirm_historical_sales:historical},
        });
        var result=await r.json();
        if(!r.ok)throw Object.assign(new Error(result.error||'Не удалось сохранить'),{code:result.code});
        return result;
      }
      try{await submit(false);}
      catch(error){
        if(error.code!=='CONFIRM_HISTORICAL_SALES')throw error;
        if(!confirm('На точке уже были оплаченные продажи. Назначить пригласившего задним числом? Если выручка достигла 1 000 ₽, бонус будет начислен сразу.')) {
          status.textContent='Назначение отменено.';return;
        }
        await submit(true);
      }
      close();
      if(typeof renderPartners==='function')await renderPartners();
    }catch(error){status.textContent=error.message||'Ошибка сохранения';}
    finally{busy=false;button.disabled=false;}
  }
  async function reconcile(pointId){
    if(busy)return;
    busy=true;
    var note=E('referral-control-error');
    note.textContent='Проверяем начисление…';
    try{
      var r=await authFetch('/api/admin/referral-control/points/'+encodeURIComponent(pointId)+'/reconcile',{method:'POST',body:{}});
      var value=await r.json();
      if(!r.ok)throw new Error(value.error||'Не удалось обновить начисление');
      note.textContent='';
      if(typeof renderPartners==='function')await renderPartners();
    }catch(error){note.textContent=error.message||'Ошибка проверки';}
    finally{busy=false;}
  }
  function install(){
    var root=E('admin-referral-control');
    if(!root||root.dataset.refControlReady)return;
    root.dataset.refControlReady='1';
    root.addEventListener('click',function(event){
      var b=event.target.closest('[data-ref-open],[data-ref-reconcile],[data-ref-report]');
      if(!b)return;
      if(b.dataset.refOpen)return open(b.dataset.refOpen);
      if(b.dataset.refReconcile)return reconcile(b.dataset.refReconcile);
      if(b.dataset.refReport&&typeof openPayoutReports==='function'){
        openPayoutReports('partner').then(function(){
          var el=E('pr-recipient');
          if(el){el.value=b.dataset.refReport; if(typeof changeReportRecipient==='function')changeReportRecipient();}
        });
      }
    });
    E('referral-modal-cancel').addEventListener('click',close);
    E('referral-modal-save').addEventListener('click',save);
  }
  function render(result){data=result||{points:[],partners:[],counts:{},bonus_by_partner:{}};install();paint();}
  window.HvostAdminReferralControl={render,open,close,save,reconcile};
})();
