import assert from 'node:assert/strict';
import test from 'node:test';
import {CloudbaseClient} from '../src/cloudbase.js';
import {ApiError} from '../src/errors.js';

const environment='community-protocol-fixture';
const wireTokens={token_type:'Bearer',access_token:'fixture-access-token',refresh_token:'fixture-refresh-token',expires_in:7200,sub:'fixture-subject'};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
function fixture(responder:(url:URL,init:RequestInit)=>Response|Promise<Response>){
  const calls:Array<{url:URL;init:RequestInit}>=[];
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(String(input));calls.push({url,init:init||{}});return responder(url,init||{});}) as typeof fetch;
  return {client:new CloudbaseClient({environment},fetcher),calls,fetcher};
}
function body(call:{init:RequestInit}){return JSON.parse(String(call.init.body));}
const errorCode=(status:number,code:string)=>(error:unknown)=>error instanceof ApiError&&error.status===status&&error.code===code;

test('CloudBase client uses the public HTTP gateway and keeps full email as password username',async()=>{
  const email=`${'a'.repeat(55)}@example.test`,f=fixture(()=>json(wireTokens));
  const result=await f.client.signIn(email,'Synthetic-Password9!');
  assert.deepEqual(result,{accessToken:wireTokens.access_token,refreshToken:wireTokens.refresh_token,expiresIn:7200,subject:'fixture-subject'});
  assert.equal(f.calls[0].url.href,`https://${environment}.api.tcloudbasegateway.com/auth/v1/signin`);
  assert.deepEqual(body(f.calls[0]),{username:email,password:'Synthetic-Password9!'});
  assert.equal(f.calls[0].init.method,'POST');assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.credentials,'omit');
  assert.equal(new Headers(f.calls[0].init.headers).has('Authorization'),false);
});

test('email code registration/recovery/login scopes and verify field names match provider protocol',async()=>{
  const f=fixture(url=>url.pathname.endsWith('/verify')?json({verification_token:'fixture-verified-email'}):json({verification_id:'fixture-verification',expires_in:600,is_user:true}));
  assert.deepEqual(await f.client.sendEmailCode('fixture@example.test','register'),{verificationId:'fixture-verification',expiresIn:600});
  await f.client.sendEmailCode('fixture@example.test','reset_password');await f.client.sendEmailCode('fixture@example.test','login');
  assert.deepEqual(body(f.calls[0]),{email:'fixture@example.test',target:'ANY'});
  assert.deepEqual(body(f.calls[1]),{email:'fixture@example.test',target:'USER'});
  assert.deepEqual(body(f.calls[2]),{email:'fixture@example.test',target:'USER'});
  assert.deepEqual(await f.client.verifyCode('fixture-verification','012345'),{verificationToken:'fixture-verified-email'});
  assert.equal(f.calls[3].url.pathname,'/auth/v1/verification/verify');
  assert.deepEqual(body(f.calls[3]),{verification_id:'fixture-verification',verification_code:'012345'});
  await assert.rejects(f.client.verifyCode('fixture-verification','12345'),errorCode(400,'invalid_verification_code'));
  assert.equal(f.calls.length,4);
});

test('verified signup and forgotten-password reset use separate documented auth operations',async()=>{
  const f=fixture(url=>url.pathname.endsWith('/signup')?json(wireTokens):json({}));
  await f.client.register({email:'fixture@example.test',password:'Synthetic-Password9!',verificationToken:'fixture-proof',name:'学习者'});
  await f.client.resetPassword({email:'fixture@example.test',password:'New-Synthetic-Password9!',verificationToken:'fixture-proof'});
  assert.equal(f.calls[0].url.pathname,'/auth/v1/signup');
  assert.deepEqual(body(f.calls[0]),{email:'fixture@example.test',password:'Synthetic-Password9!',verification_token:'fixture-proof',name:'学习者'});
  assert.equal(f.calls[1].url.pathname,'/auth/v1/reset');
  assert.deepEqual(body(f.calls[1]),{email:'fixture@example.test',new_password:'New-Synthetic-Password9!',verification_token:'fixture-proof'});
  assert.equal(new Headers(f.calls[1].init.headers).has('Authorization'),false);
});

test('refresh rotates credentials without attaching an expired bearer or public/service key',async()=>{
  const f=fixture(()=>json({...wireTokens,access_token:'rotated-access',refresh_token:'rotated-refresh'}));
  const client=new CloudbaseClient({environment,region:'ap-guangzhou',clientId:'fixture-app',publishableKey:'fixture-public-key'},f.fetcher);
  const result=await client.refresh('old-refresh');
  assert.equal(result.refreshToken,'rotated-refresh');assert.equal(result.accessToken,'rotated-access');
  assert.equal(f.calls[0].url.origin,`https://${environment}.api.tcloudbasegateway.com`);
  assert.equal(f.calls[0].url.searchParams.get('client_id'),'fixture-app');
  assert.deepEqual(body(f.calls[0]),{grant_type:'refresh_token',refresh_token:'old-refresh',client_id:'fixture-app'});
  assert.equal(new Headers(f.calls[0].init.headers).has('Authorization'),false);
  assert.equal(JSON.stringify(f.calls[0]).includes('fixture-public-key'),false);
});

