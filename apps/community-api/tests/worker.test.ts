import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './helpers.js';
import {JobQueue} from '../src/operations.js';
import {JobWorker} from '../src/worker.js';
test('real worker invokes only registered handlers, commits results, and records sanitized failed retries',async t=>{
  const f=await createTestDatabase('worker');t.after(()=>f.cleanup());const queue=new JobQueue(f.db);let calls=0;
  const worker=new JobWorker(f.db,{'fixture.execute':async()=>{calls++;return {done:true};},'fixture.fail':async()=>{throw Error('private body or password');}},'test-worker');
  const first=await queue.enqueue('fixture.execute','one',{});assert.equal((await worker.runOnce())?.state,'completed');assert.equal(calls,1);assert.deepEqual((await queue.get(first.id))?.result,{done:true});assert.equal(await worker.runOnce(),null);
  const failed=await queue.enqueue('fixture.fail','two',{}, {maxAttempts:1});assert.equal((await worker.runOnce())?.state,'failed');assert.equal((await queue.get(failed.id))?.lastError,'job_execution_failed');
  await queue.enqueue('unregistered.shell','three',{}, {maxAttempts:1});assert.equal((await worker.runOnce())?.lastError,'unsupported_job');assert.equal(calls,1);
});
