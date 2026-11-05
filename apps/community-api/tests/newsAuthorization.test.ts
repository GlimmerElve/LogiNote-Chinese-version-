import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from './helpers.js';
import {AccessService} from '../src/access.js';
import {NewsService} from '../src/news.js';
import type {Actor} from '../src/types.js';
import type {Sql} from '../src/db.js';
import type {FileService} from '../src/files.js';
import type {ContentService} from '../src/content.js';

test('official creation and review lose authorization when demotion commits while waiting for the account write lock',async t=>{
  const fixture=await createTestDatabase('news_admin_race'),now=new Date('2026-10-25T08:00:00Z'),access=new AccessService(fixture.db,()=>now),news=new NewsService(fixture.db,access,null as unknown as FileService,null as unknown as ContentService,()=>now);
  const account=async(name:string,role:'administrator'|'member'):Promise<Actor>=>{const id=randomUUID();await fixture.db.query('INSERT INTO accounts(id,email,display_name,role,password_hash,email_verified_at) VALUES($1,$2,$3,$4,$5,$6)',[id,name+'@news.example.test',name,role,'synthetic-isolated-account',now]);return {accountId:id,role,mfaVerified:role==='administrator'};};
  try{
    const admin=await account('admin','administrator'),member=await account('member','member');
    const whileDemoting=async(work:(sql:Sql)=>Promise<unknown>)=>{
      let release!:()=>void,locked!:(pid:number)=>void;const proceed=new Promise<void>(resolve=>{release=resolve;}),holding=new Promise<number>(resolve=>{locked=resolve;});
      const demotion=fixture.db.transaction(async sql=>{await sql.query("UPDATE accounts SET role='member' WHERE id=$1",[admin.accountId]);locked((await sql.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid);await proceed;});let pending:Promise<unknown>|undefined;
      try{
        const blocker=await holding;pending=fixture.db.transaction(work);void pending.catch(()=>{});let blocked=false;
        for(let attempt=0;attempt<100&&!blocked;attempt++){blocked=!!(await fixture.db.query<{waiting:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[blocker])).rows[0].waiting;if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));}
        assert.equal(blocked,true,'the real account lock must hold the official write after its first admin read');release();await demotion;await assert.rejects(pending,{status:403});
      }finally{release();await demotion.catch(()=>{});await pending?.catch(()=>{});await fixture.db.query("UPDATE accounts SET role='administrator' WHERE id=$1",[admin.accountId]);}
    };
    await t.test('new official articles and announcements cannot be created with a stale administrator actor',async()=>{
      for(const kind of ['article','announcement']){const before=Number((await fixture.db.query('SELECT count(*)::int AS n FROM protected_objects')).rows[0].n);await whileDemoting(sql=>news.save(admin,undefined,{kind,title:'未授权官方稿',body:'该事务必须整体拒绝。'},sql));assert.equal(Number((await fixture.db.query('SELECT count(*)::int AS n FROM protected_objects')).rows[0].n),before);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM news_articles')).rows[0].n,0);}
      const ordinary=await fixture.db.transaction(sql=>news.save(member,undefined,{kind:'news',body:'普通投稿仍然可用，不需要管理员身份。'},sql));assert.equal(ordinary.origin,'user');assert.equal(ordinary.kind,'news');
    });
    await t.test('pending publication remains private and unchanged when the reviewer is demoted during the actual lock wait',async()=>{
      let draft:any=await fixture.db.transaction(sql=>news.save(member,undefined,{body:'等待真实审核的用户投稿。'},sql));draft=await fixture.db.transaction(sql=>news.submit(member,draft.id,{expectedVersion:draft.version},sql));const before=(await fixture.db.query('SELECT version,published_revision_id FROM news_articles WHERE id=$1',[draft.id])).rows[0],events=Number((await fixture.db.query('SELECT count(*)::int AS n FROM news_events WHERE article_id=$1',[draft.id])).rows[0].n);
      await whileDemoting(sql=>news.review(admin,draft.id,{expectedVersion:draft.version,revisionId:draft.revision.id,action:'publish'},sql));assert.deepEqual((await fixture.db.query('SELECT version,published_revision_id FROM news_articles WHERE id=$1',[draft.id])).rows[0],before);assert.equal((await fixture.db.query('SELECT state FROM news_revisions WHERE id=$1',[draft.revision.id])).rows[0].state,'pending');assert.equal((await fixture.db.query('SELECT scope FROM protected_objects WHERE id=$1',[draft.id])).rows[0].scope,'self');assert.equal(Number((await fixture.db.query('SELECT count(*)::int AS n FROM news_events WHERE article_id=$1',[draft.id])).rows[0].n),events);assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM community_entries WHERE object_id=$1',[draft.id])).rows[0].n,0);
    });
  }finally{await fixture.cleanup();}
});
