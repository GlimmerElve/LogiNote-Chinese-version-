import { applyAgentTaskStatePatch, normalizeAgentTaskState, type AgentTaskState, type AgentTaskStatePatch } from './taskStateCodec';
type TaskApi={getAgentTaskScope?:()=>Promise<string>;loadAgentTaskState?:()=>Promise<{scopeId:string;state:unknown}>;
  saveAgentTaskState?:(scopeId:string,patch:AgentTaskStatePatch)=>Promise<void>};
const KEY='loginote-agent-task-state-v1';
function native():TaskApi|undefined{
  const electron=typeof window==='undefined'?undefined:(window as unknown as {electronAPI?:{userState?:TaskApi}}).electronAPI;
  if(electron&&(!electron.userState?.getAgentTaskScope||!electron.userState.loadAgentTaskState||!electron.userState.saveAgentTaskState))
    throw new Error('持久化任务接口不可用，请在更新后重启桌面应用；未重放任何任务');
  return electron?.userState;
}
export async function agentTaskScope():Promise<string>{return await native()?.getAgentTaskScope?.()||'browser';}
export async function loadAgentTaskState():Promise<{scopeId:string;state:AgentTaskState}>{
  const api=native();
  if(api){const result=await api.loadAgentTaskState!();return {...result,state:normalizeAgentTaskState(result.state)};}
  return {scopeId:'browser',state:normalizeAgentTaskState(typeof localStorage==='undefined'?null:JSON.parse(localStorage.getItem(KEY)||'null'))};
}
// Browser writes are serialized too; native updates merge categories under a disk lock.
let pending=Promise.resolve();
export const flushAgentTaskStateWrites=()=>pending;
export function saveAgentTaskState(scopeId:string,patch:AgentTaskStatePatch,isCurrent:()=>boolean=()=>true):Promise<void>{
  const snapshot=structuredClone(patch);
  const operation=pending.catch(()=>{}).then(async()=>{
    if(!isCurrent())return;
    const api=native();
    if(api)return api.saveAgentTaskState!(scopeId,snapshot);
    if(scopeId!=='browser'||typeof localStorage==='undefined')throw new Error('任务恢复存储不可用');
    const current=JSON.parse(localStorage.getItem(KEY)||'null');
    localStorage.setItem(KEY,JSON.stringify(applyAgentTaskStatePatch(current,snapshot)));
  });pending=operation;return operation;
}
