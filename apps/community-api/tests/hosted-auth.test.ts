import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthService} from '../src/auth.js';
import {HostedAuthService,type HostedProvider,type HostedPrincipal,type HostedTokens} from '../src/hostedAuth.js';
import {ApiError} from '../src/errors.js';
import {tokenHash,totpAt} from '../src/security.js';
import {createTestDatabase} from './helpers.js';

type Purpose='register'|'reset_password'|'login';
type ProviderAccount={subject:string;email:string;password:string;emailVerified:boolean|undefined};
type Challenge={email:string;purpose:Purpose;used:boolean};
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
const password='Synthetic hosted password 123';

/** No network or credentials: this fixture models rotating refresh tokens and one-use proofs. */
class ProviderFixture implements HostedProvider {
  configured=true;readonly environment='isolated-hosted-auth';
  private sequence=0;
  readonly accounts=new Map<string,ProviderAccount>();
  readonly challenges=new Map<string,Challenge>();
  readonly proofs=new Map<string,Challenge>();
  readonly access=new Map<string,ProviderAccount>();
  readonly refreshTokens=new Map<string,ProviderAccount>();
  readonly issued:HostedTokens[]=[];
  userInfoCount=0;refreshCount=0;verifyCount=0;signInCount=0;signOutCount=0;
  nextUserInfoError:unknown;
  nextSignInError:unknown;
  nextResetError:unknown;
  nextSignInAccount:ProviderAccount|undefined;
  accessLifetime=60;
  registrationVerified:boolean|undefined=true;
  account(email:string,verified:boolean|undefined=true){
    const account:ProviderAccount={subject:`subject-${++this.sequence}`,email,password,emailVerified:verified};this.accounts.set(email,account);return account;
  }
  private tokens(account:ProviderAccount):HostedTokens {
    const tokens={accessToken:`synthetic-access-${++this.sequence}`,refreshToken:`synthetic-refresh-${++this.sequence}`,expiresIn:this.accessLifetime};
    this.access.set(tokens.accessToken,account);this.refreshTokens.set(tokens.refreshToken,account);this.issued.push(tokens);return tokens;
  }
  async sendEmailCode(email:string,purpose:Purpose){const verificationId=`provider-challenge-${++this.sequence}`;this.challenges.set(verificationId,{email,purpose,used:false});return {verificationId,expiresIn:300};}
  async verifyCode(verificationId:string,value:string){
    this.verifyCount++;const challenge=this.challenges.get(verificationId);
    if(!challenge||challenge.used||value!=='123456')throw new ApiError(400,'invalid_verification_code','验证码无效。');
    challenge.used=true;const verificationToken=`provider-proof-${++this.sequence}`;this.proofs.set(verificationToken,challenge);return {verificationToken};
  }
  private proof(token:string,email:string,purpose:Purpose){const proof=this.proofs.get(token);if(!proof||proof.email!==email||proof.purpose!==purpose)throw new ApiError(400,'invalid_verification_code','验证凭据不匹配。');this.proofs.delete(token);}
  async register(input:{email:string;password:string;name?:string;verificationToken:string}){
    this.proof(input.verificationToken,input.email,'register');
    if(this.accounts.has(input.email))throw new ApiError(409,'email_registered','此邮箱已注册。');
    const account=this.account(input.email,this.registrationVerified);account.emailVerified=this.registrationVerified;account.password=input.password;return this.tokens(account);
  }
  async signIn(email:string,value:string){
    this.signInCount++;
    if(this.nextSignInError){const error=this.nextSignInError;this.nextSignInError=undefined;throw error;}
    const account=this.nextSignInAccount||this.accounts.get(email);this.nextSignInAccount=undefined;
    if(!account||value!==account.password)throw new ApiError(401,'invalid_credentials','邮箱或密码不正确。');return this.tokens(account);
  }
  async resetPassword(input:{email:string;password:string;verificationToken:string}){this.proof(input.verificationToken,input.email,'reset_password');if(this.nextResetError){const error=this.nextResetError;this.nextResetError=undefined;throw error;}const account=this.accounts.get(input.email);if(!account)throw new ApiError(401,'invalid_credentials','账号不可用。');account.password=input.password;}
  async refresh(token:string){this.refreshCount++;const account=this.refreshTokens.get(token);if(!account)throw new ApiError(401,'invalid_credentials','登录状态已过期。');this.refreshTokens.delete(token);return this.tokens(account);}
  async userInfo(token:string):Promise<HostedPrincipal>{this.userInfoCount++;
    if(this.nextUserInfoError){const error=this.nextUserInfoError;this.nextUserInfoError=undefined;throw error;}
    const account=this.access.get(token);if(!account)throw new ApiError(401,'invalid_credentials','登录状态已过期。');
    return {subject:account.subject,email:account.email,...(account.emailVerified===undefined?{}:{emailVerified:account.emailVerified}),displayName:'托管同学'} as HostedPrincipal;
  }
  async signOut(token:string){this.signOutCount++;this.access.delete(token);}
}

