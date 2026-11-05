import { agentTaskScope, loadAgentTaskState, saveAgentTaskState } from './taskStateClient';
import { normalizeStoredAgentSequence } from './taskStateCodec';
import type { AgentSkillSequence } from './skillSequence';

export function recoveredSequenceNeedsInspection(sequence:AgentSkillSequence):boolean{
  const index=sequence.steps.findIndex(step=>step.status!=='complete'),step=sequence.steps[index];
  return !!step&&sequence.interruptedStep===index&&!step.previewId&&!step.draftId
    &&(step.skillId==='plan-planning'||!sequence.scopeProjectId);
}

/** Persist the user's original sequence and identities, never inferred completion
 * or approval. All unfinished steps require an explicit resume after restart. */
export async function restoreAgentSequence(roleId:string):Promise<{scopeId:string;sequence:AgentSkillSequence|null}>{
  const loaded=await loadAgentTaskState();
  if(loaded.scopeId!==await agentTaskScope())throw new Error('资料库发生变化，连续任务未恢复');
  const stored=loaded.state.sequences[roleId];
  if(!stored)return {scopeId:loaded.scopeId,sequence:null};
  const sequence=normalizeStoredAgentSequence(stored,roleId);
  const interruptedStep=sequence.steps.findIndex(step=>['running','waiting-approval'].includes(step.status));
  return {scopeId:loaded.scopeId,sequence:{...sequence,
    ...(interruptedStep>=0?{interruptedStep}:{}),
    steps:sequence.steps.map(step=>['complete','cancelled'].includes(step.status)?step:{...step,status:'paused'}),
    notice:'已恢复已保存环节；未完成环节已暂停。请核对原项目后继续，未重放请求或自动授予确认。',
  }};
}
export function persistAgentSequence(scopeId:string,roleId:string,sequence:AgentSkillSequence|null):Promise<void>{
  return saveAgentTaskState(scopeId,{kind:'sequence',roleId,sequence});
}
