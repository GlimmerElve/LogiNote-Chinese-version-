import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {ApiError} from '../src/errors.js';
import {JobQueue,MAX_ACCOUNT_STORAGE_BYTES,MAX_FILE_BYTES,QuotaService,RateLimiter,runIdempotent} from '../src/operations.js';
import type {Actor} from '../src/types.js';
import {createTestDatabase} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
const mb=1024*1024;

test('durable operations against isolated PostgreSQL',async t=>{
  const fixture=await createTestDatabase('operations'),db=fixture.db,peer=createDatabase(fixture.url);
  let now=new Date('2026-10-23T00:00:00Z');const clock=()=>new Date(now);
  const account=async():Promise<Actor>=>{const accountId=randomUUID();await db.query('INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,$3)',[accountId,`${accountId}@example.test`,'synthetic-domain-fixture']);return {accountId,role:'member',mfaVerified:false};};
  try{
    const first=await account(),second=await account();
    await db.query('CREATE TABLE operation_test_effects(id uuid PRIMARY KEY,value integer NOT NULL)');
    await t.test('concurrent idempotency, canonical payload matching, durable replay and rollback share one transaction',async()=>{
      let executions=0;const id=randomUUID();
      const work=async(sql:Parameters<Parameters<typeof runIdempotent>[5]>[0])=>{executions++;await sql.query('INSERT INTO operation_test_effects(id,value) VALUES($1,1)',[id]);return {id,created:true};};
      const responses=await Promise.all(Array.from({length:16},(_,index)=>runIdempotent(index%2?peer:db,first.accountId,'create-once','create',{a:1,b:2},work)));
      assert.equal(executions,1);assert.ok(responses.every(response=>response.id===id));assert.equal((await db.query('SELECT * FROM operation_test_effects WHERE id=$1',[id])).rowCount,1);
      assert.deepEqual(await runIdempotent(peer,first.accountId,'create-once','create',{b:2,a:1},async()=>{throw Error('must replay');}),{id,created:true});
      await assert.rejects(runIdempotent(db,first.accountId,'create-once','create',{a:2},work),code('idempotency_conflict'));
      await assert.rejects(runIdempotent(db,first.accountId,'create-once','different',{a:1,b:2},work),code('idempotency_conflict'));
      assert.equal(await runIdempotent(db,second.accountId,'create-once','create',{},async()=>({separateActor:true})).then(result=>result.separateActor),true);
      const rollbackId=randomUUID();await assert.rejects(runIdempotent(db,first.accountId,'failed-once','create',{},async sql=>{await sql.query('INSERT INTO operation_test_effects(id,value) VALUES($1,2)',[rollbackId]);throw Error('synthetic rollback');}),/synthetic rollback/);
      assert.equal((await db.query('SELECT * FROM operation_test_effects WHERE id=$1',[rollbackId])).rowCount,0);
      assert.equal((await db.query('SELECT * FROM idempotency_results WHERE actor_id=$1 AND idempotency_key=$2',[first.accountId,'failed-once'])).rowCount,0);
      assert.deepEqual(await runIdempotent(peer,first.accountId,'failed-once','create',{},async sql=>{await sql.query('INSERT INTO operation_test_effects(id,value) VALUES($1,2)',[rollbackId]);return {recovered:true};}),{recovered:true});
    });
    await t.test('rate limits remain atomic across pools and reset only after their persisted window',async()=>{
      const a=new RateLimiter(db,clock),b=new RateLimiter(peer,clock);
      const outcomes=await Promise.allSettled(Array.from({length:24},(_,index)=>(index%2?a:b).consume('message:test',7,60_000)));
      assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,7);assert.ok(outcomes.filter(outcome=>outcome.status==='rejected').every(outcome=>code('rate_limited')(outcome.reason)));
      assert.equal((await db.query<{used:number}>('SELECT used FROM rate_limits WHERE bucket=$1',['message:test'])).rows[0].used,7);
      await assert.rejects(new RateLimiter(peer,clock).consume('message:test',7,60_000),code('rate_limited'));
      now=new Date(now.getTime()+60_001);assert.equal((await a.consume('message:test',7,60_000,3)).remaining,4);
      await assert.rejects(a.consume('message:test',7,60_000,5),code('rate_limited'));
    });
    await t.test('personal reservations cannot race over 1 GiB; owners commit or release and expired intents stop consuming quota',async()=>{
      const quota=new QuotaService(db,{globalLimitBytes:2048*mb,reservationTtlMs:10_000},clock),other=new QuotaService(peer,{globalLimitBytes:2048*mb,reservationTtlMs:10_000},clock);
      assert.equal(MAX_FILE_BYTES,100*mb);assert.equal(MAX_ACCOUNT_STORAGE_BYTES,1024*mb);
      await assert.rejects(quota.reserve(first,100*mb+1,'too-large'),code('file_too_large'));
      const outcomes=await Promise.allSettled(Array.from({length:12},(_,index)=>(index%2?quota:other).reserve(first,100*mb,`personal-${index}`)));
      const reserved=outcomes.filter(outcome=>outcome.status==='fulfilled').map(outcome=>outcome.value);assert.equal(reserved.length,10);assert.ok(outcomes.filter(outcome=>outcome.status==='rejected').every(outcome=>code('quota_exceeded')(outcome.reason)));
      const committed=await quota.commit(first,reserved[0].id);assert.equal(committed.state,'committed');assert.equal((await other.commit(first,committed.id)).state,'committed');
      await assert.rejects(quota.release(second,committed.id),code('not_found'));await assert.rejects(quota.release(first,committed.id),code('reservation_committed'));
      await quota.release(first,reserved[1].id);assert.equal((await other.release(first,reserved[1].id)).state,'released');await quota.reserve(first,100*mb,'replacement');
      now=new Date(now.getTime()+10_001);await assert.rejects(quota.commit(first,reserved[2].id),code('reservation_expired'));
      assert.equal((await quota.reserve(first,10*mb,'after-expiry')).state,'reserved');
      await assert.rejects(quota.reserve(first,9*mb,'after-expiry'),code('idempotency_conflict'));
    });
    await t.test('global reservations and file metadata/idempotency work commit together or release on failure',async()=>{
      await db.query('DELETE FROM storage_reservations');
      const quota=new QuotaService(db,{globalLimitBytes:10*mb},clock),other=new QuotaService(peer,{globalLimitBytes:10*mb},clock);
      const contenders=await Promise.allSettled([quota.reserve(first,6*mb,'global-first'),other.reserve(second,6*mb,'global-second')]);assert.equal(contenders.filter(result=>result.status==='fulfilled').length,1);
      const winningIndex=contenders.findIndex(result=>result.status==='fulfilled'),winner=contenders[winningIndex];assert.equal(winner.status,'fulfilled');
      if(winner.status==='fulfilled')await quota.release(winningIndex===0?first:second,winner.value.id);
      await other.reserve(second,6*mb,'after-global-release');
      const metadataId=randomUUID();
      await assert.rejects(runIdempotent(db,first.accountId,'atomic-upload','upload',{bytes:100},async sql=>{
        const intent=await quota.reserve(first,100,'atomic-reservation',sql);await quota.commit(first,intent.id,sql);await sql.query('INSERT INTO operation_test_effects(id,value) VALUES($1,3)',[metadataId]);throw Error('metadata transaction failed');
      }),/metadata transaction failed/);
      assert.equal((await db.query('SELECT * FROM storage_reservations WHERE reservation_key=$1',['atomic-reservation'])).rowCount,0);assert.equal((await db.query('SELECT * FROM operation_test_effects WHERE id=$1',[metadataId])).rowCount,0);
      const work=async(sql:Parameters<Parameters<typeof runIdempotent>[5]>[0])=>{const intent=await quota.reserve(first,100,'atomic-reservation',sql);const committed=await quota.commit(first,intent.id,sql);await sql.query('INSERT INTO operation_test_effects(id,value) VALUES($1,3)',[metadataId]);return committed;};
      const committed=await runIdempotent(db,first.accountId,'atomic-upload','upload',{bytes:100},work);assert.equal(committed.state,'committed');assert.equal((await runIdempotent(peer,first.accountId,'atomic-upload','upload',{bytes:100},work)).id,committed.id);
      await assert.rejects(new QuotaService(db,{globalLimitBytes:0},clock).reserve(first,1,'disabled'),code('not_configured'));
    });
    await t.test('job dedup, exclusive claims, stale lease rejection, delayed retries and completion survive service instances',async()=>{
      const a=new JobQueue(db,clock),b=new JobQueue(peer,clock);
      const jobs=await Promise.all(Array.from({length:12},(_,index)=>(index%2?a:b).enqueue('digest','one-event',{body:'synthetic'},{maxAttempts:3})));assert.equal(new Set(jobs.map(job=>job.id)).size,1);
      await assert.rejects(a.enqueue('digest','one-event',{body:'different'}),code('idempotency_conflict'));
      const claims=await Promise.all([a.claim('worker-a',1000),b.claim('worker-b',1000),a.claim('worker-c',1000)]),firstClaim=claims.find(Boolean)!;assert.equal(claims.filter(Boolean).length,1);assert.equal(firstClaim.attempts,1);
      now=new Date(now.getTime()+1001);const reclaimed=(await b.claim('worker-next',1000))!;assert.equal(reclaimed.id,firstClaim.id);assert.equal(reclaimed.attempts,2);assert.notEqual(reclaimed.leaseToken,firstClaim.leaseToken);
      await assert.rejects(a.complete(firstClaim.id,firstClaim.leaseToken!),code('lease_lost'));await assert.rejects(a.heartbeat(firstClaim.id,firstClaim.leaseToken!),code('lease_lost'));
      assert.equal((await b.fail(reclaimed.id,reclaimed.leaseToken!,'temporary_failure',2000)).state,'queued');assert.equal(await a.claim('too-early'),null);
      now=new Date(now.getTime()+2001);const last=(await a.claim('last-worker'))!;assert.equal(last.attempts,3);assert.equal((await a.fail(last.id,last.leaseToken!,'final_failure')).state,'failed');assert.equal(await b.claim('done-worker'),null);
      const done=await a.enqueue('digest','complete-event',{value:1}),running=(await b.claim('worker-complete'))!;assert.equal(running.id,done.id);await b.heartbeat(running.id,running.leaseToken!);
      assert.equal((await a.complete(running.id,running.leaseToken!,{success:true})).state,'completed');assert.deepEqual((await b.complete(running.id,running.leaseToken!,{success:false})).result,{success:true});assert.equal((await new JobQueue(peer,clock).get(done.id))?.state,'completed');
      await a.enqueue('digest','lease-exhaustion',{}, {maxAttempts:1});const abandoned=(await a.claim('abandoned',1000))!;now=new Date(now.getTime()+1001);assert.equal(await b.claim('recover-expired'),null);assert.equal((await b.get(abandoned.id))?.state,'failed');
    });
  }finally{await peer.close();await fixture.cleanup();}
});
