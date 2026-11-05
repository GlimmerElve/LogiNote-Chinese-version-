import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AuthService} from '../src/auth.js';
import {createTestDatabase} from './helpers.js';

test('operator assigns only the explicit community UUID and revokes all its hosted credentials',async()=>{
  const fixture=await createTestDatabase('hosted_operator');
  try{
    const auth=new AuthService(fixture.db,{encryptionKey:fixture.encryptionKey},{configured:false,async send(){return 'not_configured';}});
    const email='same-email@operator.example.test';
    const local=await auth.register({email,password:'Synthetic local password 123!'});
    const cloud=await auth.issueExternalSession({provider:'cloudbase',environment:'operator-fixture',subject:'provider-sub-not-community-uuid',email,emailVerified:true});
    await fixture.db.query('INSERT INTO hosted_sessions(session_id,environment,subject,credentials_ciphertext,access_expires_at) SELECT id,$2,$3,$4,now()+interval \'1 hour\' FROM sessions WHERE account_id=$1',[cloud.account.id,'operator-fixture','provider-sub-not-community-uuid','synthetic-unread-ciphertext']);
    const cwd=fileURLToPath(new URL('apps/community-api/',fixture.root)),shim=fileURLToPath(new URL('scripts/node-os-userinfo-fallback.cjs',fixture.root));
    const cli=async(args:string[])=>{
      const child=spawn(process.execPath,['--require',shim,'--import','tsx','src/operator.ts',...args],{cwd,env:{...process.env,COMMUNITY_DATABASE_URL:fixture.url,COMMUNITY_ENCRYPTION_KEY:fixture.encryptionKey,COMMUNITY_AUTH_PROVIDER:'cloudbase'},windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();return {status:await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),output};
    };
    assert.equal((await cli(['grant-admin','--email',email])).status,1);
    const grant=await cli(['grant-admin','--account-id',cloud.account.id]);assert.equal(grant.status,0);assert.equal(JSON.parse(grant.output).accountId,cloud.account.id);
    assert.equal((await fixture.db.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[cloud.account.id])).rows[0].role,'administrator');
    assert.equal((await fixture.db.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[local.account.id])).rows[0].role,'member');
    assert.equal(await auth.lookup(cloud.sessionToken),null);assert.equal((await fixture.db.query('SELECT * FROM hosted_sessions')).rows.length,0);
    assert.equal((await cli(['revoke-admin','--account-id',cloud.account.id])).status,0);
    assert.equal((await fixture.db.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[cloud.account.id])).rows[0].role,'member');
    assert.equal((await fixture.db.query('SELECT * FROM operator_audit WHERE target_account_id=$1',[cloud.account.id])).rows.length,2);
  }finally{await fixture.cleanup();}
});
