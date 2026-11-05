import {flushPendingChanges} from '../agent/dataFreshness';
export interface ApplicationExitParticipant {name?:string;backgroundTasks?:()=>number;stop:()=>Promise<void>;}
export function createRendererExitPreparation(flush:()=>Promise<void>){
  const participants=new Set<ApplicationExitParticipant>();let stopping=false,cancelRequested=false,forcing=false;
  let preparing:Promise<{backgroundTasks:number}>|undefined;
  let committing:Promise<{backgroundTasks:number}>|undefined;
  const save=async()=>{try{await flush();}catch(error){throw new Error(`保存笔记、设置或任务进度失败：${error instanceof Error?error.message:String(error)}`);}};
  return {
    register(participant:ApplicationExitParticipant){participants.add(participant);return()=>{participants.delete(participant);};},
    isStopping:()=>stopping,
    cancel:()=>{if(forcing)return;cancelRequested=true;if(!committing)stopping=false;},
    async run(phase:'prepare'|'commit'|'force'){
      if(phase==='force'){forcing=true;stopping=true;cancelRequested=false;}
      if(phase==='prepare'){
        // Native IPC timeout only stops waiting; the original page save still owns
        // this preparation. Cancel/retry must join it until it actually settles.
        if(preparing)return preparing;
        const priorCommit=committing;
        const operation=Promise.resolve().then(async()=>{
          if(priorCommit)await priorCommit;
          await save();
          // Let save acknowledgements update existing React beforeunload guards.
          await new Promise<void>(resolve=>setTimeout(resolve,0));
          return {backgroundTasks:[...participants].reduce((sum,item)=>sum+Math.max(0,item.backgroundTasks?.()||0),0)};
        });
        preparing=operation;
        try{return await operation;}finally{if(preparing===operation)preparing=undefined;}
      }
      if(committing)return committing;
      stopping=true;cancelRequested=false;
      const priorPreparation=preparing;
      const operation=(async()=>{
        const results=await Promise.allSettled([...participants].map(async item=>{
          try{await item.stop();}catch(error){throw new Error(`${item.name||'后台任务'}：${error instanceof Error?error.message:String(error)}`);}
        }));
        const failures=results.flatMap(result=>result.status==='rejected'?[String(result.reason instanceof Error?result.reason.message:result.reason)]:[]);
        // Still flush completed checkpoints when another participant failed to stop.
        if(priorPreparation)try{await priorPreparation;}catch(error){failures.push(error instanceof Error?error.message:String(error));}
        try{await save();}catch(error){failures.push(error instanceof Error?error.message:String(error));}
        if(failures.length)throw new Error(failures.join('\n'));
        return {backgroundTasks:0};
      })();
      committing=operation;
      try{return await operation;}finally{if(committing===operation)committing=undefined;if(cancelRequested)stopping=false;}
    },
  };
}
export const rendererExitPreparation=createRendererExitPreparation(flushPendingChanges);
export function connectApplicationExit(){
  const api=(window as unknown as {electronAPI?:{applicationExit?:{
    onRequest:(callback:(request:{requestId:string;phase:'prepare'|'commit'|'force'|'cancel'})=>void)=>()=>void;
    respond:(reply:{requestId:string;ok:boolean;backgroundTasks?:number;error?:string})=>void;
  }}}).electronAPI?.applicationExit;
  if(!api)return ()=>{};
  return api.onRequest(request=>{
    if(!request||typeof request.requestId!=='string'||!['prepare','commit','force','cancel'].includes(request.phase))return;
    if(request.phase==='cancel'){rendererExitPreparation.cancel();api.respond({requestId:request.requestId,ok:true});return;}
    void rendererExitPreparation.run(request.phase).then(result=>api.respond({requestId:request.requestId,ok:true,...result}))
      .catch(error=>api.respond({requestId:request.requestId,ok:false,error:(error instanceof Error?error.message:String(error)).slice(0,1000)}));
  });
}
export async function waitForExitCondition(ready:()=>boolean,timeoutMs=8000){
  const deadline=Date.now()+timeoutMs;
  while(!ready()){
    if(Date.now()>=deadline)throw new Error('后台操作尚未结束，未关闭应用');
    await new Promise<void>(resolve=>setTimeout(resolve,30));
  }
}
