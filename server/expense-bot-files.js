'use strict';

// Reads Telegram-sent receipts only while a verified expense upload session is
// active. Never exposes bot token or file_path in API/UI responses.
const {activeExpenseAttachment,attachmentButtons,attachmentInstructions,
  attachmentCount,queueExpenseAttachment,pendingSavedExpenseAttachments,
  markPendingAttachmentStored}=require('./expense-bot-create');
const {storeExpenseDocument,MAX_FILE_BYTES}=require('./expense-documents');

const TOKEN=process.env.TG_TOKEN || '';
const PHOTO_SUFFIX='.jpg';
const MAX_WAIT_MS=30000;

function telegramFile(message) {
  if(message.document){
    const file=message.document;
    if(!file.file_id)return {error:'Telegram не передал идентификатор документа.'};
    return {fileId:file.file_id,filename:file.file_name||'document',
      size:file.file_size};
  }
  if(Array.isArray(message.photo)&&message.photo.length){
    const file=message.photo[message.photo.length-1];
    return {fileId:file.file_id,filename:'Чек-фото-'+String(message.message_id||Date.now())+PHOTO_SUFFIX,
      size:file.file_size};
  }
  return null;
}
async function readTelegramFile(fileId,filename,reportedSize,fetchImpl=fetch){
  if(!TOKEN)throw Error('Telegram API недоступен: отсутствует токен бота.');
  if(typeof fileId!=='string'||!/^[A-Za-z0-9_-]{12,400}$/.test(fileId)){
    throw Error('Некорректный файл Telegram.');
  }
  if(Number(reportedSize)>MAX_FILE_BYTES){
    throw Error('Файл превышает 10 МБ. Отправьте сжатую фотографию или более компактный документ.');
  }
  const api=await fetchImpl('https://api.telegram.org/bot'+TOKEN+'/getFile',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({file_id:fileId}),signal:AbortSignal.timeout(10000),
  });
  const result=await api.json().catch(()=>({}));
  if(!api.ok||!result.ok||!result.result || typeof result.result.file_path!=='string'){
    throw Error('Не удалось получить документ от Telegram. Отправьте его ещё раз.');
  }
  const path=result.result.file_path;
  const segments=path.split('/');
  if(!segments.length || segments.some(seg=>seg==='.'||seg==='..'||!seg||
       !/^[A-Za-z0-9_.-]{1,160}$/.test(seg))){
    throw Error('Telegram вернул некорректный путь к документу.');
  }
  if(Number(result.result.file_size)>MAX_FILE_BYTES){
    throw Error('Файл превышает 10 МБ. Уменьшите его размер.');
  }
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),MAX_WAIT_MS);
  let response;
  try {
    response=await fetchImpl('https://api.telegram.org/file/bot'+TOKEN+'/'+
      segments.map(encodeURIComponent).join('/'),{signal:controller.signal});
    if(!response.ok)throw Error('Не удалось скачать подтверждающий файл из Telegram.');
    const advertised=Number(response.headers?.get?.('content-length')||0);
    if(advertised>MAX_FILE_BYTES)throw Error('Документ превышает 10 МБ.');
    let binary;
    if(response.body && typeof response.body.getReader==='function'){
      const reader=response.body.getReader();
      const chunks=[];
      let total=0;
      try {
        while(true){
          const value=await reader.read();
          if(value.done)break;
          const buffer=Buffer.from(value.value);
          total+=buffer.length;
          if(total>MAX_FILE_BYTES)throw Error('Документ превышает 10 МБ.');
          chunks.push(buffer);
        }
      } catch(error) {
        await reader.cancel().catch(()=>{});
        throw error;
      }
      binary=Buffer.concat(chunks,total);
    }else{
      // Fallback for older fetch implementations, capped by file_size and
      // Content-Length; Telegram Bot API provides those fields.
      binary=Buffer.from(await response.arrayBuffer());
      if(binary.length>MAX_FILE_BYTES)throw Error('Документ превышает 10 МБ.');
    }
    if(!binary.length)throw Error('Telegram вернул пустой файл.');
    return {filename,data_base64:binary.toString('base64')};
  } finally {
    clearTimeout(timeout);
  }
}
async function handleExpenseAttachmentMessage(channel,chatId,message,fetchImpl=fetch){
  const hasFile=!!(message.document||(Array.isArray(message.photo)&&message.photo.length));
  if(!hasFile)return null;
  if(channel!=='telegram'||!chatId)return null;
  const state=activeExpenseAttachment(channel,chatId);
  const file=telegramFile(message);
  if(file && !file.error && Number(file.size)>MAX_FILE_BYTES){
    const queued=queueExpenseAttachment(channel,chatId,file);
    if(queued)return {ok:false,message:'Файл больше 10 МБ. Пришлите уменьшенный документ.'};
  }
  if(file && !file.error && Number(file.size)<=MAX_FILE_BYTES){
    const queued=queueExpenseAttachment(channel,chatId,file);
    if(queued)return queued;
  }
  if(!state)return null;
  if(state.denied)return {ok:false,message:'Нет доступа к загрузке чеков для этой траты.'};
  if(!file||file.error)return {ok:false,message:file?.error||'Не удалось определить тип файла.',
    replyMarkup:attachmentButtons(state.expenseId)};
  if(Number(file.size)>MAX_FILE_BYTES){
    return {ok:false,message:'Файл больше 10 МБ. Отправьте уменьшенный файл.',
      replyMarkup:attachmentButtons(state.expenseId)};
  }
  try {
    const data=await readTelegramFile(file.fileId,file.filename,file.size,fetchImpl);
    // Recheck the active chat session after the external await; a moderator
    // may have revoked access or an expense wizard may have been restarted.
    const current=activeExpenseAttachment(channel,chatId);
    if(!current || current.denied || current.expenseId!==state.expenseId ||
       current.actor.role!==state.actor.role || Number(current.actor.id)!==Number(state.actor.id)){
      return {ok:false,message:'Сессия прикрепления завершилась. Файл не сохранён.'};
    }
    const saved=storeExpenseDocument(state.expenseId,data,state.actor);
    markPendingAttachmentStored(channel,chatId,state.expenseId,file.fileId);
    const total=attachmentCount(state.expenseId);
    return {ok:true,attached:true,expenseId:state.expenseId,document:saved.document,
      message:(saved.already_exists?'ℹ️ Этот файл уже прикреплён.':'✅ Документ прикреплён: '+saved.document.filename)+
        '\n\n'+attachmentInstructions(state.expenseId,total),
      replyMarkup:attachmentButtons(state.expenseId)};
  } catch(error) {
    return {ok:false,expenseId:state.expenseId,
      message:'⚠️ Не удалось прикрепить файл: '+String(error.message||'Ошибка загрузки')+
        '\n\nТрата уже записана — её повторно создавать не нужно. Отправьте другой файл или нажмите «✅ Готово».',
      replyMarkup:attachmentButtons(state.expenseId)};
  }
}

