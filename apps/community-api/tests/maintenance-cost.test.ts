import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './helpers.js';
import {startMaintenance} from '../src/worker.js';
import type {FileService} from '../src/files.js';
test('hourly maintenance sleeps between actual work while retrying failed jobs',async t=>{
  const fixture=await createTestDatabase('maintenance_cost');let now=new Date('2026-10-25T00:05:00Z'),queries=0,calls=0,fail=false;
  const traced={...fixture.db,query:async<R>(sql:string,values?:readonly unknown[])=>{queries++;return fixture.db.query<R>(sql,values);},transaction:<T>(work:Parameters<typeof fixture.db.transaction<T>>[0])=>fixture.db.transaction(sql=>work({query:async<R>(statement:string,values?:readonly unknown[])=>{queries++;return sql.query<R>(statement,values);}}))};
  const timers=new Map<ReturnType<typeof setTimeout>,{fn:()=>void;at:number}>(),events:Record<string,unknown>[]=[];
  const options={clock:()=>new Date(now),setTimer:(fn:()=>void,ms:number)=>{const id={unref(){}} as ReturnType<typeof setTimeout>;timers.set(id,{fn,at:now.getTime()+ms});return id;},clearTimer:(id:ReturnType<typeof setTimeout>)=>{timers.delete(id);}};
  const files={async cleanupExpired(){calls++;if(fail){fail=false;throw Error('Synthetic cleanup failure');}return {cleaned:0};}} as unknown as FileService;
  const stop=startMaintenance(traced,files,event=>events.push(event),options);
  const ready=async()=>{for(let i=0;i<300&&!timers.size;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(timers.size,1);};
  const advance=async(ms:number)=>{const end=now.getTime()+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=new Date(next[1].at);timers.delete(next[0]);await next[1].fn();}now=new Date(end);};
  try{
    await ready();await t.test('idle 30 minutes runs no database probes after startup; next hour executes once',async()=>{
      assert.equal(calls,1);const before=queries;await advance(30*60000);assert.equal(queries,before);assert.equal(calls,1);await advance(25*60000);assert.equal(calls,2);assert.ok(events.every(event=>event.state==='completed'));assert.equal((await fixture.db.query('SELECT 1 FROM background_jobs')).rowCount,2);
    });
    await t.test('cleanup failure retries at its lease-backed queue deadline; stop removes the timer',async()=>{
      fail=true;await advance(3600000);assert.equal(calls,3);assert.equal(events.at(-1)?.state,'queued');assert.equal([...timers.values()][0].at-now.getTime(),60000);
      const before=queries;await advance(59999);assert.equal(queries,before);await advance(1);assert.equal(calls,4);assert.equal(events.at(-1)?.state,'completed');await stop();assert.equal(timers.size,0);const stoppedQueries=queries;await advance(3600000);assert.equal(queries,stoppedQueries);
    });
  }finally{await stop();await fixture.cleanup();}
});
