import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './helpers.js';
import {TransferQuota} from '../src/transfers.js';
test('download budget defaults closed, persists across instances and enforces concurrent monthly limit',async t=>{
  const fixture=await createTestDatabase('transfers');t.after(()=>fixture.cleanup());let now=new Date('2026-10-23T00:00:00Z');
  const quota=new TransferQuota(fixture.db,100,()=>now);
  await assert.rejects(new TransferQuota(fixture.db,0).consume(1),{code:'not_configured'});
  const attempts=await Promise.allSettled(Array.from({length:20},()=>quota.consume(10)));assert.equal(attempts.filter(r=>r.status==='fulfilled').length,10);assert.equal((await quota.usage()).usedBytes,100);
  await assert.rejects(new TransferQuota(fixture.db,100,()=>now).consume(1),{code:'quota_exceeded'});
  now=new Date('2026-11-01T00:00:00Z');assert.equal((await quota.consume(10)).usedBytes,10);
});
