// Administrator-only central warehouse panel inside the Telegram Mini App.
// Never keeps a parallel inventory: the server performs every stock operation.
(function () {
  'use strict';
  var root=document.getElementById('workPage');
  if(!root)return;
  var state={open:false,token:'',isValid:null,onBack:null,city:'',item:'',data:null,busy:false,serial:0};
  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function valid(){return state.open&&typeof state.isValid==='function'&&state.isValid()&&!!state.token;}
  function msg(text,error){return '<p class="work-note" role="status" style="white-space:pre-wrap">' +
    (error?'⚠️ ':'')+esc(text)+'</p>';}
  function layout(inner){
    root.innerHTML='<div class="work-head"><h1>📦 Центральный склад</h1>' +
      '<p>Управление остатками ХвостМаркета</p></div>' +
      '<button class="work-back" data-hm-wh-action="back" type="button">← Кабинет администратора</button>' + inner;
  }
  async function api(url,options){
    var req=Object.assign({cache:'no-store'},options||{});
    req.headers=Object.assign({},req.headers||{},{Authorization:'Bearer '+state.token});
    var response=await fetch(url,req);
    var data=await response.json().catch(function(){return {};});
    if(!response.ok){var e=new Error(data.error||'Ошибка сервера: '+response.status);e.status=response.status;throw e;}
    return data;
  }
  function currentItem(){
    var input=document.getElementById('hmWarehouseItem');
    var id=input?String(input.value):state.item;
    return (state.data&&state.data.items||[]).find(function(x){return String(x.variant_id)===id;})||null;
  }
  function sync(){
    if(!valid()||!state.data)return;
    var item=currentItem();
    var actionNode=document.getElementById('hmWarehouseAction');
    var action=actionNode?actionNode.value:'add';
    var caption=document.getElementById('hmWarehouseCurrent');
    if(caption)caption.textContent=item
      ? 'В наличии: '+Number(item.qty||0).toLocaleString('ru-RU')+' шт.'+
        (item.can_add?'':' · архивная позиция, пополнение запрещено')
      : 'Выберите товар и фасовку';
    var amount=document.getElementById('hmWarehouseAmountWrap');
    var confirm=document.getElementById('hmWarehouseDeleteWrap');
    if(amount)amount.hidden=action==='delete';
    if(confirm)confirm.hidden=action!=='delete';
  }
  function render(confirmation){
    if(!valid()||!state.data)return;
    var data=state.data,cities=data.cities||[],items=data.items||[];
    var stocked=items.filter(function(x){return x.has_stock;});
    var units=stocked.reduce(function(n,x){return n+Number(x.qty||0);},0);
    if(!items.some(function(x){return String(x.variant_id)===state.item;}))
      state.item=items.length?String(items[0].variant_id):'';
    var citiesHtml=cities.map(function(c){
      return '<option value="'+esc(c.id)+'"'+(String(c.id)===state.city?' selected':'')+'>'+esc(c.name)+'</option>';
    }).join('');
    var itemsHtml=items.map(function(item){
      return '<option value="'+esc(item.variant_id)+'"'+(String(item.variant_id)===state.item?' selected':'')+'>'+
        esc(item.product_name+' · '+item.weight+' — '+item.qty+' шт.'+(item.can_add?'':' (архив)'))+'</option>';
    }).join('');
    var lines=stocked.slice(0,40).map(function(x){
      return '<div class="work-row"><div><b>'+esc(x.product_name)+'</b><small>'+
        esc(x.weight+(x.can_add?'':' · архив'))+'</small></div><strong>'+esc(x.qty)+' шт.</strong></div>';
    }).join('')||'<p class="work-note">Склад пуст. Выберите активный товар и оформите приход.</p>';
    var controls='<form id="hmWarehouseForm" class="work-register-form">' +
      '<label class="work-register-label" for="hmWarehouseCity">Город склада</label>' +
      '<select class="work-register-input" id="hmWarehouseCity" required>'+citiesHtml+'</select>' +
      '<label class="work-register-label" for="hmWarehouseItem">Товар и фасовка</label>' +
      '<select class="work-register-input" id="hmWarehouseItem" required><option value="">Выберите товар</option>'+
        itemsHtml+'</select>' +
      '<p class="work-note" id="hmWarehouseCurrent"></p>' +
      '<label class="work-register-label" for="hmWarehouseAction">Операция</label>' +
      '<select class="work-register-input" id="hmWarehouseAction">' +
        '<option value="add">➕ Добавить товар на склад (приход)</option>' +
        '<option value="decrease">➖ Списать количество</option>' +
        '<option value="delete">🗑 Удалить позицию со склада</option></select>' +
      '<div id="hmWarehouseAmountWrap"><label class="work-register-label" for="hmWarehouseAmount">Количество, шт.</label>' +
        '<input class="work-register-input" id="hmWarehouseAmount" type="number" inputmode="numeric" min="1" max="100000" step="1" value="1"></div>' +
      '<label class="work-register-label" for="hmWarehouseReason">Причина / накладная *</label>' +
      '<textarea class="work-register-input" id="hmWarehouseReason" rows="2" maxlength="500" ' +
        'placeholder="Накладная №..., списание по инвентаризации" required></textarea>' +
      '<div id="hmWarehouseDeleteWrap" hidden><label class="work-register-consent">' +
        '<input id="hmWarehouseDeleteConfirm" type="checkbox"> Подтверждаю удаление складской позиции. ' +
        'Каталог и остатки салонов сохраняются.</label></div>' +
      '<div id="hmWarehouseFeedback" aria-live="polite"></div>' +
      '<button type="submit" class="work-primary" id="hmWarehouseSubmit"'+(!items.length?' disabled':'')+
        '>Сохранить изменение</button></form>';
    layout('<div class="work-stats"><div class="work-stat"><small>Позиций</small><strong>'+stocked.length+
      '</strong><span>На выбранном складе</span></div><div class="work-stat"><small>Единиц товара</small><strong>'+
      units.toLocaleString('ru-RU')+'</strong></div></div>'+
      (confirmation?'<div class="work-info">'+esc(confirmation)+'</div>':'')+
      '<section class="work-surface"><h2>Изменить остаток</h2>'+controls+'</section>'+
      '<section class="work-surface"><h2>Текущие остатки</h2>'+lines+'</section>'+
      '<button type="button" class="work-secondary" data-hm-wh-action="reload">↻ Обновить остатки</button>'+
      '<p class="work-quiet">Действия фиксируются с причиной и именем администратора. Другие города и точки не затрагиваются.</p>');
    var selected=document.getElementById('hmWarehouseItem');
    if(selected&&state.item)selected.value=state.item;
    sync();
  }
  async function load(confirmation){
    if(!valid())return;
    var stamp=++state.serial;
    layout('<section class="work-surface">'+msg('Загружаем актуальные остатки центрального склада…')+'</section>');
    try{
      var data=await api('/api/miniapp/admin/warehouse'+
        (state.city?'?city='+encodeURIComponent(state.city):''));
      if(!valid()||stamp!==state.serial)return;
      state.data=data;
      state.city=String(data.city_id||'');
      render(confirmation);
    }catch(e){
      if(!valid()||stamp!==state.serial)return;
      if(e.status===401||e.status===403)return close();
      layout('<section class="work-surface">'+msg(e.message,true)+
        '<button class="work-secondary" type="button" data-hm-wh-action="reload">Повторить загрузку</button></section>');
    }
  }
  function close(silent){
    if(!state.open)return;
    var back=state.onBack;
    state.open=false;state.data=null;state.serial++;state.busy=false;state.token='';
    state.city='';state.item='';
    if(!silent&&typeof back==='function')return back();
  }
  async function submit(){
    if(!valid()||!state.data||state.busy)return;
    var item=currentItem(),action=String(document.getElementById('hmWarehouseAction').value||'');
    var reason=String(document.getElementById('hmWarehouseReason').value||'').trim();
    var qty=Number(document.getElementById('hmWarehouseAmount').value);
    var agreed=document.getElementById('hmWarehouseDeleteConfirm');
    var feedback=document.getElementById('hmWarehouseFeedback');
    var button=document.getElementById('hmWarehouseSubmit');
    function fail(text){feedback.innerHTML=msg(text,true);}
    if(!item||!['add','decrease','delete'].includes(action))return fail('Выберите товар и действие');
    if(!state.city||!(state.data.cities||[]).some(function(c){return String(c.id)===state.city;}))
      return fail('Выберите действующий город');
    if(reason.length<8||reason.length>500)return fail('Причина должна содержать от 8 до 500 символов');
    if(action!=='delete'&&(!Number.isSafeInteger(qty)||qty<1||qty>100000))
      return fail('Количество должно быть целым числом от 1 до 100 000');
    if(action==='add'&&!item.can_add)return fail('Архивные товары нельзя пополнять');
    if(action!=='add'&&!item.has_stock)return fail('Указанной позиции нет на этом складе');
    if(action==='decrease'&&qty>Number(item.qty))return fail('Недостаточно товара на складе');
    if(action==='delete'&&(!agreed||!agreed.checked))return fail('Подтвердите удаление позиции со склада');
    state.busy=true;button.disabled=true;feedback.innerHTML=msg('Сохраняем изменение…');
    var stamp=state.serial,selected=String(item.variant_id);
    try{
      var result=await api('/api/miniapp/admin/warehouse/adjust',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({city_id:state.city,variant_id:Number(item.variant_id),
          expected_qty:Number(item.qty),action:action,qty:action==='delete'?null:qty,
          reason:reason,confirmed:action==='delete'&&!!agreed.checked}),
      });
      if(!valid()||stamp!==state.serial)return;
      state.item=selected;
      await load('✅ Изменение сохранено. Новый остаток: '+
        (result.new_qty===null?'позиция удалена':result.new_qty+' шт.'));
    }catch(e){
      if(!valid()||stamp!==state.serial)return;
      if(e.status===401||e.status===403)return close();
      fail(e.message||'Не удалось обновить остаток');
      button.disabled=false;
    }finally{state.busy=false;}
  }
  root.addEventListener('click',function(event){
    var t=event.target&&event.target.closest&&event.target.closest('[data-hm-wh-action]');
    if(!t||!state.open)return;
    if(event.preventDefault)event.preventDefault();
    if(t.dataset.hmWhAction==='back')return close();
    if(t.dataset.hmWhAction==='reload')return load();
  });
  root.addEventListener('submit',function(event){
    if(!state.open||!event.target||event.target.id!=='hmWarehouseForm')return;
    event.preventDefault();return submit();
  });
  root.addEventListener('change',function(event){
    if(!state.open||!event.target)return;
    if(event.target.id==='hmWarehouseCity'){
      state.city=String(event.target.value||'');state.item='';return load();
    }
    if(event.target.id==='hmWarehouseItem')state.item=String(event.target.value||'');
    if(['hmWarehouseItem','hmWarehouseAction'].includes(event.target.id))sync();
  });
  window.HvostAdminWarehouse={
    open:function(opts){
      if(!opts||typeof opts.isValid!=='function'||!opts.isValid()||!opts.token)return;
      state.open=true;state.token=opts.token;state.isValid=opts.isValid;
      state.onBack=opts.onBack;state.city='';state.item='';state.data=null;
      return load();
    },
    close:close,
    isOpen:function(){return state.open;},
  };
})();
