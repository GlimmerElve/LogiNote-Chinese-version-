import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {AuthService} from '../src/auth.js';
import {HostedAuthService,type HostedProvider,type HostedPrincipal,type HostedTokens} from '../src/hostedAuth.js';
import {createCommunityServer} from '../src/http.js';
import {ApiError} from '../src/errors.js';
import {tokenHash} from '../src/security.js';
import {createTestDatabase} from './helpers.js';

const password='Synthetic identity window password 2026!';
class WindowProvider implements HostedProvider {
  configured=true;readonly environment='isolated-identity-window';
  userInfoCount=0;refreshCount=0;accessLifetime=7200;
  nextError:ApiError|undefined;
  signOutUnavailable=false;
  readonly access=new Map<string,HostedPrincipal>();
  readonly refreshTokens=new Map<string,HostedPrincipal>();
  readonly people=new Map<string,HostedPrincipal>();
  private issue(person:HostedPrincipal):HostedTokens {
    const result={accessToken:'synthetic-access-'+randomUUID(),refreshToken:'synthetic-refresh-'+randomUUID(),expiresIn:this.accessLifetime};
    this.access.set(result.accessToken,person);this.refreshTokens.set(result.refreshToken,person);return result;
  }
  async signIn(email:string,value:string){
    assert.equal(value,password);let person=this.people.get(email);
    if(!person){person={subject:randomUUID(),email,emailVerified:true};this.people.set(email,person);}
    return this.issue(person);
  }
  async userInfo(token:string){this.userInfoCount++;if(this.nextError){const error=this.nextError;this.nextError=undefined;throw error;}const person=this.access.get(token);if(!person)throw new ApiError(401,'invalid_credentials','登录已失效。');return person;}
  async refresh(token:string){this.refreshCount++;const person=this.refreshTokens.get(token);if(!person)throw new ApiError(401,'invalid_credentials','登录已失效。');this.refreshTokens.delete(token);return this.issue(person);}
  async signOut(token:string){if(this.signOutUnavailable)throw new ApiError(503,'auth_unavailable','合成服务暂不可用。',true);this.access.delete(token);}
  async sendEmailCode():Promise<never>{throw Error('No external mail in this test');}
  async verifyCode():Promise<never>{throw Error('No external mail in this test');}
  async register():Promise<never>{throw Error('Use synthetic sign-in');}
  async resetPassword():Promise<never>{throw Error('Covered by hosted-auth reset tests');}
}

