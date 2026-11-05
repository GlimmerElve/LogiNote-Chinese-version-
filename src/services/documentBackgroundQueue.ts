export type DocumentBackgroundStatus='queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
export type DocumentBackgroundAction='next'|'all'|'regenerate'|'continue';
export interface DocumentBackgroundJob {
  id:string;docId:string;fileName:string;action:DocumentBackgroundAction;status:DocumentBackgroundStatus;
  message:string;error?:string;updatedAt:number;
  scopeId?:string;sourceIdentity?:string;resumeOf?:string;archivedAt?:number;
}
type Runner=(progress:(message:string)=>void,signal:AbortSignal)=>Promise<unknown>;
export const documentJobActive=(job:DocumentBackgroundJob)=>['queued','running','cancelling'].includes(job.status);

export function normalizeDocumentBackgroundJobs(saved:unknown):DocumentBackgroundJob[]{
  if(!Array.isArray(saved)||saved.length>40)throw new Error('资料任务恢复记录格式无效');
  const ids=new Set<string>();
  return saved.map(j=>{
    if(!j||typeof j.id!=='string'||!j.id||j.id.length>200||ids.has(j.id)||typeof j.docId!=='string'
      ||!/^doc-[A-Za-z0-9._-]+$/u.test(j.docId)||typeof j.fileName!=='string'||j.fileName.length>500
      ||!['next','all','regenerate','continue'].includes(j.action)
      ||!['queued','running','cancelling','completed','failed','cancelled','interrupted'].includes(j.status)
      ||!Number.isFinite(j.updatedAt))throw new Error('资料任务恢复记录格式无效');
    ids.add(j.id);
    const optional=(key:string,max:number)=>j[key]===undefined?{}:typeof j[key]==='string'&&j[key].length<=max?{[key]:j[key]}:(()=>{throw new Error('资料任务恢复引用无效');})();
    if(j.archivedAt!==undefined&&(!Number.isFinite(j.archivedAt)||documentJobActive(j)))throw new Error('运行中的资料任务不能归档');
    return {id:j.id,docId:j.docId,fileName:j.fileName,action:j.action,status:j.status,
      message:String(j.message||'').slice(0,2000),updatedAt:j.updatedAt,
      ...optional('error',2000),...optional('scopeId',200),...optional('sourceIdentity',2000),...optional('resumeOf',200),
      ...(j.archivedAt!==undefined?{archivedAt:j.archivedAt}:{}),
    } as DocumentBackgroundJob;
  });
}

/** Application-owned queue, never owned by a mounted page. Persist metadata only;
 * interrupted runs require a new user action, never replay a paid model request. */
export function createDocumentBackgroundQueue(storage?:{read():unknown;write(jobs:DocumentBackgroundJob[]):void|Promise<void>}){
  let jobs:DocumentBackgroundJob[]=[];
  try {
    const saved=storage?.read();
    if(Array.isArray(saved))jobs=normalizeDocumentBackgroundJobs(saved)
      .map(j=>({...j,
        status:documentJobActive(j)?'interrupted':['completed','failed','cancelled','interrupted'].includes(j.status)?j.status:'interrupted',
        message:documentJobActive(j)?'应用已重新加载；已保存批次保留，请显式继续。':String(j.message||'').slice(0,2000),
      }));
  }catch{/* A damaged progress cache is not a processing instruction. */}
  const listeners=new Set<()=>void>(),runners=new Map<string,Runner>();
  let active:{job:DocumentBackgroundJob;controller:AbortController}|undefined,sequence=0;
  let pendingWrite=Promise.resolve(),persistenceError:string|undefined;
  const snapshot=()=>structuredClone(jobs);
  const publish=()=>{
    const value=snapshot();
    pendingWrite=pendingWrite.catch(()=>{}).then(async()=>{await storage?.write(value);persistenceError=undefined;});
    void pendingWrite.catch(error=>{persistenceError=error instanceof Error?error.message:'任务进度未能保存';});
    for(const listener of listeners)try{listener();}catch{/* One closed UI cannot stop the queue. */}
  };
  async function drain(){
    if(active)return;
    const job=jobs.find(j=>j.status==='queued');if(!job)return;
    const run=runners.get(job.id);if(!run){job.status='interrupted';publish();return;}
    const controller=new AbortController();active={job,controller};job.status='running';job.updatedAt=Date.now();publish();
    try {
      // Persist the locked target BEFORE a runner can issue its first request.
      await pendingWrite;controller.signal.throwIfAborted();
      await run(message=>{if(job.status!=='running')return;job.message=message.slice(0,2000);job.updatedAt=Date.now();publish();},controller.signal);
      job.status=controller.signal.aborted?'cancelled':'completed';
      if(controller.signal.aborted)job.message='已停止；已保存的批次和旧版图保留。';
    }catch(error){
      job.status=controller.signal.aborted?'cancelled':'failed';
      job.error=controller.signal.aborted?undefined:(error instanceof Error?error.message:String(error)).slice(0,2000);
      job.message=controller.signal.aborted?'已停止；已保存批次保留，可显式继续。':'后台处理失败；没有自动重试，请检查后继续。';
    }finally{job.updatedAt=Date.now();runners.delete(job.id);active=undefined;publish();queueMicrotask(()=>void drain());}
  }
  return {
    getSnapshot:snapshot,
    flush:()=>pendingWrite,
    getPersistenceError:()=>persistenceError,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    enqueue(input:Pick<DocumentBackgroundJob,'docId'|'fileName'|'action'|'scopeId'|'sourceIdentity'|'resumeOf'>,run:Runner){
      if(jobs.some(j=>j.docId===input.docId&&documentJobActive(j)))throw new Error('该资料已在后台处理中，请勿重复提交');
      if(jobs.filter(documentJobActive).length>=20)throw new Error('后台任务队列已满，请等待已有任务完成');
      const job:DocumentBackgroundJob={...input,id:`document-job-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2,10)}`,status:'queued',message:'已加入后台队列，可以离开资料页面。',updatedAt:Date.now()};
      const live=jobs.filter(documentJobActive);
      const history=jobs.filter(j=>!documentJobActive(j)).slice(-(39-live.length));
      jobs=[...live,...history,job];runners.set(job.id,run);publish();
      queueMicrotask(()=>void drain());return structuredClone(job);
    },
    cancel(id:string){
      const job=jobs.find(j=>j.id===id);if(!job||!documentJobActive(job))return;
      if(active?.job===job){job.status='cancelling';job.message='正在停止；不再开始新请求，已保存批次保留。';active.controller.abort();}
      else{job.status='cancelled';job.message='已取消排队，未发送请求。';runners.delete(id);}
      job.updatedAt=Date.now();publish();
    },
    archive(id:string,archived:boolean){
      const job=jobs.find(j=>j.id===id);if(!job)throw new Error('资料任务不存在');
      if(documentJobActive(job))throw new Error('请先停止运行中的资料任务，不能直接归档');
      job.archivedAt=archived?Date.now():undefined;job.updatedAt=Date.now();publish();
      return structuredClone(job);
    },
  };
}
