export type ApplicationExitPhase='idle'|'preparing'|'stopping'|'forcing'|'ready';
export type ApplicationExitStage='检查写入'|'保存页面数据'|'检查未保存窗口'|'停止助手与资料任务'|'保存磁盘数据'|'停止本地服务'|'强制退出';
/** Timeouts stop waiting, not the underlying write. Never pretend an unfinished save succeeded. */
export async function waitForShutdownStep<T>(operation:Promise<T>,label:string,timeoutMs=15000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超时，尚未确认完成`)),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}
export interface ApplicationShutdownPorts {
  freeze:(value:boolean)=>void;
  assertNoAcceptedWrites:()=>void;
  prepareRenderer:()=>Promise<{backgroundTasks:number}>;
  assertWindowsReady:()=>Promise<void>;
  confirmBackgroundStop:(count:number)=>Promise<boolean|'force'>;
  commitRenderer:()=>Promise<void>;
  flushNativeWrites:()=>Promise<void>;
  stopOwnedServices:()=>Promise<void>;
  quit:()=>void;
  failed:(error:unknown,stoppingStarted:boolean,stage:ApplicationExitStage)=>void|boolean|Promise<void|boolean>;
  /** Native dialogs only. No renderer/Agent command may authorize this bypass. */
  confirmForceQuit?:()=>Promise<boolean>;
  forceQuit?:()=>Promise<void>|void;
}
/** Only an explicit application quit/main-window close enters this coordinator.
 * Page navigation and assistant-panel close have no route into it. */
export function createApplicationShutdown(ports:ApplicationShutdownPorts,options:{stepTimeoutMs?:number}={}){
  let phase:ApplicationExitPhase='idle',pending:Promise<boolean>|undefined;
  const inFlight=new Map<ApplicationExitStage,Promise<unknown>>();
  const step=async<T>(label:ApplicationExitStage,run:()=>Promise<T>):Promise<T>=>{
    // A timed-out write/stop still owns its lane; retry joins it, never launches a second one.
    let operation=inFlight.get(label) as Promise<T>|undefined;
    if(!operation){operation=Promise.resolve().then(run);inFlight.set(label,operation);
      const current=operation;void operation.finally(()=>{if(inFlight.get(label)===current)inFlight.delete(label);}).catch(()=>{});}
    return waitForShutdownStep(operation,label,options.stepTimeoutMs);
  };
  const force=async()=>{
    if(!ports.forceQuit||!ports.confirmForceQuit||!await ports.confirmForceQuit())return false;
    phase='forcing';await ports.forceQuit();phase='ready';return true;
  };
  const request=():Promise<boolean>=>{
    if(phase==='ready')return Promise.resolve(true);
    if(pending)return pending;
    const operation=(async()=>{
      let stoppingStarted=false,stage:ApplicationExitStage='检查写入';
      phase='preparing';
      try{
        ports.freeze(true);
        ports.assertNoAcceptedWrites();
        stage='保存页面数据';const {backgroundTasks}=await step(stage,ports.prepareRenderer);
        stage='检查未保存窗口';await step(stage,ports.assertWindowsReady);
        if(backgroundTasks>0){
          const choice=await ports.confirmBackgroundStop(backgroundTasks);
          if(choice==='force'){stage='强制退出';return await force();}
          if(!choice)return false;
        }
        stage='检查写入';
        ports.assertNoAcceptedWrites();
        phase='stopping';stoppingStarted=true;
        stage='停止助手与资料任务';await step(stage,ports.commitRenderer);
        stage='保存磁盘数据';await step(stage,ports.flushNativeWrites);
        // Late model/UI completions may have registered another save/guard.
        ports.freeze(true);stage='检查未保存窗口';await step(stage,ports.assertWindowsReady);stage='检查写入';ports.assertNoAcceptedWrites();
        stage='停止本地服务';await step(stage,ports.stopOwnedServices);
        // A native worker may commit a final knowledge projection while it is
        // stopping. Its renderer notification must be drained before quit too.
        stage='保存页面数据';await step(stage,ports.prepareRenderer);
        stage='保存磁盘数据';await step(stage,ports.flushNativeWrites);
        stage='检查未保存窗口';await step(stage,ports.assertWindowsReady);stage='检查写入';ports.assertNoAcceptedWrites();
        phase='ready';ports.quit();return true;
      }catch(error){
        phase='idle';
        try{if(await ports.failed(error,stoppingStarted,stage))return await force();}
        catch(reportError){console.warn('[application-exit] exit confirmation failed:',reportError);}
        return false;
      }
      finally{if(phase!=='ready'){phase='idle';ports.freeze(false);}}
    })();
    pending=operation;
    void operation.finally(()=>{if(pending===operation)pending=undefined;}).catch(()=>{});
    return operation;
  };
  return {request,getPhase:()=>phase};
}

export interface ExitPreparationReply {requestId:string;ok:boolean;backgroundTasks?:number;error?:string;}
/** Sender+nonce bound RPC; no late/foreign renderer can authorize application exit. */
export function createExitRequestBroker(timeoutMs=12000){
  let sequence=0;
  const pending=new Map<string,{senderId:number;resolve:(value:{backgroundTasks:number})=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  return {
    request(sender:{id:number;send:(channel:string,payload:unknown)=>void},phase:'prepare'|'commit'){
      const requestId=`exit-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
      return new Promise<{backgroundTasks:number}>((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(phase==='commit'?'停止助手或资料任务超时，任务可能仍在收尾；可重试或明确选择强制退出':'页面尚未完成退出准备，请检查保存状态后重试'));},timeoutMs);
        pending.set(requestId,{senderId:sender.id,resolve,reject,timer});
        try{sender.send('application:exit-request',{requestId,phase});}
        catch(error){clearTimeout(timer);pending.delete(requestId);reject(error);}
      });
    },
    acknowledge(senderId:number,value:unknown){
      const reply=value as ExitPreparationReply;
      if(!reply||typeof reply.requestId!=='string'||typeof reply.ok!=='boolean')return false;
      const item=pending.get(reply.requestId);if(!item||item.senderId!==senderId)return false;
      pending.delete(reply.requestId);clearTimeout(item.timer);
      if(!reply.ok)item.reject(new Error(typeof reply.error==='string'&&reply.error.trim()?reply.error.slice(0,1000):'页面保存或后台收尾尚未完成，已取消退出'));
      else item.resolve({backgroundTasks:Math.max(0,Math.min(100,Number.isFinite(reply.backgroundTasks)?Math.floor(reply.backgroundTasks!):0))});
      return true;
    },
  };
}
