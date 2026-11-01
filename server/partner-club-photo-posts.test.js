'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hm-club-photos-'));
process.env.DATA_DIR=temp;
process.env.TG_TOKEN='123456:fake-for-tests';
const db=require('./db');
const telegram=require('./telegram');
const club=require('./routes-partner-club');
const photos=require('./partner-club-photo-posts');

const ADMIN='789650001', GROUP='-1002525252525';
const fid=n=>'AgACAgIAAxkBAAI'+String(n).padStart(8,'0')+'abCDEFghijklmnop';
const adminId=Number(db.prepare(
 "INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role,active) VALUES (?,?,?,?,?,1)"
).run('photo-admin','hash','Модератор',ADMIN,'super').lastInsertRowid);
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)').run(
 JSON.stringify({chat_id:GROUP,enabled:false,reviewer_admin_id:adminId}));
const sent=[];
const originalText=telegram.sendToChat, originalPhotos=telegram.sendPhotosToChat;
telegram.sendToChat=async(chat,text,options={})=>{
 sent.push({chat:String(chat),kind:'text',text,options});
 return {ok:true,data:{ok:true}};
};
telegram.sendPhotosToChat=async(chat,images,caption,options={})=>{
 sent.push({chat:String(chat),kind:'photos',images:[...images],caption,options});
 return {ok:true,data:{ok:true}};
};
const event=id=>db.prepare('SELECT e.*,r.state AS review_state FROM partner_club_events e LEFT JOIN partner_club_reviews r ON r.event_id=e.id WHERE e.id=?').get(id);
const latest=()=>db.prepare("SELECT id FROM partner_club_events WHERE event_type='manual' ORDER BY id DESC LIMIT 1").get()?.id;
const groupSent=()=>sent.filter(m=>m.chat===GROUP);
const buttons=()=>sent.filter(m=>m.chat===ADMIN&&m.options?.reply_markup)
 .flatMap(m=>m.options.reply_markup.inline_keyboard.flat().map(b=>b.callback_data))
 .filter(Boolean);

