import {JobQueue,type Job} from './operations.js';
import type {Database} from './db.js';
import type {FileService} from './files.js';
import type {NewsSourceService} from './newsSources.js';
import {systemClock,type Clock} from './types.js';
import {setTimeout,clearTimeout,setInterval,clearInterval} from 'node:timers';
export type JobHandler=(payload:unknown)=>Promise<unknown>;
export class JobWorker {
  private readonly queue:JobQueue;
  constructor(db:Database,private readonly handlers:Record<string,JobHandler>,private readonly workerId:string,clock:Clock=systemClock){this.queue=new JobQueue(db,clock);}
  async runOnce():Promise<Job|null>{
    const job=await this.queue.claim(this.workerId,60_000);if(!job)return null;
    const handler=Object.hasOwn(this.handlers,job.kind)?this.handlers[job.kind]:undefined;
    if(!handler)return this.queue.fail(job.id,job.leaseToken!,'unsupported_job',60_000);
    const heartbeat=setInterval(()=>{void this.queue.heartbeat(job.id,job.leaseToken!,60_000).catch(()=>{});},15_000);heartbeat.unref();
    try{return await this.queue.complete(job.id,job.leaseToken!,await handler(job.payload));}
    catch{return await this.queue.fail(job.id,job.leaseToken!,'job_execution_failed',60_000).catch(()=>null);}
    finally{clearInterval(heartbeat);}
  }
}
/** Registry is owned by the server, never selected from a browser-supplied command. */
export function startMaintenance(db:Database,files:FileService,log:(value:Record<string,unknown>)=>void,options:{clock?:Clock;setTimer?:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void}={}){
  const clock=options.clock||systemClock,setTimer:NonNullable<typeof options.setTimer>=options.setTimer||setTimeout,clearTimer=options.clearTimer||clearTimeout;
  const queue=new JobQueue(db,clock),worker=new JobWorker(db,{'system.maintenance':async()=>{
    const cleared=await files.cleanupExpired(100);
    const counts=await db.transaction(async sql=>{
      const grants=await sql.query('DELETE FROM attachment_download_grants WHERE expires_at<now()');
      const rates=await sql.query("DELETE FROM rate_limits WHERE reset_at<now()-interval '1 day'");
      const sessions=await sql.query("DELETE FROM sessions WHERE expires_at<now()-interval '30 days'");
      const tokens=await sql.query("DELETE FROM auth_tokens WHERE expires_at<now()-interval '30 days'");
      const hosted=await sql.query('DELETE FROM hosted_sessions WHERE session_id IN (SELECT id FROM sessions WHERE revoked_at IS NOT NULL OR expires_at<now())');
      const challenges=await sql.query("DELETE FROM hosted_email_challenges WHERE expires_at<now()-interval '1 day'");
      return {grants:grants.rowCount,rates:rates.rowCount,sessions:sessions.rowCount,tokens:tokens.rowCount,hosted:hosted.rowCount,challenges:challenges.rowCount};
    });return {cleared,...counts};
  }},`maintenance-${process.pid}`,clock);
  let stopped=false,running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,failures=0;
  const tick=()=>{if(stopped||running)return;let delay=3600000-clock().getTime()%3600000;running=(async()=>{
    const bucket=clock().toISOString().slice(0,13),scheduled=await queue.enqueue('system.maintenance',`maintenance:${bucket}`,{});
    const result=await worker.runOnce();if(result)log({event:'background_job',id:result.id,kind:result.kind,state:result.state});
    failures=0;
    // Successful hourly work does not need 59 empty queue checks. Retry queued
    // work and recover an active lease at its own deadline instead of sleeping past it.
    const pending=result?.state==='queued'?result:!result?scheduled:null;
    if(pending?.state==='queued')delay=Math.max(1000,Date.parse(pending.availableAt)-clock().getTime());
    if(pending?.state==='running'&&pending.leaseUntil)delay=Math.max(1000,Date.parse(pending.leaseUntil)-clock().getTime());
  })().catch(()=>{failures++;delay=Math.min(900000,60000*2**Math.min(failures-1,4));log({event:'background_job_error',code:'maintenance_unavailable'});}).finally(()=>{running=undefined;if(!stopped){timer=setTimer(()=>tick(),Math.max(1000,delay));timer.unref();}});return running;};
  void tick();
  return async()=>{stopped=true;if(timer)clearTimer(timer);await running;};
}

/** Shares the API process; paused sources never issue an outbound request. */
export function startNewsCollection(sources:Pick<NewsSourceService,'tick'|'stop'>,log:(value:Record<string,unknown>)=>void,options:{setTimer?:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void}={}){
  const setTimer:NonNullable<typeof options.setTimer>=options.setTimer||setTimeout,clearTimer=options.clearTimer||clearTimeout;
  let stopped=false,running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=()=>{
    if(stopped||running)return;
    running=(async()=>{const results=await sources.tick();if(results.length)log({event:'news_collection',results});})()
      .catch(()=>log({event:'news_collection_error',code:'sources_unavailable'}))
      .finally(()=>{running=undefined;if(!stopped){timer=setTimer(tick,3_600_000);timer.unref();}});
  };
  tick();
  return async()=>{stopped=true;if(timer)clearTimer(timer);await sources.stop();await running;};
}
