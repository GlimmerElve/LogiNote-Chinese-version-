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

test('group tasks have scoped lifecycle, voluntary progress, private pause and reversible actions',async t=>{
  const fixture=await createTestDatabase('group_tasks'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-tasks-')),mail:MailMessage[]=[],origin='http://127.0.0.1:5174';let now=new Date('2026-10-25T04:00:00Z');
  const app=createCommunityServer({db:fixture.db,config:{databaseUrl:fixture.url,encryptionKey:fixture.encryptionKey,host:'127.0.0.1',port:0,webOrigin:origin,allowedOrigins:[origin],secureCookies:false,dataDirectory:directory,globalStorageLimitBytes:50000000,authProvider:'local'},mailer:{configured:true,async send(message){mail.push(message);return 'sent';}},clock:()=>new Date(now)});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(app.server.address() as AddressInfo).port+'/api/community/v1';
  type Who={id:string;cookie:string;csrf:string};
  const request=async(route:string,who?:Who,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>{const response=await fetch(base+route,{method,headers:{Origin:origin,Connection:'close',...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),'Idempotency-Key':randomUUID(),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const ok=async(route:string,who?:Who,body?:unknown,method?:string)=>{const result=await request(route,who,body,method);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.value;};
  const account=async(name:string):Promise<Who>=>{const email=name+'@tasks.example.test',result=await app.auth.register({email,password:'Synthetic tasks account 2026!',displayName:name});await app.auth.verifyEmail({token:mail.at(-1)!.token});const session=await app.auth.login({email,password:'Synthetic tasks account 2026!'});return {id:result.account.id,cookie:'loginote_community_session='+session.sessionToken,csrf:session.csrfToken};};
  const check=async(name:string,work:()=>Promise<void>)=>{now=new Date(now.getTime()+61000);await t.test(name,work);};
  try{
    const owner=await account('任务群主'),member=await account('参与者'),admin=await account('群管理员'),outsider=await account('外部用户'),group=await ok('/groups',owner,{name:'隔离任务共学群'}),room='/groups/'+group.id,tasks=room+'/tasks';let task:any;
    await ok(room+'/membership',member,{action:'join'});await ok(room+'/membership',admin,{action:'join'});await ok(room+'/members/'+admin.id,owner,{action:'promote'},'PUT');
    const read=(who=owner)=>ok(tasks+'/'+task.id,who);
    const progress=async(who:Who,state:string)=>{const latest=await read(who);return ok(tasks+'/'+task.id+'/progress',who,{state,expectedVersion:latest.progressVersion},'PUT');};
    const action=async(who:Who,act:string,fields={})=>{const latest=await read(who);return ok(tasks+'/'+task.id,who,{action:act,expectedVersion:latest.version,...fields},'PUT');};
    await check('only room managers create tasks; fields are optional, validated and never imply task membership',async()=>{
      assert.equal((await request(tasks,member,{title:'越权创建'})).status,403);assert.equal((await request(tasks,outsider)).status,403);assert.equal((await request(tasks)).status,401);
      task=await ok(tasks,owner,{title:'读懂基向量'});assert.equal(task.body,'');assert.equal(task.dueOn,null);assert.equal(task.myState,'none');assert.equal(task.participantCount,0);
      assert.equal((await request(tasks,owner,{title:'日期错误',dueOn:'2026-13-31'})).status,400);assert.equal((await request(tasks,owner,{title:'日期错误',dueOn:'2026-02-30'})).status,400);
      assert.equal((await request(tasks,owner,{title:'伪造用户',accountId:member.id})).status,400);assert.equal((await request(tasks,owner,{title:'csrf'},'POST',{'X-CSRF-Token':'wrong'})).status,403);
      const edited=await action(admin,'edit',{title:task.title,body:'## 看图理解\nhttps://example.org/basis',dueOn:'2026-11-01'});assert.equal(edited.dueOn,'2026-11-01');assert.equal(edited.body.includes('https://'),true);
    });
    await check('own progress and undo are independent, versioned and idempotent; no account identity may be supplied',async()=>{
      await progress(member,'doing');assert.equal((await read(owner)).myState,'none');assert.equal((await read(owner)).participantCount,1);
      const before=await read(member),payload={state:'done',expectedVersion:before.progressVersion},key=randomUUID();const done=await request(tasks+'/'+task.id+'/progress',member,payload,'PUT',{'Idempotency-Key':key});assert.equal(done.status,200);assert.equal((await request(tasks+'/'+task.id+'/progress',member,payload,'PUT',{'Idempotency-Key':key})).value.progressVersion,done.value.progressVersion);
      assert.equal((await request(tasks+'/'+task.id+'/progress',member,payload,'PUT')).status,409);assert.equal((await request(tasks+'/'+task.id+'/progress',owner,{...payload,accountId:member.id},'PUT')).status,400);assert.equal((await read(owner)).completedCount,1);
      const concurrent=await read(member),outcomes=await Promise.all([request(tasks+'/'+task.id+'/progress',member,{state:'doing',expectedVersion:concurrent.progressVersion},'PUT'),request(tasks+'/'+task.id+'/progress',member,{state:'none',expectedVersion:concurrent.progressVersion},'PUT')]);assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
      const undone=await progress(member,'doing');assert.equal(undone.completedAt,null);assert.equal(undone.completedCount,0);const withdrawn=await progress(member,'none');assert.equal(withdrawn.participantCount,0);assert.ok(withdrawn.progressVersion>done.value.progressVersion);assert.equal((await request(tasks+'/'+task.id+'/progress',member,{state:'done',expectedVersion:1},'PUT')).status,409);
    });
    await check('pause is self-only and private; retains reading/chat but stops task actions until explicit resume',async()=>{
      assert.equal((await ok(room+'/participation',member,{paused:true},'PUT')).learningPaused,true);assert.equal((await ok(room,owner)).learningPaused,false);
      assert.equal(JSON.stringify(await ok(room+'/members',owner)).includes('learningPaused'),false);assert.equal((await request(room+'/participation',owner,{paused:true,accountId:member.id},'PUT')).status,400);
      assert.equal((await request(tasks+'/'+task.id+'/progress',member,{state:'done',expectedVersion:(await read(member)).progressVersion},'PUT')).error.code,'learning_paused');await ok(room+'/messages',member,{body:'暂停任务期间仍可正常交流',clientId:randomUUID()});
      await ok(room+'/participation',member,{paused:false},'PUT');await progress(member,'done');assert.equal((await read(owner)).completedCount,1);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM attention_deliveries')).rows[0].n,0);
    });
    await check('closed and removed tasks retain history and restore safely; stale managers cannot overwrite edits',async()=>{
      const stale=await read(owner);await action(admin,'edit',{title:'按基向量推导变换',body:'新的说明'});assert.equal((await request(tasks+'/'+task.id,owner,{action:'edit',expectedVersion:stale.version,title:'旧说明'},'PUT')).status,409);
      assert.equal((await request(tasks+'/'+task.id,member,{action:'close',expectedVersion:(await read(member)).version},'PUT')).status,403);await action(admin,'close');assert.equal((await ok(tasks+'?view=closed',member)).items[0].id,task.id);assert.equal((await request(tasks+'/'+task.id+'/progress',member,{state:'doing',expectedVersion:(await read(member)).progressVersion},'PUT')).status,403);
      await action(owner,'reopen');await action(admin,'remove');assert.equal((await request(tasks+'/'+task.id,member)).status,403);assert.equal((await request(tasks+'?view=removed',member)).status,403);assert.equal((await ok(tasks+'?view=removed',owner)).items[0].id,task.id);await action(owner,'restore');assert.equal((await read(member)).myState,'done');
      const events=await ok(tasks+'/'+task.id+'/activity',member);assert.ok(events.items.some((e:any)=>e.action==='restore'));if(events.nextBefore)assert.ok((await ok(tasks+'/'+task.id+'/activity?before='+events.nextBefore,member)).items.length);assert.equal(JSON.stringify(events).includes('@tasks.'),false);
    });
    await check('task pages are bounded, stable and scoped before pagination',async()=>{
      for(let n=0;n<23;n++)await ok(tasks,admin,{title:'分页任务 '+n});
      const first=await ok(tasks,member),second=await ok(tasks+'?offset='+first.nextOffset,member);assert.equal(first.items.length,20);assert.equal(first.nextOffset,20);assert.equal(second.items.length,4);assert.equal(second.nextOffset,null);assert.equal(new Set([...first.items,...second.items].map((item:any)=>item.id)).size,24);
      assert.equal((await request(tasks+'?view=all',member)).status,400);assert.equal((await request(tasks+'?offset=0&offset=1',member)).status,400);assert.equal((await request(tasks+'?offset=20',outsider)).status,403);
    });
    await check('room/archive/moderation revocation applies to tasks; cross-room routes and visibility cannot bypass it',async()=>{
      const other=await ok('/groups',outsider,{name:'其他群'});assert.equal((await request('/groups/'+other.id+'/tasks/'+task.id,outsider)).status,404);
      const report=await ok('/reports',member,{kind:'report',targetType:'object',targetId:task.id,body:'需要核查任务内容'});assert.ok(report.id);
      await fixture.db.query("UPDATE protected_objects SET state='restricted',restricted_until=$2 WHERE id=$1",[task.id,new Date(now.getTime()+3600000)]);assert.equal((await request(tasks+'/'+task.id,member)).status,403);assert.equal((await request(tasks+'/'+task.id,owner,{action:'remove',expectedVersion:(await fixture.db.query('SELECT version FROM protected_objects WHERE id=$1',[task.id])).rows[0].version},'PUT')).status,403);assert.equal((await ok(tasks,member)).items.some((x:any)=>x.id===task.id),false);await fixture.db.query("UPDATE protected_objects SET state='visible' WHERE id=$1",[task.id]);
      await ok(room,owner,{state:'archived'},'PUT');assert.ok(await read(member));assert.equal((await request(tasks,owner,{title:'归档后新增'})).status,403);await ok(room,owner,{state:'active'},'PUT');
      await ok(room+'/members/'+member.id,owner,{action:'remove'},'PUT');assert.equal((await request(tasks,member)).status,403);assert.equal((await request(tasks+'/'+task.id+'/activity',member)).status,403);assert.equal((await read(owner)).participantCount,0);await ok(room+'/membership',member,{action:'join'});assert.equal((await read(member)).myState,'done');
      await ok(room,owner,undefined,'DELETE');assert.equal((await request(tasks,member)).status,410);assert.equal((await request(tasks+'/'+task.id,member)).status,410);
    });
  }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await fixture.cleanup();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
});
