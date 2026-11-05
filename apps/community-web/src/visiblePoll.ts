/** Foreground polling with one request at a time and bounded failure backoff.
 * No response cache or authorization grace period is introduced here. */
export type PollEnvironment={now:()=>number;hidden:()=>boolean;online:()=>boolean;setTimeout:(fn:()=>void,ms:number)=>unknown;clearTimeout:(id:unknown)=>void;listen:(event:'visibilitychange'|'focus'|'online'|'offline',fn:()=>void)=>()=>void};
export function browserPollEnvironment():PollEnvironment{return {now:()=>Date.now(),hidden:()=>document.hidden,online:()=>navigator.onLine!==false,setTimeout:(fn,ms)=>window.setTimeout(fn,ms),clearTimeout:id=>window.clearTimeout(id as number),listen:(event,fn)=>{const target=event==='visibilitychange'?document:window;target.addEventListener(event,fn);return()=>target.removeEventListener(event,fn);}};}
export function startVisiblePoll(work:(signal:AbortSignal)=>Promise<void>,options:{intervalMs:number;immediate?:boolean;onError?:(error:unknown)=>void},env:PollEnvironment=browserPollEnvironment()){
  let stopped=false,timer:unknown,controller:AbortController|null=null,running=false,failures=0,resume=false,lastStarted=-Infinity,retryAt=0;
  const available=()=>!stopped&&!env.hidden()&&env.online();
  const cancelTimer=()=>{if(timer!==undefined)env.clearTimeout(timer);timer=undefined;};
  const schedule=(ms:number)=>{cancelTimer();if(available())timer=env.setTimeout(()=>{timer=undefined;void run();},ms);};
  const run=async()=>{
    if(!available()||running)return;if(env.now()<retryAt){schedule(retryAt-env.now());return;}running=true;const active=new AbortController();controller=active;lastStarted=env.now();let delay=options.intervalMs;
    try{await work(active.signal);if(!active.signal.aborted){failures=0;retryAt=0;delay=Math.max(0,options.intervalMs-(env.now()-lastStarted));}}
    catch(error){if(!active.signal.aborted){failures=Math.min(failures+1,8);const retry=Number((error as {retryAfterSeconds?:unknown})?.retryAfterSeconds);delay=Math.max(Math.min(60000,options.intervalMs*2**failures),Number.isFinite(retry)&&retry>0?Math.min(3600,retry)*1000:0);retryAt=env.now()+delay;options.onError?.(error);}}
    finally{running=false;if(controller===active)controller=null;if(resume&&available()){resume=false;schedule(0);}else schedule(delay);}
  };
  const changed=()=>{
    if(!available()){cancelTimer();controller?.abort();return;}
    // focus, visibility and online often arrive together. Merge them into one refresh.
    if(running){if(controller?.signal.aborted)resume=true;return;}
    if(env.now()-lastStarted<250)return;schedule(Math.max(50,retryAt-env.now()));
  };
  const remove=(['visibilitychange','focus','online','offline'] as const).map(event=>env.listen(event,changed));
  schedule(options.immediate===false?options.intervalMs:0);
  return {stop(){stopped=true;cancelTimer();controller?.abort();remove.forEach(off=>off());},refresh:changed};
}
