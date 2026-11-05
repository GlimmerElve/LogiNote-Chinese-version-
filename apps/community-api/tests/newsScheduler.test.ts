import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {startNewsCollection} from '../src/worker.js';

test('news scheduler stays in-process, polls at most hourly, logs summaries and drains on stop',async()=>{
  let calls=0,stops=0,cleared=0,unref=0,next:(()=>void)|undefined;
  const delays:number[]=[],logs:Record<string,unknown>[]=[];
  const timer={unref(){unref++;return this;}} as ReturnType<typeof setTimeout>;
  const stop=startNewsCollection({async tick(){calls++;return calls===1?[]:[{status:'collected' as const,imported:2,duplicates:1,ignored:0,nextCheckAt:null}];},async stop(){stops++;}},value=>logs.push(value),{
    setTimer(fn,ms){next=fn;delays.push(ms);return timer;},clearTimer(value){assert.equal(value,timer);cleared++;},
  });
  await setImmediate();assert.equal(calls,1);assert.deepEqual(delays,[3_600_000]);assert.equal(unref,1);assert.equal(logs.length,0);
  next!();await setImmediate();assert.equal(calls,2);assert.deepEqual(delays,[3_600_000,3_600_000]);assert.equal(logs[0].event,'news_collection');
  await stop();assert.equal(stops,1);assert.equal(cleared,1);next!();await setImmediate();assert.equal(calls,2);
});

test('news scheduler sanitizes failures and waits for cancellation before returning',async()=>{
  let release!:()=>void,done=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),logs:Record<string,unknown>[]=[];
  const stop=startNewsCollection({async tick(){await gate;throw Error('secret response body');},async stop(){release();await setImmediate();done=true;}},value=>logs.push(value),{
    setTimer(){throw Error('Must not schedule after shutdown');},
  });
  await stop();assert.equal(done,true);assert.deepEqual(logs,[{event:'news_collection_error',code:'sources_unavailable'}]);
});
