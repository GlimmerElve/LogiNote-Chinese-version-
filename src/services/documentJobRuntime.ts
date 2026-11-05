import { createDocumentBackgroundQueue, documentJobActive, normalizeDocumentBackgroundJobs, type DocumentBackgroundJob } from './documentBackgroundQueue';
type Queue=ReturnType<typeof createDocumentBackgroundQueue>;
export function createPersistentDocumentJobs(ports:{scope:()=>Promise<string>;load:()=>Promise<{scopeId:string;jobs:DocumentBackgroundJob[]}>;
  save:(scopeId:string,jobs:DocumentBackgroundJob[])=>Promise<void>}){
  const queues=new Map<string,Queue>(),listeners=new Set<()=>void>();let currentScope:string|undefined;
  let loading:Promise<string>|undefined;
  const notify=()=>{for(const listener of listeners)try{listener();}catch{/* Closed pages do not own tasks. */}};
  const current=()=>{const queue=currentScope?queues.get(currentScope):undefined;if(!queue)throw new Error('任务恢复尚未就绪');return queue;};
  async function ensureReady():Promise<string>{
    if(loading){await loading;return ensureReady();}
    loading=(async()=>{
      const scopeId=await ports.scope();
      if(currentScope===scopeId)return scopeId;
      if(!queues.has(scopeId)){
        const saved=await ports.load();
        if(saved.scopeId!==scopeId||scopeId!==await ports.scope())throw new Error('资料库发生变化，请重新查询任务');
        const jobs=normalizeDocumentBackgroundJobs(saved.jobs).map(job=>job.scopeId===scopeId?job:{...job,scopeId,sourceIdentity:undefined,
          status:'interrupted' as const,message:'存储位置或资料库绑定发生变化；记录保留，但须从资料页重新检查来源，不直接继续旧任务。'});
        const queue=createDocumentBackgroundQueue({read:()=>jobs,write:value=>ports.save(scopeId,value)});
        queue.subscribe(()=>{if(currentScope===scopeId)notify();});queues.set(scopeId,queue);
      }
      if(currentScope)for(const job of current().getSnapshot().filter(documentJobActive))current().cancel(job.id);
      currentScope=scopeId;notify();return scopeId;
    })();
    try{return await loading;}finally{loading=undefined;}
  }
  return {ensureReady,getSnapshot:()=>currentScope?current().getSnapshot():[],
    getScopeId:()=>currentScope,getPersistenceError:()=>currentScope?current().getPersistenceError():undefined,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    enqueue(input:Parameters<Queue['enqueue']>[0],run:Parameters<Queue['enqueue']>[1]){
      const ownerScope=currentScope;
      return current().enqueue({...input,scopeId:ownerScope},async(progress,signal)=>{
        if(ownerScope!==await ports.scope())throw new Error('资料库已改变，旧任务不会转移到新资料库');
        signal.throwIfAborted();
        return run(progress,signal);
      });
    },
    cancel:(id:string)=>current().cancel(id),archive:(id:string,archived:boolean)=>current().archive(id,archived),flush:()=>current().flush(),
  };
}
