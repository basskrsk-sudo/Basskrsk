'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sendMaxRewardFile,MAX_BYTES}=require('./max-reward-report-file');
const args={userId:'12345678',token:'test-secret',pdf:Buffer.from('%PDF-test'),filename:'report.pdf',caption:'test report'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test('MAX uploads multipart PDF then sends file only to authenticated user, retries only explicit not-ready',async()=>{
 const calls=[],delays=[];
 let attempts=0,checks=0;
 const request=async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/uploads?type=file'))return json({url:'https://vu.mycdn.me/upload.do?sig=test'});
  if(url.includes('vu.mycdn.me')){
    assert.equal(options.headers,undefined);
    assert.equal(options.redirect,'error');
    const file=options.body.get('data');assert.equal(file.name,'report.pdf');assert.equal(file.type,'application/pdf');
    assert.equal(await file.text(),'%PDF-test');return json({token:'attachment-token'});
  }
  assert.equal(url,'https://platform-api2.max.ru/messages?user_id=12345678');
  assert.equal(options.headers.Authorization,'test-secret');
  assert.deepEqual(JSON.parse(options.body),{text:'test report',attachments:[{type:'file',payload:{token:'attachment-token'}}]});
  if(++attempts===1)return json({code:'attachment.not.ready'},400);
  return json({message:{body:{mid:'mid.1',attachments:[{type:'file'}]}}});
 };
 const result=await sendMaxRewardFile({...args,authorize:()=>checks++},{request,sleep:async ms=>delays.push(ms)});
 assert.equal(result.messageId,'mid.1');assert.equal(calls.length,4);assert.deepEqual(delays,[500]);assert.equal(checks,4);
});
test('reject untrusted protocol, oversized files, missing file confirmation and ambiguous failure without repeated send',async()=>{
 let calls=0;
 await assert.rejects(()=>sendMaxRewardFile({...args,pdf:Buffer.alloc(MAX_BYTES+1)},{request:async()=>{calls++;}}),{statusCode:413});
 assert.equal(calls,0);
 await assert.rejects(()=>sendMaxRewardFile(args,{request:async()=>{calls++;return json({url:'http://example.test/'});}}),{statusCode:502});
 assert.equal(calls,1);
 calls=0;
 const request=async(url)=>{calls++;if(url.includes('/uploads'))return json({url:'https://vu.mycdn.me/file'});
 if(url.includes('vu.mycdn.me'))return json({token:'t'});
 return json({message:{body:{mid:'mid-no-file'}}});};
 await assert.rejects(()=>sendMaxRewardFile(args,{request}),{statusCode:502});assert.equal(calls,3);
 calls=0;
 await assert.rejects(()=>sendMaxRewardFile(args,{request:async url=>{calls++;if(url.includes('/uploads'))return json({url:'https://vu.mycdn.me/file'});
 if(url.includes('vu.mycdn.me'))return json({token:'t'});throw Error('timeout');}}),/timeout/);
 assert.equal(calls,3);
});
