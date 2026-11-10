(function () {
  'use strict';
  var state={points:[],products:[],pointId:'',category:'all',search:''};
  var labels={all:'Все',treats:'Лакомства',toys:'Игрушки',accessories:'Аксессуары',care:'Уход'};
  var $=function(id){return document.getElementById(id)};
  function text(id,value){$(id).textContent=String(value==null?'':value)}
  function getMaxInitData(){
    // WebAppData is supplied by MAX in the URL fragment. Never use
    // initDataUnsafe for authentication.
    try{
      if(window.WebApp&&typeof window.WebApp.initData==='string'&&window.WebApp.initData){
        return window.WebApp.initData;
      }
      var fragment=new URLSearchParams(location.hash.replace(/^#/,''));
      if(fragment.getAll('WebAppData').length!==1)return '';
      return fragment.get('WebAppData')||'';
    }catch(_){return ''}
  }
  function userName(user){
    return [user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,120)||'покупатель';
  }
  async function verifyMax(){
    var initData=getMaxInitData();
    if(!initData){
      text('identity-title','Режим просмотра');
      text('identity-info','Откройте мини-приложение из MAX, чтобы подтвердить аккаунт.');
      return;
    }
    try{
      var res=await fetch('/api/max/miniapp/verify',{method:'POST',
        headers:{'Content-Type':'application/json'},cache:'no-store',
        body:JSON.stringify({init_data:initData})});
      var data=await res.json();
      if(!res.ok||data.verified!==true)throw new Error(data.error||'Сессия MAX не подтверждена.');
      text('identity-title','Здравствуйте, '+userName(data.user)+'!');
      text('identity-info','✅ Ваш запуск подтверждён MAX. Сейчас доступен тестовый каталог.');
    }catch(_){
      text('identity-title','Подтверждение MAX не прошло');
      text('identity-info','Откройте мини-приложение из бота MAX повторно. Каталог доступен для просмотра.');
    }
  }
  function selectedPoint(){
    return state.points.find(function(p){return String(p.id)===state.pointId})||null;
  }
  function qty(variant){return Number((variant.stock||{})[state.pointId]||0)}
  function money(n){return Math.round(Number(n)||0).toLocaleString('ru-RU')+' ₽'}
  function categoryButtons(){
    var holder=$('category-filters');
    holder.replaceChildren();
    Object.keys(labels).forEach(function(k){
      var btn=document.createElement('button');
      btn.type='button';btn.textContent=labels[k];
      btn.className='filter'+(state.category===k?' active':'');
      btn.setAttribute('aria-pressed',state.category===k?'true':'false');
      btn.addEventListener('click',function(){state.category=k;categoryButtons();render()});
      holder.appendChild(btn);
    });
  }
  function productImage(product,pic){
    var raw=String(product.img||'').trim();
    if(/^\/?images\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(raw)){
      var img=document.createElement('img');
      img.src='/'+raw.replace(/^\//,'');img.alt='';img.loading='lazy';
      img.onerror=function(){img.remove();pic.textContent=product.icon||'🐾'};
      pic.appendChild(img);
    }else pic.textContent=product.icon||'🐾';
  }
  function productCard(product){
    var card=document.createElement('article');card.className='product';
    var pic=document.createElement('div');pic.className='pic';productImage(product,pic);
    var body=document.createElement('div');body.className='product-body';
    var name=document.createElement('strong');name.textContent=product.name;
    var items=(product.variants||[]).filter(function(v){return v.active!==false});
    var inStock=items.filter(function(v){return qty(v)>0});
    var available=items.length&&inStock.length>0;
    var info=document.createElement('span');info.className='qty'+(available?'':' empty-stock');
    info.textContent=available?'В наличии: '+inStock.reduce(function(s,v){return s+qty(v)},0)+' шт.':'Нет в выбранной точке';
    var weights=document.createElement('div');weights.className='variants';
    items.slice(0,5).forEach(function(item){
      var line=document.createElement('span');line.className='variant';
      line.textContent=item.weight+(qty(item)>0?' · '+qty(item)+' шт.':' · нет');weights.appendChild(line);
    });
    var price=document.createElement('span');price.className='price';
    var valid=items.map(function(v){return Number(v.price)}).filter(Number.isFinite);
    price.textContent=valid.length?'от '+money(Math.min.apply(null,valid)):'Цена уточняется';
    body.append(name,info,weights,price);card.append(pic,body);
    return card;
  }
  function render(){
    var root=$('products');root.replaceChildren();
    var count=0;
    var point=selectedPoint();
    if(!point){root.innerHTML='<div class="empty">Выберите минимаркет, чтобы увидеть товары.</div>';text('stock-count','');return}
    var subset=state.products.filter(function(p){
      return (state.category==='all'||p.category===state.category)&&
        (!state.search||(String(p.name||'')+' '+String(p.desc||'')).toLocaleLowerCase('ru-RU').includes(state.search));
    });
    subset.forEach(function(p){
      if((p.variants||[]).some(function(v){return qty(v)>0}))count++;
      root.appendChild(productCard(p));
    });
    if(!subset.length)root.innerHTML='<div class="empty">По вашему запросу товары не найдены.</div>';
    text('stock-count',count+' в наличии');
  }
  function showPoints(){
    var select=$('point-select');
    select.replaceChildren();
    if(!state.points.length){
      var empty=document.createElement('option');empty.textContent='Точек пока нет';empty.value='';
      select.appendChild(empty);state.pointId='';text('point-address','');return;
    }
    state.points.sort(function(a,b){return String(a.name).localeCompare(String(b.name),'ru')});
    for(var p of state.points){
      var option=document.createElement('option');option.value=String(p.id);
      option.textContent=p.name;select.appendChild(option);
    }
    var stored='';
    try{stored=localStorage.getItem('hm_max_pilot_point')||''}catch(_){}
    if(state.points.some(function(p){return String(p.id)===stored}))state.pointId=stored;
    else state.pointId=String(state.points[0].id);
    select.value=state.pointId;
    text('point-address',selectedPoint().addr||'Адрес уточняйте у площадки');
    text('point-count',state.points.length+' точек');
  }
  async function getJson(url){
    var abort=new AbortController();
    var timeout=setTimeout(function(){abort.abort()},10000);
    try{
      var result=await fetch(url,{cache:'no-store',signal:abort.signal});
      if(!result.ok)throw new Error('Ошибка сервера: '+result.status);
      return await result.json();
    }finally{clearTimeout(timeout)}
  }
  async function load(){
    $('refresh').disabled=true;
    try{
      var data=await Promise.all([getJson('/api/points'),getJson('/api/products')]);
      state.points=(data[0].points||[]).filter(function(p){return p.active!==0&&p.active!==false});
      state.products=(data[1].products||[]).filter(function(p){return p.active!==false&&!p.archived});
      showPoints();categoryButtons();render();
      text('updated-at','Данные обновлены: '+new Date().toLocaleString('ru-RU',{timeZone:'Asia/Krasnoyarsk'})+' (Красноярск)');
    }catch(_){
      text('stock-count','');
      $('products').innerHTML='<div class="empty">Не удалось получить каталог. Проверьте интернет и нажмите «Обновить остатки».</div>';
      text('updated-at','Данные временно недоступны.');
    }finally{$('refresh').disabled=false}
  }
  $('point-select').addEventListener('change',function(){
    state.pointId=this.value;
    try{localStorage.setItem('hm_max_pilot_point',state.pointId)}catch(_){}
    text('point-address',selectedPoint()?.addr||'');
    render();
  });
  $('product-search').addEventListener('input',function(){
    state.search=this.value.toLocaleLowerCase('ru-RU').trim();render();
  });
  $('refresh').addEventListener('click',load);
  try{if(window.WebApp&&typeof window.WebApp.ready==='function')window.WebApp.ready()}catch(_){}
  verifyMax();
  load();
})();
