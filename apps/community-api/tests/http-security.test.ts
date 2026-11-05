import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {ApiConfig} from '../src/config.js';
import type {MailMessage,Mailer} from '../src/auth.js';
import {createCommunityServer,type SafeLog} from '../src/http.js';
import {totpAt} from '../src/security.js';
import {createTestDatabase} from './helpers.js';

type Envelope<T>={ok:true;value:T;requestId:string}|{ok:false;error:{code:string;message:string;retryable:boolean};requestId:string};
type Result<T>={status:number;headers:Headers;body:Envelope<T>};
type Session={kind:'authenticated';account:{accountId:string;displayName:string;email:string};role:'member'|'administrator';expiresAt:string;csrfToken:string;mfa:string};
type Identity=Session&{cookie:string;token:string};
const value=<T>(result:Result<T>):T=>{assert.ok(result.status>=200&&result.status<300);assert.ok(result.body.ok);return result.body.value;};
const denied=<T>(result:Result<T>,status:number,code:string)=>{assert.equal(result.status,status);assert.ok(result.body.ok===false);assert.equal(result.body.error.code,code);};

test('HTTP security and governance use real sessions and isolated PostgreSQL',async t=>{
  let fixture:Awaited<ReturnType<typeof createTestDatabase>>;
  try{fixture=await createTestDatabase('http_security');}catch(error){const missing=error as NodeJS.ErrnoException;if(missing.code==='ENOENT'&&missing.path?.endsWith('runtime.json')){t.skip('No isolated PostgreSQL test configuration.');return;}throw error;}
  const mail:MailMessage[]=[],logs:SafeLog[]=[],webOrigin='http://127.0.0.1:5174';let now=new Date('2026-10-23T01:00:00Z');
  const mailer:Mailer={configured:true,async send(message){mail.push(message);return 'sent';}};
  const config:ApiConfig={databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin,allowedOrigins:[webOrigin],secureCookies:false,dataDirectory:'.data/http-security-unused',globalStorageLimitBytes:0};
  const app=createCommunityServer({db:fixture.db,config,mailer,clock:()=>new Date(now),log:entry=>logs.push(entry)});
  await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const request=async<T=unknown>(path:string,options:{method?:string;body?:unknown;identity?:Identity;csrf?:string|false;origin?:string|false;key?:string;headers?:Record<string,string>}={}):Promise<Result<T>>=>{
    const headers:Record<string,string>={...options.headers};if(options.origin!==false)headers.Origin=options.origin||webOrigin;
    if(options.identity)headers.Cookie=options.identity.cookie;
    if(options.csrf!==false&&(options.csrf||options.identity))headers['X-CSRF-Token']=options.csrf||options.identity!.csrfToken;
    if(options.key)headers['Idempotency-Key']=options.key;if(options.body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(`${base}${path}`,{method:options.method||(options.body===undefined?'GET':'POST'),headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
    return {status:response.status,headers:response.headers,body:response.status===204?{ok:true,value:undefined as T,requestId:response.headers.get('x-request-id')!}:await response.json() as Envelope<T>};
  };
  const password='HTTP isolated password 123';
  const createAccount=async(label:string,administrator=false)=>{
    const email=`${label}@http.example.test`,registered=await app.auth.register({email,password,displayName:label});
    await app.auth.verifyEmail({token:mail.filter(message=>message.to===email&&message.purpose==='verify_email').at(-1)!.token});
    if(administrator)await fixture.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[registered.account.id]);return registered.account;
  };
  const login=async(email:string):Promise<Identity>=>{
    const result=await request<Session>('/identity/login',{body:{email,password}}),session=value(result),setCookie=result.headers.get('set-cookie')!;
    const cookie=setCookie.split(';')[0],token=cookie.slice(cookie.indexOf('=')+1);
    assert.equal(JSON.stringify(result.body).includes(token),false);assert.equal(Object.hasOwn(session,'sessionToken'),false);
    assert.ok(setCookie.includes('HttpOnly'));assert.ok(setCookie.includes('SameSite=Lax'));assert.ok(setCookie.includes('Path=/'));assert.ok(setCookie.includes('Max-Age='));
    assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(result.headers.get('x-request-id'),result.body.requestId);
    return {...session,cookie,token};
  };
  let owner:Identity,reporter:Identity,administrator:Identity,outsider:Identity,reportId='',secret='';
  try{
    const ownerAccount=await createAccount('owner'),reporterAccount=await createAccount('reporter'),adminAccount=await createAccount('administrator',true),outsiderAccount=await createAccount('outsider');
    await t.test('public identity workflows verify email and never permit owner/role claims',async()=>{
      denied(await request('/identity/register',{body:{email:'claim@http.example.test',password,role:'administrator'}}),400,'invalid_request');
      const registered=value(await request<{account:{id:string};delivery:string}>('/identity/register',{body:{email:'unverified@http.example.test',password}}));assert.equal(registered.delivery,'sent');
      assert.equal((await fixture.db.query<{role:string}>('SELECT role FROM accounts WHERE id=$1',[registered.account.id])).rows[0].role,'member');
      denied(await request('/identity/login',{body:{email:'unverified@http.example.test',password}}),403,'email_not_verified');
      const token=mail.filter(message=>message.to==='unverified@http.example.test').at(-1)!.token;assert.equal(value(await request<{verified:boolean}>('/identity/verify-email',{body:{token}})).verified,true);
      denied(await request('/identity/verify-email',{body:{token}}),400,'invalid_token');
      owner=await login(ownerAccount.email);reporter=await login(reporterAccount.email);administrator=await login(adminAccount.email);outsider=await login(outsiderAccount.email);
      assert.equal(owner.account.accountId,ownerAccount.id);assert.equal(owner.role,'member');assert.equal(administrator.mfa,'enrollment_required');
      denied(await request('/identity/login',{body:{email:ownerAccount.email,password,actor:{accountId:adminAccount.id,role:'administrator',mfaVerified:true}}}),400,'invalid_request');
    });
    await t.test('guest and forged actor headers cannot access private data or acquire administrative authority',async()=>{
      assert.deepEqual(value(await request('/me/session')),{kind:'guest'});
      const forged={'X-Actor-Id':adminAccount.id,'X-Role':'administrator','X-Mfa-Verified':'true'};
      denied(await request('/admin/reports',{headers:forged}),401,'authentication_required');
      denied(await request('/admin/reports',{identity:owner,headers:forged}),403,'forbidden');
      denied(await request('/objects',{body:{scope:'public'},headers:forged,key:randomUUID()}),401,'authentication_required');
      denied(await request('/objects',{body:{scope:'public',ownerId:adminAccount.id,role:'administrator'},identity:owner,key:randomUUID()}),400,'invalid_request');
      const object=value(await request<{id:string;ownerId:string}>('/objects',{body:{scope:'self'},identity:owner,key:randomUUID()}));assert.equal(object.ownerId,ownerAccount.id);
      denied(await request(`/objects/${object.id}`,{headers:forged}),403,'forbidden');denied(await request(`/objects/${object.id}`,{identity:outsider}),403,'forbidden');
      assert.equal(value(await request<{id:string}>(`/objects/${object.id}`,{identity:owner})).id,object.id);
    });
    await t.test('Origin and CSRF are enforced independently and CORS never reflects an untrusted origin',async()=>{
      const rejected=await request('/me/session',{origin:'https://untrusted.example.test'});denied(rejected,403,'origin_forbidden');assert.equal(rejected.headers.get('access-control-allow-origin'),null);
      denied(await request('/objects',{body:{scope:'public'},identity:owner,origin:false,key:randomUUID()}),403,'origin_forbidden');
      denied(await request('/objects',{body:{scope:'public'},identity:owner,origin:'null',key:randomUUID()}),403,'origin_forbidden');
      denied(await request('/objects',{body:{scope:'public'},identity:owner,csrf:false,key:randomUUID()}),403,'csrf_invalid');
      denied(await request('/objects',{body:{scope:'public'},identity:owner,csrf:'wrong',key:randomUUID()}),403,'csrf_invalid');
      denied(await request('/objects',{body:{scope:'public'},identity:owner}),400,'idempotency_required');
      const preflight=await request('/objects',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-csrf-token,idempotency-key'}});assert.equal(preflight.status,204);
      assert.equal(preflight.headers.get('access-control-allow-origin'),webOrigin);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
      denied(await request('/objects',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-actor-id'}}),400,'invalid_request');
      denied(await request('/me/sign-out',{method:'POST',identity:owner,csrf:false}),403,'csrf_invalid');assert.equal(value(await request<Session>('/me/session',{identity:owner})).account.accountId,ownerAccount.id);
    });
    await t.test('report creation is atomic and idempotent; administrators need real MFA before queue, assignment and evidence',async()=>{
      const body={targetType:'account',targetId:ownerAccount.id,body:'HTTP account report',evidence:'private evidence fixture'},key=randomUUID();
      const results=await Promise.all([request<{id:string}>('/reports',{body,identity:reporter,key}),request<{id:string}>('/reports',{body,identity:reporter,key})]);reportId=value(results[0]).id;assert.equal(value(results[1]).id,reportId);
      assert.equal((await fixture.db.query<{count:string}>('SELECT count(*)::text AS count FROM reports WHERE id=$1',[reportId])).rows[0].count,'1');
      denied(await request('/reports',{body:{...body,body:'different request'},identity:reporter,key}),409,'idempotency_conflict');
      denied(await request(`/reports/${reportId}`,{identity:outsider}),403,'forbidden');denied(await request('/admin/reports',{identity:administrator}),403,'forbidden');
      denied(await request(`/admin/reports/${reportId}/assign`,{body:{},identity:administrator,key:randomUUID()}),403,'forbidden');
      denied(await request('/me/mfa/enroll',{body:{password},identity:owner}),403,'forbidden');
      denied(await request('/me/mfa/enroll',{body:{password},identity:administrator,csrf:false}),403,'csrf_invalid');
      const setup=value(await request<{secret:string}>('/me/mfa/enroll',{body:{password},identity:administrator}));secret=setup.secret;
      const otp=totpAt(secret,BigInt(Math.floor(now.getTime()/30000)));assert.equal(value(await request<Session>('/me/mfa/confirm',{body:{code:otp},identity:administrator})).mfa,'verified');
      assert.equal(value(await request<Session>('/me/session',{identity:administrator})).mfa,'verified');
      const queue=value(await request<{id:string}[]>('/admin/reports',{identity:administrator}));assert.ok(queue.some(report=>report.id===reportId));assert.equal(JSON.stringify(queue).includes(body.evidence),false);
      denied(await request(`/admin/reports/${reportId}/evidence`,{identity:administrator}),403,'forbidden');
      value(await request(`/admin/reports/${reportId}/assign`,{body:{},identity:administrator,key:randomUUID()}));
      denied(await request(`/admin/reports/${reportId}/evidence`,{identity:administrator,csrf:false}),403,'csrf_invalid');
      assert.equal(value(await request<{evidence:{body:string}[]}>(`/admin/reports/${reportId}/evidence`,{identity:administrator})).evidence[0].body,body.evidence);
    });
    await t.test('HTTP decisions restrict actual writes; a permitted appeal and verified review restore capability',async()=>{
      const decision={action:'restrict_account',reason:'HTTP verified restriction',capabilities:['write'],expiresAt:new Date(now.getTime()+3600000).toISOString()},key=randomUUID();
      const first=value(await request<{decisionId:string}>(`/admin/reports/${reportId}/decisions`,{body:decision,identity:administrator,key}));
      const replay=value(await request<{decisionId:string}>(`/admin/reports/${reportId}/decisions`,{body:decision,identity:administrator,key}));assert.equal(first.decisionId,replay.decisionId);
      denied(await request('/objects',{body:{scope:'public'},identity:owner,key:randomUUID()}),403,'forbidden');
      const appeal=value(await request<{id:string}>(`/reports/${reportId}/appeals`,{body:{body:'The account owner appeals this decision'},identity:owner,key:randomUUID()}));
      now=new Date(now.getTime()+10*60000+1);denied(await request('/admin/reports',{identity:administrator}),403,'forbidden');
      denied(await request(`/admin/appeals/${appeal.id}/review`,{body:{outcome:'restore',reason:'expired MFA cannot restore'},identity:administrator,key:randomUUID()}),403,'forbidden');
      const otp=totpAt(secret,BigInt(Math.floor(now.getTime()/30000)));assert.equal(value(await request<Session>('/me/mfa/challenge',{body:{code:otp},identity:administrator})).mfa,'verified');
      value(await request(`/admin/appeals/${appeal.id}/review`,{body:{outcome:'restore',reason:'Restored after verified evidence review'},identity:administrator,key:randomUUID()}));
      assert.equal(value(await request<{ownerId:string}>('/objects',{body:{scope:'public'},identity:owner,key:randomUUID()})).ownerId,ownerAccount.id);
      const events=value(await request<{eventType:string}[]>(`/admin/reports/${reportId}/audit`,{identity:administrator}));assert.ok(events.some(event=>event.eventType==='report.decided'));assert.ok(events.some(event=>event.eventType==='appeal.reviewed'));assert.ok(events.some(event=>event.eventType==='evidence.read'));
      await fixture.db.query("UPDATE accounts SET role='member' WHERE id=$1",[adminAccount.id]);denied(await request('/admin/reports',{identity:administrator}),403,'forbidden');
      const signOut=await request('/me/sign-out',{method:'POST',identity:owner});value(signOut);assert.ok(signOut.headers.get('set-cookie')?.includes('Max-Age=0'));assert.deepEqual(value(await request('/me/session',{identity:owner})),{kind:'guest'});
    });
    await t.test('production cookie has Secure and __Host prefix; structured logs contain no credentials or private evidence',async()=>{
      const secure=createCommunityServer({db:fixture.db,config:{...config,secureCookies:true},mailer,clock:()=>new Date(now)});
      await new Promise<void>(resolve=>secure.server.listen(0,'127.0.0.1',resolve));
      try{const response=await fetch(`http://127.0.0.1:${(secure.server.address() as AddressInfo).port}/api/community/v1/identity/login`,{method:'POST',headers:{Origin:webOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:reporterAccount.email,password})});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie')!;assert.ok(cookie.startsWith('__Host-community_session='));assert.ok(cookie.includes('; Secure'));assert.ok(cookie.includes('; Path=/'));await response.arrayBuffer();}finally{await new Promise<void>(resolve=>secure.server.close(()=>resolve()));}
      const serialized=JSON.stringify(logs);for(const secretValue of [password,owner.token,reporter.token,administrator.token,secret,'private evidence fixture'])assert.equal(serialized.includes(secretValue),false);
      assert.ok(logs.length>20);assert.ok(logs.every(entry=>typeof entry.requestId==='string'&&typeof entry.route==='string'&&Number.isInteger(entry.status)));
    });
  }finally{await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();}
});