test('bounded upstream verification remains session scoped, non-sliding and shared across API instances',async t=>{
  const fixture=await createTestDatabase('identity_window'),{db,encryptionKey}=fixture;
  let now=new Date('2026-10-28T00:00:00Z');const clock=()=>new Date(now),advance=(ms:number)=>{now=new Date(now.getTime()+ms);};
  const provider=new WindowProvider(),local=new AuthService(db,{encryptionKey},{configured:false,async send(){return 'not_configured';}},clock);
  const hosted=new HostedAuthService(db,local,provider,encryptionKey,clock),other=new HostedAuthService(db,local,provider,encryptionKey,clock);
  const login=(name:string)=>hosted.login({email:name+'@window.example.test',password});
  const errorCode=(value:string)=>(error:unknown)=>error instanceof ApiError&&error.code===value;
  try{
    await t.test('ordinary polling reuses login verification until the exact 60 second boundary without sliding it',async()=>{
      const session=await login('boundary'),before=provider.userInfoCount;
      for(const delay of [0,1000,29000,29999]){advance(delay);assert.equal((await hosted.lookup(session.sessionToken))?.account.id,session.account.id);}
      assert.equal(provider.userInfoCount,before);advance(1);assert.ok(await hosted.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before+1);
    });
    await t.test('different API instances share one expired-window renewal through the database row lock',async()=>{
      const session=await login('instances');advance(60000);const before=provider.userInfoCount;
      const values=await Promise.all(Array.from({length:12},(_,index)=>(index%2?hosted:other).lookup(session.sessionToken)));
      assert.ok(values.every(view=>view?.account.id===session.account.id));assert.equal(provider.userInfoCount,before+1);
      assert.ok(await other.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before+1);
    });
    await t.test('sensitive validation cannot join an ordinary cache hit; administrators always revalidate',async()=>{
      const session=await login('sensitive'),before=provider.userInfoCount;
      await Promise.all([hosted.lookup(session.sessionToken),hosted.lookup(session.sessionToken,{requireFresh:true})]);assert.equal(provider.userInfoCount,before+1);
      await db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[session.account.id]);
      assert.equal((await hosted.lookup(session.sessionToken))?.actor.role,'administrator');await other.lookup(session.sessionToken);assert.equal(provider.userInfoCount,before+3);
      await db.query("UPDATE accounts SET role='member' WHERE id=$1",[session.account.id]);assert.equal((await hosted.lookup(session.sessionToken))?.actor.role,'member');
    });
    await t.test('token refresh happens before its expiry even inside the identity window',async()=>{
      provider.accessLifetime=45;const session=await login('refresh-early');provider.accessLifetime=7200;
      const before=provider.userInfoCount,refreshes=provider.refreshCount;advance(14999);assert.ok(await hosted.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before);
      advance(1);assert.ok(await hosted.lookup(session.sessionToken));assert.equal(provider.refreshCount,refreshes+1);assert.equal(provider.userInfoCount,before+1);
    });
    await t.test('a failed fresh check clears an unexpired success and ordinary reads must recover upstream',async()=>{
      const session=await login('failure'),before=provider.userInfoCount;
      provider.nextError=new ApiError(503,'auth_unavailable','账号服务暂不可用。',true);
      await assert.rejects(hosted.lookup(session.sessionToken,{requireFresh:true}),errorCode('auth_unavailable'));
      const row=(await db.query<{identity_verified_at:Date|null}>('SELECT h.identity_verified_at FROM hosted_sessions h JOIN sessions s ON s.id=h.session_id WHERE s.token_hash=$1',[tokenHash(session.sessionToken)])).rows[0];assert.equal(row.identity_verified_at,null);
      assert.ok(await other.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before+2);
      advance(60000);provider.nextError=new ApiError(503,'auth_unavailable','账号服务暂不可用。',true);
      await assert.rejects(other.lookup(session.sessionToken),errorCode('auth_unavailable'));assert.ok(await hosted.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before+4);
    });
    await t.test('provider-only revocation is detected at the next bounded renewal and cannot revive the local session',async()=>{
      const session=await login('remote-revoke'),person=provider.people.get(session.account.email)!;
      for(const [token,value] of provider.access)if(value===person)provider.access.delete(token);
      advance(59999);assert.ok(await hosted.lookup(session.sessionToken));advance(1);
      assert.equal(await other.lookup(session.sessionToken),null);assert.equal(await local.lookup(session.sessionToken),null);assert.equal(await hosted.lookup(session.sessionToken),null);
    });
    await t.test('local logout and session expiry take effect within a valid upstream window on every API instance',async()=>{
      const session=await login('local-revoke'),before=provider.userInfoCount;await local.logout(session.sessionToken);
      assert.equal(await other.lookup(session.sessionToken),null);assert.equal(provider.userInfoCount,before);
      const expired=await login('local-expiry');await db.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1',[tokenHash(expired.sessionToken),now]);assert.equal(await hosted.lookup(expired.sessionToken),null);
    });
    await t.test('verification cannot cross identities, environments or changed account email',async()=>{
      const first=await login('identity-a'),second=await login('identity-b'),before=provider.userInfoCount;
      assert.equal((await hosted.lookup(first.sessionToken))?.account.id,first.account.id);assert.equal((await hosted.lookup(second.sessionToken))?.account.id,second.account.id);assert.equal(provider.userInfoCount,before);
      const foreignProvider=Object.create(provider) as HostedProvider;Object.defineProperty(foreignProvider,'environment',{value:'other-environment'});
      const foreign=new HostedAuthService(db,local,foreignProvider,encryptionKey,clock);
      assert.deepEqual(await Promise.all([foreign.lookup(first.sessionToken),foreign.lookup(first.sessionToken)]),[null,null]);
      await db.query('UPDATE accounts SET email=$2 WHERE id=$1',[second.account.id,'changed@window.example.test']);assert.equal(await hosted.lookup(second.sessionToken),null);
    });
    await t.test('backward clock movement cannot reuse a future verification timestamp',async()=>{
      const session=await login('clock'),before=provider.userInfoCount;advance(-1000);assert.ok(await hosted.lookup(session.sessionToken));assert.equal(provider.userInfoCount,before+1);
    });
  }finally{await fixture.cleanup();}
});

