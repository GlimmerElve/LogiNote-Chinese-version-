import { spawn } from 'node:child_process';

export interface OwnedProcess {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  on(event:string,listener:(...args:any[])=>void):unknown;
  removeListener?(event:string,listener:(...args:any[])=>void):unknown;
  kill():unknown;
}
const stopped=new WeakSet<object>();
const stopping=new WeakMap<object,Promise<void>>();
export interface OwnedProcessStopOptions {
  timeoutMs?:number; platform?:string; terminateTree?:(pid:number)=>Promise<void>;
  /** Windows consumers which must not overlap generations require a tree receipt,
   * not just the parent handle's exit. Other consumers retain handle fallback. */
  requireTreeStop?:boolean;
}
type TreeStopAttempt={promise:Promise<void>;status:'pending'|'confirmed'|'failed';error?:unknown};
const treeStops=new WeakMap<object,TreeStopAttempt>();
async function boundedStop<T>(operation:Promise<T>,timeoutMs:number,message:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),Math.max(1,timeoutMs));})]);}
  finally{if(timer)clearTimeout(timer);}
}
function terminateWindowsTree(pid:number,timeoutMs:number,waitForCommandExit=false):Promise<void>{
  return new Promise((resolve,reject)=>{
    // Only a PID obtained from OUR spawn/fork handle, never an image name or all Node processes.
    const command=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    let failure:Error|undefined,timedOut=false;
    const fail=(error:Error,terminateCommand=false)=>{
      failure=error;
      // In strict mode a timed-out command may still be running. Keep its
      // confirmation pending until its OWN exit, preventing concurrent retries.
      if(!waitForCommandExit){
        if(terminateCommand)try{command.kill();}catch{/* Preserve the ordinary fallback. */}
        reject(error);return;
      }
      if(!Number.isInteger(command.pid)){reject(error);return;}
      if(terminateCommand)try{command.kill();}catch{/* The strict receipt still waits for an exit. */}
    };
    const timer=setTimeout(()=>{timedOut=true;fail(new Error('停止后台进程树超时'),true);},timeoutMs);
    command.on('error',error=>{
      // A running command may emit a further error when timeout cleanup signals
      // it. Do not recursively kill from its error listener or lose the receipt.
      if(!waitForCommandExit||!Number.isInteger(command.pid))clearTimeout(timer);
      fail(error);
    });
    command.once('exit',code=>{
      clearTimeout(timer);
      // A late positive receipt can unblock the NEXT explicit retry without
      // ever reissuing taskkill against a parent which has already exited.
      if(waitForCommandExit&&timedOut&&code===0){resolve();return;}
      failure?reject(failure):code===0?resolve():reject(new Error('后台进程树尚未确认停止'));
    });
  });
}
const hasExited=(child:OwnedProcess)=>typeof child.exitCode==='number'||typeof child.signalCode==='string';

async function stopWindowsTreeStrict(child:OwnedProcess,options:OwnedProcessStopOptions):Promise<void>{
  const timeoutMs=Math.max(1,options.timeoutMs??4000);
  let tree=treeStops.get(child);
  if(!tree||tree.status==='failed'){
    // Never use an exited parent's PID again: it can already name another app.
    if(hasExited(child))throw new Error('后台父进程已退出，但旧进程树停止尚未确认；未重用旧 PID');
    if(!Number.isInteger(child.pid)||child.pid!<=0)throw new Error('后台进程缺少有效的所属 PID，无法确认进程树停止');
    const attempt:TreeStopAttempt={status:'pending',promise:Promise.resolve()};
    attempt.promise=Promise.resolve().then(()=>(options.terminateTree
      ||((pid:number)=>terminateWindowsTree(pid,timeoutMs,true)))(child.pid!));
    treeStops.set(child,attempt);
    void attempt.promise.then(()=>{attempt.status='confirmed';},error=>{attempt.status='failed';attempt.error=error;});
    tree=attempt;
  }
  let onExit:(()=>void)|undefined;
  const exit=hasExited(child)?Promise.resolve():new Promise<void>(resolve=>{
    onExit=resolve;child.on('exit',onExit);
  });
  try{
    await boundedStop(Promise.all([exit,tree.promise]),timeoutMs,'后台进程树未在限定时间内确认停止');
    stopped.add(child); // Only after BOTH the parent and its tree are confirmed.
  }finally{if(onExit)child.removeListener?.('exit',onExit);}
}
/** Last resort after a native destructive confirmation. The target is ALWAYS this
 * application's own PID tree, never a renderer-supplied PID or an image name. */
