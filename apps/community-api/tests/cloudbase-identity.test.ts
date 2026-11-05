import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthService,type Mailer,type MailMessage,type VerifiedExternalPrincipal} from '../src/auth.js';
import {AccessService} from '../src/access.js';
import {GovernanceService} from '../src/governance.js';
import {ApiError} from '../src/errors.js';
import {opaqueToken,tokenHash,totpAt} from '../src/security.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
const principal=(subject:string,overrides:Partial<VerifiedExternalPrincipal>={}):VerifiedExternalPrincipal=>({provider:'cloudbase',environment:'test-environment',subject,email:`${subject}@cloudbase.example.test`,emailVerified:true,displayName:'云端同学',...overrides});

test('CloudBase identities preserve independent community accounts and MFA against PostgreSQL',async t=>{
  const fixture=await createTestDatabase('external_identity_test'),{db,encryptionKey}=fixture;
  const mail:MailMessage[]=[],mailer:Mailer={configured:true,async send(message){mail.push(message);return 'sent';}};
  let now=new Date('2026-10-24T00:00:00Z');
  const clock=()=>new Date(now),auth=new AuthService(db,{encryptionKey,sessionTtlMs:60*60000},mailer,clock);
  const password='Synthetic local password 123';
  try{
    await t.test('provider environment and subject map atomically; matching email never merges a local account',async()=>{
      const local=await auth.register({email:'shared@example.test',password});
      await auth.verifyEmail({token:mail.at(-1)!.token});
      await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[local.account.id]);
      const identity=principal('concurrent',{email:local.account.email});
      const sessions=await Promise.all(Array.from({length:6},()=>auth.issueExternalSession(identity)));
      assert.equal(new Set(sessions.map(session=>session.account.id)).size,1);
      const external=sessions[0];assert.notEqual(external.account.id,local.account.id);assert.equal(external.actor.role,'member');
      assert.equal(external.actor.mfaVerified,false);assert.equal(external.account.emailVerified,true);
      const identityRows=(await db.query<{account_id:string;password_hash:string|null;auth_provider:string}>(`SELECT e.account_id,a.password_hash,a.auth_provider FROM external_identities e JOIN accounts a ON a.id=e.account_id WHERE e.provider=$1 AND e.environment=$2 AND e.subject=$3`,[identity.provider,identity.environment,identity.subject])).rows;
      assert.equal(identityRows.length,1);assert.equal(identityRows[0].password_hash,null);assert.equal(identityRows[0].auth_provider,'cloudbase');
      assert.deepEqual(await auth.externalIdentity(external.sessionToken),{provider:identity.provider,environment:identity.environment,subject:identity.subject});
      const localSession=await auth.login({email:local.account.email,password});assert.equal(localSession.account.id,local.account.id);assert.equal(await auth.externalIdentity(localSession.sessionToken),null);
      const anotherSubject=await auth.issueExternalSession({...identity,subject:'different-subject'}),anotherEnvironment=await auth.issueExternalSession({...identity,environment:'another-environment'});
      assert.equal(new Set([external.account.id,anotherSubject.account.id,anotherEnvironment.account.id,local.account.id]).size,4);
      const changed=await auth.issueExternalSession({...identity,email:'changed@example.test',displayName:'Changed provider name'});
      assert.equal(changed.account.id,external.account.id);assert.equal(changed.account.email,'changed@example.test');assert.equal(changed.account.displayName,'云端同学');
      const stored=(await db.query<{token_hash:string}>('SELECT token_hash FROM sessions WHERE account_id=$1',[external.account.id])).rows;
      assert.ok(stored.some(row=>row.token_hash===tokenHash(external.sessionToken)));assert.equal(stored.some(row=>row.token_hash===external.sessionToken),false);
    });
    await t.test('unverified or malformed identities and client privilege fields cannot create accounts',async()=>{
      await assert.rejects(auth.issueExternalSession({...principal('unverified'),emailVerified:false} as unknown as VerifiedExternalPrincipal),code('email_not_verified'));
      await assert.rejects(auth.issueExternalSession({...principal('forged'),role:'administrator'} as VerifiedExternalPrincipal),code('invalid_request'));
      await assert.rejects(auth.issueExternalSession(principal('bad-environment',{environment:'https://untrusted.example'})),code('invalid_external_identity'));
      await assert.rejects(auth.issueExternalSession(principal('bad-subject',{subject:'invalid\nsubject'})),code('invalid_external_identity'));
      await assert.rejects(auth.issueExternalSession(principal('bad-email',{email:''})),code('invalid_request'));
      await assert.rejects(auth.issueExternalSession(principal('expired'),{expiresAt:new Date(now)}),code('external_session_expired'));
      assert.equal((await db.query<{n:string}>("SELECT count(*)::text AS n FROM external_identities WHERE subject IN ('unverified','forged','expired')")).rows[0].n,'0');
    });
    await t.test('external accounts have no local login or reset path, including a manually inserted local-action token',async()=>{
      const external=await auth.issueExternalSession(principal('provider-only'));
      await assert.rejects(auth.login({email:external.account.email,password}),code('invalid_credentials'));
      const before=mail.length;await auth.requestPasswordReset({email:external.account.email});await auth.requestEmailVerification({email:external.account.email});assert.equal(mail.length,before);
      const token=opaqueToken();await db.query("INSERT INTO auth_tokens(id,account_id,token_hash,purpose,expires_at) VALUES(gen_random_uuid(),$1,$2,'reset_password',$3)",[external.account.id,tokenHash(token),new Date(now.getTime()+60000)]);
      await assert.rejects(auth.resetPassword({token,password}),code('invalid_token'));
      assert.equal((await db.query<{password_hash:string|null}>('SELECT password_hash FROM accounts WHERE id=$1',[external.account.id])).rows[0].password_hash,null);
      assert.ok(await auth.lookup(external.sessionToken));
    });
    await t.test('provider expiry caps community sessions and sign-out revokes the opaque session',async()=>{
      const expiry=new Date(now.getTime()+30000),short=await auth.issueExternalSession(principal('expiry'),{expiresAt:expiry});
      assert.equal(short.expiresAt,expiry.toISOString());assert.ok(await auth.lookup(short.sessionToken));
      now=new Date(now.getTime()+30000);assert.equal(await auth.lookup(short.sessionToken),null);await assert.rejects(auth.externalIdentity(short.sessionToken),code('unauthenticated'));
      const capped=await auth.issueExternalSession(principal('capped'),{expiresAt:new Date(now.getTime()+86400000)});assert.equal(capped.expiresAt,new Date(now.getTime()+60*60000).toISOString());
      await auth.logout(capped.sessionToken);assert.equal(await auth.lookup(capped.sessionToken),null);
    });
    await t.test('external administrator enrollment requires the same provider principal and retains replay-resistant MFA',async()=>{
      const identity=principal('administrator'),member=await auth.issueExternalSession(identity);
      await assert.rejects(auth.enrollExternalTotp(member.sessionToken,identity),code('forbidden'));
      await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[member.account.id]);
      const session=await auth.issueExternalSession(identity);assert.equal(session.mfa,'enrollment_required');assert.equal(session.actor.mfaVerified,false);
      await assert.rejects(auth.enrollTotp(session.sessionToken,{password}),code('external_reauthentication_required'));
      await assert.rejects(auth.enrollExternalTotp(session.sessionToken,{...identity,subject:'other-admin'}),code('external_identity_mismatch'));
      await assert.rejects(auth.enrollExternalTotp(session.sessionToken,{...identity,environment:'other-environment'}),code('external_identity_mismatch'));
      const enrollment=await auth.enrollExternalTotp(session.sessionToken,identity),step=()=>BigInt(Math.floor(now.getTime()/30000));
      const enabled=await auth.confirmTotp(session.sessionToken,{code:totpAt(enrollment.secret,step())});assert.equal(enabled.actor.mfaVerified,true);
      const other=await auth.issueExternalSession(identity);assert.equal(other.mfa,'challenge_required');assert.equal(other.actor.mfaVerified,false);
      await assert.rejects(auth.challengeTotp(other.sessionToken,{code:totpAt(enrollment.secret,step())}),code('invalid_mfa_code'));
      now=new Date(now.getTime()+30000);assert.equal((await auth.challengeTotp(other.sessionToken,{code:totpAt(enrollment.secret,step())})).actor.mfaVerified,true);
      await assert.rejects(auth.enrollExternalTotp(other.sessionToken,identity),code('mfa_already_enabled'));
      now=new Date(now.getTime()+10*60000);assert.equal((await auth.lookup(other.sessionToken))?.actor.mfaVerified,false);
      const stored=(await db.query<{secret_ciphertext:string;password_hash:string|null}>('SELECT m.secret_ciphertext,a.password_hash FROM account_mfa m JOIN accounts a ON a.id=m.account_id WHERE a.id=$1',[member.account.id])).rows[0];
      assert.equal(stored.password_hash,null);assert.equal(stored.secret_ciphertext.includes(enrollment.secret),false);
    });
    await t.test('new provider sign-in retains community restrictions, scope access, and restoration',async()=>{
      const access=new AccessService(db,clock),governance=new GovernanceService(db,access,clock),adminPrincipal=principal('case-admin');
      const administrator=await auth.issueExternalSession(adminPrincipal);await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[administrator.account.id]);
      const admin=await auth.issueExternalSession(adminPrincipal),enrolled=await auth.enrollExternalTotp(admin.sessionToken,adminPrincipal);
      const adminActor=(await auth.confirmTotp(admin.sessionToken,{code:totpAt(enrolled.secret,BigInt(Math.floor(now.getTime()/30000)))})).actor;
      const memberPrincipal=principal('restricted-member'),member=await auth.issueExternalSession(memberPrincipal),other=await auth.issueExternalSession(principal('outsider'));
      const item=await access.createObject(member.actor,{scope:'self'});await assert.rejects(access.readObject(other.actor,item.id),code('forbidden'));
      const report=await governance.submit(other.actor,{targetType:'account',targetId:member.account.id,body:'Synthetic test restriction'});await governance.assign(adminActor,report.id);
      await governance.decide(adminActor,report.id,{action:'restrict_account',reason:'Synthetic test decision',capabilities:['write'],expiresAt:new Date(now.getTime()+60*60000).toISOString()});
      const newSession=await auth.issueExternalSession({...memberPrincipal,email:'new-contact@example.test'});assert.equal(newSession.account.id,member.account.id);
      await assert.rejects(access.createObject(newSession.actor,{scope:'public'}),code('forbidden'));assert.equal((await access.readObject(newSession.actor,item.id)).ownerId,member.account.id);
      await governance.decide(adminActor,report.id,{action:'restore_account',reason:'Synthetic test restoration'});assert.ok(await access.createObject(newSession.actor,{scope:'public'}));
    });
  }finally{await fixture.cleanup();}
});
