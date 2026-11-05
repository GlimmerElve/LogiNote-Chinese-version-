import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {MailMessage} from '../src/auth.js';
import {createCommunityServer} from '../src/http.js';
import {createTestDatabase} from './helpers.js';

type Identity={accountId:string;cookie:string;csrf:string};
test('real community content separates public records, group scope and two accounts private state',async t=>{
  const fixture=await createTestDatabase('content_isolation'),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-24T05:00:00Z');
  const app=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:'.data/content-test-unused',globalStorageLimitBytes:0,authProvider:'local'},mailer:{configured:true,async send(value){mail.push(value);return 'sent';}},clock:()=>new Date(now)});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/community/v1`;
  const request=async(path:string,who?:Identity,body?:unknown,method=body===undefined?'GET':'POST',options:{key?:string;csrf?:string;origin?:string}={})=>{
    const response=await fetch(base+path,{method,headers:{Origin:options.origin||origin,...(who?{Cookie:who.cookie,'X-CSRF-Token':options.csrf??who.csrf}:{}),...(method!=='GET'?{'Idempotency-Key':options.key||randomUUID()}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,...await response.json() as {ok:boolean;value:any;error?:{code:string}}};
  };
  const account=async(label:string):Promise<Identity>=>{const email=`${label}@isolation.example.test`,registered=await app.auth.register({email,password:'Synthetic isolation password 2026!',displayName:label});await app.auth.verifyEmail({token:mail.at(-1)!.token});const login=await app.auth.login({email,password:'Synthetic isolation password 2026!'});return {accountId:registered.account.id,cookie:`loginote_community_session=${login.sessionToken}`,csrf:login.csrfToken};};
  const a=await account('isolation-A'),b=await account('isolation-B');let publicPost='',privatePost='',publicResource='',groupResource='',commentA='',groupId=randomUUID();
  const create=async(who:Identity,input:Record<string,unknown>)=>{now=new Date(now.getTime()+1000);const result=await request('/entries',who,{kind:'post',body:'public shared learning',scope:'public',...input});assert.equal(result.status,201,JSON.stringify(result.error));return result.value;};
  try{
    await fixture.db.query('INSERT INTO groups(id,owner_id) VALUES($1,$2)',[groupId,a.accountId]);await fixture.db.query("INSERT INTO group_memberships(group_id,account_id,role,state) VALUES($1,$2,'owner','active')",[groupId,a.accountId]);
    await t.test('server owns identity and real content is created once with a replay key',async()=>{
      assert.equal((await request('/entries',a,{kind:'post',body:'spoof',ownerId:b.accountId})).status,400);
      assert.equal((await request('/entries',a,{kind:'post',body:'csrf'},'POST',{csrf:'wrong'})).status,403);
      const key=randomUUID(),input={kind:'post',body:'public shared learning',topics:['数学']};const first=await request('/entries',a,input,'POST',{key}),replay=await request('/entries',a,input,'POST',{key});assert.equal(first.status,201);assert.equal(replay.value.id,first.value.id);assert.equal(first.value.author.accountId,a.accountId);publicPost=first.value.id;
      assert.equal((await request('/entries',a,{...input,body:'different'},'POST',{key})).status,409);
      privatePost=(await create(a,{body:'private-secret-A',scope:'self'})).id;
      publicResource=(await create(a,{kind:'resource',title:'共享线性代数',body:'public resource learning',resourceType:'note'})).id;
      groupResource=(await create(a,{kind:'resource',body:'group-secret-A',scope:'group',groupId})).id;
      assert.equal((await request('/entries',b,{kind:'post',body:'not a member',scope:'group',groupId})).status,403);
    });
    await t.test('public lists, search, pagination, profiles and details exclude private or group records',async()=>{
      const all=await request('/entries?view=public&limit=20');assert.equal(all.status,200);assert.deepEqual(new Set(all.value.items.map((item:any)=>item.id)),new Set([publicPost,publicResource]));
      for(const who of [undefined,b]){assert.equal((await request('/entries/'+privatePost,who)).status,403);assert.equal((await request('/entries/'+groupResource,who)).status,403);assert.equal((await request('/entries?view=public&q=secret&limit=1',who)).value.items.length,0);}
      const searched=await request('/entries?view=public&q=public%20resource&resourceType=note',b);assert.equal(searched.value.items.length,1);assert.equal(searched.value.items[0].id,publicResource);
      assert.equal((await request('/entries?view=mine&authorId='+a.accountId,b)).value.items.length,0);
      assert.equal((await request('/entries?view=bookmarks')).status,401);
      assert.equal((await request('/entries?view=group&groupId='+groupId,b)).status,403);
      const profile=await request('/people/'+a.accountId,b);assert.equal(profile.status,200);const encoded=JSON.stringify(profile.value);for(const field of ['email','role','csrf','password','subject'])assert.equal(encoded.includes(`"${field}"`),false);
      assert.equal((await request('/people?accountId='+a.accountId,b)).status,400);
      assert.equal((await request('/entries?view=public&view=mine',b)).status,400);
    });
    await t.test('bookmarks and learning memberships are owned separately even for the same public resource',async()=>{
      await request(`/entries/${publicResource}/bookmark`,b,{enabled:true},'PUT');await request(`/entries/${publicResource}/learning`,b,{enabled:true},'PUT');
      const aView=(await request('/entries/'+publicResource,a)).value,bView=(await request('/entries/'+publicResource,b)).value;
      assert.equal(aView.bookmarked,false);assert.equal(aView.inLearning,false);assert.equal(bView.bookmarked,true);assert.equal(bView.inLearning,true);assert.equal(aView.learningCount,1);
      assert.equal((await request('/entries?view=bookmarks',a)).value.items.length,0);assert.equal((await request('/entries?view=bookmarks',b)).value.items[0].id,publicResource);
      assert.equal((await request('/entries?view=learning',a)).value.items.length,0);assert.equal((await request('/entries?view=learning',b)).value.items[0].id,publicResource);
      assert.equal((await request(`/entries/${publicResource}/bookmark`,a,{enabled:true,accountId:b.accountId},'PUT')).status,400);
      assert.equal((await request(`/entries/${privatePost}/bookmark`,b,{enabled:true},'PUT')).status,403);
    });
    await t.test('following lists are private and the followed feed contains only public content',async()=>{
      assert.equal((await request(`/people/${a.accountId}/follow`,b,{enabled:true},'PUT')).status,200);
      const followed=await request('/entries?view=following&limit=20',b);assert.deepEqual(new Set(followed.value.items.map((item:any)=>item.id)),new Set([publicPost,publicResource]));
      assert.equal((await request('/entries?view=following',a)).value.items.length,0);
      assert.equal((await request('/people?following=true',b)).value.items[0].accountId,a.accountId);assert.equal((await request('/people?following=true',a)).value.items.length,0);assert.equal((await request('/people?following=true')).status,401);
      assert.equal((await request(`/people/${a.accountId}/follow`,a,{enabled:true},'PUT')).status,400);
    });
    await t.test('private drafts retain visibility and never move to another account or public search',async()=>{
      const draft={title:'private-draft-A',body:'draft-secret-A',topics:['线性代数'],scope:'self',resourceType:'route'};
      assert.equal((await request('/me/drafts/resource',a,draft,'PUT')).status,200);
      assert.deepEqual((await request('/me/drafts/resource',a)).value,draft);assert.equal((await request('/me/drafts/resource',b)).value.body,'');assert.equal((await request('/entries?q=draft-secret')).value.items.length,0);
      assert.equal((await request('/me/drafts/resource',b,{...draft,accountId:a.accountId},'PUT')).status,400);assert.deepEqual((await request('/me/drafts/resource',a)).value,draft);
      await request('/me/drafts/resource',b,{title:'B draft',body:'draft-secret-B',topics:[]},'PUT');await create(a,{kind:'resource',body:'new public resource'});
      assert.equal((await request('/me/drafts/resource',a)).value.body,'');assert.equal((await request('/me/drafts/resource',b)).value.body,'draft-secret-B');
    });
    await t.test('mutual replies inherit parent access and cannot cross threads or bypass group membership',async()=>{
      commentA=(await request(`/entries/${publicPost}/comments`,a,{body:'A 的回应'})).value.id;const replied=await request(`/entries/${publicPost}/comments`,b,{body:'B 的补充',replyToId:commentA});assert.equal(replied.status,201);
      const comments=(await request(`/entries/${publicPost}/comments`,b)).value.items;assert.equal(comments.length,2);assert.equal(comments[1].replyToId,commentA);assert.equal(comments[1].author.accountId,b.accountId);
      assert.equal((await request(`/entries/${publicResource}/comments`,b,{body:'wrong parent',replyToId:commentA})).status,400);assert.equal((await request(`/entries/${privatePost}/comments`,b,{body:'private intrusion'})).status,403);assert.equal((await request(`/entries/${groupResource}/comments`,b,{body:'group intrusion'})).status,403);
      assert.ok((await request('/entries?view=participated',b)).value.items.some((item:any)=>item.id===publicPost));
    });
    await t.test('leaving a group revokes entry, comment, bookmark and learning access without publishing private content',async()=>{
      await fixture.db.query("INSERT INTO group_memberships(group_id,account_id,role,state) VALUES($1,$2,'member','active')",[groupId,b.accountId]);
      assert.equal((await request('/entries/'+groupResource,b)).status,200);await request(`/entries/${groupResource}/bookmark`,b,{enabled:true},'PUT');await request(`/entries/${groupResource}/learning`,b,{enabled:true},'PUT');
      await fixture.db.query("UPDATE group_memberships SET state='left' WHERE group_id=$1 AND account_id=$2",[groupId,b.accountId]);
      assert.equal((await request('/entries/'+groupResource,b)).status,403);assert.equal((await request(`/entries/${groupResource}/comments`,b)).status,403);
      for(const view of ['bookmarks','learning'])assert.equal((await request('/entries?view='+view,b)).value.items.some((item:any)=>item.id===groupResource),false);
      assert.equal((await request(`/entries/${groupResource}/bookmark`,b,{enabled:false},'PUT')).status,200);
    });
    await t.test('only the author edits or withdraws; withdrawn/restricted resources vanish from public and personal saved lists',async()=>{
      assert.equal((await request('/entries/'+publicPost,b,{body:'takeover',topics:[]},'PUT')).status,403);
      assert.equal((await request('/entries/'+publicPost,a,{body:'edited public post',title:'edited',topics:[]},'PUT')).status,200);
      assert.equal((await request('/entries/'+publicPost,b,undefined,'DELETE')).status,403);
      assert.equal((await request('/entries/'+publicPost,a,undefined,'DELETE')).status,200);assert.equal((await request('/entries/'+publicPost,b)).status,403);
      assert.equal((await request(`/entries/${publicPost}/comments`,b)).status,403);assert.equal((await request(`/entries/${publicPost}/restore`,b,{})).status,403);assert.equal((await request(`/entries/${publicPost}/restore`,a,{})).status,200);
      await fixture.db.query("UPDATE protected_objects SET state='restricted',restricted_until=$2 WHERE id=$1",[publicResource,new Date(now.getTime()+60000)]);
      assert.equal((await request('/entries?view=public&kind=resource&limit=20',b)).value.items.some((item:any)=>item.id===publicResource),false);
      assert.equal((await request('/entries?view=bookmarks',b)).value.items.some((item:any)=>item.id===publicResource),false);assert.equal((await request('/entries/'+publicResource,a)).status,200);
      now=new Date(now.getTime()+61000);assert.equal((await request('/entries/'+publicResource,b)).status,200);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();}
});
