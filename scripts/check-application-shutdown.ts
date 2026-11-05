import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createApplicationShutdown,createExitRequestBroker,type ApplicationShutdownPorts} from '../src/electron/applicationShutdown';
import {stopOwnedProcess,forceExitOwnApplication} from '../src/electron/ownedProcessShutdown';
import {RagComputeClient,type ComputeTransport} from '../src/electron/ragComputeClient';
import {createRendererExitPreparation} from '../src/services/ui/applicationExit';

// Synthetic processes/windows only: never starts/kills Electron, Python or taskkill.
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
let groups=0;const pass=(name:string)=>{groups++;console.log(`PASS ${name}`);};
function fixture(overrides:Partial<ApplicationShutdownPorts>={}){
  const log:string[]=[],failures:unknown[]=[];
  const ports:ApplicationShutdownPorts={freeze:value=>{log.push(`freeze:${value}`);},assertNoAcceptedWrites:()=>{log.push('writes-idle');},
    prepareRenderer:async()=>{log.push('prepare');return {backgroundTasks:1};},assertWindowsReady:async()=>{log.push('guards');},
    confirmBackgroundStop:async()=>{log.push('confirm');return true;},commitRenderer:async()=>{log.push('commit');},
    flushNativeWrites:async()=>{log.push('flush-native');},stopOwnedServices:async()=>{log.push('stop-owned');},quit:()=>{log.push('quit');},
    failed:error=>{failures.push(error);},...overrides};
  return {controller:createApplicationShutdown(ports),log,failures};
}
const gate=deferred(),successful=fixture({prepareRenderer:async()=>{await gate.promise;return {backgroundTasks:1};}});
const first=successful.controller.request(),second=successful.controller.request();assert.equal(first,second,'repeated X is one exit attempt');
assert(!successful.log.includes('stop-owned'));gate.resolve();assert.equal(await first,true);
assert.equal(successful.log.at(-1),'quit');assert(successful.log.indexOf('commit')<successful.log.indexOf('stop-owned'));
assert.equal(successful.controller.getPhase(),'ready');await successful.controller.request();assert.equal(successful.log.filter(item=>item==='quit').length,1);
pass('整个应用统一退出且幂等：先预检、确认、保存，再停止所属服务，最后退出');

for(const overrides of [
  {prepareRenderer:async()=>{throw Error('save failed');}},
  {assertWindowsReady:async()=>{throw Error('dirty auxiliary editor');}},
  {confirmBackgroundStop:async()=>false},
] as Partial<ApplicationShutdownPorts>[]){
  const blocked=fixture(overrides);assert.equal(await blocked.controller.request(),false);
  assert(!blocked.log.includes('commit'));assert(!blocked.log.includes('stop-owned'));assert(!blocked.log.includes('quit'));
  assert.equal(blocked.log.at(-1),'freeze:false');assert.equal(blocked.controller.getPhase(),'idle');
}
let busy=true;
const accepted=fixture({assertNoAcceptedWrites:()=>{if(busy)throw Error('accepted save in flight');}});
assert.equal(await accepted.controller.request(),false);busy=false;assert.equal(await accepted.controller.request(),true,'synchronous rejection must not latch a resolved request forever');
pass('保存失败、独立窗口未保存、用户取消及已接受写入都保留窗口；处理后可再次退出');

const hanging=fixture({stopOwnedServices:async()=>{throw Error('owned worker did not exit');}});
assert.equal(await hanging.controller.request(),false);assert(!hanging.log.includes('quit'));assert.equal(hanging.log.at(-1),'freeze:false');
let probes=0;
const lateGuard=fixture({assertWindowsReady:async()=>{if(++probes===2)throw Error('late result requires save');}});
assert.equal(await lateGuard.controller.request(),false);assert(!lateGuard.log.includes('stop-owned'));assert(!lateGuard.log.includes('quit'));
pass('停止未确认或晚到保存保护均不伪装退出成功，也不强制销毁未保存窗口');

let finalDirty=false,finalSaves=0;
const afterWorkers=fixture({prepareRenderer:async()=>{finalSaves++;finalDirty=false;return {backgroundTasks:0};},
  assertWindowsReady:async()=>{if(finalDirty)throw Error('worker notification not acknowledged');},stopOwnedServices:async()=>{finalDirty=true;}});
