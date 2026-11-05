import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';
import type {MailMessage} from '../src/auth.js';
type Identity={id:string;cookie:string;csrf:string};
test('inline content images inherit post, comment and group access through real HTTP and PostgreSQL',async t=>{
  const fixture=await createTestDatabase('inline_images'),directory=await mkdtemp(path.join(tmpdir(),'community-inline-')),origin='http://127.0.0.1:5174',mail:MailMessage[]=[];
  const app=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:1024*1024*1024,globalDownloadLimitBytes:1024*1024*1024,authProvider:'local'},mailer:{configured:true,async send(message){mail.push(message);return 'sent';}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const request=async(route:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={},bytes?:Uint8Array)=>{const response=await fetch(base+route,{method,headers:{Origin:origin,...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),'Idempotency-Key':randomUUID(),...(bytes?{'Content-Type':'application/octet-stream'}:body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:bytes||body===undefined?bytes:JSON.stringify(body)});return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():new Uint8Array(await response.arrayBuffer())};};
  const account=async(label:string):Promise<Identity>=>{const email=label+'@inline.example.test',password='Inline image fixture 2026!',registered=await app.auth.register({email,password});await app.auth.verifyEmail({token:mail.at(-1)!.token});const session=await app.auth.login({email,password});return {id:registered.account.id,cookie:'loginote_community_session='+session.sessionToken,csrf:session.csrfToken};};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCYkAAAAASUVORK5CYII=','base64');
  const upload=async(who:Identity,ready=true)=>{const stage=(await request('/resource-stages',who,{})).data.value.stageId;const intent=(await request(`/resource-stages/${stage}/files`,who,{name:'截图.png',mime:'image/png',bytes:png.length,role:'image'})).data.value;if(ready)assert.equal((await request(`/attachments/${intent.attachmentId}/content`,who,undefined,'PUT',{'X-Upload-Token':intent.uploadToken},png)).status,200);return {stage,id:intent.attachmentId,body:`![截图](attachment:${intent.attachmentId})`};};
  try{
    const a=await account('a'),b=await account('b');
    await t.test('private drafts cannot be stolen; public and self posts expose only bound image metadata',async()=>{
      const image=await upload(a);
      assert.equal((await request('/entries',b,{kind:'post',body:image.body,stageId:image.stage,scope:'public'})).status,403);
      const created=await request('/entries',a,{kind:'post',body:'分享截图\n'+image.body,stageId:image.stage,scope:'self'});assert.equal(created.status,201);const id=created.data.value.id;assert.equal(created.data.value.images[0].id,image.id);
      assert.equal((await request(`/entries/${id}`,b)).status,403);assert.equal((await request(`/attachments/${image.id}/download`,b,{})).status,403);
      const publicImage=await upload(a),post=await request('/entries',a,{kind:'question',body:publicImage.body,stageId:publicImage.stage,scope:'public'});assert.equal(post.status,201);const read=await request('/entries/'+post.data.value.id,b);assert.equal(read.data.value.images[0].id,publicImage.id);
      const forged=await request('/entries',b,{kind:'post',body:publicImage.body,scope:'public'});assert.equal(forged.status,403,'Readable public bytes cannot be rebound to a different author');
    });
    await t.test('comments attach images in one transaction; withdrawn parent revokes already-issued image grants',async()=>{
      const post=(await request('/entries',a,{kind:'post',body:'原帖',scope:'public'})).data.value,image=await upload(b);
      const comment=await request(`/entries/${post.id}/comments`,b,{body:image.body,stageId:image.stage});assert.equal(comment.status,201);
      const comments=(await request(`/entries/${post.id}/comments`,a)).data.value.items;assert.equal(comments[0].images[0].id,image.id);
      const grant=(await request(`/attachments/${image.id}/download`,a,{})).data.value.token;assert.equal((await request(`/attachments/${image.id}/content`,a,undefined,'GET',{'X-Download-Token':grant})).status,200);
      assert.equal((await request('/entries/'+post.id,a,undefined,'DELETE')).status,200);
      assert.equal((await request(`/attachments/${image.id}/content`,a,undefined,'GET',{'X-Download-Token':grant})).status,403);
    });
    await t.test('failed uploads roll back publication; images in a group become unavailable immediately after exit',async()=>{
      const pending=await upload(a,false),failed=await request('/entries',a,{kind:'post',body:pending.body,stageId:pending.stage,scope:'public'});assert.equal(failed.status,400);assert.equal((await fixture.db.query('SELECT published_entry_id FROM resource_upload_stages WHERE object_id=$1',[pending.stage])).rows[0].published_entry_id,null);
      const group=randomUUID();await fixture.db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[group,a.id]);for(const who of [a,b])await fixture.db.query("INSERT INTO group_memberships(group_id,account_id,role,state) VALUES($1,$2,$3,'active')",[group,who.id,who===a?'owner':'member']);
      const image=await upload(a),post=await request('/entries',a,{kind:'post',body:image.body,stageId:image.stage,scope:'group',groupId:group});assert.equal(post.status,201);
      const grant=(await request(`/attachments/${image.id}/download`,b,{})).data.value.token;
      await fixture.db.query("UPDATE group_memberships SET state='left' WHERE group_id=$1 AND account_id=$2",[group,b.id]);
      assert.equal((await request(`/attachments/${image.id}/content`,b,undefined,'GET',{'X-Download-Token':grant})).status,403);
      assert.equal((await request('/entries/'+post.data.value.id,b)).status,403);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('community-inline-'));await rm(directory,{recursive:true,force:true});}
});
