// Admin editor for launch equipment. No financial transactions.
(function(){
  'use strict';
  var rows=[],activeId=null;
  var $=id=>document.getElementById(id);
  var labels={
    none:'Без стойки и полки',
    large_stand:'Большая стойка — 5 000 ₽',
    small_stand:'Маленькая стойка — 2 500 ₽',
    shelf:'Полка ХвостМаркета'
  };
  function escape(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','&#39;':'&#39;'}[c]||'&#39;'));}
  function rub(n){return Number(n||0).toLocaleString('ru-RU')+' ₽';}
  function toggleShelf(selectId,wrapId){
    var select=$(selectId),wrap=$(wrapId);
    if(wrap)wrap.style.display=select&&select.value==='shelf'?'block':'none';
  }
  function readChoice(selectId,shelfId){
    var type=$(selectId)?.value;
    if(!Object.prototype.hasOwnProperty.call(labels,type))throw new Error('Выберите оснащение при запуске точки');
    if(type==='shelf'){
      var raw=String($(shelfId)?.value??'').trim();
      var cost=Number(raw);
      if(!raw||!Number.isSafeInteger(cost)||cost<0||cost>1000000)
        throw new Error('Укажите стоимость полки в целых рублях (в том числе 0, если полка бесплатная)');
      return {type,shelf_cost:cost};
    }
    return {type};
  }
  function resetCreate(){
    if($('pt-new-equipment'))$('pt-new-equipment').value='';
    if($('pt-new-shelf-cost'))$('pt-new-shelf-cost').value='';
    toggleShelf('pt-new-equipment','pt-new-shelf-wrap');
  }
  function rowFor(id){return rows.find(p=>p.point_id===id);}
  function equipmentLabel(p){
    return p&&p.type ? labels[p.type] + (p.type==='shelf'?' · '+rub(p.cost):'') : 'Не указано';
  }
  function open(id,name){
    activeId=id;
    var p=rowFor(id);
    $('point-equip-modal').style.display='flex';
    $('point-equip-modal-name').textContent=name||p?.point_name||'Точка';
    $('point-equip-error').textContent='';
    $('point-equip-type').value=p?.type||'';
    $('point-equip-shelf-cost').value=p?.type==='shelf'?p.cost:'';
    toggleShelf('point-equip-type','point-equip-shelf-wrap');
  }
  function close(){
    activeId=null;
    $('point-equip-modal').style.display='none';
  }
  async function save(){
    if(!activeId)return;
    var err=$('point-equip-error'),btn=$('point-equip-save');
    var body;
    try{body=readChoice('point-equip-type','point-equip-shelf-cost');}
    catch(e){err.textContent=e.message;return;}
    btn.disabled=true;err.textContent='';
    try{
      var res=await authFetch('/api/points/'+encodeURIComponent(activeId)+'/launch-equipment',{
        method:'PUT',body:{equipment:body}});
      var data=await res.json();
      if(!res.ok)throw new Error(data.error||'Ошибка сохранения');
      close();
      await renderPointsManagement();
      if(typeof showToast==='function')showToast('Оснащение точки сохранено');
    }catch(e){err.textContent=e.message||'Ошибка сети';}
    finally{btn.disabled=false;}
  }
  async function load(){
    try{
      var res=await authFetch('/api/points/launch-equipment');
      if(!res.ok)return [];
      var data=await res.json();
      rows=data.points||[];
      return rows;
    }catch(e){
      console.error('Оснащение точек не загружено:',e.message);
      return [];
    }
  }
  function renderEconomics(){
    var card=$('point-economics-card'),body=$('point-economics-body');
    if(!card||!body)return Promise.resolve();
    if(currentAdminRole!=='super'){card.style.display='none';return Promise.resolve();}
    card.style.display='block';
    return authFetch('/api/economics/point-launch').then(async res=>{
      var data=await res.json();
      if(!res.ok)throw new Error(data.error||'Не удалось загрузить экономику точек');
      var sum=data.summary||{};
      $('point-economics-summary').textContent='Точек: '+sum.total_points+
        ' · Оснащение подтверждено: '+sum.configured+
        ' · Не указано: '+sum.unknown+
        ' · Стоимость оборудования: '+rub(sum.equipment_cost);
      $('point-economics-note').textContent=data.profit_disclaimer||data.assumption;
      body.innerHTML=(data.points||[]).map(p=>{
        var investment=p.estimated_investment==null?'—':rub(p.estimated_investment);
        var c=p.estimated_period_contribution==null?'—':rub(p.estimated_period_contribution);
        var payback=p.payback_months_at_current_pace==null?'—':Number(p.payback_months_at_current_pace).toLocaleString('ru-RU')+' мес.';
        return '<tr><td>'+escape(p.point_name)+'</td><td>'+escape(equipmentLabel(p))+
          '</td><td class="r">'+investment+'</td><td class="r">'+rub(p.period_revenue)+
          '</td><td class="r">'+c+'</td><td class="r">'+payback+'</td></tr>';
      }).join('')||'<tr><td colspan="6">Нет данных</td></tr>';
    }).catch(error=>{
      $('point-economics-summary').textContent=error.message||'Не удалось загрузить расчёт';
      body.innerHTML='';
    });
  }
  window.HvostPointEquipmentUI={load,rows:()=>rows,resetCreate,readChoice,open,close,save,
    toggleShelf,equipmentLabel,renderEconomics};
})();
