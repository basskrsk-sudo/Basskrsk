'use strict';

// MAX Mini App: read-only storefront + independently authorized staff cabinets.
// A signed MAX launch identifies only the platform user. Staff sessions require
// a separately signed OWN phone from MAX Bridge or the official bot contact.
// No guessed phone, no account creation and no SMS.
const crypto = require('node:crypto');
const { sendJson } = require('./http-utils');
const db = require('./db');
const { signToken } = require('./auth');
const { normalizeRussianPhone, hasLinkedGroomerOwner } = require('./miniapp-phone-identity');

const PHONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const CONTACT_TTL_SECONDS = 10 * 60;
const STAFF_ROLES = Object.freeze(['partner','owner','manager','admin']);

// Keep MAX proof separate from Telegram identity, and do not store MAX secrets.
db.exec(`
  CREATE TABLE IF NOT EXISTS max_miniapp_verified_phones (
    max_user_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    chat_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_max_miniapp_verified_phones_time
    ON max_miniapp_verified_phones(verified_at);
`);


const MAX_AGE_SECONDS = 60 * 60;
const FUTURE_SKEW_SECONDS = 60;
const MAX_DATA_LENGTH = 12 * 1024;
const MAX_PARAMS = 32;
const USER_ID_RE = /^[1-9]\d{0,19}$/;

function normalizeMaxId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && USER_ID_RE.test(value)) return value;
  return null;
}

function verifyMaxInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!botToken || typeof botToken !== 'string' ||
      typeof initData !== 'string' || !initData || initData.length > MAX_DATA_LENGTH) return null;

  try {
    const entries = [...new URLSearchParams(initData).entries()];
    if (entries.length < 3 || entries.length > MAX_PARAMS) return null;

    const values = new Map();
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_]*$/i.test(key) || values.has(key)) return null;
      values.set(key, value);
    }
    const hash = values.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

    const authText = values.get('auth_date');
    if (!/^\d{10,11}$/.test(authText || '')) return null;
    const authDate = Number(authText);
    if (!Number.isSafeInteger(authDate) ||
        authDate > nowSeconds + FUTURE_SKEW_SECONDS ||
        nowSeconds - authDate > MAX_AGE_SECONDS) return null;

    const payload = [...values.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => key + '=' + value)
      .join('\n');
    // MAX official algorithm: HMAC(key='WebAppData', message=BOT_TOKEN)
    // then HMAC(key=secret, message=sorted launch parameters).
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const actual = crypto.createHmac('sha256', secret).update(payload).digest();
    const expected = Buffer.from(hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    const user = JSON.parse(values.get('user') || 'null');
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    const id = normalizeMaxId(user.id);
    if (!id) return null;
    const safeName = input => typeof input === 'string' ?
      input.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
    const signedChat = JSON.parse(values.get('chat') || 'null');
    const chatId = signedChat && signedChat.type === 'DIALOG'
      ? normalizeMaxId(signedChat.id) : null;
    return {
      id,
      first_name: safeName(user.first_name),
      last_name: safeName(user.last_name),
      chat_id: chatId,
    };
  } catch (_) {
    return null;
  }
}


function normalizeVerifiedMaxPhone(raw) {
  const phone = normalizeRussianPhone(raw);
  return phone && /^79\d{9}$/.test(phone) ? phone : null;
}