assert.equal(await afterWorkers.controller.request(),true);assert.equal(finalSaves,2);assert.equal(finalDirty,false);
let failedFinalSaves=0;
const failedFinal=fixture({prepareRenderer:async()=>{if(++failedFinalSaves===2)throw Error('final projection save failed');return {backgroundTasks:0};}});
assert.equal(await failedFinal.controller.request(),false);assert(!failedFinal.log.includes('quit'));assert.equal(failedFinal.log.at(-1),'freeze:false');
pass('停止后台服务后晚到的知识点通知仍须保存并通过窗口检查；最后一次保存失败保留窗口');

const broker=createExitRequestBroker(20),requests:any[]=[];
const rpc=broker.request({id:7,send:(_channel,payload)=>requests.push(payload)},'prepare');
const request=requests[0];assert.equal(broker.acknowledge(8,{requestId:request.requestId,ok:true}),false);
assert.equal(broker.acknowledge(7,{requestId:'stale',ok:true}),false);
assert.equal(broker.acknowledge(7,{requestId:request.requestId,ok:true,backgroundTasks:2}),true);
assert.deepEqual(await rpc,{backgroundTasks:2});assert.equal(broker.acknowledge(7,{requestId:request.requestId,ok:true}),false);
const rejected=broker.request({id:7,send:(_channel,payload)=>requests.push(payload)},'commit');
broker.acknowledge(7,{requestId:requests.at(-1).requestId,ok:false});await assert.rejects(rejected,/取消退出/);
await assert.rejects(broker.request({id:9,send:()=>{}},'prepare'),/尚未完成/);
pass('退出预检按窗口ID和一次性请求绑定；外来/过期确认、失败响应和超时均拒绝');

class FakeProcess extends EventEmitter {
  pid=4711;exitCode:number|null=null;signalCode:string|null=null;killed=false;killCalls=0;
  kill(){this.killed=true;this.killCalls++;return true;}
  finish(){this.exitCode=0;this.emit('exit',0);}
}
const child=new FakeProcess();let ended=false;
const stopping=stopOwnedProcess(child,{platform:'test',timeoutMs:100}).then(()=>{ended=true;});
await tick();assert.equal(child.killed,true);assert.equal(ended,false,'signal sent is NOT exited');child.finish();await stopping;assert(ended);
await stopOwnedProcess(child,{platform:'test'});assert.equal(child.killCalls,1);
const delayed=new FakeProcess();await assert.rejects(stopOwnedProcess(delayed,{platform:'test',timeoutMs:5}),/限定时间/);
const retry=stopOwnedProcess(delayed,{platform:'test',timeoutMs:100});delayed.finish();await retry;assert.equal(delayed.killCalls,2);
const tree=new FakeProcess(),treeIds:number[]=[];
await stopOwnedProcess(tree,{platform:'win32',terminateTree:async pid=>{treeIds.push(pid);tree.finish();}});
assert.deepEqual(treeIds,[tree.pid]);assert.equal(tree.killCalls,0,'terminate own tree before orphaning its descendants');
pass('进程退出必须收到真实exit；超时保留可重试句柄，只针对本应用spawn/fork获得的PID树');

class HandleStoppedProcess extends FakeProcess {
  kill(){super.kill();queueMicrotask(()=>this.finish());return true;}
}
for(const terminateTree of [async()=>{throw Error('taskkill unavailable');},()=>new Promise<void>(()=>{}),async()=>{}]){
  const fallback=new HandleStoppedProcess();
  await stopOwnedProcess(fallback,{platform:'win32',timeoutMs:60,terminateTree});
  assert.equal(fallback.killCalls,1);assert.equal(fallback.exitCode,0);
}
const lateExit=new FakeProcess();
const receipt=stopOwnedProcess(lateExit,{platform:'win32',timeoutMs:150,terminateTree:async()=>{throw Error('denied');}});
await tick();let received=false;void receipt.then(()=>{received=true;});await tick();
assert.equal(lateExit.killCalls,1);assert(!received,'handle.kill only sends a signal; wait for its exit receipt');lateExit.finish();await receipt;
const blockedHandle=new FakeProcess();
await assert.rejects(stopOwnedProcess(blockedHandle,{platform:'win32',timeoutMs:30,terminateTree:async()=>{throw Error('denied');}}),/限定时间/);
assert.equal(blockedHandle.killCalls,1);blockedHandle.finish();
pass('taskkill失败、卡住或无退出回执都在同一时限内回退已持有句柄；无真实exit绝不报已停止');

