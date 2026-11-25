'use strict';

// Official MAX file flow: POST /uploads?type=file, multipart field data,
// then POST /messages with file payload.token. Destination is the signed
// administrator's user ID, never a recipient ID or a client-supplied chat.
const API='https://platform-api2.max.ru';
const MAX_BYTES=8*1024*1024;
function failure(message,statusCode=502){return Object.assign(new Error(message),{statusCode,publicMessage:true});}
async function sendMaxRewardFile({userId,token,pdf,filename,caption,authorize=()=>{}},
 {request=globalThis.fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(!token)throw failure('MAX временно не настроен',503);
  if(!/^[1-9]\d{0,19}$/.test(String(userId)))throw failure('Личный MAX администратора не подтверждён',403);
  if(!Buffer.isBuffer(pdf)||!pdf.length||pdf.length>MAX_BYTES)throw failure('PDF превышает допустимый размер 8 МБ. Выберите более короткий период.',413);
  const auth={Authorization:token};
  async function json(response){return response.json().catch(()=>({}));}
  authorize();
  const init=await request(API+'/uploads?type=file',{method:'POST',headers:auth,
    signal:AbortSignal.timeout(10000),redirect:'error'});
  const target=await json(init);
  if(!init.ok||typeof target.url!=='string')throw failure('MAX не предоставил ссылку для загрузки PDF');
  // The upload URL is provided by the authenticated MAX API, not the browser.
  // The signed URL is sufficient for multipart upload; do not forward the bot token.
  let url;
  try{url=new URL(target.url);}catch(_){throw failure('MAX вернул некорректный адрес загрузки');}
  if(url.protocol!=='https:'||url.username||url.password)throw failure('MAX вернул небезопасный адрес загрузки');
  const form=new FormData();
  form.append('data',new Blob([pdf],{type:'application/pdf'}),filename);
  authorize();
  const uploaded=await request(url.href,{method:'POST',body:form,signal:AbortSignal.timeout(35000),redirect:'error'});
  const data=await json(uploaded);
  const fileToken=data.token||data.payload?.token||data.retval?.token||(typeof data.retval==='string'?data.retval:null)||target.token;
  if(!uploaded.ok||typeof fileToken!=='string'||!fileToken)throw failure('MAX не подтвердил загрузку PDF');
  const body=JSON.stringify({text:String(caption).slice(0,3900),attachments:[{type:'file',payload:{token:fileToken}}]});
  // Retry only an explicit NOT_READY response. Never retry a timeout or
  // ambiguous network failure, which could duplicate an already sent report.
  for(const delay of [0,500,1000,2000,4000]){
    if(delay)await sleep(delay);
    authorize();
    const response=await request(API+'/messages?user_id='+encodeURIComponent(String(userId)),{
      method:'POST',headers:{...auth,'Content-Type':'application/json'},
      body,signal:AbortSignal.timeout(12000),redirect:'error',
    });
    const message=await json(response);
    if(response.ok&&message.message?.body?.mid&&message.message?.body?.attachments?.some(a=>a.type==='file'))
      return {messageId:String(message.message.body.mid)};
    if(message.code==='attachment.not.ready')continue;
    throw failure('MAX не подтвердил отправку файла. Проверьте личный чат с ботом перед повтором.');
  }
  throw failure('MAX ещё обрабатывает файл. Повторите запрос позднее.');
}
module.exports={sendMaxRewardFile,MAX_BYTES};