test('userinfo trusts only explicit verified-email booleans and never adopts provider roles',async()=>{
  let value:Record<string,unknown>={sub:'fixture-subject',email:'fixture@example.test',name:'学习者',status:'ACTIVE',groups:[{id:'administrator'}],providers:[{id:'email'}]};
  const f=fixture(()=>json(value));
  assert.deepEqual(await f.client.userInfo('fixture-access'),{subject:'fixture-subject',email:'fixture@example.test',displayName:'学习者'});
  assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].url.pathname,'/auth/v1/user/me');
  assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),'Bearer fixture-access');
  value={...value,email_verified:false};assert.equal((await f.client.userInfo('fixture-access')).emailVerified,false);
  value={...value,email_verified:true};assert.equal((await f.client.userInfo('fixture-access')).emailVerified,true);
  value={...value,email_verified:'true'};await assert.rejects(f.client.userInfo('fixture-access'),errorCode(502,'auth_response_invalid'));
  value={...value,email_verified:true,status:'BLOCKED'};await assert.rejects(f.client.userInfo('fixture-access'),errorCode(403,'auth_account_unavailable'));
  value={sub:'fixture-subject'};assert.deepEqual(await f.client.userInfo('fixture-access'),{subject:'fixture-subject'});
});

test('signout uses bearer header and never includes token in URL or body',async()=>{
  const f=fixture(()=>new Response(null,{status:200}));await f.client.signOut('fixture-access');
  assert.equal(f.calls[0].url.pathname,'/auth/v1/user/signout');assert.deepEqual(body(f.calls[0]),{});
  assert.equal(new Headers(f.calls[0].init.headers).get('Authorization'),'Bearer fixture-access');
  assert.equal(f.calls[0].url.href.includes('fixture-access'),false);
});

test('captcha challenges are not retried or bypassed; provider text and credentials stay private',async()=>{
  const secret='must-never-escape-fixture';
  const f=fixture(()=>json({error:'captcha_required',error_code:4028,error_description:secret,password:secret},400));
  await assert.rejects(f.client.sendEmailCode('fixture@example.test','register'),error=>{
    assert.ok(error instanceof ApiError);assert.equal(error.code,'captcha_required');assert.equal(error.message.includes(secret),false);return true;
  });assert.equal(f.calls.length,1);
  const solved=fixture(()=>json(wireTokens));await solved.client.signIn('fixture@example.test','Synthetic-Password9!','fixture-captcha-proof');
  assert.equal(new Headers(solved.calls[0].init.headers).get('x-captcha-token'),'fixture-captcha-proof');
  const credentials=fixture(()=>json({error:'invalid_username_or_password',error_description:secret},400));
  await assert.rejects(credentials.client.signIn('fixture@example.test',secret),errorCode(401,'invalid_credentials'));
});

test('provider channel failures and limits are distinguished from user verification mistakes',async()=>{
  const unavailable=fixture(()=>json({error:'unimplemented',error_code:12,error_description:'fixture-provider-details'},400));
  await assert.rejects(unavailable.client.verifyCode('fixture-verification','012345'),errorCode(503,'auth_unavailable'));
  const wrong=fixture(()=>json({error:'invalid_argument',error_code:3,error_description:'fixture-private-details'},400));
  await assert.rejects(wrong.client.verifyCode('fixture-verification','012345'),errorCode(400,'invalid_verification_code'));
  const limited=fixture(()=>json({error:'resource_exhausted',error_code:8},400));
  await assert.rejects(limited.client.sendEmailCode('fixture@example.test','login'),error=>error instanceof ApiError&&error.status===429&&error.code==='rate_limited'&&error.retryable);
  assert.equal(limited.calls.length,1);
});

test('unregistered recovery never reports a wrong password; password login points new users to registration',async()=>{
  const missing=fixture(()=>json({error:'user_not_found',error_description:'private fixture mailbox'},400));
  await assert.rejects(missing.client.sendEmailCode('fixture@example.test','reset_password'),error=>error instanceof ApiError&&error.code==='account_unavailable'&&error.status===400&&error.message.includes('先注册')&&!error.message.includes('密码')&&!error.message.includes('private'));
  const login=fixture(()=>json({error:'invalid_username_or_password'},400));
  await assert.rejects(login.client.signIn('fixture@example.test','fixture-password'),error=>error instanceof ApiError&&error.code==='invalid_credentials'&&error.message.includes('先注册'));
});

test('missing verification provider is a service failure, never evidence that a mailbox is unregistered',async()=>{
  const missing=fixture(()=>json({error:'not_found',error_code:5,error_description:'verification provider EMAIL not found'},404));
  await assert.rejects(missing.client.sendEmailCode('fixture@example.test','register'),error=>error instanceof ApiError&&error.status===503&&error.code==='email_provider_unavailable'&&!error.message.includes('先注册'));
  const generic=fixture(()=>json({error:'not_found',error_code:5},404));
  await assert.rejects(generic.client.sendEmailCode('fixture@example.test','register'),errorCode(503,'auth_service_unavailable'));
});

