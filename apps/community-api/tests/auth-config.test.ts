import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {readConfig} from '../src/config.js';

test('CloudBase is the startup default and missing configuration never selects local auth',()=>{
  const base={COMMUNITY_DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55432/fixture',COMMUNITY_ENCRYPTION_KEY:randomBytes(32).toString('base64url')};
  const absent=readConfig(base);assert.equal(absent.authProvider,'cloudbase');assert.equal(absent.cloudbase,undefined);
  const configured=readConfig({...base,COMMUNITY_CLOUDBASE_ENV_ID:'fixture-env-123'});assert.equal(configured.cloudbase?.environment,'fixture-env-123');assert.equal(configured.cloudbase?.region,'ap-shanghai');
  assert.equal(readConfig({...base,COMMUNITY_AUTH_PROVIDER:'local'}).authProvider,'local');
  assert.throws(()=>readConfig({...base,COMMUNITY_AUTH_PROVIDER:'automatic'}));
  for(const invalid of ['https://attacker.example/','../env','env.example/path','env@host'])assert.throws(()=>readConfig({...base,COMMUNITY_CLOUDBASE_ENV_ID:invalid}));
});

test('RSS DNS is an explicit fixed resolver choice and never an arbitrary endpoint',()=>{
  const base={COMMUNITY_DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55432/fixture',COMMUNITY_ENCRYPTION_KEY:randomBytes(32).toString('base64url')};
  assert.equal(readConfig(base).newsDnsMode,'system');assert.equal(readConfig({...base,COMMUNITY_RSS_DNS:'alidns'}).newsDnsMode,'alidns');
  for(const invalid of ['https://attacker.example/resolve','localhost','proxy','198.18.0.1'])assert.throws(()=>readConfig({...base,COMMUNITY_RSS_DNS:invalid}));
});