test('only a linked club moderator can create posts or add photos',async()=>{
 assert.equal(club.startClubPost('999999').ok,false);
 assert.equal(club.startClubPost(ADMIN).ok,true);
 assert.equal(await club.handleClubPhotoMessage({chat:{id:'999999',type:'private'},photo:[{file_id:fid(1)}]}),null);
 assert.equal((await club.handleClubPhotoCallback('999999','club:done')).ok,false);
 assert.equal(await club.handleClubPhotoMessage({chat:{id:GROUP,type:'supergroup'},photo:[{file_id:fid(1)}]}),null);
 assert.equal(groupSent().length,0);
});
let textFirstId;
test('text first creates moderated draft with Add photos button',async()=>{
 const result=await club.handleClubPostInput(ADMIN,'🐾 Обновление клуба!\n\n**Фото новой стойки**');
 assert.equal(result.ok,true);
 textFirstId=latest();
 assert.equal(event(textFirstId).review_state,'pending');
 assert.equal(groupSent().length,0);
 assert.ok(buttons().includes('club:addphoto:'+textFirstId));
 assert.deepEqual(photos.getEventPhotos(textFirstId),[]);
 assert.match(sent.at(-1).text,/<b>Фото новой стойки<\/b>/);
});
test('two external photos are staged then previewed as one album, never sent to group early',async()=>{
 assert.equal((await club.handleClubPhotoCallback(ADMIN,'club:addphoto:'+textFirstId)).ok,true);
 const first=await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},media_group_id:'abc',
   photo:[{file_id:fid(2)}]});
 assert.equal(first.ok,true);
 const second=await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},media_group_id:'abc',
   photo:[{file_id:fid(3)}]});
 assert.equal(second.silent,true);
 assert.deepEqual(photos.getEventPhotos(textFirstId),[]);
 assert.equal((await club.handleClubCallback(ADMIN,'club:send:'+textFirstId)).ok,false);
 const ready=await club.handleClubPhotoCallback(ADMIN,'club:photosdone');
 assert.equal(ready.ok,true);
 assert.deepEqual(photos.getEventPhotos(textFirstId),[fid(2),fid(3)]);
 const album=sent.filter(x=>x.chat===ADMIN&&x.kind==='photos').at(-1);
 assert.deepEqual(album.images,[fid(2),fid(3)]);
 assert.match(album.caption,/<b>Фото новой стойки<\/b>/);
 assert.ok(buttons().includes('club:send:'+textFirstId));
 assert.equal(groupSent().length,0);
});
test('the approved album is delivered to the group only once',async()=>{
 const result=await club.handleClubCallback(ADMIN,'club:send:'+textFirstId);
 assert.equal(result.ok,true);
 assert.equal(groupSent().length,1);
 assert.equal(groupSent()[0].kind,'photos');
 assert.deepEqual(groupSent()[0].images,[fid(2),fid(3)]);
 assert.match(groupSent()[0].caption,/<b>Фото новой стойки<\/b>/);
 assert.equal(event(textFirstId).review_state,'sent');
 assert.equal((await club.handleClubCallback(ADMIN,'club:send:'+textFirstId)).ok,false);
 assert.equal(groupSent().length,1);
});
test('photo-first album with rich Telegram caption is previewed before publication',async()=>{
 assert.equal(club.startClubPost(ADMIN).ok,true);
 const first=await club.handleClubPhotoMessage({
  chat:{id:ADMIN,type:'private'},media_group_id:'def',photo:[{file_id:fid(4)}],
  caption:'🎉 Новинка! Ждём вас в клубе',
  caption_entities:[{type:'bold',offset:3,length:8}],
 });
 assert.equal(first.ok,true);
 assert.match(first.reply_markup.inline_keyboard.flat()[0].callback_data,/club:done/);
 assert.equal((await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},
   media_group_id:'def',photo:[{file_id:fid(5)}]})).silent,true);
 const made=await club.handleClubPhotoCallback(ADMIN,'club:done');
 assert.equal(made.ok,true);
 const id=latest();
 assert.deepEqual(photos.getEventPhotos(id),[fid(4),fid(5)]);
 assert.equal(event(id).review_state,'pending');
 assert.match(sent.filter(x=>x.chat===ADMIN&&x.kind==='photos').at(-1).caption,/<b>/);
 assert.equal(groupSent().length,1);
 assert.equal((await club.handleClubCallback(ADMIN,'club:send:'+id)).ok,true);
 assert.equal(groupSent().length,2);
});
test('photo-first with no caption asks for text and uses single-photo preview',async()=>{
 assert.equal(club.startClubPost(ADMIN).ok,true);
 await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},photo:[{file_id:fid(6)}]});
 const result=await club.handleClubPhotoCallback(ADMIN,'club:done');
 assert.equal(result.ok,false);
 assert.match(result.message,/Пришлите текст/);
 assert.equal(photos.currentPhotoDraft(ADMIN).photos.length,1);
 const created=await club.handleClubPostInput(ADMIN,'📷 Фото из телефона');
 assert.equal(created.ok,true);
 const id=latest();
 assert.deepEqual(photos.getEventPhotos(id),[fid(6)]);
 const single=sent.filter(x=>x.chat===ADMIN&&x.kind==='photos').at(-1);
 assert.equal(single.images.length,1);
 assert.ok(single.options.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='club:send:'+id));
 assert.equal(groupSent().length,2);
});
test('staging cancellation does not change previously attached photos',async()=>{
 const id=latest();
 assert.equal((await club.handleClubPhotoCallback(ADMIN,'club:addphoto:'+id)).ok,true);
 await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},photo:[{file_id:fid(7)}]});
 assert.equal((await club.handleClubPhotoCallback(ADMIN,'club:cancelphotos')).ok,true);
 assert.deepEqual(photos.getEventPhotos(id),[fid(6)]);
 assert.equal(event(id).review_state,'pending');
 assert.equal((await club.handleClubPhotoCallback(ADMIN,'club:clearphotos:'+id)).ok,true);
 assert.deepEqual(photos.getEventPhotos(id),[]);
});
test('limits block more than ten images and overly long photo text',async()=>{
 club.startClubPost(ADMIN);
 for(let i=10;i<20;i++){
   const result=await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},
     photo:[{file_id:fid(i)}]});
   assert.equal(result.ok,true);
 }
 const error=await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},
   photo:[{file_id:fid(20)}]});
 assert.equal(error.ok,false);
 assert.match(error.message,/10 фотографий/);
 assert.equal(photos.currentPhotoDraft(ADMIN).photos.length,10);
 const long=await club.handleClubPostInput(ADMIN,'X'.repeat(851));
 assert.equal(long.ok,false);
 assert.equal(club.cancelClubInput(ADMIN),true);
});
test('photo transport uses sendPhoto and sendMediaGroup JSON, without uploads to site',async()=>{
 const saved=global.fetch, requests=[];
 try {
  global.fetch=async(url,options)=>{
   requests.push({url,body:JSON.parse(options.body)});
   return {ok:true,status:200,json:async()=>({ok:true})};
  };
  assert.equal((await originalPhotos(ADMIN,[fid(1)],'<b>Фото</b>',{
   reply_markup:{inline_keyboard:[[{text:'Да',callback_data:'club:send:99'}]]},
  })).ok,true);
  assert.equal((await originalPhotos(GROUP,[fid(1),fid(2)],'<b>Альбом</b>')).ok,true);
  assert.match(requests[0].url,/\/sendPhoto$/);
  assert.equal(requests[0].body.photo,fid(1));
  assert.equal(requests[0].body.parse_mode,'HTML');
  assert.equal(requests[0].body.reply_markup.inline_keyboard[0][0].text,'Да');
  assert.match(requests[1].url,/\/sendMediaGroup$/);
  assert.deepEqual(requests[1].body.media.map(m=>m.media),[fid(1),fid(2)]);
  assert.equal(requests[1].body.media[0].caption,'<b>Альбом</b>');
  assert.equal(requests[1].body.media[1].caption,undefined);
 } finally{global.fetch=saved;}
});
test('poller processes photo messages before the text-only guard',()=>{
 const code=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
 assert.match(code,/handleClubPhotoMessage\(msg\)/);
 assert.match(code,/handleClubPhotoCallback\(chat.id,callback.data\)/);
 const offset=code.indexOf('handleClubPhotoMessage(msg)');
 assert.ok(offset>=0&&offset<code.indexOf('if (!msg.text) return;',offset));
});
test.after(()=>{
 telegram.sendToChat=originalText;
 telegram.sendPhotosToChat=originalPhotos;
 try{db.close();}catch(_){}
 fs.rmSync(temp,{recursive:true,force:true});
});


test('manual photo post can be edited while keeping its gallery and review buttons',async()=>{
 const id=latest();
 // The most recent draft had its photos cleared in a previous test.
 await club.handleClubPhotoCallback(ADMIN,'club:addphoto:'+id);
 await club.handleClubPhotoMessage({chat:{id:ADMIN,type:'private'},photo:[{file_id:fid(21)}]});
 assert.equal((await club.handleClubPhotoCallback(ADMIN,'club:photosdone')).ok,true);
 const before=photos.getEventPhotos(id);
 assert.equal((await club.handleClubCallback(ADMIN,'club:edit:'+id)).ok,true);
 const edited=await club.handleClubPostInput(ADMIN,'**Изменённый текст с фотографией**');
 assert.equal(edited.ok,true);
 assert.deepEqual(photos.getEventPhotos(id),before);
 assert.match(sent.filter(x=>x.kind==='photos'&&x.chat===ADMIN).at(-1).caption,
   /<b>Изменённый текст с фотографией<\/b>/);
 assert.ok(buttons().includes('club:send:'+id));
});
