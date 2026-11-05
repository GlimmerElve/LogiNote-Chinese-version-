import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import type {MailMessage} from '../src/auth.js';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';
import {strToU8,zipSync} from 'fflate';
type Identity={accountId:string;cookie:string;csrf:string};
test('resource files, immutable versions and account-authorized desktop delivery use real PostgreSQL and private disk',async t=>{
  const database=await createTestDatabase('resource_delivery'),directory=await mkdtemp(path.resolve('.ui-preview-resource-test-')),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-24T06:00:00Z');
  const config={databaseUrl:database.url,encryptionKey:database.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:1024*1024*1024,globalDownloadLimitBytes:1024*1024*1024,authProvider:'local' as const};
  const app=createCommunityServer({db:database.db,config,clock:()=>new Date(now),mailer:{configured:true,async send(message){mail.push(message);return 'sent';}}});await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const request=async(route:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',extra:{key?:string;device?:string;headers?:Record<string,string>;raw?:Uint8Array}={})=>{const response=await fetch(base+route,{method,headers:{'X-Community-Protocol':'2',Origin:origin,...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(extra.device?{Authorization:'Bearer '+extra.device}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(extra.raw?{'Content-Type':'application/octet-stream'}:{}),'Idempotency-Key':extra.key||randomUUID(),...extra.headers},body:extra.raw?Buffer.from(extra.raw):body===undefined?undefined:JSON.stringify(route==='/desktop/claim'||route.endsWith('/validate')?{...Object(body),protocol:2}:body)});const type=response.headers.get('content-type')||'';return {status:response.status,...(type.includes('application/json')?await response.json() as {ok:boolean;value:any;error:any}:{bytes:new Uint8Array(await response.arrayBuffer())})} as any;};
  const account=async(label:string)=>{const email=label+'@resource.example.test',created=await app.auth.register({email,password:'Resource fixture password 2026!',displayName:label});await app.auth.verifyEmail({token:mail.at(-1)!.token});const logged=await app.auth.login({email,password:'Resource fixture password 2026!'});return {accountId:created.account.id,cookie:'loginote_community_session='+logged.sessionToken,csrf:logged.csrfToken};};
  const a=await account('resource-A'),b=await account('resource-B');
  const bundle=strToU8('%PDF-1.4\nBasic material fixture');let resource='',stage='',main='',device='',token='',task:any;
  const upload=async(who:Identity,stageId:string,name:string,bytes:Uint8Array,role='main')=>{const input={name,mime:name.endsWith('.pdf')?'application/pdf':'application/octet-stream',bytes:bytes.length,role},key=randomUUID();const intent=await request(`/resource-stages/${stageId}/files`,who,input,'POST',{key});assert.equal(intent.status,201,JSON.stringify(intent.error));const repeated=await request(`/resource-stages/${stageId}/files`,who,input,'POST',{key});assert.equal(repeated.value.attachmentId,intent.value.attachmentId);const stored=await request(`/attachments/${intent.value.attachmentId}/content`,who,undefined,'PUT',{headers:{'X-Upload-Token':intent.value.uploadToken},raw:bytes});assert.equal(stored.status,200,JSON.stringify(stored.error));return intent.value.attachmentId as string;};
  try{
    await t.test('staged files are private, uploads replay and publication atomically exposes the chosen version',async()=>{
      stage=(await request('/resource-stages',a,{})).value.stageId;main=await upload(a,stage,'线代资料.pdf',bundle);assert.equal((await request('/resource-stages/'+stage,b)).status,403);assert.equal((await request(`/attachments/${main}/download`,b,{})).status,403);assert.equal((await request('/entries',b,{kind:'resource',title:'takeover',body:'takeover',stageId:stage})).status,403);
      const input={kind:'resource',title:'线代体系分享',body:'包含目录与向量的讲解。',stageId:stage,resourceType:'note',scope:'public'},key=randomUUID();const published=await request('/entries',a,input,'POST',{key});assert.equal(published.status,201,JSON.stringify(published.error));resource=published.value.id;assert.equal((await request('/entries',a,input,'POST',{key})).value.id,resource);
      const version=(await request(`/entries/${resource}/versions`,b)).value.current;assert.equal(version.preview.format,'pdf');assert.equal(version.delivery.kind,'file');assert.equal(version.files[0].id,main);assert.deepEqual(version.preview.items,[]);assert.equal((await request(`/attachments/${main}/download`,b,{})).status,200);assert.equal((await request(`/resource-stages/${stage}/files`,a,{name:'late.pdf',mime:'application/pdf',bytes:10,role:'attachment'})).status,404);
    });
    await t.test('complex package and video uploads are rejected; removing ordinary unpublished ZIP frees actual quota',async()=>{
      const stageId=(await request('/resource-stages',a,{})).value.stageId,bytes=zipSync({'note.md':strToU8('not a standard package')}),rejected=await request(`/resource-stages/${stageId}/files`,a,{name:'bad.lnresource',mime:'application/octet-stream',bytes:bytes.length,role:'main'});assert.equal(rejected.status,400);assert.equal(rejected.error.code,'not_in_scope');assert.equal((await request(`/resource-stages/${stageId}/files`,a,{name:'video.mp4',mime:'video/mp4',bytes:bytes.length,role:'main'})).status,400);const id=await upload(a,stageId,'ordinary.zip',bytes);
      const before=Number((await database.db.query("SELECT COALESCE(sum(bytes),0) AS n FROM storage_reservations WHERE account_id=$1 AND state='committed'",[a.accountId])).rows[0].n);assert.equal((await request(`/resource-stages/${stageId}/files/${id}`,a,undefined,'DELETE')).status,200);assert.equal((await request(`/attachments/${id}/download`,a,{})).status,404);assert.equal(Number((await database.db.query("SELECT COALESCE(sum(bytes),0) AS n FROM storage_reservations WHERE account_id=$1 AND state='committed'",[a.accountId])).rows[0].n),before);await app.files.cleanupExpired();const after=Number((await database.db.query("SELECT COALESCE(sum(bytes),0) AS n FROM storage_reservations WHERE account_id=$1 AND state='committed'",[a.accountId])).rows[0].n);assert.equal(before-after,bytes.length);
    });
    await t.test('join learning creates one private durable receipt while desktop is offline',async()=>{
      const key=randomUUID();assert.equal((await request(`/entries/${resource}/learning`,b,{enabled:true},'PUT',{key})).status,200);assert.equal((await request(`/entries/${resource}/learning`,b,{enabled:true},'PUT')).status,200);const receipts=(await request('/me/receipts',b)).value;assert.equal(receipts.length,1);assert.equal(receipts[0].state,'queued');assert.equal((await request('/me/receipts',a)).value.length,0);assert.equal((await request('/me/receipts')).status,401);
    });
    await t.test('pair code requires account approval; polling secret and native device identity cannot be substituted',async()=>{
      const targetKey=randomUUID(),pair=(await request('/desktop/pairings',undefined,{label:'合成桌面 B',targetKey})).value;assert.equal((await request(`/desktop/pairings/${pair.pairingId}`,undefined,{claimToken:pair.claimToken})).value.state,'pending');assert.equal((await request(`/desktop/pairings/${pair.pairingId}`,undefined,{claimToken:'invalid'})).status,403);assert.equal((await request('/me/devices/approve',b,{code:pair.code})).status,200);const connected=(await request(`/desktop/pairings/${pair.pairingId}`,undefined,{claimToken:pair.claimToken})).value;assert.equal(connected.accountId,b.accountId);assert.equal(connected.targetKey,targetKey);device=connected.deviceId;token=connected.token;assert.equal((await request(`/desktop/pairings/${pair.pairingId}`,undefined,{claimToken:pair.claimToken})).value.token,token);assert.equal((await request('/me/devices',a)).value.length,0);assert.equal((await request('/desktop/session',undefined,undefined,'GET',{device:token})).value.accountId,b.accountId);assert.equal((await request('/admin/reports',undefined,undefined,'GET',{device:token})).status,401);
    });
    await t.test('claim/download/acknowledge are device, account, version and lease bound and survive repeated receipts',async()=>{
      task=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.ok(task);assert.equal(task.version.version,1);assert.equal((await request(`/desktop/receipts/${task.id}/files/${main}`,undefined,undefined,'GET',{device:token,headers:{'X-Receipt-Lease':'wrong'}})).status,403);const downloaded=await request(`/desktop/receipts/${task.id}/files/${main}`,undefined,undefined,'GET',{device:token,headers:{'X-Receipt-Lease':task.leaseToken}});assert.deepEqual(downloaded.bytes,bundle);assert.equal((await request(`/desktop/receipts/${task.id}/validate`,undefined,{leaseToken:task.leaseToken},'POST',{device:token})).status,200);
      const input={leaseToken:task.leaseToken,state:'imported',localIds:['community-synthetic-copy']};assert.equal((await request(`/desktop/receipts/${task.id}`,undefined,input,'PUT',{device:token})).status,200);assert.equal((await request(`/desktop/receipts/${task.id}`,undefined,input,'PUT',{device:token})).status,200);assert.equal((await request('/desktop/claim',undefined,{},'POST',{device:token})).value,null);assert.equal((await request('/me/receipts',b)).value[0].state,'imported');assert.equal((await request(`/desktop/receipts/${task.id}`,undefined,{...input,localIds:['C:/private/path']},'PUT',{device:token})).status,400);
    });
    await t.test('author updates create immutable versions and do not silently enqueue the new version',async()=>{
      const old=(await request(`/entries/${resource}/versions`,b)).value.current;assert.equal((await request(`/entries/${resource}`,a,{title:'新版介绍',body:'第二版分享介绍',topics:[]},'PUT')).status,200);const current=(await request(`/entries/${resource}/versions`,b)).value;assert.equal(current.current.version,2);assert.equal(current.versions.length,2);assert.equal((await request(`/entries/${resource}/versions/${old.id}`,b)).value.body,'包含目录与向量的讲解。');assert.equal((await request('/me/receipts',b)).value.length,1);
    });
    await t.test('explicit version receipt, cancellation and retry cannot reuse a previous lease',async()=>{
      const current=(await request(`/entries/${resource}/versions`,b)).value.current;
      const enqueued=await request(`/entries/${resource}/receive`,b,{versionId:current.id});assert.equal(enqueued.status,201);
      assert.equal((await request('/me/receipts',b)).value.length,2);
      const claimed=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.equal(claimed.version.version,2);
      assert.equal((await request(`/me/receipts/${claimed.id}`,a,{action:'cancel'},'PUT')).status,404);
      assert.equal((await request(`/me/receipts/${claimed.id}`,b,{action:'cancel'},'PUT')).status,200);
      assert.equal((await request(`/desktop/receipts/${claimed.id}/validate`,undefined,{leaseToken:claimed.leaseToken},'POST',{device:token})).status,403);
      await request(`/me/receipts/${claimed.id}`,b,{action:'retry'},'PUT');const retried=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.equal(retried.id,claimed.id);assert.notEqual(retried.leaseToken,claimed.leaseToken);
      assert.equal((await request(`/desktop/receipts/${claimed.id}`,undefined,{leaseToken:claimed.leaseToken,state:'imported',localIds:['old-lease']},'PUT',{device:token})).status,403);
      assert.equal((await request(`/desktop/receipts/${retried.id}`,undefined,{leaseToken:retried.leaseToken,state:'imported',localIds:['version-two']},'PUT',{device:token})).status,200);
    });
    await t.test('group exit revokes preview, browser grants and queued native receipt without bypass through saved relationships',async()=>{
      const groupId=randomUUID();await database.db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[groupId,a.accountId]);for(const who of [a,b])await database.db.query("INSERT INTO group_memberships(group_id,account_id,role,state) VALUES($1,$2,$3,'active')",[groupId,who.accountId,who===a?'owner':'member']);
      const stageId=(await request('/resource-stages',a,{})).value.stageId,fileId=await upload(a,stageId,'group.pdf',strToU8('%PDF-1.4\ngroup fixture'));
      const groupEntry=(await request('/entries',a,{kind:'resource',title:'群资料',body:'群内文件',scope:'group',groupId,stageId})).value.id;
      await request(`/entries/${groupEntry}/learning`,b,{enabled:true},'PUT');assert.equal((await request(`/attachments/${fileId}/download`,b,{})).status,200);
      await database.db.query("UPDATE group_memberships SET state='left' WHERE group_id=$1 AND account_id=$2",[groupId,b.accountId]);
      assert.equal((await request(`/entries/${groupEntry}/versions`,b)).status,403);assert.equal((await request(`/attachments/${fileId}/download`,b,{})).status,403);
      assert.equal((await request('/desktop/claim',undefined,{},'POST',{device:token})).value,null);assert.equal((await request('/me/receipts',b)).value.find((row:any)=>row.entryId===groupEntry).state,'blocked');
      assert.equal((await request(`/entries/${groupEntry}/receive`,b,{})).status,403);
    });
    await t.test('bookmarks and browser downloads do not enqueue; link, video and single snapshot have typed immutable delivery',async()=>{
      const count=(await request('/me/receipts',b)).value.length;
      const created=await request('/entries',a,{kind:'resource',title:'网页',body:'https://example.org/material',resourceType:'link',scope:'public'});const id=created.value.id;
      assert.equal((await request(`/entries/${id}/bookmark`,b,{enabled:true},'PUT')).status,200);
      assert.equal((await request('/me/receipts',b)).value.length,count);
      const first=(await request(`/entries/${id}/versions`,b)).value.current;assert.deepEqual(first.delivery,{kind:'link',url:'https://example.org/material'});
      await request(`/entries/${id}`,a,{title:'内容新版',body:'独立只读正文',topics:[]},'PUT');
      assert.equal((await request(`/entries/${id}/versions/${first.id}`,b)).value.delivery.kind,'link');
      const snap=(await request(`/entries/${id}/versions`,b)).value.current;assert.equal(snap.delivery.kind,'snapshot');
      await request(`/entries/${id}/receive`,b,{versionId:first.id});assert.equal((await request('/me/receipts',b)).value.length,count+1);
      const video=(await request('/entries',a,{kind:'resource',title:'视频链接',body:'https://www.bilibili.com/video/BVfixture',resourceType:'link',scope:'public'})).value;
      assert.equal((await request(`/entries/${video.id}/versions`,b)).value.current.delivery.kind,'video-link');
      const pdfFile=(await request(`/entries/${resource}/versions`,b)).value.current.files[0];await request(`/attachments/${pdfFile.id}/download`,b,{});assert.equal((await request('/me/receipts',b)).value.length,count+1);
      const old=await fetch(base+'/desktop/claim',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(old.status,409);assert.equal((await old.json()).error.code,'protocol_update_required');
      const claim=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.ok(claim);assert.equal(claim.version.delivery.kind,'link');
      const validate=await fetch(base+'/desktop/receipts/'+claim.id+'/validate',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({leaseToken:claim.leaseToken})});assert.equal(validate.status,409);
      await request('/desktop/receipts/'+claim.id,undefined,{leaseToken:claim.leaseToken,state:'imported',kind:'link',localIds:['community-link-reference']},'PUT',{device:token});
    });
    await t.test('a 100 MiB file survives upload, publication and authorized browser and desktop downloads',async()=>{
      const size=100*1024*1024,bytes=Buffer.alloc(size,32);bytes.write('%PDF-1.7\n');const digest=createHash('sha256').update(bytes).digest('hex');
      const stageId=(await request('/resource-stages',a,{})).value.stageId;
      const oversized=await request('/resource-stages/'+stageId+'/files',a,{name:'too-large.pdf',mime:'application/pdf',bytes:size+1,role:'main'});assert.equal(oversized.status,413);
      const fileId=await upload(a,stageId,'100MiB-boundary.pdf',bytes),published=await request('/entries',a,{kind:'resource',body:'100 MiB binary boundary fixture',title:'Large file fixture',stageId,scope:'public'});assert.equal(published.status,201);
      const id=published.value.id,version=(await request('/entries/'+id+'/versions',b)).value.current;assert.equal(version.files[0].bytes,size);
      const grant=(await request('/attachments/'+fileId+'/download',b,{})).value.token;
      const browser=await request('/attachments/'+fileId+'/content',b,undefined,'GET',{headers:{'X-Download-Token':grant}});assert.equal(browser.bytes.length,size);assert.equal(createHash('sha256').update(browser.bytes).digest('hex'),digest);
      await request('/entries/'+id+'/receive',b,{versionId:version.id});const receipt=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.equal(receipt.entryId,id);
      const desktop=await request('/desktop/receipts/'+receipt.id+'/files/'+fileId,undefined,undefined,'GET',{device:token,headers:{'X-Receipt-Lease':receipt.leaseToken}});assert.equal(desktop.bytes.length,size);assert.equal(createHash('sha256').update(desktop.bytes).digest('hex'),digest);
      assert.equal((await request('/desktop/receipts/'+receipt.id,undefined,{leaseToken:receipt.leaseToken,state:'stored',kind:'document',localIds:['community-large-file']},'PUT',{device:token})).status,200);
    });
    await t.test('withdrawal and device revocation are rechecked at actual transfer time',async()=>{
      const pdfStage=(await request('/resource-stages',a,{})).value.stageId,pdf=await upload(a,pdfStage,'sample.pdf',strToU8('%PDF-1.7\nsynthetic'));const entry=(await request('/entries',a,{kind:'resource',title:'PDF',body:'PDF 介绍',stageId:pdfStage})).value.id;await request(`/entries/${entry}/learning`,b,{enabled:true},'PUT');const claimed=(await request('/desktop/claim',undefined,{},'POST',{device:token})).value;assert.ok(claimed);await request(`/entries/${entry}`,a,undefined,'DELETE');assert.equal((await request(`/desktop/receipts/${claimed.id}/files/${pdf}`,undefined,undefined,'GET',{device:token,headers:{'X-Receipt-Lease':claimed.leaseToken}})).status,403);assert.equal((await request(`/desktop/receipts/${claimed.id}/validate`,undefined,{leaseToken:claimed.leaseToken},'POST',{device:token})).status,403);assert.equal((await request(`/me/devices/${device}`,b,undefined,'DELETE')).status,200);assert.equal((await request('/desktop/session',undefined,undefined,'GET',{device:token})).status,401);
      now=new Date(now.getTime()+11*60_000);assert.equal((await request('/desktop/pairings/'+randomUUID(),undefined,{claimToken:'A'.repeat(43)})).status,403);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await database.cleanup();assert.equal(path.dirname(directory),path.resolve('.'));assert.ok(path.basename(directory).startsWith('.ui-preview-resource-test-'));await rm(directory,{recursive:true,force:true});}
});
