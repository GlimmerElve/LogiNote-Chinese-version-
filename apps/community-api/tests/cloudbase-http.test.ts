import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {CloudbaseClient} from '../src/cloudbase.js';
import {createCommunityServer,type SafeLog} from '../src/http.js';
import {createTestDatabase} from './helpers.js';

test('CloudBase REST adapter, BFF cookies and real PostgreSQL enforce one identity boundary',async t=>{
  const fixture=await createTestDatabase('cloudbase_http'),logs:SafeLog[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-24T00:00:00Z'),sequence=0,refreshes=0;
  type User={sub:string;email:string;password:string;email_verified?:boolean;status:string};
  const users=new Map<string,User>(),access=new Map<string,User>(),refresh=new Map<string,User>(),codes=new Map<string,string>(),proofs=new Map<string,string>();
  let upstreamError:Record<string,unknown>|undefined,profileFailure=false;
  const tokens=(user:User)=>{const accessToken=`fixture-access-${++sequence}`,refreshToken=`fixture-refresh-${++sequence}`;access.set(accessToken,user);refresh.set(refreshToken,user);return {token_type:'Bearer',access_token:accessToken,refresh_token:refreshToken,expires_in:60,sub:user.sub};};
  const upstream:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://fixture-cloudbase.api.tcloudbasegateway.com');assert.equal(init?.redirect,'error');
    const body=init?.body?JSON.parse(String(init.body)):undefined,path=url.pathname.slice('/auth/v1/'.length),headers=new Headers(init?.headers);
    const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    if(upstreamError){const error=upstreamError;upstreamError=undefined;return reply(error,400);}
    if(path==='verification'){
      if('usage' in body)return reply({error:'not_found',error_description:'provider email not found from endpoint'},404);
      assert.ok(['ANY','USER'].includes(body.target));
      const id=`fixture-verification-${++sequence}`;codes.set(id,body.email);return reply({verification_id:id,expires_in:600});
    }
    if(path==='verification/verify'){
      if(body.verification_code!=='123456'||!codes.has(body.verification_id))return reply({error:'invalid_code'},400);
      const proof=`fixture-proof-${++sequence}`;proofs.set(proof,codes.get(body.verification_id)!);codes.delete(body.verification_id);return reply({verification_token:proof,expires_in:600});
    }
    if(path==='signup'){
      assert.equal(proofs.get(body.verification_token),body.email);proofs.delete(body.verification_token);
      const user={sub:`fixture-sub-${++sequence}`,email:body.email,password:body.password,email_verified:true,status:'ACTIVE'};users.set(user.email,user);return reply(tokens(user));
    }
    if(path==='signin'){const user=users.get(body.username);return user&&user.password===body.password?reply(tokens(user)):reply({error:'invalid_username_or_password',error_description:`private ${body.password}`},400);}
    if(path==='token'){refreshes++;const user=refresh.get(body.refresh_token);if(!user)return reply({error:'invalid_grant'},400);refresh.delete(body.refresh_token);return reply(tokens(user));}
    if(path==='user/me'){
      if(profileFailure)return reply({error:'unavailable'},503);
      const user=access.get((headers.get('Authorization')||'').slice(7));return user?reply({sub:user.sub,email:user.email,email_verified:user.email_verified,status:user.status,groups:[{id:'administrator'}],name:'合成测试成员'}):reply({error:'invalid_token'},401);
    }
    if(path==='reset'){assert.equal(proofs.get(body.verification_token),body.email);proofs.delete(body.verification_token);users.get(body.email)!.password=body.new_password;return reply({});}
    if(path==='user/signout'){access.delete((headers.get('Authorization')||'').slice(7));return reply({});}
    assert.fail(`Unexpected fixture request: ${path}`);
  };
  const provider=new CloudbaseClient({environment:'fixture-cloudbase'},upstream);
  const mail:unknown[]=[];
  const config={databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:'.data/cloudbase-http-unused',globalStorageLimitBytes:0,authProvider:'cloudbase' as const,cloudbase:{environment:provider.environment,region:'ap-shanghai'}};
  const app=createCommunityServer({db:fixture.db,config,hostedProvider:provider,mailer:{configured:true,async send(value){mail.push(value);return 'sent';}},clock:()=>new Date(now),log:entry=>logs.push(entry)});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const request=async(path:string,body?:unknown,cookie?:string,csrf?:string,webOrigin=origin)=>{
    const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:webOrigin,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),'Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,headers:response.headers,...await response.json() as {ok:boolean;value:any;error?:{code:string;message:string;retryAfterSeconds?:number}}};
  };
  const advance=()=>{now=new Date(now.getTime()+16*60000);};
  let cookie='',csrf='',accountId='',secondCookie='';const email='rest-bff@example.test',password='Synthetic CloudBase password 123!';
  try{
    await t.test('provider metadata never exposes CloudBase configuration secrets',async()=>{
      const result=await request('/identity/provider');assert.equal(result.status,200);assert.deepEqual(result.value,{provider:'cloudbase',configured:true,emailVerification:'code',passwordMinLength:12,passwordMaxLength:64,resendAfterSeconds:60});assert.equal(JSON.stringify(result).includes(provider.environment),false);
      assert.equal((await request('/identity/verify-email',{token:'old-link'})).error?.code,'identity_method_unavailable');
      assert.equal((await request('/identity/email-code',{email,purpose:'register'},undefined,undefined,'https://untrusted.test')).status,403);
    });
    await t.test('registration establishes only a community cookie and ignores upstream role claims',async()=>{
      const sent=await request('/identity/email-code',{email,purpose:'register'});assert.equal(sent.value.delivery,'sent');
      const limited=await request('/identity/email-code',{email,purpose:'reset_password'});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(limited.error?.retryAfterSeconds,60);assert.equal(logs.at(-1)?.errorSource,'community');assert.equal(logs.at(-1)?.route,'identity.email-code');
      const result=await request('/identity/register',{email,password,code:'123456',verificationId:sent.value.verificationId});assert.equal(result.status,201);
      const setCookie=result.headers.get('set-cookie')!;cookie=setCookie.split(';')[0];csrf=result.value.csrfToken;accountId=result.value.account.accountId;
      assert.ok(setCookie.includes('HttpOnly'));assert.ok(setCookie.includes('SameSite=Lax'));assert.notEqual(accountId,users.get(email)!.sub);assert.equal(result.value.role,'member');
      const serialized=JSON.stringify(result.value);assert.ok(!serialized.includes('fixture-access-'));assert.ok(!serialized.includes('fixture-refresh-'));assert.ok(!serialized.includes(cookie.split('=')[1]));
      const stored=(await fixture.db.query<{password_hash:string|null;auth_provider:string}>('SELECT password_hash,auth_provider FROM accounts WHERE id=$1',[accountId])).rows[0];assert.equal(stored.password_hash,null);assert.equal(stored.auth_provider,'cloudbase');assert.equal(mail.length,0);
      const local=await app.auth.register({email,password});await fixture.db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[local.account.id]);
      const legacy=await app.auth.login({email,password});assert.equal((await request('/me/session',undefined,`loginote_community_session=${legacy.sessionToken}`)).value.kind,'guest');
    });
    await t.test('real profile persists only for the authenticated community account and cannot change identity or role',async()=>{
      assert.equal((await request('/me/profile')).status,401);
      const fresh=await request('/me/profile',undefined,cookie);assert.deepEqual(fresh.value,{accountId,displayName:'合成测试成员',bio:'',interests:[],learningStatistics:{policy:{enabled:false,metrics:['streak','activeDaysThisMonth'],scope:'public',groupIds:[],sourceDeviceId:null,revision:0},snapshot:null,sourceConnected:false}});
      const update={displayName:'独立社区昵称',bio:'用图像理解数学。',interests:['线性代数','阅读','线性代数']};
      const put=async(body:unknown,csrfValue=csrf)=>{
        const response=await fetch(`${base}/me/profile`,{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrfValue,'Idempotency-Key':randomUUID()},body:JSON.stringify(body)});
        return {status:response.status,...await response.json() as {value:any;error?:{code:string}}};
      };
      assert.equal((await put(update,'')).status,403);
      assert.equal((await put({...update,role:'administrator'})).status,400);
      const other=(await fixture.db.query<{id:string}>("SELECT id FROM accounts WHERE auth_provider='local' AND email=$1",[email])).rows[0];
      assert.equal((await put({...update,accountId:other.id})).status,400);
      const saved=await put(update);assert.equal(saved.status,200);assert.deepEqual(saved.value,{accountId,displayName:update.displayName,bio:update.bio,interests:['线性代数','阅读']});
      const reloaded=(await request('/me/profile',undefined,cookie)).value;const {learningStatistics,...profileFields}=reloaded;assert.deepEqual(profileFields,saved.value);assert.equal(learningStatistics.policy.enabled,false);
      assert.equal((await request('/me/session',undefined,cookie)).value.account.displayName,update.displayName);
      assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM account_profiles WHERE account_id=$1',[other.id])).rows[0].n,0);
      assert.equal((await put({...update,interests:Array.from({length:9},(_,i)=>`兴趣${i}`)})).status,400);
      assert.equal((await put({...update,displayName:''})).status,400);
      assert.equal((await request('/me/session',undefined,cookie)).value.role,'member');
    });
    await t.test('authenticated writes require CSRF and refresh preserves account identity',async()=>{
      assert.equal((await request('/objects',{scope:'self'},cookie)).error?.code,'csrf_invalid');
      assert.equal((await request('/objects',{scope:'self',ownerId:randomUUID()},cookie,csrf)).status,400);
      const item=await request('/objects',{scope:'self'},cookie,csrf);assert.equal(item.status,201);assert.equal(item.value.ownerId,accountId);
      advance();const session=await request('/me/session',undefined,cookie);assert.equal(session.value.account.accountId,accountId);assert.equal(refreshes,1);
      assert.equal((await request('/admin/reports',undefined,cookie)).status,403);
    });
    await t.test('upstream errors are sanitized and CAPTCHA cannot create a false success',async()=>{
      advance();const secret='DO_NOT_LEAK_PRIVATE_PROVIDER_ERROR';upstreamError={error:'captcha_required',error_description:secret};
      const result=await request('/identity/email-code',{email:'captcha@example.test',purpose:'register'});assert.equal(result.status,409);assert.equal(result.error?.code,'captcha_required');assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(result.value,undefined);
      const wrong=await request('/identity/login',{email,password:'wrong private password'});assert.equal(wrong.status,401);assert.equal(wrong.error?.code,'invalid_credentials');assert.equal(JSON.stringify(wrong).includes('wrong private password'),false);
      assert.equal(JSON.stringify(logs).includes(secret),false);assert.equal(JSON.stringify(logs).includes(password),false);
    });
    await t.test('reset revokes every hosted cookie while local accounts remain independent',async()=>{
      advance();const another=await request('/identity/login',{email,password});secondCookie=another.headers.get('set-cookie')!.split(';')[0];
      const sent=await request('/identity/email-code',{email,purpose:'reset_password'});
      const reset=await request('/identity/reset-password',{email,password:'New synthetic hosted password 123!',code:'123456',verificationId:sent.value.verificationId});assert.equal(reset.status,200);
      assert.equal((await request('/me/session',undefined,cookie)).value.kind,'guest');assert.equal((await request('/me/session',undefined,secondCookie)).value.kind,'guest');
      assert.equal((await request('/identity/login',{email,password})).status,401);
      const logged=await request('/identity/login',{email,password:'New synthetic hosted password 123!'});assert.equal(logged.value.account.accountId,accountId);cookie=logged.headers.get('set-cookie')!.split(';')[0];csrf=logged.value.csrfToken;
      profileFailure=true;const signedOut=await request('/me/sign-out',{},cookie,csrf);assert.equal(signedOut.status,200);assert.equal(signedOut.value.signedOut,true);assert.ok(signedOut.headers.get('set-cookie')!.includes('Max-Age=0'));profileFailure=false;
      assert.equal((await request('/me/session',undefined,cookie)).value.kind,'guest');
    });
  }finally{await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();}
});
