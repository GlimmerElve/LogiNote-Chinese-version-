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
test('group rooms use scoped roles, consented membership, threads and incremental events',async t=>{
  const fixture=await createTestDatabase('group_rooms'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-group-')),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-25T04:00:00Z');
  const app=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:50000000,globalDownloadLimitBytes:50000000,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}},clock:()=>new Date(now)});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(app.server.address() as AddressInfo).port+'/api/community/v1';
  const request=async(route:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close',...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(body===undefined?{}:{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}),'Idempotency-Key':randomUUID(),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});return {status:response.status,...(response.headers.get('content-type')?.includes('application/json')?await response.json():{bytes:Buffer.from(await response.arrayBuffer())})};};
  const ok=async(route:string,who?:Identity,body?:unknown,method?:string)=>{const value=await request(route,who,body,method);assert.ok(value.status>=200&&value.status<300,JSON.stringify({route,...value}));return value.value;};
  const account=async(label:string):Promise<Identity>=>{const email=label+'@groups.example.test',registered=await app.auth.register({email,password:'Synthetic group test 2026!',displayName:label});await app.auth.verifyEmail({token:mail.at(-1)!.token});const login=await app.auth.login({email,password:'Synthetic group test 2026!'});return {accountId:registered.account.id,cookie:'loginote_community_session='+login.sessionToken,csrf:login.csrfToken};};
  const check=async(name:string,work:()=>Promise<void>)=>{now=new Date(now.getTime()+61000);await t.test(name,work);};
  try{
    const a=await account('群主甲'),b=await account('成员乙'),c=await account('管理员丙'),d=await account('外部丁');let id='',root='',reply='',fileId='',grant='';const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII=','base64');
    const group=()=>'/groups/'+id,send=async(who:Identity,body:string,threadId?:string)=>ok(group()+'/messages',who,{body,clientId:randomUUID(),...(threadId?{threadId}:{})});
    const manage=async(who:Identity,target:Identity,action:string,until?:string)=>ok(group()+'/members/'+target.accountId,who,{action,...(until?{until}:{})},'PUT');
    await check('create and discovery use real accounts; public metadata reveals no member list or email',async()=>{
      assert.equal((await request('/groups',undefined,{name:'未登录'})).status,401);const created=await ok('/groups',a,{name:'线性代数共学',description:'一起理解矩阵变换',joinPolicy:'request'});id=created.id;assert.equal(created.role,'owner');assert.equal(created.memberCount,1);
      assert.equal((await ok('/groups?view=discover&q=矩阵')).items[0].id,id);const publicGroup=await ok(group());assert.equal(publicGroup.membership,'none');assert.equal(JSON.stringify(publicGroup).includes('@'),false);assert.equal((await request(group()+'/members',d)).status,403);assert.equal((await request(group()+'/messages',d)).status,403);assert.equal((await request(group()+'/sync?since=0',d)).status,403);
      assert.equal((await request('/groups',a,{name:'伪造角色',ownerId:d.accountId})).status,400);assert.equal((await request('/groups',a,{name:'csrf'},'POST',{'X-CSRF-Token':'wrong'})).status,403);
    });
    await check('request, approval and invitation are separate membership states and never auto-join recipients',async()=>{
      assert.equal((await ok(group()+'/membership',b,{action:'join'})).membership,'requested');assert.equal((await request(group()+'/messages',b)).status,403);await manage(a,b,'approve');assert.equal((await ok(group(),b)).role,'member');
      await manage(a,c,'invite');assert.equal((await ok(group(),c)).membership,'invited');assert.equal((await request(group()+'/messages',c)).status,403);assert.equal((await ok('/groups?view=mine',c)).items[0].id,id);await ok(group()+'/membership',c,{action:'join'});assert.equal((await ok(group(),c)).membership,'active');
      assert.equal((await request(group()+'/members/'+d.accountId,b,{action:'approve'},'PUT')).status,403);
    });
    await check('owner and administrator powers are room-scoped and cannot target owner or promote themselves',async()=>{
      await manage(a,c,'promote');assert.equal((await ok(group(),c)).role,'administrator');assert.equal((await request(group()+'/members/'+b.accountId,c,{action:'promote'},'PUT')).status,403);assert.equal((await request(group()+'/members/'+a.accountId,c,{action:'ban'},'PUT')).status,403);
      assert.equal((await request(group(),b,{name:'越权改名'},'PUT')).status,403);assert.equal((await request(group(),c,{state:'archived'},'PUT')).status,403);await ok(group(),c,{description:'由本群管理员维护目标'},'PUT');
      const other=await ok('/groups',d,{name:'另一个群'});assert.equal((await request('/groups/'+other.id+'/members/'+d.accountId,c,{action:'ban'},'PUT')).status,403);
    });
    await check('threads reference one root in the same room; manager pinning does not create a second chat',async()=>{
      root=(await send(a,'矩阵乘法究竟改变了什么？')).id;reply=(await send(b,'我认为它改变了基向量。',root)).id;
      assert.equal((await ok(group()+'/messages',a)).items.length,1);assert.equal((await ok(group()+'/messages?threadId='+root,a)).items[0].id,reply);assert.equal((await ok(group()+'/messages/'+root,a)).replyCount,1);
      assert.equal((await request(group()+'/messages/'+root,b,{action:'pin'},'PUT')).status,403);await ok(group()+'/messages/'+root,c,{action:'pin'},'PUT');assert.equal((await ok(group()+'/pins',b))[0].id,root);
      const other=await ok('/groups',b,{name:'交叉群'});assert.equal((await request('/groups/'+other.id+'/messages',b,{body:'跨群回复',clientId:randomUUID(),threadId:root})).status,404);assert.equal((await request(group()+'/messages',b,{body:'回复下再嵌套根',clientId:randomUUID(),threadId:reply})).status,404);
      const payload={body:'同一条重试',clientId:randomUUID(),threadId:root},first=await ok(group()+'/messages',b,payload);assert.equal((await ok(group()+'/messages',b,payload)).id,first.id);assert.equal((await request(group()+'/messages',b,{...payload,body:'换内容'})).status,409);
    });
    await check('message stages, real bytes and grants use current membership; a sent image is immutable',async()=>{
      const stage=(await ok(group()+'/stages',b,{threadId:root})).stageId,intent=await ok('/attachments/intents',b,{objectId:stage,name:'矩阵截图.png',mime:'image/png',bytes:png.length});fileId=intent.attachmentId;assert.equal((await request('/attachments/'+fileId+'/content',b,png,'PUT',{'X-Upload-Token':intent.uploadToken})).status,200);
      await ok(group()+'/messages',b,{body:'看这个图',clientId:randomUUID(),threadId:root,stageId:stage});grant=(await ok('/attachments/'+fileId+'/download',c,{})).token;assert.deepEqual((await request('/attachments/'+fileId+'/content',c,undefined,'GET',{'X-Download-Token':grant})).bytes,png);
      assert.equal((await request('/attachments/'+fileId+'/download',d,{})).status,403);assert.equal((await request('/attachments/intents',b,{objectId:stage,name:'追加.png',mime:'image/png',bytes:png.length})).status,409);assert.equal((await request(group()+'/stages/'+stage+'/files/'+fileId,b,undefined,'DELETE')).status,409);
      assert.equal((await request(group()+'/messages',a,{body:'偷用附件',clientId:randomUUID(),threadId:root,stageId:stage})).status,403);
    });
    await check('mute affects every group write, not public posting; unmute and expiry restore group participation',async()=>{
      const until=new Date(now.getTime()+3600000).toISOString();await manage(c,b,'mute',until);assert.equal((await ok(group(),b)).canSend,false);assert.equal((await request(group()+'/messages',b,{body:'绕过禁言',clientId:randomUUID()})).status,403);assert.equal((await request(group()+'/stages',b,{})).status,403);assert.equal((await request('/entries',b,{kind:'post',body:'绕过群禁言',scope:'group',groupId:id})).status,403);
      await ok('/entries',b,{kind:'post',body:'公开学习仍可继续',scope:'public'});await manage(c,b,'unmute');assert.equal((await ok(group(),b)).canSend,true);await manage(c,b,'mute',new Date(now.getTime()+1000).toISOString());now=new Date(now.getTime()+2000);await send(b,'限时禁言已经到期');
    });
    await check('removal and bans revoke messages, drafts and pre-issued file grants on the next request',async()=>{
      await manage(a,c,'remove');assert.equal((await request(group()+'/messages',c)).status,403);assert.equal((await request('/attachments/'+fileId+'/content',c,undefined,'GET',{'X-Download-Token':grant})).status,403);assert.equal((await request(group()+'/draft',c)).status,403);
      await manage(a,c,'invite');await ok(group()+'/membership',c,{action:'join'});await manage(a,c,'promote');await manage(c,b,'ban');assert.equal((await request(group()+'/membership',b,{action:'join'})).status,403);await manage(c,b,'unban');assert.equal((await ok(group()+'/membership',b,{action:'join'})).membership,'requested');await manage(c,b,'approve');
    });
    await check('message and content drafts belong to one account, one room and one thread; group publish does not clear private drafts',async()=>{
      await ok(group()+'/draft',b,{body:'乙的群主会话草稿',clientId:randomUUID()},'PUT');await ok(group()+'/draft',b,{body:'乙的话题草稿',clientId:randomUUID(),threadId:root},'PUT');assert.equal((await ok(group()+'/draft',a)).body,'');assert.equal((await ok(group()+'/draft?threadId='+root,b)).body,'乙的话题草稿');assert.equal((await ok(group()+'/draft',b)).body,'乙的群主会话草稿');
      await ok('/me/drafts/post',b,{title:'',body:'乙的个人草稿',topics:[]},'PUT');await ok(group()+'/content-drafts/post',b,{title:'',body:'乙的群记录草稿',topics:[]},'PUT');assert.equal((await ok(group()+'/content-drafts/post',a)).body,'');const entry=await ok('/entries',b,{kind:'post',body:'今天理解了特征向量。',scope:'group',groupId:id});assert.equal((await ok('/me/drafts/post',b)).body,'乙的个人草稿');assert.equal((await ok(group()+'/content-drafts/post',b)).body,'');assert.equal((await request('/entries/'+entry.id,d)).status,403);
    });
    await check('initial snapshot cursor and incremental change log include replies, pins, closed threads and removed-message tombstones',async()=>{
      const initial=await ok(group()+'/messages',b);assert.ok(initial.syncCursor);const fresh=(await send(a,'新增同步话题')).id;const response=await ok(group()+'/sync?since='+initial.syncCursor,b);assert.equal(response.changes.find((m:any)=>m.id===fresh).body,'新增同步话题');const since=response.cursor;
      await send(b,'针对新话题的回答',fresh);await ok(group()+'/messages/'+fresh,c,{action:'pin'},'PUT');await ok(group()+'/messages/'+fresh,c,{action:'close'},'PUT');const changes=await ok(group()+'/sync?since='+since,b);assert.equal(changes.changes.find((m:any)=>m.id===fresh).threadClosed,true);assert.equal(changes.changes.find((m:any)=>m.id===fresh).replyCount,1);assert.equal((await request(group()+'/messages',b,{body:'关闭后绕过',clientId:randomUUID(),threadId:fresh})).status,403);
      await ok(group()+'/messages/'+fresh,c,{action:'remove'},'PUT');const removed=await ok(group()+'/sync?since='+changes.cursor,b);assert.equal(removed.changes.find((m:any)=>m.id===fresh).visible,false);assert.equal(removed.changes.find((m:any)=>m.id===fresh).body,'');assert.equal((await ok(group()+'/messages?threadId='+fresh,b)).items.length,1);
    });
    await check('accepted answers follow Discourse-style author or scoped moderator permissions and never rewrite the original question',async()=>{
      const question=await ok('/entries',a,{kind:'question',body:'如何从基向量理解变换？',scope:'public'}),answer=await ok('/entries/'+question.id+'/comments',b,{body:'先看每个基向量的像。'});
      assert.equal((await request('/entries/'+question.id+'/solution',d,{commentId:answer.id},'PUT')).status,403);
      const accepted=await ok('/entries/'+question.id+'/solution',a,{commentId:answer.id},'PUT');assert.equal(accepted.acceptedCommentId,answer.id);assert.equal(accepted.body,question.body);assert.equal((await ok('/entries/'+question.id,b)).canAcceptSolution,false);
      const foreign=await ok('/entries',a,{kind:'question',body:'另一个问题'}),foreignAnswer=await ok('/entries/'+foreign.id+'/comments',b,{body:'另一个回答'});assert.equal((await request('/entries/'+question.id+'/solution',a,{commentId:foreignAnswer.id},'PUT')).status,400);
      assert.equal((await ok('/entries/'+question.id+'/solution',a,{commentId:null},'PUT')).acceptedCommentId,null);
      const groupQuestion=await ok('/entries',b,{kind:'question',body:'群内求助',scope:'group',groupId:id}),groupAnswer=await ok('/entries/'+groupQuestion.id+'/comments',a,{body:'在本群中一起推导。'});assert.equal((await ok('/entries/'+groupQuestion.id,c)).canAcceptSolution,true);await ok('/entries/'+groupQuestion.id+'/solution',c,{commentId:groupAnswer.id},'PUT');
      await fixture.db.query("UPDATE protected_objects SET state='withdrawn' WHERE id=$1",[groupAnswer.id]);assert.equal((await ok('/entries/'+groupQuestion.id,b)).acceptedCommentId,null);assert.equal((await request('/entries/'+groupQuestion.id+'/solution',c,{commentId:groupAnswer.id},'PUT')).status,400);
    });
    await check('ownership transfer is atomic; previous owner loses owner-only permissions and cannot leave an active owned room',async()=>{
      assert.equal((await request(group()+'/membership',a,{action:'leave'})).status,409);await manage(a,c,'mute',new Date(now.getTime()+3600000).toISOString());assert.equal((await ok(group(),c)).canSend,false);await manage(a,c,'transfer');assert.equal((await ok(group(),c)).canSend,true);assert.equal((await ok(group(),c)).role,'owner');assert.equal((await ok(group(),a)).role,'administrator');assert.equal((await request(group()+'/members/'+b.accountId,a,{action:'promote'},'PUT')).status,403);assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM group_memberships WHERE group_id=$1 AND role='owner' AND state='active'",[id])).rows[0].n,1);
    });
    await check('archive is read-only and reversible; ownership and membership audit stays private to room managers',async()=>{
      await ok(group(),c,{state:'archived'},'PUT');assert.ok((await ok(group()+'/messages',b)).items.length);assert.equal((await request(group()+'/messages',b,{body:'归档后发送',clientId:randomUUID()})).status,403);assert.equal((await request(group()+'/membership',d,{action:'join'})).status,403);assert.equal((await request(group()+'/audit',b)).status,403);const audit=await ok(group()+'/audit',c);assert.ok(audit.items.some((e:any)=>e.action==='transfer'));assert.equal(JSON.stringify(audit).includes('@groups.'),false);await ok(group(),c,{state:'active'},'PUT');await send(b,'恢复后继续讨论');
    });
    await check('ordered history, concurrent send and draft autosave retain stable unique messages without deadlocks',async()=>{
      for(let n=0;n<16;n++)await Promise.all([send(b,'并发乙 '+n),send(a,'并发甲 '+n),ok(group()+'/draft',b,{body:'草稿 '+n,clientId:randomUUID()},'PUT')]);
      const first=await ok(group()+'/messages',a);assert.equal(first.items.length,30);assert.ok(first.nextBefore);const second=await ok(group()+'/messages?before='+first.nextBefore,a);const all=[...second.items,...first.items];assert.equal(new Set(all.map((m:any)=>m.id)).size,all.length);assert.ok(all.every((m:any,n:number)=>n===0||BigInt(m.position)>BigInt(all[n-1].position)));
      assert.equal((await request(group()+'/messages?after=-1',a)).status,400);assert.equal((await request(group()+'/sync?since=0&since=1',a)).status,400);
    });
    await check('reports bind the actual group message and platform admin role does not grant room membership',async()=>{
      const report=await ok('/reports',b,{kind:'report',targetType:'object',targetId:root,body:'请核查群内消息。'});assert.ok(report.id);await fixture.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[d.accountId]);assert.equal((await request(group()+'/messages',d)).status,403);assert.equal((await request(group()+'/members/'+a.accountId,d,{action:'ban'},'PUT')).status,403);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attention_deliveries')).rows[0].n,0);
    });
    await check('only the owner can dissolve; subscriptions, links, drafts and prior file grants are revoked atomically',async()=>{
      const closed=(await ok('/groups',c,{name:'待解散的隔离共学群'})).id,room='/groups/'+closed;
      await ok(room+'/membership',a,{action:'join'});await ok(room+'/membership',b,{action:'join'});await ok(room+'/members/'+a.accountId,c,{action:'promote'},'PUT');
      const entry=await ok('/entries',b,{kind:'resource',body:'仅这个群可见的资料',scope:'group',groupId:closed}),publicEntry=await ok('/entries',b,{kind:'resource',body:'解散群不影响公开资料',scope:'public'});
      const topic=await ok(room+'/messages',c,{body:'解散测试话题',clientId:randomUUID()});await ok(room+'/draft',b,{body:'群草稿',clientId:randomUUID(),threadId:topic.id},'PUT');
      const stage=(await ok(room+'/stages',b,{})).stageId,intent=await ok('/attachments/intents',b,{objectId:stage,name:'解散测试.png',mime:'image/png',bytes:png.length});
      assert.equal((await request('/attachments/'+intent.attachmentId+'/content',b,png,'PUT',{'X-Upload-Token':intent.uploadToken})).status,200);
      await ok(room+'/messages',b,{body:'群图片',clientId:randomUUID(),stageId:stage});const issued=(await ok('/attachments/'+intent.attachmentId+'/download',a,{})).token;
      await ok(room,c,{joinPolicy:'request'},'PUT');await ok(room+'/members/'+d.accountId,c,{action:'invite'},'PUT');const pending=await account('待审核戊');await ok(room+'/membership',pending,{action:'join'});
      for(const who of [a,b,d])assert.equal((await request(room,who,undefined,'DELETE')).status,403);
      assert.equal((await request(room,c,undefined,'DELETE',{'X-CSRF-Token':'wrong'})).status,403);
      const key=randomUUID(),[deleted,sent]=await Promise.all([request(room,c,undefined,'DELETE',{'Idempotency-Key':key}),request(room+'/messages',b,{body:'与解散并发的消息',clientId:randomUUID()})]);
      assert.equal(deleted.status,200);assert.equal(deleted.value.dissolved,true);assert.ok([201,403,410].includes(sent.status));assert.equal((await request(room,c,undefined,'DELETE',{'Idempotency-Key':key})).status,200);
      assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM group_memberships WHERE group_id=$1 AND state<>'left'",[closed])).rows[0].n,0);
      assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM group_room_drafts WHERE group_id=$1',[closed])).rows[0].n,0);
      assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM group_management_events WHERE group_id=$1 AND action='dissolve'",[closed])).rows[0].n,1);
      for(const who of [a,b,c,pending]){
        assert.equal((await request(room,who)).error.code,'group_dissolved');
        for(const route of ['/messages','/messages/'+topic.id,'/sync?since=0','/pins','/members','/draft','/content-drafts/resource','/audit'])assert.ok([403,410].includes((await request(room+route,who)).status),route);
        assert.equal((await request('/entries/'+entry.id,who)).status,403);
        assert.equal((await ok('/groups?view=mine',who)).items.some((g:any)=>g.id===closed),false);
      }
      assert.equal((await request('/attachments/'+intent.attachmentId+'/content',a,undefined,'GET',{'X-Download-Token':issued})).status,403);
      assert.equal((await request(room,c,{state:'active'},'PUT')).status,410);assert.equal((await request(room+'/membership',b,{action:'join'})).status,410);
      assert.equal((await request('/entries',b,{kind:'post',body:'旧地址绕过',scope:'group',groupId:closed})).status,403);
      assert.equal((await ok('/groups?view=discover&q=待解散')).items.length,0);assert.equal((await ok('/entries/'+publicEntry.id)).id,publicEntry.id);
      const archived=(await ok('/groups',c,{name:'可解散的归档群'})).id;await ok('/groups/'+archived,c,{state:'archived'},'PUT');assert.equal((await ok('/groups/'+archived,c,undefined,'DELETE')).dissolved,true);
    });
    await check('planned default limits are enforced across creating and joining rather than merely displayed',async()=>{
      assert.equal((await ok(group(),b)).memberLimit,50);for(let n=0;n<3;n++)await ok('/groups',a,{name:'甲的活跃共学 '+n});assert.equal((await request('/groups',a,{name:'第四个活跃共学'})).status,409);
      const before=Number((await fixture.db.query("SELECT count(*)::int AS n FROM group_memberships WHERE account_id=$1 AND state IN ('active','requested')",[b.accountId])).rows[0].n);
      for(let n=before;n<10;n++){const fixtureGroup=randomUUID();await fixture.db.query('INSERT INTO groups(id,owner_id,name) VALUES($1,$2,$3)',[fixtureGroup,c.accountId,'隔离容量样例 '+n]);await fixture.db.query("INSERT INTO group_memberships(group_id,account_id,role,state) VALUES($1,$2,'member','active')",[fixtureGroup,b.accountId]);}
      const available=(await ok('/groups?view=discover',b)).items.find((g:any)=>g.membership==='none');assert.ok(available);assert.equal((await request('/groups/'+available.id+'/membership',b,{action:'join'})).status,409);assert.equal((await request('/groups',b,{name:'建群也不能绕过参与上限'})).status,409);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
});
