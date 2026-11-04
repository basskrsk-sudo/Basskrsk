// Shared private receipt actions for business expenses in the admin ledger
// and founder Mini App. No direct file links: every download needs a bearer token.
(function(){
  'use strict';
  var ALLOWED=/\.(pdf|jpe?g|png|webp|heic|heif|docx?|xlsx?|pptx|odt|ods|txt|csv|xml|rtf|zip)$/i;
  var MAX_SIZE=10*1024*1024,MAX_COUNT=12;
  function esc(value) {
    return String(value==null?'':value).replace(/[&<>"']/g,function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function validFile(file) {
    if (!file || !file.name || !ALLOWED.test(file.name))
      throw Error('Поддерживаются PDF, JPG, PNG, WebP, HEIC, Word, Excel, PowerPoint, ODT/ODS, TXT, CSV, XML, RTF и ZIP.');
    if (!file.size || file.size>MAX_SIZE)throw Error('Размер каждого файла должен быть от 1 байта до 10 МБ.');
  }
  function readBase64(file) {
    return new Promise(function(resolve,reject){
      var reader=new FileReader();
      reader.onerror=function(){reject(Error('Не удалось прочитать файл.'));};
      reader.onload=function(){
        var value=String(reader.result||'');
        var comma=value.indexOf(',');
        if(comma<0)return reject(Error('Ошибка чтения файла.'));
        resolve(value.slice(comma+1));
      };
      reader.readAsDataURL(file);
    });
  }
  async function upload(expenseId,files,token,onProgress){
    if (!token)throw Error('Сессия завершилась. Войдите в кабинет заново.');
    var items=Array.from(files||[]);
    if (!items.length)return [];
    if(items.length>MAX_COUNT)throw Error('За один раз можно выбрать не более 12 файлов.');
    items.forEach(validFile);
    var result=[];
    for(var i=0;i<items.length;i++){
      if(onProgress)onProgress('Загружаем '+(i+1)+'/'+items.length+': '+items[i].name);
      var encoded=await readBase64(items[i]);
      var res=await fetch('/api/expenses/'+encodeURIComponent(expenseId)+'/documents',{
        method:'POST',cache:'no-store',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({filename:items[i].name,data_base64:encoded}),
      });
      var data=await res.json().catch(function(){return {};});
      if(!res.ok){
        var err=new Error(data.error||'Не удалось прикрепить '+items[i].name);
        err.completed=result.length;
        throw err;
      }
      result.push(data.document);
    }
    return result;
  }
  async function download(id,filename,token){
    if(!token)throw Error('Сессия истекла. Войдите снова.');
    var res=await fetch('/api/expense-documents/'+encodeURIComponent(id)+'/download',{
      method:'GET',cache:'no-store',headers:{Authorization:'Bearer '+token},
    });
    if(!res.ok){
      var body=await res.json().catch(function(){return {};});
      throw Error(body.error||'Не удалось получить подтверждающий файл.');
    }
    var blob=await res.blob();
    var blobUrl=URL.createObjectURL(blob),link=document.createElement('a');
    try {
      link.href=blobUrl;
      link.download=String(filename||'document').slice(0,160);
      link.style.display='none';
      document.body.appendChild(link);
      link.click();
    }finally{
      link.remove();
      setTimeout(function(){URL.revokeObjectURL(blobUrl);},1000);
    }
  }
  async function remove(id,token){
    if(!token)throw Error('Сессия истекла. Войдите снова.');
    var res=await fetch('/api/expense-documents/'+encodeURIComponent(id),{
      method:'DELETE',cache:'no-store',headers:{Authorization:'Bearer '+token},
    });
    if(!res.ok){
      var body=await res.json().catch(function(){return {};});
      throw Error(body.error||'Не удалось удалить документ.');
    }
  }
  function fileRows(documents,options) {
    var settings=options||{},docs=documents||[];
    if(!docs.length)return '<span style="font-size:12px;color:var(--muted,#66796a)">Нет файлов</span>';
    return '<div class="expense-evidence-list">'+docs.map(function(d){
      var size=(Number(d.size_bytes||0)/1024/1024).toFixed(1).replace('.',',');
      var attr=' data-expense-doc-id="'+Number(d.id)+'" data-expense-doc-name="'+esc(d.filename)+'"';
      return '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 0">'+
        '<button type="button"'+attr+' data-expense-file-action="download" '+
        'style="text-align:left;background:transparent;border:0;color:#186b49;text-decoration:underline;padding:4px 0;max-width:200px;overflow-wrap:anywhere">📎 '+esc(d.filename)+'</button>'+
        '<small style="color:var(--muted,#66796a)">'+size+' МБ</small>'+
        (settings.allowDelete?'<button type="button"'+attr+
          ' data-expense-file-action="delete" title="Удалить файл" '+
          'style="border:0;background:transparent;color:#a23a30;padding:4px">✕</button>':'')+
        '</div>';
    }).join('')+'</div>';
  }
  window.HvostExpenseEvidence={upload:upload,download:download,remove:remove,
    fileRows:fileRows,validFile:validFile,MAX_SIZE:MAX_SIZE,MAX_COUNT:MAX_COUNT};
})();