function verifyMaxBridgeContact(contact, user, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!user || !normalizeMaxId(user.id) || !botToken || !contact ||
      typeof contact !== 'object' || Array.isArray(contact)) return null;
  const { phone, authDate, hash } = contact;
  if (typeof phone !== 'string' || phone.length < 10 || phone.length > 40 ||
      typeof authDate !== 'string' || !/^\d{10}(?:\d{3})?$/.test(authDate) ||
      typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  const verifiedPhone = normalizeVerifiedMaxPhone(phone);
  if (!verifiedPhone) return null;
  const authValue = Number(authDate);
  const authSeconds = authDate.length === 13 ? Math.floor(authValue / 1000) : authValue;
  if (!Number.isSafeInteger(authSeconds) ||
      authSeconds > nowSeconds + FUTURE_SKEW_SECONDS ||
      nowSeconds - authSeconds > CONTACT_TTL_SECONDS) return null;
  // MAX Bridge requestContact: HMAC over alphabetically sorted key=value
  // pairs, with phone WITHOUT a leading "+". NOT the initData HMAC.
  const signedPhone = phone.startsWith('+') ? phone.slice(1) : phone;
  const message = ['authDate=' + authDate,'phone=' + signedPhone,
    'userId=' + String(user.id)].join('\n');
  const expected = crypto.createHmac('sha256',botToken)
    .update(message).digest();
  const actual = Buffer.from(hash,'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) return null;
  return verifiedPhone;
}

function recordVerifiedMaxBridgePhone(userId, phone, chatId = null, now = Math.floor(Date.now() / 1000)) {
  const id = normalizeMaxId(userId), normalized = normalizeVerifiedMaxPhone(phone);
  const verifiedChat = normalizeMaxId(chatId);
  if (!id || !normalized) return false;
  // Keep previous bot chat binding only for the same verified phone.
  db.prepare(
    'INSERT INTO max_miniapp_verified_phones(max_user_id,phone,verified_at,chat_id) VALUES(?,?,?,?) '+
    'ON CONFLICT(max_user_id) DO UPDATE SET phone=excluded.phone,verified_at=excluded.verified_at,'+
    'chat_id=CASE WHEN excluded.chat_id IS NOT NULL THEN excluded.chat_id '+
    'WHEN phone=excluded.phone THEN chat_id ELSE NULL END'
  ).run(id,normalized,now,verifiedChat);
  return true;
}

function recordVerifiedMaxBotContact(userId, chatId, phone, now = Math.floor(Date.now() / 1000)) {
  const id = normalizeMaxId(userId), chat = normalizeMaxId(chatId);
  const normalized = normalizeVerifiedMaxPhone(phone);
  if (!id || !chat || !normalized) return false;
  db.prepare(
    'INSERT INTO max_miniapp_verified_phones(max_user_id,phone,verified_at,chat_id) VALUES(?,?,?,?) '+
    'ON CONFLICT(max_user_id) DO UPDATE SET phone=excluded.phone,verified_at=excluded.verified_at,chat_id=excluded.chat_id'
  ).run(id,normalized,now,chat);
  return true;
}

function verifiedMaxPhone(userId, now = Math.floor(Date.now() / 1000)) {
  const id = normalizeMaxId(userId);
  if (!id) return null;
  const row = db.prepare(
    'SELECT phone,chat_id,verified_at FROM max_miniapp_verified_phones WHERE max_user_id=?'
  ).get(id);
  if (!row || row.verified_at > now + FUTURE_SKEW_SECONDS ||
      row.verified_at + PHONE_TTL_SECONDS < now) return null;
  const phone = normalizeVerifiedMaxPhone(row.phone);
  return phone ? {phone,chatId:row.chat_id ? String(row.chat_id) : null} : null;
}

function maxRoleMatches(role, verified) {
  const phone = verified.phone, chatId = verified.chatId;
  let rows;
  if (role === 'partner') {
    rows = db.prepare('SELECT id,login,full_name,phone,active,max_chat_id,point_id FROM partners WHERE active=1 AND phone_last10=? LIMIT 16').all(phone.slice(-10));
  } else if (role === 'owner') {
    rows = db.prepare('SELECT id,login,full_name,phone,active,max_chat_id,point_id,groomer_partner_id FROM salon_owners WHERE active=1').all();
  } else if (role === 'manager') {
    rows = db.prepare('SELECT id,login,full_name,phone,active,max_chat_id FROM managers WHERE active=1').all();
  } else if (role === 'admin') {
    rows = db.prepare('SELECT id,login,full_name,phone,active,max_chat_id,role,miniapp_auth_version FROM admins WHERE active=1 AND phone IS NOT NULL').all();
  } else return {allowed:[],ambiguous:false};
  const samePhone = rows.filter(row => normalizeVerifiedMaxPhone(row.phone) === phone);
  if (samePhone.length > 1) return {allowed:[],ambiguous:true};
  const allowed = samePhone.filter(row =>
    !row.max_chat_id || (chatId && String(row.max_chat_id) === chatId)
  ).map(row => ({
    role,id:row.id,login:row.login,name:row.full_name||row.login,
    ...(role === 'admin' ? {adminRole:row.role,miniappAuthVersion:Number(row.miniapp_auth_version || 0)} : {}),
  }));
  return {allowed,ambiguous:false};
}

function availableMaxStaffAccounts(userId, now = Math.floor(Date.now() / 1000)) {
  const verified = verifiedMaxPhone(userId, now);
  if (!verified) return {verified:false,phoneMasked:'',accounts:[],ambiguousRoles:[],combinedSalon:false};
  const accounts=[],ambiguousRoles=[];
  for (const role of STAFF_ROLES) {
    const result = maxRoleMatches(role,verified);
    if (result.ambiguous) ambiguousRoles.push(role);
    else accounts.push(...result.allowed);
  }
  return {
    verified:true,
    phoneMasked:'+7 (***) ***-**-'+verified.phone.slice(-2),
    accounts,ambiguousRoles,combinedSalon:hasLinkedGroomerOwner(accounts),
    preferredRole:accounts.length===1 ? accounts[0].role : null,
  };
}

function issueMaxStaffSession(userId, role, now = Math.floor(Date.now() / 1000)) {
  if (!STAFF_ROLES.includes(role)) return null;
  const state=availableMaxStaffAccounts(userId,now);
  if (!state.verified || state.ambiguousRoles.includes(role)) return null;
  const account=state.accounts.find(x=>x.role===role);
  if (!account)return null;
  // Re-evaluate on every request. Admin JWT also carries its revocation version.
  const token=signToken({
    role,id:account.id,login:account.login,
    ...(role==='admin'?{
      adminRole:account.adminRole,
      miniappAuthVersion:account.miniappAuthVersion,
    }:{}),
  });
  return {
    token,role,
    account:{name:account.name,login:account.login,adminRole:account.adminRole||null},
  };
}

function registerMaxMiniAppRoutes(router, { token = () => process.env.MAX_BOT_TOKEN, rewardReports = require('./max-reward-reports').createMaxRewardReports(db) } = {}) {
  router.post('/api/max/miniapp/verify', (req, res, ctx) => {
    res.setHeader?.('Cache-Control', 'no-store');
    const botToken = token();
    if (!botToken) return sendJson(res, 503, { error: 'MAX временно не настроен' });
    const input = ctx.body && ctx.body.init_data;
    if (typeof input !== 'string' || !input || input.length > MAX_DATA_LENGTH) {
      return sendJson(res, 400, { error: 'Отсутствуют данные запуска MAX' });
    }
    const user = verifyMaxInitData(input, botToken);
    if (!user) return sendJson(res, 401, { error: 'Подтверждение MAX не прошло. Откройте приложение из бота повторно.' });
    // The signed MAX identity alone never reveals staff accounts.
    sendJson(res, 200, {
      verified: true, user, mode: 'staff_and_catalog', checkout_enabled: false,
    });
  });

  function signedMaxUser(ctx,res) {
    res.setHeader?.('Cache-Control','no-store');
    const botToken=token();
    if (!botToken) {
      sendJson(res,503,{error:'MAX временно не настроен'});
      return null;
    }
    const user=verifyMaxInitData(ctx.body&&ctx.body.init_data,botToken);
    if(!user) {
      sendJson(res,401,{error:'Откройте мини-приложение заново через MAX'});
      return null;
    }
    return user;
  }

  // A payout report contains private partner data. Require a current admin
  // JWT AND the signed MAX identity/own phone in that same private dialog.
  // Never reuse a phone-matched chat from another account or accept a target
  // user/chat from the request body. Revalidate before every outbound send.
  function reportAdmin(req,res,ctx){
    const user=signedMaxUser(ctx,res);
    if(!user)return null;
    const claims=require('./routes-auth').requireActiveAdmin(req,res,ctx);
    if(!claims)return null;
    const authorize=()=>{
      const verified=verifiedMaxPhone(user.id);
      const current=verified&&maxRoleMatches('admin',verified);
      if(!user.chat_id||!verified?.chatId||verified.chatId!==user.chat_id||
          !current||current.ambiguous||!current.allowed.some(a=>a.id===claims.id))
        throw Object.assign(new Error('Для отчётов откройте личный чат с ботом MAX и заново подтвердите номер администратора.'),{statusCode:403,publicMessage:true});
      const latest=db.prepare('SELECT active,role,miniapp_auth_version FROM admins WHERE id=?').get(claims.id);
      if(!latest||Number(latest.active)!==1||
          (claims.adminRole&&latest.role!==claims.adminRole)||
          (Object.hasOwn(claims,'miniappAuthVersion')&&Number(latest.miniapp_auth_version||0)!==Number(claims.miniappAuthVersion)))
        throw Object.assign(new Error('Доступ администратора изменён. Войдите заново.'),{statusCode:403,publicMessage:true});
    };
    try{authorize();}catch(error){sendJson(res,error.statusCode||403,{error:error.message});return null;}
    return {userId:user.id,token:token(),authorize};
  }
  function reportError(res,error){
    // Do not expose private document data, upload URLs or access tokens.
    const code=Number(error.statusCode);
    if(code>=400&&code<=599&&error.publicMessage)return sendJson(res,code,{error:error.message});
    if(code===400||code===404)return sendJson(res,code,{error:'Проверьте получателя и период отчёта (не более 367 дней).'});
    console.warn('[max-reward-report] export failed',error.name||'Error');
    return sendJson(res,502,{error:'Не удалось подтвердить отправку PDF в MAX. Проверьте личный чат с ботом перед повтором.'});
  }
  router.post('/api/max/miniapp/reward-reports/options',(req,res,ctx)=>{
    const access=reportAdmin(req,res,ctx);if(!access)return;
    try{sendJson(res,200,rewardReports.options(ctx.body));}
    catch(error){reportError(res,error);}
  });
  router.post('/api/max/miniapp/reward-reports/send',async(req,res,ctx)=>{
    const access=reportAdmin(req,res,ctx);if(!access)return;
    try{sendJson(res,200,await rewardReports.send(ctx.body,access));}
    catch(error){reportError(res,error);}
  });

  router.post('/api/max/miniapp/accounts',(req,res,ctx)=>{
    const user=signedMaxUser(ctx,res);
    if(!user)return;
    const state=availableMaxStaffAccounts(user.id);
    sendJson(res,200,{
      verified:state.verified,
      phone_masked:state.phoneMasked,
      accounts:state.accounts.map(a=>({role:a.role,name:a.name})),
      ambiguous_roles:state.ambiguousRoles,
      combined_salon:state.combinedSalon,
      preferred_role:state.preferredRole,
    });
  });

  router.post('/api/max/miniapp/verify-phone',(req,res,ctx)=>{
    const user=signedMaxUser(ctx,res);
    if(!user)return;
    const phone=verifyMaxBridgeContact(
      ctx.body && ctx.body.contact,user,token()
    );
    if(!phone)return sendJson(res,403,{
      error:'Не удалось подтвердить ваш номер через MAX. Откройте мини-приложение в MAX и повторите запрос.',
    });
    recordVerifiedMaxBridgePhone(user.id,phone,user.chat_id);
    const state=availableMaxStaffAccounts(user.id);
    return sendJson(res,200,{
      verified:true,
      phone_masked:state.phoneMasked,
      accounts:state.accounts.map(a=>({role:a.role,name:a.name})),
      ambiguous_roles:state.ambiguousRoles,
      combined_salon:state.combinedSalon,
      preferred_role:state.preferredRole,
    });
  });

  router.post('/api/max/miniapp/session',(req,res,ctx)=>{
    const user=signedMaxUser(ctx,res);
    if(!user)return;
    const role=ctx.body && ctx.body.role;
    if(!STAFF_ROLES.includes(role)){
      return sendJson(res,400,{error:'Некорректная роль'});
    }
    const result=issueMaxStaffSession(user.id,role);
    if(!result)return sendJson(res,403,{
      error:'Нет подтверждённого доступа к этому кабинету. Проверьте номер MAX и привязку аккаунта.',
    });
    sendJson(res,200,result);
  });
}

module.exports = {
  verifyMaxInitData, verifyMaxBridgeContact,
  recordVerifiedMaxBotContact, verifiedMaxPhone,
  availableMaxStaffAccounts, issueMaxStaffSession,
  registerMaxMiniAppRoutes, MAX_AGE_SECONDS,
};
