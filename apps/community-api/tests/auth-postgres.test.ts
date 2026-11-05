import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthService,type Mailer,type MailMessage} from '../src/auth.js';
import {ApiError} from '../src/errors.js';
import {totpAt} from '../src/security.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;

test('authentication lifecycle against isolated PostgreSQL schema',async t=>{
  let database:Awaited<ReturnType<typeof createTestDatabase>>;
  try{database=await createTestDatabase('auth_test');}catch(error){const missing=error as NodeJS.ErrnoException;if(missing.code==='ENOENT'&&missing.path?.endsWith('runtime.json')){t.skip('No isolated PostgreSQL test configuration.');return;}throw error;}
  const {db,encryptionKey:key}=database,mail:MailMessage[]=[];
  const mailer:Mailer={configured:true,async send(message){mail.push(message);return 'sent';}};
  let now=new Date('2026-10-23T00:00:00Z');
  const auth=new AuthService(db,{encryptionKey:key,sessionTtlMs:60*60000,verificationTtlMs:15*60000,resetTtlMs:15*60000},mailer,()=>new Date(now));
  const password='Correct original password 123';
  const step=()=>BigInt(Math.floor(now.getTime()/30000));
  const latest=(purpose:MailMessage['purpose'],email:string)=>mail.filter(message=>message.purpose===purpose&&message.to===email).at(-1)!;
  const verified=async(email:string)=>{const registered=await auth.register({email,password});await auth.verifyEmail({token:latest('verify_email',email).token});return registered.account;};
  try{
    await t.test('registration, expiring and single-use email verification, no client-claimed roles',async()=>{
      await assert.rejects(auth.register({email:'bad@example.test',password,role:'administrator'}),code('invalid_request'));
      const registered=await auth.register({email:'  First@Example.test ',password,displayName:' 同学 '});
      assert.equal(registered.account.email,'first@example.test');assert.equal(registered.account.displayName,'同学');assert.equal(registered.delivery,'sent');
      await assert.rejects(auth.login({email:'first@example.test',password}),code('email_not_verified'));
      const delivered=latest('verify_email','first@example.test');
      const rows=await db.query<{role:string;password_hash:string;token_hash:string}>(`SELECT a.role,a.password_hash,t.token_hash FROM accounts a JOIN auth_tokens t ON t.account_id=a.id WHERE a.id=$1`,[registered.account.id]);
      assert.equal(rows.rows[0].role,'member');assert.notEqual(rows.rows[0].password_hash,password);assert.notEqual(rows.rows[0].token_hash,delivered.token);
      await assert.rejects(auth.verifyEmail({token:'invalid'}),code('invalid_token'));
      const concurrent=await Promise.allSettled([auth.verifyEmail({token:delivered.token}),auth.verifyEmail({token:delivered.token})]);assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
      await auth.register({email:'expires@example.test',password});const old=latest('verify_email','expires@example.test').token;now=new Date(now.getTime()+15*60000);
      await assert.rejects(auth.verifyEmail({token:old}),code('invalid_token'));await auth.requestEmailVerification({email:'expires@example.test'});await auth.verifyEmail({token:latest('verify_email','expires@example.test').token});
      assert.deepEqual(await auth.requestPasswordReset({email:'nobody@example.test'}),await auth.requestPasswordReset({email:'first@example.test'}));
      const reset=latest('reset_password','first@example.test');await assert.rejects(auth.verifyEmail({token:reset.token}),code('invalid_token'));
      const unavailable=new AuthService(db,{encryptionKey:key},{configured:false,async send(){throw Error('must not send');}},()=>new Date(now));
      assert.equal((await unavailable.register({email:'unconfigured@example.test',password})).delivery,'not_configured');assert.equal((await unavailable.requestPasswordReset({email:'nobody@example.test'})).delivery,'not_configured');
    });
    await t.test('session hash only, stable CSRF, lookup roles, logout, expiry and password account lock',async()=>{
      const account=await verified('sessions@example.test'),first=await auth.login({email:account.email,password}),second=await auth.login({email:account.email,password});
      assert.notEqual(first.sessionToken,second.sessionToken);assert.equal(first.actor.mfaVerified,false);assert.equal(first.mfa,'not_required');assert.match(first.csrfToken,/^[A-Za-z0-9_-]{43}$/);
      assert.equal((await auth.lookup(first.sessionToken))?.csrfToken,first.csrfToken);assert.equal(await auth.lookup('invalid'),null);
      const stored=(await db.query<{token_hash:string}>('SELECT token_hash FROM sessions WHERE account_id=$1',[account.id])).rows;assert.equal(stored.some(row=>row.token_hash===first.sessionToken),false);
      await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[account.id]);assert.equal((await auth.lookup(first.sessionToken))?.actor.role,'administrator');assert.equal((await auth.lookup(first.sessionToken))?.actor.mfaVerified,false);
      await auth.logout(first.sessionToken);assert.equal(await auth.lookup(first.sessionToken),null);assert.ok(await auth.lookup(second.sessionToken));
      now=new Date(now.getTime()+60*60000);assert.equal(await auth.lookup(second.sessionToken),null);
      for(let attempt=0;attempt<5;attempt++)await assert.rejects(auth.login({email:account.email,password:'wrong password'}),code('invalid_credentials'));
      await assert.rejects(auth.login({email:account.email,password}),code('invalid_credentials'));now=new Date(now.getTime()+10*60000);assert.ok(await auth.login({email:account.email,password}));
    });
    await t.test('password reset expires, cannot cross-purpose, is consumed once and revokes all sessions',async()=>{
      const account=await verified('reset@example.test'),first=await auth.login({email:account.email,password}),second=await auth.login({email:account.email,password});
      await auth.requestPasswordReset({email:account.email});const expiredToken=latest('reset_password',account.email).token;now=new Date(now.getTime()+15*60000);
      await assert.rejects(auth.resetPassword({token:expiredToken,password:'Replacement password 123'}),code('invalid_token'));
      await auth.requestPasswordReset({email:account.email});const token=latest('reset_password',account.email).token,newPassword='Replacement password 123';
      const results=await Promise.allSettled([auth.resetPassword({token,password:newPassword}),auth.resetPassword({token,password:newPassword})]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(await auth.lookup(first.sessionToken),null);assert.equal(await auth.lookup(second.sessionToken),null);await assert.rejects(auth.login({email:account.email,password}),code('invalid_credentials'));assert.ok(await auth.login({email:account.email,password:newPassword}));
    });
    await t.test('administrator enrollment, encrypted secret, atomic OTP replay prevention, ten-minute step-up and reset preserving MFA',async()=>{
      const member=await verified('mfa@example.test'),memberSession=await auth.login({email:member.email,password});
      await assert.rejects(auth.enrollTotp(memberSession.sessionToken,{password}),code('forbidden'));
      await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[member.id]);const session=await auth.login({email:member.email,password});assert.equal(session.mfa,'enrollment_required');
      await assert.rejects(auth.enrollTotp(session.sessionToken,{password:'wrong'}),code('invalid_credentials'));
      let enrollment=await auth.enrollTotp(session.sessionToken,{password});assert.match(enrollment.secret,/^[A-Z2-7]{32}$/);assert.match(enrollment.otpauthUri,/^otpauth:\/\/totp\//);
      const ciphertext=(await db.query<{secret_ciphertext:string}>('SELECT secret_ciphertext FROM account_mfa WHERE account_id=$1',[member.id])).rows[0].secret_ciphertext;assert.equal(ciphertext.includes(enrollment.secret),false);
      now=new Date(now.getTime()+10*60000);await assert.rejects(auth.confirmTotp(session.sessionToken,{code:totpAt(enrollment.secret,step())}),code('mfa_enrollment_expired'));
      enrollment=await auth.enrollTotp(session.sessionToken,{password});const confirmation=await auth.confirmTotp(session.sessionToken,{code:totpAt(enrollment.secret,step())});assert.equal(confirmation.actor.mfaVerified,true);assert.equal((await auth.lookup(session.sessionToken))?.actor.mfaVerified,true);
      await assert.rejects(auth.challengeTotp(session.sessionToken,{code:totpAt(enrollment.secret,step())}),code('invalid_mfa_code'));
      const other=await auth.login({email:member.email,password});assert.equal(other.mfa,'challenge_required');now=new Date(now.getTime()+30000);
      const current=totpAt(enrollment.secret,step()),attempts=await Promise.allSettled([auth.challengeTotp(session.sessionToken,{code:current}),auth.challengeTotp(other.sessionToken,{code:current})]);assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
      now=new Date(now.getTime()+10*60000);assert.equal((await auth.lookup(session.sessionToken))?.actor.mfaVerified,false);assert.equal((await auth.lookup(other.sessionToken))?.actor.mfaVerified,false);
      await auth.requestPasswordReset({email:member.email});await auth.resetPassword({token:latest('reset_password',member.email).token,password:'Administrator replaced password 123'});
      assert.equal(await auth.lookup(session.sessionToken),null);assert.equal(await auth.lookup(other.sessionToken),null);
      const afterReset=await auth.login({email:member.email,password:'Administrator replaced password 123'});assert.equal(afterReset.actor.mfaVerified,false);assert.equal(afterReset.mfa,'challenge_required');
      await assert.rejects(auth.enrollTotp(afterReset.sessionToken,{password:'Administrator replaced password 123'}),code('mfa_already_enabled'));
      assert.equal((await auth.challengeTotp(afterReset.sessionToken,{code:totpAt(enrollment.secret,step())})).actor.mfaVerified,true);now=new Date(now.getTime()+30000);
      const actual=new Set([-1n,0n,1n].map(offset=>totpAt(enrollment.secret,step()+offset))),wrong=actual.has('000000')?'111111':'000000';
      for(let attempt=0;attempt<5;attempt++)await assert.rejects(auth.challengeTotp(afterReset.sessionToken,{code:wrong}),code('invalid_mfa_code'));
      await assert.rejects(auth.challengeTotp(afterReset.sessionToken,{code:totpAt(enrollment.secret,step())}),code('mfa_rate_limited'));
      now=new Date(now.getTime()+10*60000);assert.equal((await auth.challengeTotp(afterReset.sessionToken,{code:totpAt(enrollment.secret,step())})).actor.mfaVerified,true);
    });
  }finally{await database.cleanup();}
});
