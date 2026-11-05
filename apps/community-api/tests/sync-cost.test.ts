import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {MailMessage} from '../src/auth.js';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';
import {MessageService} from '../src/messages.js';
test('batched reads retain scoped authorization, contact states and bounded query work',async t=>{
  const fixture=await createTestDatabase('sync_cost_api'),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date();
  const app=createCommunityServer({db:fixture.db,clock:()=>now,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:'.ui-preview/community-phase3/sync-api',globalStorageLimitBytes:0,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}}});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(app.server.address() as AddressInfo).port+'/api/community/v1';
  type Who={id:string;cookie:string;csrf:string};
  const req=async(route:string,who?:Who,data?:unknown,method=data===undefined?'GET':'POST')=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close',...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),'Idempotency-Key':randomUUID()},body:data===undefined?undefined:JSON.stringify(data)});return {status:response.status,...await response.json()};};
  const ok=async(...args:Parameters<typeof req>)=>{const result=await req(...args);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.value;};
  const register=async(label:string)=>{const email=label+'@sync.example.test',created=await app.auth.register({email,password:'Synthetic sync cost password 2026!',displayName:label});await app.auth.verifyEmail({token:mail.at(-1)!.token});const login=await app.auth.login({email,password:'Synthetic sync cost password 2026!'});return {id:created.account.id,cookie:'loginote_community_session='+login.sessionToken,csrf:login.csrfToken};};
  try{
    const a=await register('甲'),b=await register('乙'),c=await register('丙');let id='';
    await t.test('one history and contact-state response matches existing views and rejects outsiders',async()=>{
      id=(await ok('/conversations',a,{peerId:b.id})).id;const first=await ok('/conversations/'+id+'/messages',a,{body:'介绍',clientId:randomUUID()});
      const initial=await ok('/conversations/'+id+'/sync',a);assert.deepEqual(initial.conversation,await ok('/conversations/'+id,a));const {conversation,...history}=initial;assert.deepEqual(history,await ok('/conversations/'+id+'/messages',a));assert.equal(initial.items[0].id,first.id);
      assert.equal((await req('/conversations/'+id+'/sync',c)).status,404);assert.equal((await req('/conversations/'+id+'/sync')).status,401);assert.equal((await req('/conversations/'+id+'/sync?after=1&before=2',a)).status,400);assert.equal((await req('/conversations/'+id+'/sync?unexpected=true',a)).status,400);
      await ok('/conversations/'+id,b,{action:'accept'},'PUT');const position=initial.items[0].position;await ok('/conversations/'+id+'/messages',b,{body:'接收后的回应',clientId:randomUUID()});const next=await ok('/conversations/'+id+'/sync?after='+position,a);assert.equal(next.items.length,1);assert.equal(next.items[0].body,'接收后的回应');assert.equal(next.conversation.canSend,true);
    });
    await t.test('conversation list uses one query regardless of row count and preserves block and pending rules',async()=>{
      await ok('/conversations',a,{peerId:c.id});let queries=0;const traced={...fixture.db,query:async<R>(sql:string,values?:readonly unknown[])=>{queries++;return fixture.db.query<R>(sql,values);}};
      const service=new MessageService(traced,app.access,app.files,app.attention,()=>now),actor={accountId:a.id,role:'member' as const,mfaVerified:false};
      let list=await service.list(actor);assert.equal(queries,1);assert.equal(list.items.length,2);for(const item of list.items)assert.deepEqual(item,await ok('/conversations/'+item.id,a));
      await ok('/people/'+a.id+'/block',b,{enabled:true},'PUT');queries=0;list=await service.list(actor);assert.equal(queries,1);const blocked=list.items.find(item=>item.person.accountId===b.id)!;assert.equal(blocked.contactUnavailable,true);assert.equal(blocked.blockedByMe,false);assert.equal(blocked.canSend,false);assert.deepEqual(blocked,await ok('/conversations/'+id,a));
      await ok('/conversations/'+id,a,{action:'hide'},'PUT');assert.equal((await service.list(actor)).items.some(item=>item.id===id),false);await ok('/people/'+a.id+'/block',b,{enabled:false},'PUT');
    });
    await t.test('group overview exposes pins only to current members, including after leaving and dissolution',async()=>{
      const group=(await ok('/groups',a,{name:'权限核对群',description:'同步批量读取',joinPolicy:'open'})).id;await ok('/groups/'+group+'/membership',b,{action:'join'});const root=(await ok('/groups/'+group+'/messages',a,{body:'本群讨论',clientId:randomUUID()})).id;await ok('/groups/'+group+'/messages/'+root,a,{action:'pin'},'PUT');
      const mine=await ok('/groups/'+group+'/overview',b);assert.equal(mine.pins[0].body,'本群讨论');assert.deepEqual(mine.group,await ok('/groups/'+group,b));assert.deepEqual((await ok('/groups/'+group+'/overview',c)).pins,[]);assert.deepEqual((await ok('/groups/'+group+'/overview')).pins,[]);
      await ok('/groups/'+group+'/membership',b,{action:'leave'});assert.deepEqual((await ok('/groups/'+group+'/overview',b)).pins,[]);await ok('/groups/'+group,a,undefined,'DELETE');assert.equal((await req('/groups/'+group+'/overview',b)).status,410);
    });
    await t.test('new reads never bypass a revoked cookie and preflight caching still rechecks origin',async()=>{
      await ok('/me/sign-out',a,{},'POST');assert.equal((await req('/conversations/'+id+'/sync',a)).status,401);
      const allowed=await fetch(base+'/conversations',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}});assert.equal(allowed.status,204);assert.equal(allowed.headers.get('Access-Control-Max-Age'),'600');
      assert.equal((await fetch(base+'/conversations',{headers:{Origin:'https://untrusted.example.test',Cookie:b.cookie}})).status,403);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();}
});
