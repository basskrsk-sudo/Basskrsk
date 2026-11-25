// Only loaded by MAX. The administrator explicitly requests each PDF.
(function(){
  'use strict';
  var sending=false;
  function open(config){
    if(!config.isValid())return;
    var root=config.root;
    root.innerHTML='<button type="button" class="work-back" id="maxRewardBack">← В кабинет</button>'+
      '<div class="work-surface"><h2>💸 Расчёт вознаграждений</h2>'+
      '<p class="work-note">PDF придёт только в ваш личный чат с ботом MAX. После проверки вы можете сами переслать его партнёру. Выплаты не фиксируются.</p>'+
      '<form id="maxRewardForm"><label class="work-label" for="maxRewardKind">Вид отчёта</label>'+
      '<select id="maxRewardKind" class="work-register-input"><option value="unpaid">Текущая справка к выплате</option><option value="period">Расчёт за выбранный период</option></select>'+
      '<label class="work-label" for="maxRewardRecipient">На кого сформировать отчёт</label>'+
      '<select required id="maxRewardRecipient" class="work-register-input"></select>'+
      '<button type="button" class="work-secondary" id="maxRewardRefresh">↻ Обновить список</button>'+
      '<div id="maxRewardDates" hidden><label class="work-label" for="maxRewardStart">Начало периода (UTC)</label>'+
      '<input type="date" id="maxRewardStart" class="work-register-input">'+
      '<label class="work-label" for="maxRewardEnd">Конец периода (UTC)</label><input type="date" id="maxRewardEnd" class="work-register-input"></div>'+
      '<button class="work-primary" id="maxRewardSend" type="submit" disabled>📄 Отправить PDF мне в MAX</button>'+
      '<p role="status" aria-live="polite" id="maxRewardStatus" class="work-note"></p></form></div>';
    var get=id=>root.querySelector('#'+id);
    var form=get('maxRewardForm'),kind=get('maxRewardKind'),recipient=get('maxRewardRecipient'),dates=get('maxRewardDates');
    var start=get('maxRewardStart'),end=get('maxRewardEnd'),send=get('maxRewardSend'),status=get('maxRewardStatus');
    var refresh=get('maxRewardRefresh'),back=get('maxRewardBack');
    var options=[],epoch=0,periodKey=null;
    var today=new Date().toISOString().slice(0,10);
    start.value=today.slice(0,8)+'01';end.value=today;
    function valid(){return form.isConnected&&config.isValid();}
    function controls(){
      var loading=recipient.disabled;
      kind.disabled=sending;refresh.disabled=sending;back.disabled=sending;
      start.disabled=sending;end.disabled=sending;
      send.disabled=sending||loading||recipient.value==='';
    }
    async function load(){
      if(!valid()||sending)return;
      var n=++epoch,mode=kind.value;
      dates.hidden=mode!=='period';start.required=end.required=mode==='period';
      options=[];periodKey=null;recipient.replaceChildren();recipient.disabled=true;
      status.textContent='Загружаем получателей…';controls();
      try{
        var result=await config.identity.rewardReportOptions({kind:mode},config.token);
        if(!valid()||n!==epoch)return;
        options=result.recipients||[];periodKey=result.period?.key||null;
        var placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='— Выберите получателя —';recipient.append(placeholder);
        options.forEach(function(r,i){
          var option=document.createElement('option');option.value=String(i);
          option.textContent=r.name+' · '+r.roles+(r.points||r.point?' · '+(r.points||r.point):'')+
            (mode==='unpaid'?' · '+Number(r.amount||0).toLocaleString('ru-RU')+' ₽':'')+' · '+(r.payout_method_label||'Не указан');
          recipient.append(option);
        });
        recipient.disabled=false;
        status.textContent=(result.period?'Расчётный период: '+result.period.label+'. ':'')+(result.payout_method_groups||[]).map(g=>g.label+': '+Number(g.amount).toLocaleString('ru-RU')+' ₽').join(' · ')+(options.length?'':' Нет получателей для этого вида отчёта.');
      }catch(error){if(valid()&&n===epoch)status.textContent=error.message;}
      finally{if(valid()&&n===epoch)controls();}
    }
    back.addEventListener('click',function(){if(!sending)config.onBack();});
    kind.addEventListener('change',load);refresh.addEventListener('click',load);
    recipient.addEventListener('change',controls);
    form.addEventListener('submit',async function(event){
      event.preventDefault();
      if(!valid()||sending||recipient.value==='')return;
      var r=options[Number(recipient.value)];if(!r)return;
      var body=kind.value==='unpaid'?{kind:'unpaid',key:r.key,expected_total:r.amount,expected_period:periodKey}:
        {kind:'period',role:r.role,recipient_id:r.id,start:start.value,end:end.value};
      if(body.kind==='period'&&(!body.start||!body.end||body.start>body.end)){status.textContent='Укажите корректный период.';return;}
      sending=true;recipient.disabled=true;controls();
      status.textContent='Формируем PDF и отправляем в ваш MAX…';
      try{
        var result=await config.identity.sendRewardReport(body,config.token);
        if(valid())status.textContent=result.message||'PDF отправлен в ваш личный чат MAX.';
      }catch(error){if(valid())status.textContent=error.message;}
      finally{sending=false;if(valid()){recipient.disabled=false;controls();}}
    });
    if(sending){status.textContent='Другой запрос ещё выполняется. Вернитесь в кабинет и откройте раздел после завершения.';controls();}
    else load();
  }
  window.HvostMaxRewardReports={open:open};
})();