async function processPendingExpenseAttachments(channel,chatId,fetchImpl=fetch) {
  const session=pendingSavedExpenseAttachments(channel,chatId);
  if(!session || !session.files.length)return null;
  const results=[];
  let attached=0,failed=0;
  for(const file of session.files) {
    // A revoked account or cancelled session must not finish old downloads.
    const before=pendingSavedExpenseAttachments(channel,chatId);
    if(!before || before.expenseId!==session.expenseId ||
      !before.files.some(entry=>entry.fileId===file.fileId))break;
    try {
      const data=await readTelegramFile(file.fileId,file.filename,file.size,fetchImpl);
      const current=pendingSavedExpenseAttachments(channel,chatId);
      if(!current || current.expenseId!==session.expenseId ||
        current.actor.role!==session.actor.role || Number(current.actor.id)!==Number(session.actor.id) ||
        !current.files.some(entry=>entry.fileId===file.fileId))break;
      const saved=storeExpenseDocument(session.expenseId,data,current.actor);
      markPendingAttachmentStored(channel,chatId,session.expenseId,file.fileId);
      attached++;
      results.push('✅ '+(saved.already_exists?'Уже прикреплён: ':'Прикреплён: ')+saved.document.filename);
    } catch(error) {
      failed++;
      // Do not delete a failed pending attachment. The user can explicitly
      // retry it without creating another expense.
      results.push('⚠️ '+String(file.filename||'Файл').slice(0,80)+': '+
        String(error.message||'ошибка скачивания').slice(0,140));
    }
  }
  return {
    ok: failed===0,attached,failed,expenseId:session.expenseId,
    message:'📎 Документы для траты №'+session.expenseId+
      '\n'+results.join('\n')+
      (failed?'\n\nЧасть файлов пока не прикреплена. Нажмите «🔄 Повторить ожидающие файлы» — новую трату создавать не нужно.':
        '\n\nВсе ожидающие файлы обработаны. Можно прислать дополнительные чеки или нажать «✅ Готово».'),
    replyMarkup:attachmentButtons(session.expenseId),
  };
}

module.exports={handleExpenseAttachmentMessage,processPendingExpenseAttachments,
  readTelegramFile,telegramFile};

