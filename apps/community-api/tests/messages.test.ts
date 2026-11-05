import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {AddressInfo} from 'node:net';
import type {MailMessage} from '../src/auth.js';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';
type Identity={accountId:string;cookie:string;csrf:string};

test('private conversations persist consent, private media, retries, blocks and governance',async t=>{
  const fixture=await createTestDatabase('messages'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-messages-')),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-25T02:00:00Z');
  const app=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:50000000,globalDownloadLimitBytes:50000000,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}},clock:()=>new Date(now)});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(app.server.address() as AddressInfo).port+'/api/community/v1';
  const request=async(route:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close',...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(body===undefined?{}:{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}),'Idempotency-Key':randomUUID(),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});const type=response.headers.get('content-type')||'';return {status:response.status,...(type.includes('application/json')?await response.json():{bytes:Buffer.from(await response.arrayBuffer())})};};
  const ok=async(route:string,who:Identity,body?:unknown,method?:string)=>{const result=await request(route,who,body,method);assert.ok(result.status>=200&&result.status<300,JSON.stringify({route,...result}));return result.value;};
  const account=async(label:string):Promise<Identity>=>{const email=label+'@messages.example.test',registered=await app.auth.register({email,password:'Synthetic messaging password 2026!',displayName:label});await app.auth.verifyEmail({token:mail.at(-1)!.token});const login=await app.auth.login({email,password:'Synthetic messaging password 2026!'});return {accountId:registered.account.id,cookie:'loginote_community_session='+login.sessionToken,csrf:login.csrfToken};};
  try{
    const a=await account('甲'),b=await account('乙'),c=await account('丙');let conversationId='',firstMessageId='',fileId='',stageId='';
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII=','base64');
    const upload=async(stage:string,name='截图.png',mime='image/png',bytes=png)=>{const intent=await ok('/attachments/intents',a,{objectId:stage,name,mime,bytes:bytes.length});assert.equal((await request('/attachments/'+intent.attachmentId+'/content',a,bytes,'PUT',{'X-Upload-Token':intent.uploadToken})).status,200);return intent.attachmentId;};
    await t.test('only participants can see a conversation or private draft; sender identity and CSRF cannot be forged',async()=>{
      assert.equal((await request('/conversations')).status,401);
      assert.equal((await request('/conversations',a,{peerId:b.accountId},'POST',{'X-CSRF-Token':'wrong'})).status,403);
      const opened=await ok('/conversations',a,{peerId:b.accountId});conversationId=opened.id;assert.equal(opened.state,'pending');assert.equal((await ok('/conversations',a,{peerId:b.accountId})).id,conversationId);
      assert.equal((await ok('/conversations',b)).items.length,0);assert.equal((await request('/conversations/'+conversationId,c)).status,404);assert.equal((await request('/conversations/'+conversationId+'/messages',c)).status,404);
      const draft={body:'甲的私人草稿',clientId:randomUUID()};await ok('/conversations/'+conversationId+'/draft',a,draft,'PUT');assert.equal((await ok('/conversations/'+conversationId+'/draft',b)).body,'');assert.equal((await request('/conversations/'+conversationId+'/draft',c)).status,404);
      assert.equal((await request('/conversations/'+conversationId+'/messages',a,{body:'伪造',clientId:randomUUID(),senderId:c.accountId})).status,400);
    });
    await t.test('private uploaded images have participant grants; draft image removal releases quota; sent media cannot be modified',async()=>{
      stageId=(await ok('/conversations/'+conversationId+'/stages',a,{})).stageId;const removed=await upload(stageId,'移除.png');await ok('/conversations/'+conversationId+'/stages/'+stageId+'/files/'+removed,a,undefined,'DELETE');
      assert.equal((await fixture.db.query("SELECT state FROM private_attachments WHERE id=$1",[removed])).rows[0].state,'cancelled');
      fileId=await upload(stageId);const payload={body:'你好，一起讨论矩阵吗？',clientId:randomUUID(),stageId};firstMessageId=(await ok('/conversations/'+conversationId+'/messages',a,payload)).id;
      assert.equal((await ok('/conversations/'+conversationId+'/messages',a,payload)).id,firstMessageId);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM community_messages')).rows[0].n,1);
      const grant=await ok('/attachments/'+fileId+'/download',b,{});const bytes=await request('/attachments/'+fileId+'/content',b,undefined,'GET',{'X-Download-Token':grant.token});assert.deepEqual(bytes.bytes,png);
      assert.equal((await request('/attachments/'+fileId+'/download',c,{})).status,403);assert.equal((await request('/attachments/'+fileId+'/content',c,undefined,'GET',{'X-Download-Token':grant.token})).status,403);
      assert.equal((await request('/attachments/intents',a,{objectId:stageId,name:'后加.png',mime:'image/png',bytes:png.length})).status,409);
      assert.equal((await request('/conversations/'+conversationId+'/stages/'+stageId+'/files/'+fileId,a,undefined,'DELETE')).status,409);
    });
    await t.test('one introduction is allowed until recipient acceptance; replay cannot reset consent',async()=>{
      assert.equal((await request('/conversations/'+conversationId+'/messages',a,{body:'连续发送',clientId:randomUUID()})).status,403);assert.equal((await request('/conversations/'+conversationId+'/messages',b,{body:'先回复',clientId:randomUUID()})).status,403);
      assert.equal((await request('/conversations/'+conversationId,a,{action:'accept'},'PUT')).status,403);assert.equal((await request('/conversations/'+conversationId,c,{action:'accept'},'PUT')).status,404);
      assert.equal((await ok('/conversations',b)).items[0].incoming,true);await ok('/conversations/'+conversationId,b,{action:'accept'},'PUT');
      await ok('/conversations/'+conversationId+'/messages',b,{body:'可以，我们一起看。🙂',clientId:randomUUID()});assert.equal((await ok('/conversations/'+conversationId,a)).canSend,true);
    });
    await t.test('new events use default quiet preferences and carry no private message body',async()=>{
      const events=await fixture.db.query<{payload:Record<string,unknown>;status:string;reason:string}>('SELECT e.payload,d.status,d.reason FROM attention_events e JOIN attention_deliveries d ON d.event_record_id=e.id');assert.equal(events.rows.length,2);for(const event of events.rows){assert.equal(event.status,'suppressed');assert.equal(event.reason,'disabled');assert.deepEqual(Object.keys(event.payload).sort(),['conversationId','messageId']);}
    });
    await t.test('history is ordered and paginated; reconnect cursor has no gaps or duplicate positions',async()=>{
      now=new Date(now.getTime()+61000);for(let index=0;index<35;index++){if(index===20)now=new Date(now.getTime()+61000);await ok('/conversations/'+conversationId+'/messages',index%2?a:b,{body:'历史消息 '+index,clientId:randomUUID()});}
      const newest=await ok('/conversations/'+conversationId+'/messages',a);assert.equal(newest.items.length,30);assert.ok(newest.nextBefore);const older=await ok('/conversations/'+conversationId+'/messages?before='+newest.nextBefore,a);const all=[...older.items,...newest.items];assert.equal(all.length,37);assert.equal(new Set(all.map((row:any)=>row.position)).size,37);assert.ok(all.every((row:any,index:number)=>index===0||BigInt(row.position)>BigInt(all[index-1].position)));
      const after=await ok('/conversations/'+conversationId+'/messages?after='+all[0].position,a);assert.equal(after.items.length,30);assert.ok(after.nextAfter);const rest=await ok('/conversations/'+conversationId+'/messages?after='+after.nextAfter,a);assert.equal(after.items.length+rest.items.length,36);
      assert.equal((await request('/conversations/'+conversationId+'/messages?after=-1',a)).status,400);
    });
    await t.test('deleting a conversation hides only the actor list and new messages restore that list',async()=>{
      await ok('/conversations/'+conversationId,a,{action:'hide'},'PUT');assert.equal((await ok('/conversations',a)).items.length,0);assert.equal((await ok('/conversations',b)).items.length,1);assert.equal((await ok('/conversations/'+conversationId+'/messages',b)).items.length,30);
      await ok('/conversations/'+conversationId+'/messages',b,{body:'再次交流',clientId:randomUUID()});assert.equal((await ok('/conversations',a)).items[0].id,conversationId);assert.equal((await ok('/conversations',a,{peerId:b.accountId})).id,conversationId);
    });
    await t.test('blocks stop messages, new image stages, follows and replies in both directions without deleting history',async()=>{
      const post=await ok('/entries',b,{kind:'post',body:'公开学习记录',scope:'public'});await ok('/people/'+b.accountId+'/follow',a,{enabled:true},'PUT');await ok('/people/'+a.accountId+'/block',b,{enabled:true},'PUT');
      assert.equal((await ok('/me/blocked',b)).length,1);assert.equal((await ok('/me/blocked',a)).length,0);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM account_follows')).rows[0].n,0);
      for(const [sender,target] of [[a,b],[b,a]]){assert.equal((await request('/conversations/'+conversationId+'/messages',sender,{body:'绕过拉黑',clientId:randomUUID()})).status,403);assert.equal((await request('/conversations/'+conversationId+'/stages',sender,{})).status,403);assert.equal((await request('/conversations',sender,{peerId:target.accountId})).status,403);}
      assert.equal((await request('/people/'+b.accountId+'/follow',a,{enabled:true},'PUT')).status,403);assert.equal((await request('/entries/'+post.id+'/comments',a,{body:'绕过评论'})).status,403);
      await ok('/people/'+b.accountId+'/block',a,{enabled:false},'PUT');assert.equal((await ok('/conversations/'+conversationId,a)).contactUnavailable,true);assert.ok((await ok('/conversations/'+conversationId+'/messages',b)).items.length);
      await ok('/people/'+a.accountId+'/block',b,{enabled:false},'PUT');assert.equal((await ok('/conversations/'+conversationId,a)).canSend,true);
    });
    await t.test('draft autosave and incoming messages acquire locks consistently',async()=>{
      now=new Date(now.getTime()+61000);for(let index=0;index<8;index++){await Promise.all([ok('/conversations/'+conversationId+'/draft',a,{body:'未发送 '+index,clientId:randomUUID()},'PUT'),ok('/conversations/'+conversationId+'/messages',b,{body:'同时收到 '+index,clientId:randomUUID()})]);}
      assert.equal((await ok('/conversations/'+conversationId+'/draft',a)).body,'未发送 7');
    });
    await t.test('ignored requests cannot be reset by reopen; new-contact limit remains account-wide',async()=>{
      now=new Date(now.getTime()+61000);const sender=await account('新联系人测试'),targets:Identity[]=[];const rooms:string[]=[];
      for(let index=0;index<6;index++){const target=await account('收件人'+index);targets.push(target);const room=await ok('/conversations',sender,{peerId:target.accountId});rooms.push(room.id);const result=await request('/conversations/'+room.id+'/messages',sender,{body:'一条介绍 '+index,clientId:randomUUID()});assert.equal(result.status,index<5?201:429);}
      await ok('/conversations/'+rooms[0],targets[0],{action:'reject'},'PUT');await ok('/conversations/'+rooms[0],sender,{action:'hide'},'PUT');const reopened=await ok('/conversations',sender,{peerId:targets[0].accountId});assert.equal(reopened.state,'rejected');assert.equal(reopened.canSend,false);assert.equal((await request('/conversations/'+rooms[0]+'/messages',sender,{body:'重新打开后绕过',clientId:randomUUID()})).status,403);
      await ok('/conversations/'+rooms[0],targets[0],{action:'accept'},'PUT');assert.equal((await ok('/conversations/'+rooms[0],sender)).canSend,true);
    });
    await t.test('invalid media is rejected and an accepted conversation has a server-side message rate limit',async()=>{
      now=new Date(now.getTime()+61000);const stage=(await ok('/conversations/'+conversationId+'/stages',a,{})).stageId;await upload(stage,'伪装.png','image/png',Buffer.from('<svg onload="alert(1)"/>'));assert.equal((await request('/conversations/'+conversationId+'/messages',a,{body:'伪装图片',clientId:randomUUID(),stageId:stage})).status,400);
      now=new Date(now.getTime()+61000);for(let index=0;index<31;index++){const result=await request('/conversations/'+conversationId+'/messages',a,{body:'频率测试 '+index,clientId:randomUUID()});assert.equal(result.status,index<30?201:429);}
    });
    await t.test('message reports enter assigned governance; restricted message and media disappear for recipient, administrator cannot browse another conversation',async()=>{
      const report=await ok('/reports',b,{kind:'report',targetType:'object',targetId:firstMessageId,body:'请核查这条私信',evidence:'我收到的介绍含有截图。'});await fixture.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[c.accountId]);const admin={accountId:c.accountId,role:'administrator' as const,mfaVerified:true};
      await app.governance.assign(admin,report.id,{});await app.governance.decide(admin,report.id,{action:'restrict_object',reason:'测试受理后的内容限制',expiresAt:new Date(now.getTime()+3600000).toISOString()});
      const history=await ok('/conversations/'+conversationId+'/messages?after=0',b);const first=history.items.find((row:any)=>row.id===firstMessageId);assert.equal(first.visible,false);assert.equal(first.body,'');assert.deepEqual(first.files,[]);assert.equal((await request('/attachments/'+fileId+'/download',b,{})).status,403);assert.equal((await request('/conversations/'+conversationId+'/messages',c)).status,404);
      assert.equal((await ok('/me/reports',b))[0].id,report.id);
    });
    await t.test('simultaneous accepted messages serialize without loss; delivery capability restrictions apply to new sends',async()=>{
      now=new Date(now.getTime()+61000);const results=await Promise.all([ok('/conversations/'+conversationId+'/messages',a,{body:'并发甲',clientId:randomUUID()}),ok('/conversations/'+conversationId+'/messages',b,{body:'并发乙',clientId:randomUUID()})]);assert.notEqual(results[0].id,results[1].id);
      const report=await ok('/reports',b,{kind:'report',targetType:'account',targetId:a.accountId,body:'测试限制私信'}),admin={accountId:c.accountId,role:'administrator' as const,mfaVerified:true};await app.governance.assign(admin,report.id,{});await app.governance.decide(admin,report.id,{action:'restrict_account',reason:'测试私信限制',capabilities:['send_message'],expiresAt:new Date(now.getTime()+3600000).toISOString()});
      assert.equal((await request('/conversations/'+conversationId+'/messages',a,{body:'受限后发送',clientId:randomUUID()})).status,403);assert.ok((await ok('/conversations/'+conversationId+'/messages',a)).items.length);await ok('/people/'+b.accountId+'/block',a,{enabled:true},'PUT');
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
});
