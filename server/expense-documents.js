// Private evidence files for paid business-founder expenses.
// Files are stored under persistent /data and NEVER served by public static URLs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { activeFounder } = require('./business-founders');

const DOCUMENT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'expense-documents');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_EXPENSE = 12;
const MIME = Object.freeze({
  pdf:'application/pdf', jpg:'image/jpeg', jpeg:'image/jpeg',
  png:'image/png', webp:'image/webp', heic:'image/heic', heif:'image/heif',
  doc:'application/msword',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt:'application/vnd.oasis.opendocument.text', ods:'application/vnd.oasis.opendocument.spreadsheet',
  txt:'text/plain', csv:'text/csv', xml:'application/xml', rtf:'application/rtf',
  zip:'application/zip',
});
const ZIP_TYPES = new Set(['docx','xlsx','pptx','odt','ods','zip']);
const OLE_TYPES = new Set(['doc','xls']);

db.exec(
  'CREATE TABLE IF NOT EXISTS expense_documents (' +
  'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  'expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,' +
  'filename TEXT NOT NULL,storage_name TEXT NOT NULL UNIQUE,' +
  'mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,' +
  'uploaded_by_role TEXT NOT NULL,uploaded_by_id INTEGER NOT NULL,' +
  'uploaded_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
  ')'
);
db.exec('CREATE INDEX IF NOT EXISTS idx_expense_documents_expense ON expense_documents(expense_id,id)');

function idNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && String(number) === String(value) ? number : null;
}
function sanitizeFilename(value) {
  const clean = String(value || '').replace(/[\u0000-\u001F\u007F/\\]/g, '_').trim();
  if (!clean || clean.length > 160 || /^\.+$/.test(clean)) return null;
  return clean;
}
function checkMagic(ext, buffer) {
  if (!buffer || !buffer.length) return false;
  const first = buffer.subarray(0, 16);
  const prefix = first.toString('ascii');
  if (ext === 'pdf') return prefix.startsWith('%PDF-');
  if (ext === 'jpg' || ext === 'jpeg') return first.length >= 3 &&
    first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff;
  if (ext === 'png') return first.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if (ext === 'webp') return prefix.startsWith('RIFF') && prefix.slice(8,12) === 'WEBP';
  if (ext === 'heic' || ext === 'heif') {
    const tag=prefix.slice(4,12);
    return tag.startsWith('ftyp') && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(tag.slice(4,8));
  }
  if (ZIP_TYPES.has(ext)) return prefix.startsWith('PK\x03\x04');
  if (OLE_TYPES.has(ext)) return first.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'));
  if (ext === 'rtf') return prefix.startsWith('{\\rtf');
  if (['txt','csv','xml'].includes(ext)) {
    // No binary disguised as text and no HTML/SVG disguised as evidence.
    if (buffer.includes(0)) return false;
    try {
      const decoded = new TextDecoder('utf-8',{fatal:true}).decode(buffer);
      if (/<\s*(html|svg|script)\b/i.test(decoded.slice(0,300))) return false;
      return true;
    } catch { return false; }
  }
  return false;
}
function validateFile(body) {
  const filename=sanitizeFilename(body && body.filename);
  if (!filename) return {error:'Укажите корректное имя документа (до 160 символов)'};
  const ext=filename.split('.').pop().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME,ext) || filename===ext) {
    return {error:'Формат файла не поддерживается. Разрешены PDF, изображения, Word, Excel, PowerPoint, текстовые файлы и ZIP.'};
  }
  const text=body && body.data_base64;
  if (typeof text!=='string' || !text.length || text.length>Math.ceil(MAX_FILE_BYTES/3)*4+8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    return {error:'Недопустимый файл или размер превышает 10 МБ'};
  }
  const buffer=Buffer.from(text,'base64');
  if (!buffer.length || buffer.length>MAX_FILE_BYTES || buffer.toString('base64')!==text) {
    return {error:'Недопустимый файл или размер превышает 10 МБ'};
  }
  if (!checkMagic(ext,buffer)) {
    return {error:'Файл повреждён или его содержимое не соответствует формату '+ext.toUpperCase()};
  }
  return {filename,ext,mime_type:MIME[ext],buffer};
}
function safeDocument(row) {
  return {id:row.id,filename:row.filename,mime_type:row.mime_type,
    size_bytes:row.size_bytes,uploaded_at:row.uploaded_at};
}
function listExpenseDocuments(expenseIds) {
  const ids=[...new Set((expenseIds||[]).filter(x=>Number.isSafeInteger(Number(x))).map(Number))];
  const result=Object.create(null);
  for (const id of ids) result[id]=[];
  for(let offset=0;offset<ids.length;offset+=250){
    const batch=ids.slice(offset,offset+250);
    const placeholders=batch.map(()=>'?').join(',');
    const rows=db.prepare(
      'SELECT id,expense_id,filename,mime_type,size_bytes,uploaded_at ' +
      'FROM expense_documents WHERE expense_id IN ('+placeholders+') ORDER BY id'
    ).all(...batch);
    for(const row of rows)result[row.expense_id].push(safeDocument(row));
  }
  return result;
}
function expenseForId(raw) {
  const id=idNumber(raw);
  return id?db.prepare('SELECT * FROM expenses WHERE id=?').get(id):null;
}
function checkAccess(req,res,ctx,expense) {
  const payload=requireAuth(['admin','founder'])(req,res,ctx);
  if (!payload) return null;
  if(payload.role==='admin'){
    const admin=db.prepare('SELECT id FROM admins WHERE id=? AND active=1').get(payload.id);
    if(!admin) {sendJson(res,401,{error:'Учётная запись администратора отключена'});return null;}
    return payload;
  }
  const founder=activeFounder(payload.id);
  if(!founder) {sendJson(res,401,{error:'Доступ собственника отключён'});return null;}
  if (!expense || expense.investor_name!==founder.full_name) {
    sendJson(res,404,{error:'Трата не найдена'});return null;
  }
  return payload;
}
function removeExpenseFiles(expenseId) {
  const docs=db.prepare('SELECT storage_name FROM expense_documents WHERE expense_id=?').all(expenseId);
  // Called AFTER deleting the expense; the FK cascades metadata removal.
  for(const doc of docs) {
    try {fs.unlinkSync(path.join(DOCUMENT_DIR,doc.storage_name));} catch(e) {
      if(e.code!=='ENOENT')console.warn('Expense file cleanup failed:',e.code);
    }
  }
}
function cleanupAfterDeletedExpense(storageNames) {
  for(const name of storageNames) {
    if(!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(name))continue;
    try{fs.unlinkSync(path.join(DOCUMENT_DIR,name));}catch(e) {
      if(e.code!=='ENOENT')console.warn('Expense attachment cleanup failed:',e.code);
    }
  }
}
function registerExpenseDocumentRoutes(router) {
  router.get('/api/expenses/:id/documents',(req,res,ctx)=>{
    const expense=expenseForId(ctx.params.id);
    const payload=checkAccess(req,res,ctx,expense);
    if(!payload)return;
    if(!expense)return sendJson(res,404,{error:'Трата не найдена'});
    const grouped=listExpenseDocuments([expense.id]);
    sendJson(res,200,{expense_id:expense.id,documents:grouped[expense.id]});
  });
  router.post('/api/expenses/:id/documents',(req,res,ctx)=>{
    const expense=expenseForId(ctx.params.id);
    const payload=checkAccess(req,res,ctx,expense);
    if(!payload)return;
    if(!expense)return sendJson(res,404,{error:'Трата не найдена'});
    const count=db.prepare('SELECT COUNT(*) AS n FROM expense_documents WHERE expense_id=?').get(expense.id).n;
    if(count>=MAX_FILES_PER_EXPENSE)return sendJson(res,409,{error:'К одной трате можно прикрепить не более 12 файлов'});
    const parsed=validateFile(ctx.body);
    if(parsed.error)return sendJson(res,400,{error:parsed.error});
    fs.mkdirSync(DOCUMENT_DIR,{recursive:true,mode:0o700});
    const storageName=crypto.randomBytes(16).toString('hex')+'.'+parsed.ext;
    const filePath=path.join(DOCUMENT_DIR,storageName);
    fs.writeFileSync(filePath,parsed.buffer,{flag:'wx',mode:0o600});
    try {
      const result=db.prepare(
        'INSERT INTO expense_documents(expense_id,filename,storage_name,mime_type,size_bytes,uploaded_by_role,uploaded_by_id) ' +
        'VALUES(?,?,?,?,?,?,?)'
      ).run(expense.id,parsed.filename,storageName,parsed.mime_type,
        parsed.buffer.length,payload.role,payload.id);
      const row=db.prepare('SELECT * FROM expense_documents WHERE id=?').get(result.lastInsertRowid);
      sendJson(res,201,{ok:true,document:safeDocument(row)});
    } catch(error) {
      try{fs.unlinkSync(filePath);}catch(_){}
      throw error;
    }
  });
  router.get('/api/expense-documents/:id/download',(req,res,ctx)=>{
    const id=idNumber(ctx.params.id);
    const doc=id?db.prepare(
      'SELECT d.*,e.investor_name FROM expense_documents d JOIN expenses e ON e.id=d.expense_id WHERE d.id=?'
    ).get(id):null;
    const payload=checkAccess(req,res,ctx,doc?{investor_name:doc.investor_name}:null);
    if(!payload)return;
    if(!doc)return sendJson(res,404,{error:'Файл не найден'});
    const filePath=path.join(DOCUMENT_DIR,doc.storage_name);
    let stat;
    try{stat=fs.statSync(filePath);}catch(_) {return sendJson(res,404,{error:'Файл не найден в хранилище'});}
    if(!stat.isFile())return sendJson(res,404,{error:'Файл не найден'});
    const fallback='evidence-'+doc.id+path.extname(doc.filename).toLowerCase();
    res.writeHead(200,{
      'Content-Type':'application/octet-stream',
      'Content-Disposition':'attachment; filename="'+fallback+'"; filename*=UTF-8\'\''+encodeURIComponent(doc.filename),
      'Content-Length':stat.size,'Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",
    });
    fs.createReadStream(filePath).on('error',()=>res.destroy()).pipe(res);
  });
  router.delete('/api/expense-documents/:id',(req,res,ctx)=>{
    const id=idNumber(ctx.params.id);
    const doc=id?db.prepare(
      'SELECT d.*,e.investor_name FROM expense_documents d JOIN expenses e ON e.id=d.expense_id WHERE d.id=?'
    ).get(id):null;
    const payload=checkAccess(req,res,ctx,doc?{investor_name:doc.investor_name}:null);
    if(!payload)return;
    if(!doc)return sendJson(res,404,{error:'Файл не найден'});
    if(payload.role==='founder' &&
       (doc.uploaded_by_role!=='founder' || Number(doc.uploaded_by_id)!==Number(payload.id))) {
      return sendJson(res,403,{error:'Удаление этого документа доступно администратору'});
    }
    db.prepare('DELETE FROM expense_documents WHERE id=?').run(doc.id);
    cleanupAfterDeletedExpense([doc.storage_name]);
    sendJson(res,200,{ok:true});
  });
}
module.exports={
  registerExpenseDocumentRoutes,listExpenseDocuments,cleanupAfterDeletedExpense,
  validateFile,MAX_FILE_BYTES,MAX_FILES_PER_EXPENSE,DOCUMENT_DIR,
};