class FakeCompute extends FakeProcess implements ComputeTransport {postMessage(_value:unknown){}}
const workers:FakeCompute[]=[];
const compute=new RagComputeClient(()=>{const worker=new FakeCompute();workers.push(worker);return worker;},()=>({modelsDir:'synthetic',pdfExtractScript:'synthetic'}));
const active=compute.run('parse',{}),queued=compute.run('embed',{});
const activeRejected=assert.rejects(active,/应用退出/),queuedRejected=assert.rejects(queued,/应用退出/);
await compute.shutdown(async worker=>{(worker as FakeCompute).finish();});await Promise.all([activeRejected,queuedRejected]);
await assert.rejects(compute.run('embed',{}),/正在退出/);await tick();assert.equal(workers.length,1,'late drain cannot restart worker after shutdown');
pass('RAG终止拒绝在途与排队任务，退出开始后不被迟到回调自动拉起新工作进程');

let flushes=0,stops=0;
const renderer=createRendererExitPreparation(async()=>{flushes++;});
const unregister=renderer.register({backgroundTasks:()=>2,stop:async()=>{assert(renderer.isStopping());stops++;}});
assert.deepEqual(await renderer.run('prepare'),{backgroundTasks:2});assert.equal(stops,0);
await renderer.run('commit');assert.equal(stops,1);assert.equal(flushes,2);assert.equal(renderer.isStopping(),true,'late callbacks cannot restart work after commit');renderer.cancel();assert.equal(renderer.isStopping(),false);unregister();
assert.deepEqual(await renderer.run('prepare'),{backgroundTasks:0});assert.equal(stops,1,'unmount/navigation only unregisters; it never stops work');
pass('页面/助手关闭不执行退出停止；仅确认后的应用commit阶段停止并刷新已有检查点');

let slowStarts=0;
const slowGate=deferred(),stages:string[]=[];
// Inject small deadlines; no real slow services or filesystem operations.
const slow=createApplicationShutdown({freeze:()=>{},assertNoAcceptedWrites:()=>{},prepareRenderer:async()=>{
  slowStarts++;await slowGate.promise;return {backgroundTasks:0};},assertWindowsReady:async()=>{},confirmBackgroundStop:async()=>true,
  commitRenderer:async()=>{},flushNativeWrites:async()=>{},stopOwnedServices:async()=>{},quit:()=>{},
  failed:(error,_started,stage)=>{stages.push(stage);assert.match(String(error),/超时/);}}, {stepTimeoutMs:15});
assert.equal(await slow.request(),false);assert.deepEqual(stages,['保存页面数据']);
const retried=slow.request();await tick();assert.equal(slowStarts,1,'retry must join the unfinished preparation, not duplicate writes');
slowGate.resolve();assert.equal(await retried,true);assert.equal(slow.getPhase(),'ready');
pass('阶段超时有明确原因；重试复用未结束的保存，不并发写入，晚到结果不自行退出');

// Use all three REAL layers. Native broker timeout does not stop the page's flush.
let ipcFlushes=0,ipcQuits=0;const ipcGate=deferred(),acknowledgements:boolean[]=[];
const ipcRenderer=createRendererExitPreparation(async()=>{ipcFlushes++;if(ipcFlushes===1)await ipcGate.promise;});
const ipcBroker=createExitRequestBroker(25);
const ipcSender={id:31,send:(_channel:string,value:unknown)=>{
  const request=value as {requestId:string;phase:'prepare'|'commit'};
  void ipcRenderer.run(request.phase).then(result=>{acknowledgements.push(ipcBroker.acknowledge(31,{requestId:request.requestId,ok:true,...result}));},
    error=>{ipcBroker.acknowledge(31,{requestId:request.requestId,ok:false,error:String(error)});});
}};
const ipcExit=createApplicationShutdown({freeze:()=>{},assertNoAcceptedWrites:()=>{},
  prepareRenderer:()=>ipcBroker.request(ipcSender,'prepare'),assertWindowsReady:async()=>{},confirmBackgroundStop:async()=>true,
  commitRenderer:async()=>{await ipcBroker.request(ipcSender,'commit');},flushNativeWrites:async()=>{},stopOwnedServices:async()=>{},
  quit:()=>{ipcQuits++;},failed:()=>{ipcRenderer.cancel();}},{stepTimeoutMs:250});
