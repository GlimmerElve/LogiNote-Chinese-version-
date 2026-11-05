import { normalizeDocumentBackgroundJobs, type DocumentBackgroundJob } from '../documentBackgroundQueue';
import type { AgentSkillSequence } from './skillSequence';
import { normalizeConceptBatchJobs, type ConceptBatchJob } from '../conceptBatchTypes';
import { normalizeBackgroundWorkflows, type BackgroundWorkflowJob } from './backgroundWorkflowTypes';
import { normalizeCognitionAssistantState, type CognitionAssistantState } from './cognitionAssistantState';

export interface AgentTaskState { version:1; documents:DocumentBackgroundJob[]; sequences:Record<string,AgentSkillSequence>; concepts?:ConceptBatchJob[]; workflows?:BackgroundWorkflowJob[]; cognitionAssistant?:CognitionAssistantState; }
export type AgentTaskStatePatch = { kind:'documents'; jobs:DocumentBackgroundJob[] }
  | { kind:'concepts'; jobs:ConceptBatchJob[] }
  | { kind:'workflows'; jobs:BackgroundWorkflowJob[] }
  | { kind:'cognition-assistant'; state:CognitionAssistantState|null }
  | { kind:'sequence'; roleId:string; sequence:AgentSkillSequence|null };
const skills=['plan-planning','study-task-generation','resource-curation'];
const statuses=['ready','running','waiting-input','waiting-approval','waiting-editor','waiting-workbench','paused','complete','cancelled'];
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max;
const validRole=(v:unknown)=>text(v,120)&&/^[a-zA-Z0-9_-]+$/u.test(v as string)&&!['__proto__','constructor','prototype'].includes(v as string);
export function normalizeStoredAgentSequence(value:unknown,roleId:string):AgentSkillSequence{
  const s=value as AgentSkillSequence;
  if(!s||s.version!==1||s.roleId!==roleId||!validRole(roleId)||!text(s.id,120)||!text(s.request,6000)
    ||!Number.isFinite(Date.parse(s.createdAt))||Date.parse(s.createdAt)>Date.now()+60_000
    ||(s.scopeProjectId!==undefined&&!text(s.scopeProjectId,200))||!Array.isArray(s.steps)||s.steps.length<2||s.steps.length>3
    ||new Set(s.steps.map(step=>step.skillId)).size!==s.steps.length)throw new Error('连续任务恢复记录无效');
  if(s.interruptedStep!==undefined&&(!Number.isInteger(s.interruptedStep)||s.interruptedStep<0||s.interruptedStep>=s.steps.length))throw new Error('中断环节引用无效');
  return {version:1,id:s.id,roleId,request:s.request,createdAt:s.createdAt,
    ...(s.interruptedStep!==undefined?{interruptedStep:s.interruptedStep}:{}),
    ...(s.scopeProjectId?{scopeProjectId:s.scopeProjectId}:{}),
    ...(typeof s.notice==='string'?{notice:s.notice.slice(0,1000)}:{}),
    steps:s.steps.map(step=>{
      if(!skills.includes(step.skillId)||!statuses.includes(step.status))throw new Error('连续任务步骤无效');
      const references:Record<string,string>={};
      for(const key of ['runId','previewId','draftId'] as const)if(step[key]!==undefined){
        if(!text(step[key],200))throw new Error('连续任务引用无效');references[key]=step[key]!;
      }
      return {skillId:step.skillId,status:step.status,...references};
    }),
  };
}
export function normalizeAgentTaskState(value:unknown):AgentTaskState{
  if(value===null)return {version:1,documents:[],sequences:{}};
  const file=value as AgentTaskState;
  if(!file||file.version!==1||!file.sequences||typeof file.sequences!=='object'||Array.isArray(file.sequences)
    ||Object.keys(file.sequences).length>32||JSON.stringify(value).length>2_000_000)throw new Error('任务恢复文件无效或超过容量');
  return {version:1,documents:normalizeDocumentBackgroundJobs(file.documents),
    ...(file.concepts!==undefined?{concepts:normalizeConceptBatchJobs(file.concepts)}:{}),
    ...(file.workflows!==undefined?{workflows:normalizeBackgroundWorkflows(file.workflows)}:{}),
    ...(file.cognitionAssistant!==undefined?{cognitionAssistant:normalizeCognitionAssistantState(file.cognitionAssistant)}:{}),
    sequences:Object.fromEntries(Object.entries(file.sequences).map(([roleId,s])=>[roleId,normalizeStoredAgentSequence(s,roleId)]))};
}
export function applyAgentTaskStatePatch(current:unknown,patch:AgentTaskStatePatch):AgentTaskState{
  const file=normalizeAgentTaskState(current);
  if(patch?.kind==='documents')file.documents=normalizeDocumentBackgroundJobs(patch.jobs);
  else if(patch?.kind==='concepts')file.concepts=normalizeConceptBatchJobs(patch.jobs);
  else if(patch?.kind==='workflows')file.workflows=normalizeBackgroundWorkflows(patch.jobs);
  else if(patch?.kind==='cognition-assistant'){
    if(patch.state===null)delete file.cognitionAssistant;
    else file.cognitionAssistant=normalizeCognitionAssistantState(patch.state);
  }
  else if(patch?.kind==='sequence'&&validRole(patch.roleId)){
    if(patch.sequence===null)delete file.sequences[patch.roleId];
    else file.sequences[patch.roleId]=normalizeStoredAgentSequence(patch.sequence,patch.roleId);
  }else throw new Error('不支持的任务恢复写入');
  return normalizeAgentTaskState(file);
}
