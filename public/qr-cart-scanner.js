/* Camera access only after a user gesture; all QR decoding stays on device. */
(function(root){
  'use strict';
  var overlay=null,stream=null,timer=null,sequence=0,decoderPromise=null;
  function stop(){
    sequence++;
    if(timer!==null){clearTimeout(timer);timer=null;}
    if(stream){stream.getTracks().forEach(function(track){track.stop();});stream=null;}
    if(overlay){overlay.remove();overlay=null;}
  }
  function decoder(){
    if(typeof root.jsQR==='function')return Promise.resolve(root.jsQR);
    if(!decoderPromise)decoderPromise=new Promise(function(resolve,reject){
      var script=document.createElement('script');
      script.src='/vendor/jsQR-1.4.0.js';
      script.onload=function(){typeof root.jsQR==='function'?resolve(root.jsQR):reject(new Error('decoder'));};
      script.onerror=function(){script.remove();reject(new Error('decoder'));};
      document.head.appendChild(script);
    }).catch(function(e){decoderPromise=null;throw e;});
    return decoderPromise;
  }
  async function open(point,onScan){
    stop();
    var token=sequence;
    overlay=document.createElement('div');
    overlay.className='qr-scanner-overlay';
    overlay.innerHTML='<div class="qr-scanner-panel" role="dialog" aria-modal="true" aria-label="Сканирование QR"><button type="button" class="qr-scanner-close">Закрыть ✕</button><h2>Сканируйте QR на упаковке</h2><video playsinline muted autoplay></video><p role="status" class="qr-scanner-status">Разрешите доступ к камере.</p><p class="small muted">Если камера недоступна, откройте обычную камеру телефона и сканируйте упаковку. Корзина сохранится в этом браузере.</p></div>';
    document.body.appendChild(overlay);
    var box=overlay,video=box.querySelector('video'),status=box.querySelector('.qr-scanner-status');
    box.querySelector('button').onclick=stop;
    function current(){return token===sequence&&overlay===box;}
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('camera');
      var acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      if(!current()){acquired.getTracks().forEach(function(t){t.stop();});return;}
      stream=acquired;video.srcObject=stream;
      await video.play();
      if(!current())return;
      var read=await decoder();
      if(!current())return;
      var canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(!ctx)throw new Error('canvas');
      status.textContent='Наведите камеру на QR-код товара.';
      function tick(){
        if(!current())return;
        try{
          if(video.readyState>=2&&video.videoWidth&&video.videoHeight){
            var scale=Math.min(1,720/Math.max(video.videoWidth,video.videoHeight));
            canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
            ctx.drawImage(video,0,0,canvas.width,canvas.height);
            var pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
            var decoded=read(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'});
            if(decoded){
              var parsed=root.HvostQrCart.parseCode(decoded.data,root.location.origin);
              if(!parsed)status.textContent='Это не товарный QR ХвостМаркета. Попробуйте другую упаковку.';
              else if(String(parsed.point)!==String(point))status.textContent='Этот QR относится к другой точке. Сканируйте товар текущего минимаркета.';
              else{stop();onScan(parsed);return;}
            }
          }
        }catch(_){status.textContent='Не удалось прочитать QR. Попробуйте обычную камеру телефона.';}
        if(current())timer=setTimeout(tick,220);
      }
      tick();
    }catch(_){
      if(!current())return;
      if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}
      video.hidden=true;
      status.textContent='Камера недоступна. Закройте окно и воспользуйтесь обычной камерой телефона.';
    }
  }
  document.addEventListener('visibilitychange',function(){if(document.hidden)stop();});
  root.addEventListener('pagehide',stop);
  root.HvostQrScanner={open:open,stop:stop};
})(window);