assert.equal(await ipcExit.request(),false);assert.equal(await ipcExit.request(),false);
assert.equal(ipcFlushes,1,'two real IPC timeouts must still share the original pending flush');assert.equal(ipcQuits,0);
const ipcRetry=ipcExit.request();await tick();assert.equal(ipcFlushes,1);ipcGate.resolve();assert.equal(await ipcRetry,true);
assert.equal(ipcFlushes,3,'preparation, commit and post-worker-stop saves all settle before quit');assert.equal(ipcQuits,1);
assert.equal(acknowledgements.filter(value=>!value).length,2,'late replies to timed-out nonces cannot authorize exit');
pass('真实协调器→IPC broker→renderer：跨两次超时仍只保存一次，重试可完成，旧响应不能退出应用');

let failedPreparations=0;
const preparationFailure=createRendererExitPreparation(async()=>{if(++failedPreparations===1)throw Error('disk error');});
await assert.rejects(preparationFailure.run('prepare'),/disk error/);preparationFailure.cancel();
await preparationFailure.run('prepare');assert.equal(failedPreparations,2,'settled failure must release the preparation so a real retry is possible');
const overlappingGate=deferred();let overlappingFlushes=0;
const overlapping=createRendererExitPreparation(async()=>{overlappingFlushes++;if(overlappingFlushes===1)await overlappingGate.promise;});
const unfinishedPreparation=overlapping.run('prepare');await tick();
const forcedPreparation=overlapping.run('force');await tick();assert.equal(overlappingFlushes,1,'force aborts participants but must not launch a concurrent flush');
overlappingGate.resolve();await Promise.all([unfinishedPreparation,forcedPreparation]);assert.equal(overlappingFlushes,2);assert(overlapping.isStopping());
pass('准备操作仅在真正结束后释放；失败可重试，强退与未完准备不会并发刷新');

for(const stage of ['prepareRenderer','assertWindowsReady','commitRenderer','flushNativeWrites','stopOwnedServices'] as const){
  const reported:string[]=[];
  const broken=fixture({[stage]:async()=>{throw Error('synthetic failure');},
    failed:(error,_started,label)=>{assert.match(String(error),/synthetic failure/);reported.push(label);}});
  assert.equal(await broken.controller.request(),false);assert.equal(reported.length,1);assert(!broken.log.includes('quit'));
}
pass('保存、窗口保护、助手停止及本地服务失败均报告具体阶段，不伪报退出成功');

for(const approved of [false,true]){
  let confirmations=0,forced=0;
  const manual=fixture({confirmBackgroundStop:async()=> 'force',confirmForceQuit:async()=>{confirmations++;return approved;},forceQuit:()=>{forced++;}});
  assert.equal(await manual.controller.request(),approved);assert.equal(confirmations,1);assert.equal(forced,approved?1:0);
  assert(!manual.log.includes('commit'));assert(!manual.log.includes('stop-owned'));
  if(approved){assert.equal(manual.controller.getPhase(),'ready');await manual.controller.request();assert.equal(forced,1);}
}
let forceAfterFailure=0;
const failThenForce=fixture({prepareRenderer:async()=>{throw Error('page hung');},failed:()=>true,
  confirmForceQuit:async()=>true,forceQuit:()=>{forceAfterFailure++;}});
assert.equal(await failThenForce.controller.request(),true);assert.equal(forceAfterFailure,1);
const unavailable=fixture({confirmBackgroundStop:async()=> 'force'});assert.equal(await unavailable.controller.request(),false);
pass('主动选择和失败后强制退出均需第二次原生确认；取消或缺少端口不强制；重复关闭只退出一次');

let hardExits=0;const targets:number[]=[];
await forceExitOwnApplication(()=>{hardExits++;},{platform:'win32',terminateTree:async pid=>{targets.push(pid);}});
assert.deepEqual(targets,[process.pid]);assert.equal(hardExits,1);
await forceExitOwnApplication(()=>{hardExits++;},{platform:'test',terminateTree:async()=>{throw Error('must not execute');}});
assert.equal(hardExits,2);
const warnings:unknown[]=[];const warn=console.warn;console.warn=(...args:unknown[])=>{warnings.push(args);};
try{
  await forceExitOwnApplication(()=>{hardExits++;},{platform:'win32',timeoutMs:10,terminateTree:()=>new Promise<void>(()=>{})});
  await forceExitOwnApplication(()=>{hardExits++;},{platform:'win32',terminateTree:async()=>{throw Error('denied');}});
}finally{console.warn=warn;}
assert.equal(hardExits,4);assert.equal(warnings.length,2);
pass('强退只指向当前应用自身PID树；进程树命令失败或超时仍退出自身，不等待计算完成');

