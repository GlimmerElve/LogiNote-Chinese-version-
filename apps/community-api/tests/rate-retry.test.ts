import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError} from '../src/errors.js';
import {RateLimiter} from '../src/operations.js';
import {createTestDatabase} from './helpers.js';

test('rate rejection returns remaining time and does not extend or reset the existing throttle',async()=>{
  const fixture=await createTestDatabase('rate_retry');let now=new Date('2026-10-24T01:00:00Z');
  try{
    const limiter=new RateLimiter(fixture.db,()=>new Date(now));
    await limiter.consume('fixture-email',1,60000);now=new Date(now.getTime()+17000);
    for(let i=0;i<3;i++)await assert.rejects(limiter.consume('fixture-email',1,60000),error=>error instanceof ApiError&&error.status===429&&error.retryAfterSeconds===43&&error.source==='community');
    assert.equal((await fixture.db.query<{used:number}>('SELECT used FROM rate_limits WHERE bucket=$1',['fixture-email'])).rows[0].used,1);
    now=new Date(now.getTime()+43000);assert.equal((await limiter.consume('fixture-email',1,60000)).remaining,0);
  }finally{await fixture.cleanup();}
});
