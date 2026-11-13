'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-telegram-edit-'));
process.env.TG_TOKEN = 'test-edit-token';
const db = require('./db');
const poller = require('./telegram-login-poller');
// Partner Club owns its settings table; initialize it before configuring a group.
require('./routes-partner-club');

const ADMIN = 91700201;
const STRANGER = 91700299;
const GROUP = -100260001;
const BOT = 991122;
const adminRow = db.prepare(
  "INSERT INTO admins(login,password_hash,role,active,telegram_chat_id) VALUES (?,?,?,?,?)"
).run('telegram-message-editor','hash','super',1,String(ADMIN));
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)')
  .run(JSON.stringify({chat_id:String(GROUP), enabled:true, reviewer_admin_id:Number(adminRow.lastInsertRowid)}));

const requests = [];
let dmBlocked = false;
let editError = '';
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const method = String(url).split('/').pop();
  const body = options.body ? JSON.parse(options.body) : {};
  requests.push({ method, body });
  if ((method === 'sendMessage' && String(body.chat_id) === String(ADMIN) && dmBlocked) ||
      (method.startsWith('editMessage') && editError)) {
    return {
      ok: false, status: 400,
      json: async () => ({ok:false, description:editError || 'Forbidden: bot was blocked by the user'})
    };
  }
  const result = method === 'getMe' ? { id: BOT, username: 'HvostMarketRusBot' } : true;
  return { ok: true, status: 200, json: async () => ({ok:true,result}) };
};

const calls = method => requests.filter(r => r.method === method);
const drafts = () => db.prepare('SELECT * FROM telegram_message_edit_drafts WHERE editor_chat_id=?').get(String(ADMIN));
async function groupEdit(options = {}) {
  const { sender = ADMIN, group = GROUP, bot = BOT, caption = null } = options;
  await poller.processUpdate({message:{
    message_id: 900,
    chat: { id: group, type: 'supergroup' },
    from: { id: sender },
    text: '/edit',
    reply_to_message: {
      message_id: 850,
      from: { id: bot, is_bot: true },
      ...(caption === null ? { text: 'Исходный текст' } : { caption, photo:[{file_id:'example'}] })
    }
  }});
}
async function privateText(text, options = {}) {
  const { sender = ADMIN, entities = [] } = options;
  await poller.processUpdate({message:{
    message_id: 901,
    chat: {id:ADMIN,type:'private'},
    from: {id:sender},
    text, entities
  }});
}

test('admin can edit a bot text in the configured group; rich formatting is safe', async () => {
  requests.length = 0;
  await groupEdit();
  assert.equal(calls('getMe').length, 1);
  assert.ok(calls('sendMessage').some(r => r.body.chat_id === ADMIN));
  assert.deepEqual([drafts().target_chat_id,drafts().target_message_id,drafts().target_kind],
    [String(GROUP),850,'text']);

  await privateText('Отлично <3!', {entities:[{type:'bold',offset:0,length:8}]});
  assert.equal(calls('editMessageText').length, 1);
  assert.deepEqual(calls('editMessageText')[0].body, {
    chat_id:String(GROUP),message_id:850,parse_mode:'HTML',
    text:'<b>Отлично </b>&lt;3!'
  });
  assert.equal(drafts(), undefined);
});

test('a bot photo caption can be edited; excessive caption length keeps the draft', async () => {
  requests.length = 0;
  await groupEdit({caption:'Подпись фото'});
  assert.equal(drafts().target_kind, 'caption');
  await privateText('А'.repeat(1025));
  assert.equal(calls('editMessageCaption').length,0);
  assert.ok(drafts());
  await privateText('🐾 Новый текст');
  assert.equal(calls('editMessageCaption').length,1);
  assert.equal(calls('editMessageCaption')[0].body.caption,'🐾 Новый текст');
  assert.equal(drafts(),undefined);
});

test('unauthorized users, different groups, and other bots cannot open an edit', async () => {
  requests.length = 0;
  await groupEdit({sender:STRANGER});
  await groupEdit({group:-100999});
  await groupEdit({bot:BOT+1});
  assert.equal(calls('editMessageText').length,0);
  assert.equal(calls('sendMessage').filter(r => r.body.chat_id === ADMIN).length,0);
  assert.equal(drafts(),undefined);
});

test('cannot start an edit when private bot messages are blocked', async () => {
  requests.length=0;
  dmBlocked=true;
  await groupEdit();
  dmBlocked=false;
  assert.equal(drafts(),undefined);
  assert.ok(calls('sendMessage').some(r => r.body.chat_id === GROUP));
});

test('Telegram failure preserves draft; /cancel clears it without changing a post', async () => {
  requests.length=0;
  await groupEdit();
  editError='Bad Request: message text is invalid';
  await privateText('Попробовать');
  editError='';
  assert.ok(drafts());
  await privateText('/cancel');
  assert.equal(drafts(),undefined);
  assert.equal(calls('editMessageText').length,1);
});

test('revoked administrator cannot submit a stale edit', async () => {
  requests.length=0;
  await groupEdit();
  db.prepare("UPDATE admins SET active=0 WHERE telegram_chat_id=?").run(String(ADMIN));
  await privateText('Текст после отзыва доступа');
  assert.equal(calls('editMessageText').length,0);
  assert.equal(drafts(),undefined);
  db.prepare("UPDATE admins SET active=1 WHERE telegram_chat_id=?").run(String(ADMIN));
});

test.after(() => { global.fetch = originalFetch; });