const fallbackOrder:string[]=[];const forceChild=new HandleStoppedProcess();const forceWarnings:unknown[]=[];
console.warn=(...args:unknown[])=>{forceWarnings.push(args);};
try{
  await forceExitOwnApplication(()=>{assert.equal(forceChild.exitCode,0);fallbackOrder.push('exit-app');},{platform:'win32',timeoutMs:200,
    stopOwnedServices:async timeoutMs=>{assert(timeoutMs<200);await stopOwnedProcess(forceChild,{platform:'win32',timeoutMs,terminateTree:async()=>{throw Error('blocked');}});fallbackOrder.push('child-exited');},
    terminateTree:async pid=>{assert.equal(pid,process.pid);fallbackOrder.push('self-tree');throw Error('blocked');}});
  assert.deepEqual(fallbackOrder,['child-exited','self-tree','exit-app']);assert.equal(forceChild.killCalls,1);
  let forcedDespiteHang=false;
  await forceExitOwnApplication(()=>{forcedDespiteHang=true;},{platform:'win32',timeoutMs:30,
    stopOwnedServices:()=>new Promise<void>(()=>{}),terminateTree:()=>new Promise<void>(()=>{})});
  assert(forcedDespiteHang,'shared deadline cannot be held forever by an unresponsive child/service');
}finally{console.warn=warn;}
assert.equal(forceWarnings.length,3);
pass('强退真实接线先确认句柄兜底退出，再尝试自身PID树；服务和进程树都卡住也受统一总时限约束');

const participantGate=deferred();let participantStarts=0;
const singleCommit=createRendererExitPreparation(async()=>{});
singleCommit.register({name:'慢资料任务',stop:async()=>{participantStarts++;await participantGate.promise;}});
const commitA=singleCommit.run('commit'),commitB=singleCommit.run('commit');await tick();singleCommit.cancel();
assert.equal(participantStarts,1);assert(singleCommit.isStopping(),'cancel must not re-enable new work while old stop callbacks are still pending');
participantGate.resolve();await Promise.all([commitA,commitB]);assert.equal(singleCommit.isStopping(),false);
const forceGate=deferred(),forceRenderer=createRendererExitPreparation(async()=>{});
forceRenderer.register({stop:async()=>{await forceGate.promise;}});
const oldCommit=forceRenderer.run('commit');forceRenderer.cancel();
const forcedCommit=forceRenderer.run('force');forceRenderer.cancel();
forceGate.resolve();await Promise.all([oldCommit,forcedCommit]);assert(forceRenderer.isStopping(),'late cancel cannot restart tasks after native force confirmation');
let failureFlush=0;
const namedFailure=createRendererExitPreparation(async()=>{failureFlush++;});
namedFailure.register({name:'对话标签保存',stop:async()=>{throw Error('synthetic disk full');}});
await assert.rejects(namedFailure.run('commit'),/对话标签保存.*synthetic disk full/);assert.equal(failureFlush,1);
const errorBroker=createExitRequestBroker(100),errorRequests:any[]=[];
const errorReply=errorBroker.request({id:12,send:(_channel,payload)=>errorRequests.push(payload)},'commit');
errorBroker.acknowledge(12,{requestId:errorRequests[0].requestId,ok:false,error:'资料后台处理：检查点保存失败'});
await assert.rejects(errorReply,/资料后台处理：检查点保存失败/);
pass('并发退出请求共用一次renderer收尾，仍提交可保存检查点，参与者错误经绑定IPC传到原生弹窗');

