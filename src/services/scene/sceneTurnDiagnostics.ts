import type { LlmCallRequest, LlmCallResponse, SceneRunState } from '../../types';
import { sceneInputFacts } from './scenePendingTask';

export type SceneTurnIssue = { code: string; path: string };
export interface SceneTurnAttemptDiagnostic {
  phase: 'understand' | 'plan' | 'respond';
  attempt: number;
  outcome: 'accepted' | 'repairing' | 'rejected' | 'failed';
  issues: SceneTurnIssue[];
  inputKind: 'response' | 'conversation';
  hasSubmittedAnswer: boolean;
  hasPendingTask: boolean;
  expectedTaskAction?: 'keep' | 'replace' | 'cancel';
  receivedTaskOperation?: 'omitted' | 'null' | 'keep' | 'replace' | 'cancel' | 'invalid';
  requestedInteractionType?: string;
  returnedPendingInteraction?: boolean;
  normalizations?: Array<'null-noop' | 'keep-noop' | 'pending-echo' | 'teaching-envelope'>;
  requestedMaxTokens?: number;
  effectiveMaxTokens?: number;
  finishReason?: string;
  outputChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  hadReasoningContent?: boolean;
}
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined;
const code = (value: unknown, fallback = 'unknown') => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/u.test(value) ? value : fallback;
export function normalizeSceneTurnAttemptDiagnostic(raw: unknown): SceneTurnAttemptDiagnostic | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as SceneTurnAttemptDiagnostic;
  if (!['understand','plan','respond'].includes(value.phase) || !['accepted','repairing','rejected','failed'].includes(value.outcome)
    || !['response','conversation'].includes(value.inputKind) || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 2
    || typeof value.hasSubmittedAnswer !== 'boolean' || typeof value.hasPendingTask !== 'boolean'
    || !Array.isArray(value.issues) || value.issues.length > 12) return undefined;
  const result: SceneTurnAttemptDiagnostic = { phase:value.phase,attempt:value.attempt,outcome:value.outcome,inputKind:value.inputKind,
    hasSubmittedAnswer:value.hasSubmittedAnswer,hasPendingTask:value.hasPendingTask,
    issues:value.issues.map(issue=>({code:code(issue?.code),path:typeof issue?.path==='string'&&issue.path.length<=120&&/^[a-zA-Z]/u.test(issue.path)&&Array.from(issue.path).every(ch=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._[]-'.includes(ch))?issue.path:'response'})) };
  if (['keep','replace','cancel'].includes(value.expectedTaskAction || '')) result.expectedTaskAction = value.expectedTaskAction;
  if (['omitted','null','keep','replace','cancel','invalid'].includes(value.receivedTaskOperation || '')) result.receivedTaskOperation = value.receivedTaskOperation;
  if (typeof value.requestedInteractionType === 'string') result.requestedInteractionType = ['text','single-choice','multiple-choice','ordering','fill-blanks','question-set'].includes(value.requestedInteractionType) ? value.requestedInteractionType : 'invalid';
  if (typeof value.returnedPendingInteraction === 'boolean') result.returnedPendingInteraction = value.returnedPendingInteraction;
  if (Array.isArray(value.normalizations)) result.normalizations = [...new Set(value.normalizations.filter(item=>['null-noop','keep-noop','pending-echo','teaching-envelope'].includes(item)))].slice(0,4);
  for (const field of ['requestedMaxTokens','effectiveMaxTokens','outputChars','promptTokens','completionTokens','reasoningTokens'] as const) {
    const n=number(value[field]);if(n!==undefined)result[field]=n;
  }
  if (typeof value.finishReason === 'string') {
    const reason=value.finishReason.trim().toLowerCase().replace(/[-\s]+/gu,'_');
    result.finishReason=['stop','end_turn','eos','length','max_tokens','max_output_tokens','tool_calls','function_call','content_filter','safety','other'].includes(reason)?reason:'other';
  }
  if (typeof value.hadReasoningContent === 'boolean') result.hadReasoningContent = value.hadReasoningContent;
  return result;
}
export function sceneTurnAttemptDiagnostic(input: {
  phase: SceneTurnAttemptDiagnostic['phase']; attempt: number; outcome: SceneTurnAttemptDiagnostic['outcome']; run: SceneRunState;
  issues?: SceneTurnIssue[]; response?: LlmCallResponse; request?: Pick<LlmCallRequest,'maxTokensOverride'>;
  expectedTaskAction?: SceneTurnAttemptDiagnostic['expectedTaskAction']; envelope?: Record<string,unknown>;
  normalizations?: SceneTurnAttemptDiagnostic['normalizations'];
}): SceneTurnAttemptDiagnostic {
  const facts=sceneInputFacts(input.run),operation=input.envelope?.taskUpdate,object=operation&&typeof operation==='object'&&!Array.isArray(operation)?operation as Record<string,unknown>:undefined;
  const interaction=input.envelope?.interaction&&typeof input.envelope.interaction==='object'&&!Array.isArray(input.envelope.interaction)?input.envelope.interaction as Record<string,unknown>:undefined;
  return normalizeSceneTurnAttemptDiagnostic({phase:input.phase,attempt:input.attempt,outcome:input.outcome,issues:input.issues||[],
    inputKind:facts.inputKind,hasSubmittedAnswer:facts.hasSubmittedAnswer,hasPendingTask:Boolean(facts.pendingInteractionId),
    expectedTaskAction:input.expectedTaskAction,receivedTaskOperation:operation===undefined?'omitted':operation===null?'null':
      object&&['keep','replace','cancel'].includes(object.operation as string)?object.operation:'invalid',
    requestedInteractionType:interaction?.type,returnedPendingInteraction:interaction?interaction.id===facts.pendingInteractionId:undefined,
    normalizations:input.normalizations,requestedMaxTokens:input.request?.maxTokensOverride,
    effectiveMaxTokens:input.response?.diagnostics?.sceneContextBudget?.outputReserveTokens,
    finishReason:input.response?.diagnostics?.finishReason,outputChars:input.response?.content.length,
    promptTokens:input.response?.usage?.promptTokens,completionTokens:input.response?.usage?.completionTokens,
    reasoningTokens:input.response?.diagnostics?.reasoningTokens,hadReasoningContent:input.response?.diagnostics?.hadReasoningContent,
  })!;
}
export function emitSceneTurnDiagnostic(callback: ((value: SceneTurnAttemptDiagnostic)=>void)|undefined, value: SceneTurnAttemptDiagnostic) {
  try { callback?.(value); } catch { /* A diagnostic sink cannot invalidate an otherwise valid turn. */ }
}
export class SceneTurnProtocolError extends Error {
  constructor(readonly attempts: SceneTurnAttemptDiagnostic[]) {
    const last = attempts.at(-1)?.issues[0]?.code || 'invalid-output';
    super('本轮输出未通过场景契约校验 [' + last + ']' + (last === 'output-truncated' ? '（输出截断）' : '') + '，未提交回复或更改任务状态；请重试本轮。');
    this.name='SceneTurnProtocolError';
  }
}