test('hosted auth bridge against isolated PostgreSQL without external mail or provider traffic',async t=>{
  const fixture=await createTestDatabase('hosted_auth_test'),{db,encryptionKey}=fixture;
  let now=new Date('2026-10-24T02:00:00Z');const clock=()=>new Date(now);
  const provider=new ProviderFixture(),local=new AuthService(db,{encryptionKey},{configured:false,async send(){return 'not_configured';}},clock);
  const hosted=new HostedAuthService(db,local,provider,encryptionKey,clock);
  const challenge=(email:string,purpose:Purpose)=>hosted.sendEmailCode({email,purpose});
  try{
    await t.test('registration code is bound to email and purpose, consumed once, and provider tokens stay encrypted',async()=>{
      const email='register@hosted.example.test',sent=await challenge(email,'register');
      assert.equal(sent.delivery,'sent');assert.notEqual(sent.verificationId,[...provider.challenges.keys()].at(-1));
      const before=provider.verifyCount;
      await assert.rejects(hosted.register({email:'other@hosted.example.test',password,verificationId:sent.verificationId,code:'123456'}),code('invalid_verification_code'));
      await assert.rejects(hosted.resetPassword({email,password,verificationId:sent.verificationId,code:'123456'}),code('invalid_verification_code'));assert.equal(provider.verifyCount,before);
      const session=await hosted.register({email,password,verificationId:sent.verificationId,code:'123456'});
      assert.equal(session.account.email,email);assert.equal(session.actor.role,'member');assert.equal((await hosted.lookup(session.sessionToken))?.account.id,session.account.id);
      await assert.rejects(hosted.register({email,password,verificationId:sent.verificationId,code:'123456'}),code('invalid_verification_code'));
      const rows=(await db.query<{token_hash:string;credentials_ciphertext:string;password_hash:string|null}>(`SELECT s.token_hash,h.credentials_ciphertext,a.password_hash FROM sessions s JOIN hosted_sessions h ON h.session_id=s.id JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1`,[tokenHash(session.sessionToken)])).rows;
      assert.equal(rows.length,1);assert.notEqual(rows[0].token_hash,session.sessionToken);assert.equal(rows[0].password_hash,null);assert.match(rows[0].credentials_ciphertext,/^v1\./);
      for(const issued of provider.issued){assert.equal(rows[0].credentials_ciphertext.includes(issued.accessToken),false);assert.equal(rows[0].credentials_ciphertext.includes(issued.refreshToken),false);}
      const storedChallenge=(await db.query<{token_hash:string;consumed_at:Date|null}>('SELECT token_hash,consumed_at FROM hosted_email_challenges WHERE token_hash=$1',[tokenHash(sent.verificationId)])).rows[0];assert.equal(storedChallenge.token_hash,tokenHash(sent.verificationId));assert.ok(storedChallenge.consumed_at);
    });
    await t.test('failed codes are limited, expired codes rejected, and resending replaces the previous challenge',async()=>{
      const email='attempts@hosted.example.test',first=await challenge(email,'register');
      for(let index=0;index<5;index++)await assert.rejects(hosted.register({email,password,verificationId:first.verificationId,code:'000000'}),code('invalid_verification_code'));
      const attempts=provider.verifyCount;await assert.rejects(hosted.register({email,password,verificationId:first.verificationId,code:'123456'}),code('invalid_verification_code'));assert.equal(provider.verifyCount,attempts);
      await assert.rejects(challenge(email,'register'),error=>error instanceof ApiError&&error.status===429);
      now=new Date(now.getTime()+60000);const replacement=await challenge(email,'register');
      await assert.rejects(hosted.register({email,password,verificationId:first.verificationId,code:'123456'}),code('invalid_verification_code'));
      now=new Date(now.getTime()+300000);await assert.rejects(hosted.register({email,password,verificationId:replacement.verificationId,code:'123456'}),code('invalid_verification_code'));
    });
    await t.test('missing provider verification needs a matching login proof and cannot be replaced by another purpose or email',async()=>{
      const email='missing-verification@hosted.example.test',account=provider.account(email);account.emailVerified=undefined;
      await assert.rejects(hosted.login({email,password}),code('email_verification_required'));
      const wrongPurpose=await challenge(email,'register');
      await assert.rejects(hosted.login({email,password,verificationId:wrongPurpose.verificationId,code:'123456'}),code('invalid_verification_code'));
      now=new Date(now.getTime()+60000);const proof=await challenge(email,'login'),other=provider.account('proof-other@hosted.example.test');other.emailVerified=undefined;
      await assert.rejects(hosted.login({email:other.email,password,verificationId:proof.verificationId,code:'123456'}),code('invalid_verification_code'));
      const session=await hosted.login({email,password,verificationId:proof.verificationId,code:'123456'});assert.equal(session.account.emailVerified,true);
      assert.equal((await hosted.login({email,password})).account.id,session.account.id);assert.ok(await hosted.lookup(session.sessionToken));
      await assert.rejects(hosted.login({email,password,verificationId:proof.verificationId,code:'123456'}),code('invalid_verification_code'));
      account.emailVerified=false;assert.equal(await hosted.lookup(session.sessionToken,{requireFresh:true}),null);await assert.rejects(hosted.login({email,password}),code('email_not_verified'));
    });
    await t.test('registration code can prove an omitted verification field but cannot override an explicit false value',async()=>{
      provider.registrationVerified=undefined;
      const email='register-missing@hosted.example.test',sent=await challenge(email,'register');const session=await hosted.register({email,password,verificationId:sent.verificationId,code:'123456'});assert.equal(session.account.email,email);assert.ok(await hosted.lookup(session.sessionToken));
      provider.registrationVerified=false;
      const refusedEmail='register-unverified@hosted.example.test',refused=await challenge(refusedEmail,'register');await assert.rejects(hosted.register({email:refusedEmail,password,verificationId:refused.verificationId,code:'123456'}),code('email_not_verified'));
      assert.equal((await db.query<{n:string}>('SELECT count(*)::text AS n FROM accounts WHERE email=$1',[refusedEmail])).rows[0].n,'0');provider.registrationVerified=true;
    });
    await t.test('parallel lookups rotate one refresh token once and retain the community session',async()=>{
      provider.account('refresh@hosted.example.test');const session=await hosted.login({email:'refresh@hosted.example.test',password});
      const before=provider.refreshCount,profiles=provider.userInfoCount;now=new Date(now.getTime()+31000);
      const lookups=await Promise.all(Array.from({length:8},()=>hosted.lookup(session.sessionToken)));
      assert.equal(provider.refreshCount-before,1);assert.equal(provider.userInfoCount-profiles,1);assert.equal(new Set(lookups.map(view=>view?.account.id)).size,1);assert.ok(lookups.every(view=>view?.account.id===session.account.id));
      assert.equal(lookups[0]?.csrfToken,session.csrfToken);const verified=provider.userInfoCount;await hosted.lookup(session.sessionToken);await hosted.lookup(session.sessionToken);assert.equal(provider.userInfoCount-verified,0,'Sequential ordinary requests reuse the bounded upstream verification window');
      const another=await hosted.login({email:'refresh@hosted.example.test',password});assert.equal(another.account.id,session.account.id);assert.notEqual(another.sessionToken,session.sessionToken);
    });
    await t.test('refresh rotation commits despite a following profile outage and the next lookup recovers without another refresh',async()=>{
      const email='refresh-profile-outage@hosted.example.test';provider.account(email);const session=await hosted.login({email,password}),oldTokens=provider.issued.at(-1)!;
      const stored=async()=>(await db.query<{credentials_ciphertext:string;access_expires_at:Date}>('SELECT h.credentials_ciphertext,h.access_expires_at FROM hosted_sessions h JOIN sessions s ON s.id=h.session_id WHERE s.token_hash=$1',[tokenHash(session.sessionToken)])).rows[0];
      const before=await stored(),refreshes=provider.refreshCount;now=new Date(now.getTime()+31000);
      provider.nextUserInfoError=new ApiError(503,'cloudbase_unavailable','账号资料暂时无法读取。',true);
      await assert.rejects(hosted.lookup(session.sessionToken),error=>error instanceof ApiError&&error.status===503&&error.code==='cloudbase_unavailable');
      assert.equal(provider.refreshCount-refreshes,1);assert.equal(provider.refreshTokens.has(oldTokens.refreshToken),false);
      const rotated=provider.issued.at(-1)!,after=await stored();assert.notEqual(after.credentials_ciphertext,before.credentials_ciphertext);assert.ok(new Date(after.access_expires_at).getTime()>new Date(before.access_expires_at).getTime());
      assert.equal(after.credentials_ciphertext.includes(rotated.refreshToken),false);assert.equal(after.credentials_ciphertext.includes(rotated.accessToken),false);assert.ok(await local.lookup(session.sessionToken));
      const recovered=await hosted.lookup(session.sessionToken);assert.equal(recovered?.account.id,session.account.id);assert.equal(recovered?.csrfToken,session.csrfToken);assert.equal(provider.refreshCount-refreshes,1);assert.equal(provider.refreshTokens.has(rotated.refreshToken),true);
    });
    await t.test('remote denial revokes the community session and sign-out deletes encrypted upstream credentials',async()=>{
      provider.account('denied@hosted.example.test');const denied=await hosted.login({email:'denied@hosted.example.test',password});
      provider.nextUserInfoError=new ApiError(401,'invalid_credentials','登录状态已失效。');assert.equal(await hosted.lookup(denied.sessionToken,{requireFresh:true}),null);assert.equal(await local.lookup(denied.sessionToken),null);
      provider.account('logout@hosted.example.test');const session=await hosted.login({email:'logout@hosted.example.test',password});await hosted.logout(session.sessionToken);
      assert.equal(await hosted.lookup(session.sessionToken),null);assert.equal((await db.query<{n:string}>('SELECT count(*)::text AS n FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE token_hash=$1)',[tokenHash(session.sessionToken)])).rows[0].n,'0');
    });
    await t.test('email mismatch in a login response cannot create a session for the wrong provider account',async()=>{
      provider.account('requested@hosted.example.test');const other=provider.account('unexpected@hosted.example.test');provider.nextSignInAccount=other;const signOuts=provider.signOutCount;
      await assert.rejects(hosted.login({email:'requested@hosted.example.test',password}),code('external_identity_mismatch'));
      assert.equal(provider.signOutCount-signOuts,1);assert.equal(provider.access.has(provider.issued.at(-1)!.accessToken),false);
      assert.equal((await db.query<{n:string}>('SELECT count(*)::text AS n FROM accounts WHERE email=$1',[other.email])).rows[0].n,'0');
    });
    await t.test('provider email changes require a new login rather than retaining a stale contact identity',async()=>{
      const account=provider.account('old-contact@hosted.example.test'),session=await hosted.login({email:account.email,password});account.email='new-contact@hosted.example.test';
      assert.equal(await hosted.lookup(session.sessionToken,{requireFresh:true}),null);assert.equal(await local.lookup(session.sessionToken),null);
    });
    await t.test('invalid provider token metadata and tampered encrypted credentials fail with sanitized errors',async()=>{
      const email='invalid-response@hosted.example.test';provider.account(email);provider.accessLifetime=0;
      await assert.rejects(hosted.login({email,password}),error=>{
        assert.ok(error instanceof ApiError);assert.equal(error.code,'auth_response_invalid');
        const description=String(error);for(const issued of provider.issued){assert.equal(description.includes(issued.accessToken),false);assert.equal(description.includes(issued.refreshToken),false);}return true;
      });provider.accessLifetime=60;
      const first=await hosted.login({email,password}),second=await hosted.login({email,password});
      await db.query('UPDATE hosted_sessions SET credentials_ciphertext=(SELECT h.credentials_ciphertext FROM hosted_sessions h JOIN sessions s ON s.id=h.session_id WHERE s.token_hash=$1) WHERE session_id IN (SELECT id FROM sessions WHERE token_hash=$2)',[tokenHash(first.sessionToken),tokenHash(second.sessionToken)]);
      await assert.rejects(hosted.lookup(second.sessionToken),error=>error instanceof ApiError&&error.code==='auth_session_unavailable'&&!String(error).includes('synthetic-access'));
      assert.ok(await hosted.lookup(first.sessionToken));
    });
    await t.test('password reset revokes every mapped community session while leaving another account intact',async()=>{
      const email='reset@hosted.example.test';provider.account(email);provider.account('unrelated@hosted.example.test');
      const first=await hosted.login({email,password}),second=await hosted.login({email,password}),other=await hosted.login({email:'unrelated@hosted.example.test',password}),sent=await challenge(email,'reset_password');
      assert.deepEqual(await hosted.resetPassword({email,password:'Replacement synthetic password 123',verificationId:sent.verificationId,code:'123456'}),{reset:true});
      assert.equal(await local.lookup(first.sessionToken),null);assert.equal(await local.lookup(second.sessionToken),null);assert.ok(await hosted.lookup(other.sessionToken));
      const next=await hosted.login({email,password:'Replacement synthetic password 123'});assert.equal(next.account.id,first.account.id);assert.equal(next.actor.mfaVerified,false);
    });
    await t.test('a remote reset failure still conservatively revokes existing community sessions after mailbox proof',async()=>{
      const email='reset-failure@hosted.example.test';provider.account(email);const session=await hosted.login({email,password}),sent=await challenge(email,'reset_password');
      provider.nextResetError=new ApiError(503,'cloudbase_unavailable','账号服务暂时不可用。',true);
      await assert.rejects(hosted.resetPassword({email,password:'Replacement synthetic password 456',verificationId:sent.verificationId,code:'123456'}),code('cloudbase_unavailable'));
      assert.equal(await local.lookup(session.sessionToken),null);assert.equal((await db.query<{n:string}>('SELECT count(*)::text AS n FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE account_id=$1)',[session.account.id])).rows[0].n,'0');
    });
    await t.test('external administrator MFA rejects another subject and requires a fresh provider password',async()=>{
      const email='admin@hosted.example.test',account=provider.account(email),other=provider.account('other-admin@hosted.example.test');
      const member=await hosted.login({email,password});await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[member.account.id]);const admin=await hosted.login({email,password});
      await assert.rejects(hosted.enrollTotp(admin.sessionToken,{password:'wrong password'}),code('invalid_credentials'));
      provider.nextSignInAccount=other;await assert.rejects(hosted.enrollTotp(admin.sessionToken,{password}),error=>error instanceof ApiError&&[403,401].includes(error.status));
      const enrollment=await hosted.enrollTotp(admin.sessionToken,{password});assert.equal(provider.accounts.get(email)?.subject,account.subject);
      const view=await hosted.confirmTotp(admin.sessionToken,{code:totpAt(enrollment.secret,BigInt(Math.floor(now.getTime()/30000)))});assert.equal(view.actor.mfaVerified,true);
      const again=await hosted.login({email,password});assert.equal(again.mfa,'challenge_required');assert.equal(again.actor.mfaVerified,false);
    });
    await t.test('an unconfigured provider fails explicitly without creating a local account',async()=>{
      provider.configured=false;await assert.rejects(hosted.login({email:'never@hosted.example.test',password}),code('auth_not_configured'));
      assert.equal((await db.query<{n:string}>("SELECT count(*)::text AS n FROM accounts WHERE email='never@hosted.example.test'")).rows[0].n,'0');provider.configured=true;
    });
  }finally{await fixture.cleanup();}
});
