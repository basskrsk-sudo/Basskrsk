'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Writable}=require('node:stream');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-expense-evidence-'));
const db=require('./db');
const {hashPassword,signToken}=require('./auth');
const {Router}=require('./http-utils');
const {registerExpenseDocumentRoutes,validateFile,DOCUMENT_DIR}=require('./expense-documents');
const {registerEconomicsRoutes}=require('./routes-economics');
require('./business-founders');
const router=new Router();
registerExpenseDocumentRoutes(router);
registerEconomicsRoutes(router);
db.prepare('INSERT INTO admins(id,login,password_hash,full_name,role,active) VALUES(?,?,?,?,?,1)')
  .run(981,'expense-documents-admin',hashPassword('long-test-only-value'),'Admin','admin');
db.prepare('UPDATE business_founders SET login=?,password_hash=?,phone=?,active=1 WHERE id=?')
  .run('expense-doc-founder',hashPassword('long-test-only-value'),'79131230001',1);
const admin=signToken({role:'admin',id:981});
const founder=signToken({role:'founder',id:1});
const expense=Number(db.prepare(
  'INSERT INTO expenses(expense_date,category,amount,investor_name,city_id) VALUES(?,?,?,?,?)'
).run('2026-11-04','Покупка стойки',5000,'Лакомых Алексей','krsk').lastInsertRowid);
async function request(method,url,token,body={}){
  const matched=router.match(method,url);
  assert.ok(matched,'Missing route '+method+' '+url);
  const chunks=[];
  const res=new Writable({write(chunk,enc,cb){chunks.push(Buffer.from(chunk));cb();}});
  res.writeHead=function(status,headers){res.status=status;res.headersOut=headers||{};return res;};
  const completed=new Promise((resolve,reject)=>{
    res.once('finish',()=>{const bytes=Buffer.concat(chunks);let json=null;
      try{json=JSON.parse(bytes.toString('utf8'));}catch(_){}
      resolve({status:res.status,headers:res.headersOut,body:json,bytes});
    });
    res.once('error',reject);
  });
  await matched.handler({headers:token?{authorization:'Bearer '+token}:{}},res,
    {params:matched.params,body,query:{}});
  return completed;
}
const pdf=Buffer.from('%PDF-1.7\nDemo test document\n%%EOF');
test('validates file type by actual content',()=>{
  assert.equal(validateFile({filename:'receipt.pdf',data_base64:pdf.toString('base64')}).error,undefined);
  assert.match(validateFile({filename:'receipt.jpg',data_base64:pdf.toString('base64')}).error,/соответствует/);
});
test('document belongs to an existing expense and is safely downloadable',async()=>{
  const file={filename:'Чек.pdf',data_base64:pdf.toString('base64')};
  const added=await request('POST','/api/expenses/'+expense+'/documents',founder,file);
  assert.equal(added.status,201,JSON.stringify(added.body));
  const copy=await request('POST','/api/expenses/'+expense+'/documents',founder,file);
  assert.equal(copy.status,200);
  assert.equal(copy.body.already_exists,true);
  const docs=await request('GET','/api/expenses/'+expense+'/documents',founder);
  assert.equal(docs.body.documents.length,1);
  const downloaded=await request('GET','/api/expense-documents/'+docs.body.documents[0].id+'/download',founder);
  assert.equal(downloaded.status,200);
  assert.deepEqual(downloaded.bytes,pdf);
  assert.equal(downloaded.headers['X-Content-Type-Options'],'nosniff');
  assert.ok(fs.existsSync(DOCUMENT_DIR));
});
test('deleting expense also removes private physical attachment',async()=>{
  const row=db.prepare('SELECT * FROM expense_documents WHERE expense_id=?').get(expense);
  assert.ok(fs.existsSync(path.join(DOCUMENT_DIR,row.storage_name)));
  const removed=await request('DELETE','/api/economics/expenses/'+expense,admin);
  assert.equal(removed.status,200);
  assert.equal(fs.existsSync(path.join(DOCUMENT_DIR,row.storage_name)),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM expense_documents').get().n,0);
});

test('private receipts are not accessible through another founder or a salon owner',async()=>{
  db.prepare('UPDATE business_founders SET login=?,password_hash=?,phone=?,active=1 WHERE id=?')
    .run('second-proof-owner',hashPassword('long-test-only-value'),'79131230002',2);
  const first=Number(db.prepare(
    'INSERT INTO expenses(expense_date,category,amount,investor_name,city_id) VALUES(?,?,?,?,?)'
  ).run('2026-11-04','Стойка',3000,'Лакомых Алексей','krsk').lastInsertRowid);
  const saved=await request('POST','/api/expenses/'+first+'/documents',founder,{
    filename:'receipt.pdf',data_base64:pdf.toString('base64'),
  });
  assert.equal(saved.status,201);
  const id=saved.body.document.id;
  const other=signToken({role:'founder',id:2});
  const salon=signToken({role:'owner',id:1});
  assert.equal((await request('GET','/api/expenses/'+first+'/documents',other)).status,404);
  assert.equal((await request('GET','/api/expense-documents/'+id+'/download',other)).status,404);
  assert.equal((await request('GET','/api/expense-documents/'+id+'/download',salon)).status,401);
  assert.equal((await request('DELETE','/api/expense-documents/'+id,other)).status,404);
  assert.equal((await request('GET','/api/expense-documents/'+id+'/download',admin)).status,200);
  const listing=await request('GET','/api/economics/expenses',admin);
  assert.equal(listing.body.expenses.find(x=>x.id===first).documents[0].filename,'receipt.pdf');
  assert.equal(listing.body.expenses.find(x=>x.id===first).documents[0].storage_name,undefined);
});
