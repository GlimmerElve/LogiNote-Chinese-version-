import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {request as rawRequest} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {ApiConfig} from '../src/config.js';
import type {Mailer,MailMessage} from '../src/auth.js';
import {createCommunityServer} from '../src/http.js';
import {createDatabase} from '../src/db.js';
import {MAX_FILE_BYTES} from '../src/operations.js';
import {createTestDatabase} from './helpers.js';

type Envelope<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
type Result<T>={status:number;headers:Headers;json:Envelope<T>|null;bytes:Buffer};
type Identity={cookie:string;csrfToken:string;accountId:string};
type Intent={attachmentId:string;uploadToken:string;expiresAt:string;bytes:number;state:string};
const value=<T>(result:Result<T>):T=>{assert.ok(result.status>=200&&result.status<300);assert.ok(result.json?.ok);return result.json.value;};
const denied=<T>(result:Result<T>,status:number,code:string)=>{assert.equal(result.status,status);assert.ok(result.json&&result.json.ok===false);assert.equal(result.json.error.code,code);};

test('private files and service restart persist safely through real HTTP and PostgreSQL',async t=>{
  let fixture:Awaited<ReturnType<typeof createTestDatabase>>;
  try{fixture=await createTestDatabase('http_files');}catch(error){const missing=error as NodeJS.ErrnoException;if(missing.code==='ENOENT'&&missing.path?.endsWith('runtime.json')){t.skip('No isolated PostgreSQL test configuration.');return;}throw error;}
  const parent=path.resolve(tmpdir()),directory=await mkdtemp(path.join(parent,'community-http-files-')),mail:MailMessage[]=[];
  let now=new Date('2026-10-23T03:00:00Z');const clock=()=>new Date(now),origin='http://127.0.0.1:5174';
  const mailer:Mailer={configured:true,async send(message){mail.push(message);return 'sent';}};
  const config:ApiConfig={databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:64*1024*1024,globalDownloadLimitBytes:1024*1024};
  let pool=createDatabase(fixture.url),app=createCommunityServer({db:pool,config,mailer,clock}),base='';
  const start=async()=>{await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;};
  const stop=async()=>{await new Promise<void>(resolve=>app.server.close(()=>resolve()));await pool.close();};
  const request=async<T=unknown>(route:string,options:{method?:string;body?:unknown;binary?:Buffer;identity?:Identity;csrf?:string|false;key?:string;uploadToken?:string;downloadToken?:string;origin?:string;headers?:Record<string,string>;base?:string}={}):Promise<Result<T>>=>{
    const headers:Record<string,string>={Origin:options.origin||origin,...options.headers};if(options.identity)headers.Cookie=options.identity.cookie;
    if(options.csrf!==false&&(options.csrf||options.identity))headers['X-CSRF-Token']=options.csrf||options.identity!.csrfToken;
    if(options.key)headers['Idempotency-Key']=options.key;if(options.uploadToken)headers['X-Upload-Token']=options.uploadToken;if(options.downloadToken)headers['X-Download-Token']=options.downloadToken;
    if(options.body!==undefined)headers['Content-Type']='application/json';if(options.binary)headers['Content-Type']='application/octet-stream';
    const response=await fetch(`${options.base||base}${route}`,{method:options.method||(options.body===undefined?'GET':'POST'),headers,body:options.binary?new Uint8Array(options.binary):options.body===undefined?undefined:JSON.stringify(options.body)});
    const bytes=Buffer.from(await response.arrayBuffer()),json=response.headers.get('content-type')?.startsWith('application/json')?JSON.parse(bytes.toString()) as Envelope<T>:null;
    return {status:response.status,headers:response.headers,json,bytes};
  };
  const password='File HTTP isolated password 123';
  const account=async(label:string):Promise<Identity>=>{
    const email=`${label}@files.example.test`,created=await app.auth.register({email,password});await app.auth.verifyEmail({token:mail.filter(item=>item.to===email).at(-1)!.token});
    const result=await request<{csrfToken:string}>('/identity/login',{body:{email,password}});return {cookie:result.headers.get('set-cookie')!.split(';')[0],csrfToken:value(result).csrfToken,accountId:created.account.id};
  };
  let owner:Identity,reader:Identity,ready:Intent,direct:Intent,objectId='',directId='',downloadToken='',reportId='',reportKey='';
  const bytes=Buffer.from('<script>attachment content must never execute</script>\n'),name='学习记录.html';
  await start();
  try{
    owner=await account('owner');reader=await account('reader');
    objectId=value(await request<{id:string}>('/objects',{body:{scope:'public'},identity:owner,key:randomUUID()})).id;
    directId=value(await request<{id:string}>('/objects',{body:{scope:'direct',recipientAccountIds:[reader.accountId]},identity:owner,key:randomUUID()})).id;
    await t.test('upload intents retry without duplicating grants, bytes commit atomically and download is attachment-only',async()=>{
      const payload={objectId,name,mime:'text/html',bytes:bytes.length},key=randomUUID();
      const attempts=await Promise.all([request<Intent>('/attachments/intents',{body:payload,identity:owner,key}),request<Intent>('/attachments/intents',{body:payload,identity:owner,key})]);ready=value(attempts[0]);assert.equal(value(attempts[1]).attachmentId,ready.attachmentId);assert.equal(value(attempts[1]).uploadToken,ready.uploadToken);
      denied(await request('/attachments/intents',{body:{...payload,name:'different.html'},identity:owner,key}),409,'idempotency_conflict');
      const stored=value(await request<{contentHash:string}>(`/attachments/${ready.attachmentId}/content`,{method:'PUT',binary:bytes,identity:owner,uploadToken:ready.uploadToken}));assert.equal(stored.contentHash,createHash('sha256').update(bytes).digest('hex'));
      value(await request(`/attachments/${ready.attachmentId}/content`,{method:'PUT',binary:bytes,identity:owner,uploadToken:ready.uploadToken}));
      const grant=value(await request<{token:string}>(`/attachments/${ready.attachmentId}/download`,{method:'POST',identity:owner}));downloadToken=grant.token;
      const response=await request(`/attachments/${ready.attachmentId}/content`,{identity:owner,downloadToken});assert.equal(response.status,200);assert.deepEqual(response.bytes,bytes);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.ok(response.headers.get('content-disposition')?.startsWith('attachment;'));assert.ok(response.headers.get('content-disposition')?.includes(encodeURIComponent(name)));assert.equal(Number(response.headers.get('content-length')),bytes.length);
      const attachment=(await fixture.db.query<{upload_token_hash:string}>('SELECT upload_token_hash FROM private_attachments WHERE id=$1',[ready.attachmentId])).rows[0];assert.notEqual(attachment.upload_token_hash,ready.uploadToken);
      const grants=(await fixture.db.query<{token_hash:string}>('SELECT token_hash FROM attachment_download_grants')).rows;assert.equal(grants.some(grant=>grant.token_hash===downloadToken),false);
      const replayResults=JSON.stringify((await fixture.db.query('SELECT result FROM idempotency_results')).rows);assert.equal(replayResults.includes(ready.uploadToken),false);assert.equal(replayResults.includes(downloadToken),false);
    });
    await t.test('upload/download require cookie and current CSRF; pending cancellation releases only its reservation',async()=>{
      const route=`/attachments/${ready.attachmentId}/content`;
      denied(await request(route,{method:'PUT',binary:bytes,uploadToken:ready.uploadToken}),401,'authentication_required');
      denied(await request(route,{method:'PUT',binary:bytes,identity:owner,uploadToken:ready.uploadToken,csrf:false}),403,'csrf_invalid');
      denied(await request(route,{method:'PUT',binary:bytes,identity:owner,uploadToken:'bad'}),403,'invalid_upload_grant');
      denied(await request(route,{method:'PUT',binary:bytes,identity:reader,uploadToken:ready.uploadToken}),404,'not_found');
      denied(await request(route,{downloadToken}),401,'authentication_required');denied(await request(route,{identity:reader,downloadToken}),403,'invalid_download_grant');
      denied(await request(`/attachments/${ready.attachmentId}/download`,{method:'POST',identity:owner,csrf:'expired-csrf'}),403,'csrf_invalid');
      const pending=value(await request<Intent>('/attachments/intents',{body:{objectId,name:'cancel.txt',mime:'text/plain',bytes:4},identity:owner,key:randomUUID()}));
      denied(await request(`/attachments/${pending.attachmentId}`,{method:'DELETE',identity:owner,csrf:false}),403,'csrf_invalid');
      assert.equal(value(await request<{state:string}>(`/attachments/${pending.attachmentId}`,{method:'DELETE',identity:owner})).state,'cancelled');
      const reservation=(await fixture.db.query<{state:string}>('SELECT r.state FROM storage_reservations r JOIN private_attachments a ON a.reservation_id=r.id WHERE a.id=$1',[pending.attachmentId])).rows[0];assert.equal(reservation.state,'released');
      denied(await request(`/attachments/${pending.attachmentId}/content`,{method:'PUT',binary:Buffer.from('data'),identity:owner,uploadToken:pending.uploadToken}),409,'upload_cancelled');
    });
    await t.test('declared content longer than 100 MiB is rejected before receiving bytes',async()=>{
      const result=await new Promise<{status:number;code:string}>((resolve,reject)=>{
        let settled=false;const url=new URL(`${base}/attachments/${ready.attachmentId}/content`);
        const upload=rawRequest(url,{method:'PUT',headers:{Origin:origin,Cookie:owner.cookie,'X-CSRF-Token':owner.csrfToken,'X-Upload-Token':ready.uploadToken,'Content-Type':'application/octet-stream','Content-Length':String(MAX_FILE_BYTES+1)}},response=>{
          const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('end',()=>{settled=true;const body=JSON.parse(Buffer.concat(chunks).toString());resolve({status:response.statusCode!,code:body.error.code});upload.destroy();});
        });upload.on('error',error=>{if(!settled)reject(error);});upload.setTimeout(5000,()=>{upload.destroy();reject(Error('Oversized upload was not rejected promptly.'));});upload.end();
      });assert.deepEqual(result,{status:413,code:'file_too_large'});
    });
    await t.test('revoking read permission invalidates an existing grant and prevents issuing a fresh download token',async()=>{
      direct=value(await request<Intent>('/attachments/intents',{body:{objectId:directId,name:'private.txt',mime:'text/plain',bytes:bytes.length},identity:owner,key:randomUUID()}));
      value(await request(`/attachments/${direct.attachmentId}/content`,{method:'PUT',binary:bytes,identity:owner,uploadToken:direct.uploadToken}));
      const grant=value(await request<{token:string}>(`/attachments/${direct.attachmentId}/download`,{method:'POST',identity:reader}));assert.equal((await request(`/attachments/${direct.attachmentId}/content`,{identity:reader,downloadToken:grant.token})).status,200);
      await fixture.db.query('DELETE FROM direct_object_recipients WHERE object_id=$1 AND account_id=$2',[directId,reader.accountId]);
      denied(await request(`/attachments/${direct.attachmentId}/content`,{identity:reader,downloadToken:grant.token}),403,'forbidden');
      denied(await request(`/attachments/${direct.attachmentId}/download`,{method:'POST',identity:reader}),403,'forbidden');
      now=new Date(now.getTime()+5*60000+1);denied(await request(`/attachments/${ready.attachmentId}/content`,{identity:owner,downloadToken}),403,'invalid_download_grant');
    });
    await t.test('zero storage and distribution budgets fail closed without a pending upload or consumed download grant',async()=>{
      const fresh=value(await request<{token:string}>(`/attachments/${ready.attachmentId}/download`,{method:'POST',identity:owner}));
      const disabled=createCommunityServer({db:pool,config:{...config,globalStorageLimitBytes:0,globalDownloadLimitBytes:0},mailer,clock});await new Promise<void>(resolve=>disabled.server.listen(0,'127.0.0.1',resolve));
      const disabledBase=`http://127.0.0.1:${(disabled.server.address() as AddressInfo).port}/api/community/v1`;
      try{
        const before=await fixture.db.query('SELECT id FROM private_attachments');denied(await request('/attachments/intents',{body:{objectId,name:'budget.txt',mime:'text/plain',bytes:3},identity:owner,key:randomUUID(),base:disabledBase}),503,'not_configured');assert.equal((await fixture.db.query('SELECT id FROM private_attachments')).rowCount,before.rowCount);
        assert.equal(value(await request<{storage:string}>('/health',{base:disabledBase})).storage,'not_configured');
        denied(await request(`/attachments/${ready.attachmentId}/download`,{method:'POST',identity:owner,base:disabledBase}),503,'not_configured');
        denied(await request(`/attachments/${ready.attachmentId}/content`,{identity:owner,downloadToken:fresh.token,base:disabledBase}),503,'not_configured');
      }finally{await new Promise<void>(resolve=>disabled.server.close(()=>resolve()));}
    });
    await t.test('closing the service and its pool then starting a fresh pool/server preserves session, report, idempotency and stored bytes',async()=>{
      reportKey=randomUUID();const payload={targetType:'account',targetId:owner.accountId,body:'HTTP restart report'};
      reportId=value(await request<{id:string}>('/reports',{body:payload,identity:reader,key:reportKey})).id;
      const pending=value(await request<Intent>('/attachments/intents',{body:{objectId,name:'pending-restart.txt',mime:'text/plain',bytes:4},identity:owner,key:randomUUID()}));
      await stop();pool=createDatabase(fixture.url);app=createCommunityServer({db:pool,config,mailer,clock});await start();
      const session=value(await request<{kind:string;account:{accountId:string};csrfToken:string}>('/me/session',{identity:owner}));assert.equal(session.kind,'authenticated');assert.equal(session.account.accountId,owner.accountId);assert.equal(session.csrfToken,owner.csrfToken);
      assert.equal(value(await request<{id:string}>(`/reports/${reportId}`,{identity:reader})).id,reportId);
      assert.equal(value(await request<{id:string}>('/reports',{body:payload,identity:reader,key:reportKey})).id,reportId);
      const grant=value(await request<{token:string}>(`/attachments/${ready.attachmentId}/download`,{method:'POST',identity:owner}));assert.deepEqual((await request(`/attachments/${ready.attachmentId}/content`,{identity:owner,downloadToken:grant.token})).bytes,bytes);
      value(await request(`/attachments/${pending.attachmentId}/content`,{method:'PUT',binary:Buffer.from('data'),identity:owner,uploadToken:pending.uploadToken}));
      const leakCheck=JSON.stringify((await fixture.db.query('SELECT result FROM idempotency_results')).rows);assert.equal(leakCheck.includes(grant.token),false);assert.equal(leakCheck.includes(pending.uploadToken),false);
    });
  }finally{
    await stop();await fixture.cleanup();
    const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('community-http-files-'));await rm(resolved,{recursive:true,force:true});
  }
});