test('configured HTTP email service accepts new mailboxes without SDK-specific provider selection',async()=>{
  const send=fixture((_url,init)=>{
    const input=JSON.parse(String(init.body));
    // Captured compatibility boundary: even lowercase SDK usage causes a 404
    // in the configured environment; the documented minimal HTTP body succeeds.
    if('usage' in input)return json({error:'not_found',error_description:'provider email not found from endpoint'},404);
    assert.equal(input.target,'ANY');return json({verification_id:'new-mailbox-proof',expires_in:600,is_user:false});
  });
  assert.equal((await send.client.sendEmailCode('new@example.test','register')).verificationId,'new-mailbox-proof');
});

test('Singapore uses the international HTTP gateway and unknown regions fail before any request',async()=>{
  const f=fixture(()=>json(wireTokens));
  await new CloudbaseClient({environment,region:'ap-singapore'},f.fetcher).refresh('fixture-refresh');
  assert.equal(f.calls[0].url.origin,`https://${environment}.api.intl.tcloudbasegateway.com`);
  assert.throws(()=>new CloudbaseClient({environment,region:'ap-unknown'},f.fetcher),errorCode(500,'auth_configuration_invalid'));
  assert.equal(f.calls.length,1);
});

test('provider retry time is bounded and distinguishes upstream limits without exposing provider details',async()=>{
  const limited=fixture(()=>new Response(JSON.stringify({error:'resource_exhausted',error_description:'private provider quota details'}),{status:429,headers:{'Content-Type':'application/json','Retry-After':'37'}}));
  await assert.rejects(limited.client.sendEmailCode('fixture@example.test','register'),error=>error instanceof ApiError&&error.code==='rate_limited'&&error.retryAfterSeconds===37&&error.source==='cloudbase'&&!error.message.includes('private'));
  const documented=fixture(()=>json({error:'rate_limit_exceeded'},400));
  await assert.rejects(documented.client.sendEmailCode('fixture@example.test','register'),error=>error instanceof ApiError&&error.retryAfterSeconds===60&&error.source==='cloudbase');
});

test('bad responses, server identities, invalid expiration and redirected/network failures fail closed',async()=>{
  for(const value of [{...wireTokens,sub:'service_account'},{...wireTokens,expires_in:0},{...wireTokens,access_token:''},{...wireTokens,token_type:'Basic'}]){
    const f=fixture(()=>json(value));await assert.rejects(f.client.signIn('fixture@example.test','fixture-password'),errorCode(502,'auth_response_invalid'));
  }
  const malformed=fixture(()=>new Response('<html>unexpected diagnostic with fixture-secret</html>'));
  await assert.rejects(malformed.client.signIn('fixture@example.test','fixture-password'),errorCode(502,'auth_response_invalid'));
  const network=fixture(()=>{throw Error('network diagnostic with fixture-secret');});
  await assert.rejects(network.client.signIn('fixture@example.test','fixture-password'),errorCode(503,'auth_unavailable'));
});

test('response size caps apply to headers and streamed chunks before parsing',async()=>{
  const f=fixture(()=>new Response('fixture-secret',{headers:{'content-length':'99999'}}));
  const client=new CloudbaseClient({environment,maxResponseBytes:128},f.fetcher);
  await assert.rejects(client.signIn('fixture@example.test','fixture-password'),errorCode(502,'auth_response_invalid'));
  const streamed=fixture(()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(80));controller.enqueue(new Uint8Array(80));controller.close();}})));
  await assert.rejects(new CloudbaseClient({environment,maxResponseBytes:128},streamed.fetcher).signIn('fixture@example.test','fixture-password'),errorCode(502,'auth_response_invalid'));
});

test('timeout covers both pending fetch and pending response body',async()=>{
  let aborted=false;
  const pending=fixture((_url,init)=>new Promise<Response>(()=>{init.signal?.addEventListener('abort',()=>{aborted=true;});}));
  await assert.rejects(new CloudbaseClient({environment,timeoutMs:20},pending.fetcher).signIn('fixture@example.test','fixture-password'),errorCode(503,'auth_unavailable'));assert.equal(aborted,true);
  const bodyPending=fixture(()=>new Response(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}})));
  await assert.rejects(new CloudbaseClient({environment,timeoutMs:20},bodyPending.fetcher).userInfo('fixture-access'),errorCode(503,'auth_unavailable'));
});

test('missing provider configuration and malformed environment cannot initiate requests',async()=>{
  let calls=0;const fetcher=(async()=>{calls++;return json(wireTokens);}) as typeof fetch;
  const client=new CloudbaseClient(undefined,fetcher);assert.equal(client.configured,false);
  await assert.rejects(client.signIn('fixture@example.test','fixture-password'),errorCode(503,'auth_not_configured'));
  for(const invalid of ['attacker.test/path','env@attacker.test','env:443','ENV?secret'])assert.throws(()=>new CloudbaseClient({environment:invalid},fetcher),errorCode(500,'auth_configuration_invalid'));
  assert.equal(calls,0);
});
