'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {hashPassword,verifyPasswordAsync,verifyPassword}=require('./auth');

test('non-blocking password verification accepts existing scrypt hashes',async()=>{
  const hash=hashPassword('safe-password');
  assert.equal(verifyPassword('safe-password',hash),true);
  assert.equal(await verifyPasswordAsync('safe-password',hash),true);
  assert.equal(await verifyPasswordAsync('wrong-password',hash),false);
  assert.equal(await verifyPasswordAsync('safe-password','not-a-valid-hash'),false);
  assert.equal(await verifyPasswordAsync('safe-password','aabb:99'),false);
});

test('scrypt work runs asynchronously without blocking the event loop',async()=>{
  const hash=hashPassword('event-loop-test');
  const verifying=verifyPasswordAsync('event-loop-test',hash);
  let executed=false;
  await new Promise(resolve=>setImmediate(()=>{executed=true;resolve();}));
  assert.equal(executed,true);
  assert.equal(await verifying,true);
});