const main=readFileSync('src/electron/main.ts','utf8'),app=readFileSync('src/App.tsx','utf8'),panel=readFileSync('src/components/AgentPanel.tsx','utf8');
{
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.ES2022,true);
  let stop:ts.Expression|undefined;
  const find=(node:ts.Node)=>{if(!stop&&ts.isPropertyAssignment(node)&&node.name.getText(ast)==='stopOwnedServices')stop=node.initializer;ts.forEachChild(node,find);};find(ast);
  assert.ok(stop);
  for(const failure of ['none','cache','storage']){
    const preparation=deferred(),cache=deferred(),storage=deferred(),order:string[]=[],cleanupWarnings:unknown[]=[];
    const env={stormSearchRequests:new Map(),planSearchRequests:new Map(),mermaidProcess:undefined,disposeInteractiveFigure:undefined,progressiveDerived:undefined,
      learningPreparation:{stop:async()=>{order.push('preparation-start');await preparation.promise;order.push('preparation-done');}},
      applicationExiting:false,deferredNoteIndex:{stop(){}},deferredChangedNoteIndex:{stop(){}},
      noteCleanupWorker:undefined,backgroundGeneration:0,vectorizationQueue:[],indexProgress:new Map(),sttProcess:null,
      h5pHost:undefined,documentCompute:undefined,embeddingCompute:undefined,disposeSympyServer:async()=>{},stopOwnedProcess:async()=>{},
      vectorizationDrain:Promise.resolve(),waitForShutdownStep:async(operation:Promise<unknown>)=>operation,disposeResourceBrowserSessions:async()=>{},
      session:{fromPartition:(name:string)=>{assert.equal(name,'persist:flow-resource');return {
        clearCache:async()=>{order.push('cache-start');await cache.promise;if(failure==='cache')throw Error('cache unavailable');order.push('cache-done');},
        clearStorageData:async()=>{order.push('storage-start');await storage.promise;if(failure==='storage')throw Error('storage unavailable');order.push('storage-done');},
      };}},console:{warn:(...args:unknown[])=>cleanupWarnings.push(args)}};
    const js=ts.transpileModule(`return (${stop.getText(ast)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const realStop=new Function(...Object.keys(env),js)(...Object.values(env));
    const exit=fixture({prepareRenderer:async()=>({backgroundTasks:0}),stopOwnedServices:realStop});
    const task=exit.controller.request();await tick();assert.deepEqual(order,['preparation-start']);assert(!exit.log.includes('quit'));
    preparation.resolve();await tick();assert.deepEqual(order,['preparation-start','preparation-done','cache-start']);assert(!exit.log.includes('quit'));
    cache.resolve();await tick();assert(order.includes('storage-start'));assert(!exit.log.includes('quit'),'never destroy Chromium while storage callbacks are pending');
    storage.resolve();assert.equal(await task,true);assert.equal(exit.log.at(-1),'quit');
    assert.equal(cleanupWarnings.length,failure==='none'?0:1,'disposable cleanup failures remain visible but do not block an otherwise saved exit');
  }
  pass('真实main收尾等待缓存→存储清理完成才退出；任一临时清理失败均可继续且不遗留未等待操作');
}
const mainWindow=main.slice(main.indexOf('function createWindow()'),main.indexOf('/** 注册 autoUpdater'));
assert.match(mainWindow,/win\.on\('close',[\s\S]*?applicationShutdown\.request\(\)/u);
assert.match(main,/app\.on\('before-quit',[\s\S]*?event\.preventDefault\(\); void applicationShutdown\.request\(\)/u);
assert.match(main,/app\.on\('window-all-closed',[\s\S]*?applicationShutdown\.request\(\)/u);
assert.match(main,/if \(applicationExiting\) return;[\s\S]*?sttPort = await getFreePort\(\)[\s\S]*?if \(applicationExiting\) return;/u);
assert.match(app,/connectApplicationExit\(\)/u);assert.match(app,/documentBackgroundJobs\.cancel\(job\.id\)/u);
assert.match(panel,/abortControllerRef\.current\?\.abort\(\)/u);assert.match(panel,/rendererExitPreparation\.isStopping\(\)/u);
assert.match(readFileSync('src/electron/preload.ts','utf8'),/application:exit-ready/u);
const sympyShutdownSource=readFileSync('src/electron/sympyServer.ts','utf8');
assert.match(sympyShutdownSource,/if \(owned\) retireProcess\(owned,[^\n]*options\)/u);
assert.match(sympyShutdownSource,/await stopRetiredProcess\(obsolete, options\)/u);
assert.match(sympyShutdownSource,/stopOwnedProcess\(owned, \{ \.\.\.options, requireTreeStop: true \}\)/u);
assert.match(main,/confirmForceQuit:[\s\S]*?尚未保存的编辑[\s\S]*?buttons: \['取消', '强制退出'\]/u);
assert.match(main,/forceExitOwnApplication\(\(\) => app\.exit\(0\), \{[\s\S]*?stopOwnedServices:[\s\S]*?disposeSympyServer\(\{ timeoutMs \}\)/u);
assert.match(main,/未完成阶段：\$\{stage\}/u);
pass('真实主窗口、退出事件、预加载IPC、助手/资料检查点及STT/SymPy收尾入口均已接线');
console.log(`${groups} application shutdown groups passed; fake windows/processes only, no private data or running processes touched.`);