test('real HTTP chat keeps current consent and group permissions inside the verification window',async t=>{
  const fixture=await createTestDatabase('identity_window_http'),provider=new WindowProvider(),origin='http://127.0.0.1:5174';
  let now=new Date('2026-10-28T02:00:00Z');
  const app=createCommunityServer({db:fixture.db,clock:()=>new Date(now),hostedProvider:provider,
    config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:'.ui-preview/community-identity-window',globalStorageLimitBytes:0,authProvider:'cloudbase',cloudbase:{environment:provider.environment,region:'ap-shanghai'}},
    mailer:{configured:false,async send(){throw Error('No external mail');}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(app.server.address() as AddressInfo).port+'/api/community/v1';
  type Who={id:string;cookie:string;csrf:string};
  const req=async(route:string,who?:Who,data?:unknown,method=data===undefined?'GET':'POST')=>{
    const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close','Idempotency-Key':randomUUID(),...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,...await response.json()};
  };
  const ok=async(...args:Parameters<typeof req>)=>{const result=await req(...args);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.value;};
  const login=async(label:string):Promise<Who>=>{const session=await app.hostedAuth!.login({email:label+'@http-window.example.test',password});return {id:session.account.id,cookie:'loginote_community_session='+session.sessionToken,csrf:session.csrfToken};};
  try{
    const a=await login('a'),b=await login('b');let room='';
    await t.test('message reads, sends, conversation state and follows share verification without stale message data',async()=>{
      const before=provider.userInfoCount;room=(await ok('/conversations',a,{peerId:b.id})).id;
      await ok('/conversations/'+room+'/messages',a,{body:'第一条介绍',clientId:randomUUID()});await ok('/conversations/'+room,b,{action:'accept'},'PUT');
      for(let index=0;index<4;index++){
        const message=await ok('/conversations/'+room+'/messages',a,{body:'连续发送 '+index,clientId:randomUUID()});
        const sync=await ok('/conversations/'+room+'/sync?after=0',b);assert.ok(sync.items.some((item:{id:string})=>item.id===message.id));
        await ok('/conversations',a);await ok('/people?following=true',a);now=new Date(now.getTime()+5000);
      }
      assert.equal(provider.userInfoCount,before);
    });
    await t.test('a block prevents the next send while existing upstream identity verification is still valid',async()=>{
      const before=provider.userInfoCount;await ok('/people/'+a.id+'/block',b,{enabled:true},'PUT');
      assert.equal((await req('/conversations/'+room+'/messages',a,{body:'受阻消息',clientId:randomUUID()})).status,403);
      assert.equal((await ok('/conversations/'+room+'/sync',a)).conversation.canSend,false);assert.equal(provider.userInfoCount,before);
      await ok('/people/'+a.id+'/block',b,{enabled:false},'PUT');
    });
    await t.test('a moderation restriction stops the next send without caching community permissions',async()=>{
      const moderator=await login('moderator');await fixture.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[moderator.id]);
      const admin={accountId:moderator.id,role:'administrator' as const,mfaVerified:true};
      const report=await ok('/reports',b,{kind:'report',targetType:'account',targetId:a.id,body:'合成测试：限制私信'});
      await app.governance.assign(admin,report.id,{});await app.governance.decide(admin,report.id,{action:'restrict_account',reason:'合成限制',capabilities:['send_message'],expiresAt:new Date(now.getTime()+3600000).toISOString()});
      const before=provider.userInfoCount;assert.equal((await req('/conversations/'+room+'/messages',a,{body:'受限后发送',clientId:randomUUID()})).status,403);assert.equal(provider.userInfoCount,before);
      await app.governance.decide(admin,report.id,{action:'restore_account',reason:'合成测试恢复'});
      await ok('/conversations/'+room+'/messages',a,{body:'恢复后发送',clientId:randomUUID()});assert.equal(provider.userInfoCount,before);
    });
    await t.test('leaving a group blocks its next message read and write without waiting for the identity window',async()=>{
      const group=(await ok('/groups',a,{name:'会话权限核对',description:'合成测试',joinPolicy:'open'})).id;
      await ok('/groups/'+group+'/membership',b,{action:'join'});await ok('/groups/'+group+'/messages',b,{body:'群内消息',clientId:randomUUID()});
      const before=provider.userInfoCount;await ok('/groups/'+group+'/membership',b,{action:'leave'});
      assert.equal((await req('/groups/'+group+'/messages',b)).status,403);assert.equal((await req('/groups/'+group+'/messages',b,{body:'退出后发送',clientId:randomUUID()})).status,403);assert.equal(provider.userInfoCount,before);
    });
    await t.test('sensitive device authorization checks upstream immediately even with a valid ordinary window',async()=>{
      const account=await login('sensitive');provider.nextError=new ApiError(401,'invalid_credentials','登录已撤销。');
      assert.equal((await req('/me/devices',account)).status,401);assert.equal((await ok('/me/session',account)).kind,'guest');
    });
    await t.test('sign-out succeeds during a provider outage and the next poll is rejected',async()=>{
      provider.signOutUnavailable=true;await ok('/me/sign-out',a,{});provider.signOutUnavailable=false;
      assert.equal((await req('/conversations/'+room+'/sync',a)).status,401);assert.equal((await ok('/me/session',a)).kind,'guest');
    });
    await t.test('30 minutes of the existing 5-second/10-second polling cadence need only 30 identity checks including login',async()=>{
      const person=await login('cadence'),conversation=(await ok('/conversations',person,{peerId:b.id})).id;
      const before=provider.userInfoCount,start=now.getTime();let reads=0;
      for(let index=0;index<360;index++){
        now=new Date(start+index*5000);const requests=[ok('/conversations/'+conversation+'/sync',person)];
        if(index%2===0)requests.push(ok('/conversations',person),ok('/people?following=true',person));
        await Promise.all(requests);reads+=requests.length;
      }
      const renewals=provider.userInfoCount-before;assert.equal(reads,720);assert.equal(renewals,29);
      t.diagnostic(JSON.stringify({scenario:'one foreground account, existing 5s message and 10s sidebar cadence, 30 virtual minutes',businessReads:reads,upstreamIdentityChecksIncludingLogin:renewals+1,realCloudBaseCalls:0,messagePollingIntervalMs:5000}));
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();}
});
