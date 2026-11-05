import type { TextbookJobSummary } from '../textbook/generationTypes';
import { documentJobActive, type DocumentBackgroundJob } from '../documentBackgroundQueue';
import { safeTextbookTaskError } from '../textbook/webErrors';

export type AgentTaskStatus='queued'|'running'|'stopping'|'paused'|'waiting-confirmation'|'completed'|'failed'|'cancelled'|'archived';
export interface AgentTaskAction {tool:string;arguments:Record<string,unknown>;requiresConfirmation:boolean;mayCallModel:boolean;}
export interface AgentTaskSummary {kind:string;id:string;title:string;status:AgentTaskStatus;nativeStatus:string;
  scope:{projectNoteId?:string;docId?:string;storageScopeId?:string};actions:AgentTaskAction[];
  completedUnits?:number;totalUnits?:number;error?:string;continuation:string;}
const action=(tool:string,args:Record<string,unknown>,requiresConfirmation=false,mayCallModel=false):AgentTaskAction=>({tool,arguments:args,requiresConfirmation,mayCallModel});

/** Metadata adapters only. A uniform status never invents a module operation. */
export function textbookTaskSummary(job:TextbookJobSummary):AgentTaskSummary{
  const running=job.progress?.running===true;
  const status:AgentTaskStatus=running?'running':job.archivedAt?'archived':job.stage==='published'?'completed'
    :job.stage==='failed'?'failed':job.stage==='cancelled'?'cancelled':'paused';
  const args={jobId:job.jobId};
  const actions=[action('query_textbook_job',args)];
  if(running)actions.push(action('stop_textbook_job',args));
  if(status==='completed')actions.push(action('open_project_textbook',{projectNoteId:job.projectNoteId}));
  else if(status==='archived')actions.push(action('archive_textbook_job',{...args,archived:false},true));
  else if(!running)actions.push(action('generate_project_textbook',args,true,true),action('archive_textbook_job',{...args,archived:true},true));
  return {kind:'textbook',id:job.jobId,title:job.title,status,nativeStatus:job.stage,scope:{projectNoteId:job.projectNoteId},actions,
    ...(job.error?{error:safeTextbookTaskError(job.error)}:{}),
    completedUnits:job.completedChapters,totalUnits:job.totalChapters,
    continuation:'沿用原任务检查点和累计预算；继续或指定章节重跑须分别确认。已发布教材先query_textbook_job取得真实章节ID再请求重生成；人工改过的教材使用局部编辑，不覆盖。运行中可查询；只有用户明确要求才stop_textbook_job，停止请求不是已停止或撤销保存，不因页面切换停止。组合任务优先停止外层流程。'};
}
export function documentTaskSummary(job:DocumentBackgroundJob,jobs:DocumentBackgroundJob[]):AgentTaskSummary{
  const status:AgentTaskStatus=job.archivedAt?'archived':job.status==='cancelling'?'stopping':job.status==='interrupted'?'paused':job.status;
  const args={jobId:job.id},actions:AgentTaskAction[]=[];
  if(documentJobActive(job))actions.push(action('cancel_document_job',args,true));
  else if(job.archivedAt)actions.push(action('archive_document_job',{...args,archived:false},true));
  else{
    if(['failed','cancelled','interrupted'].includes(job.status)&&job.scopeId&&job.sourceIdentity
      &&!jobs.some(other=>other.resumeOf===job.id||other.docId===job.docId&&documentJobActive(other)))
      actions.push(action('resume_document_job',args,true,true));
    actions.push(action('archive_document_job',{...args,archived:true},true));
  }
  return {kind:'document-argument',id:job.id,title:job.fileName,status,nativeStatus:job.status,
    scope:{docId:job.docId,storageScopeId:job.scopeId},actions,
    ...(job.error?{error:safeTextbookTaskError(job.error).replace(/教材/gu,'资料任务')}:{}),
    continuation:'已保存批次保留；恢复只继续原文版本匹配的未完成图谱，不重新解析、清空旧图或自动重试。归档仅隐藏记录，不删除资料或图谱。'};
}