export async function forceExitOwnApplication(exit:()=>void,options:{platform?:string;timeoutMs?:number;terminateTree?:(pid:number,timeoutMs:number)=>Promise<void>;
  stopOwnedServices?:(timeoutMs:number)=>Promise<void>}={}):Promise<void>{
  const timeoutMs=options.timeoutMs??4000,deadline=Date.now()+timeoutMs;
  try{
    if(options.stopOwnedServices){
      const childBudget=Math.max(1,Math.floor(timeoutMs*0.75));
      try{await boundedStop(Promise.resolve().then(()=>options.stopOwnedServices!(childBudget)),childBudget,'所属后台进程停止超时');}
      catch(error){console.warn('[application-exit] owned-process cleanup incomplete:',error);}
    }
    if((options.platform??process.platform)==='win32'){
      const remaining=Math.max(1,deadline-Date.now());
      await boundedStop(Promise.resolve().then(()=>(options.terminateTree||terminateWindowsTree)(process.pid,remaining)),remaining,'强制结束本应用进程树超时');
    }
  }catch(error){console.warn('[application-exit] process-tree termination fallback:',error);}
  finally{exit();}
}
/** Wait for an actual exit event, not ChildProcess.killed (which means signal sent).
 * Failure retains the handle so a second explicit exit can retry its OWN process. */
export function stopOwnedProcess(child:OwnedProcess|undefined|null,options:OwnedProcessStopOptions={}):Promise<void>{
  if(!child)return Promise.resolve();
  const previous=stopping.get(child);if(previous)return previous;
  if(options.requireTreeStop&&(options.platform??process.platform)==='win32'){
    const operation=stopWindowsTreeStrict(child,options);
    stopping.set(child,operation);
    void operation.finally(()=>{if(stopping.get(child)===operation)stopping.delete(child);}).catch(()=>{});
    return operation;
  }
  if(stopped.has(child)||hasExited(child))return Promise.resolve();
  const timeoutMs=options.timeoutMs??4000;
  const operation=(async()=>{
    let finish!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;
    const onExit=()=>{stopped.add(child);finish();};
    const exit=new Promise<void>((resolve,reject)=>{
      finish=resolve;child.on('exit',onExit);
      timer=setTimeout(()=>reject(new Error('后台进程未在限定时间内退出')),timeoutMs);
    });
    try{
      if((options.platform??process.platform)==='win32'&&Number.isInteger(child.pid)&&child.pid!>0){
        // Reserve half of the SAME deadline for handle fallback and an actual exit
        // receipt. A broken/hung taskkill must not consume the entire stop budget.
        const treeBudget=Math.max(1,Math.floor(timeoutMs/2));
        const tree=Promise.resolve().then(()=>(options.terminateTree||((pid:number)=>terminateWindowsTree(pid,treeBudget)))(child.pid!));
        try{await boundedStop(Promise.all([exit,tree]),treeBudget,'停止后台进程树超时');}
        catch{if(!stopped.has(child))child.kill();}
      }else child.kill();
      await exit;
    }finally{if(timer)clearTimeout(timer);child.removeListener?.('exit',onExit);}
  })();
  stopping.set(child,operation);
  void operation.finally(()=>{if(stopping.get(child)===operation)stopping.delete(child);}).catch(()=>{});
  return operation;
}
