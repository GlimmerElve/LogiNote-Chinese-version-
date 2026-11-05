/** Diagnostic semantic scope, not new production graph node/edge types. */
import { prepareLockedMeaningProbe, parseLockedMeaningProbe } from './relationMeaningLocked';
import type { MeaningCase, MeaningDecision } from './relationMeaningProbe';
import type { CoreArgumentReply } from './types';

export interface ScopedMeaningCase extends MeaningCase {
  targetScope: { level: 'content' | 'attribution'; speaker?: string };
}
export const SCOPED_MEANING_VERSION = 'relation-meaning-scoped-v3' as const;
export function prepareScopedMeaningProbe(cases: ScopedMeaningCase[]) {
  const base = prepareLockedMeaningProbe(cases);
  for (const c of cases) {
    if (!c.targetScope || !['content', 'attribution'].includes(c.targetScope.level)
      || c.targetScope.speaker !== undefined && (typeof c.targetScope.speaker !== 'string' || c.targetScope.speaker.length > 200)) throw new Error('语义层级或归属非法');
  }
  const userInput = JSON.stringify({ cases: cases.map(c => ({ id: c.id, premises: [...c.premises], target: c.target,
    targetScope: { level: c.targetScope.level, ...(c.targetScope.speaker ? { speaker: c.targetScope.speaker } : {}) } })) });
  if (userInput.length > 18000) throw new Error('范围判别包超预算，未截断');
  return { ...base, version: SCOPED_MEANING_VERSION, userInput, systemPrompt: base.systemPrompt
    + '\ntargetScope.level=content时，判断target命题内容受何作用，speaker仅记录归属；attribution时，判断“某人说过/提出过这个说法”这一言说事实。实验结果可反驳预测内容，不因此反驳谁曾作过预测。不要混淆这两个层级。'
    + '\n统计关系只按给定材料判断：控制一个预测变量后，另一个对结果仍有非零作用，并不能决定两个预测变量之间是零相关还是非零相关。不得据此推断相互相关的有无或正负；材料直接报告相应相关关系时才按该报告判断，不从其他题借证据。' };
}
export type ScopedMeaningRequest = ReturnType<typeof prepareScopedMeaningProbe>;
export function parseScopedMeaningProbe(raw: string, cases: ScopedMeaningCase[]) {
  prepareScopedMeaningProbe(cases);
  return parseLockedMeaningProbe(raw, cases);
}
export async function runScopedMeaningProbe(input: ScopedMeaningCase[], model: {
  call(request: Readonly<ScopedMeaningRequest>, signal?: AbortSignal): Promise<CoreArgumentReply>;
}, signal?: AbortSignal) {
  const cases = structuredClone(input), request = prepareScopedMeaningProbe(cases);
  const run: { request: ScopedMeaningRequest; status: 'held' | 'received'; rawResponse?: string; decisions?: MeaningDecision[];
    error?: string; receipt: { requests: number; durationMs: number; finishReason?: string; usage?: CoreArgumentReply['usage'] };
    boundary: { diagnosticOnly: true; automaticallyApplied: false; productionWrites: false; automaticRetries: 0; semanticCertified: false } } = {
    request, status: 'held', receipt: { requests: 0, durationMs: 0 }, boundary: {
      diagnosticOnly: true, automaticallyApplied: false, productionWrites: false, automaticRetries: 0, semanticCertified: false } };
  const start = Date.now();
  try {
    if (signal?.aborted) throw new Error('范围判别已取消，未发送');
    run.receipt.requests = 1;
    const reply = await model.call(structuredClone(request), signal);
    run.rawResponse = reply.content; run.receipt.finishReason = reply.finishReason; run.receipt.usage = reply.usage;
    if (signal?.aborted) throw new Error('范围判别已取消，返回仅保留诊断');
    if (reply.finishReason && !['stop', 'end_turn', 'STOP', 'eos'].includes(reply.finishReason)) throw new Error(`范围判别未完整结束：${reply.finishReason}`);
    run.decisions = parseScopedMeaningProbe(reply.content, cases); run.status = 'received';
  } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
  run.receipt.durationMs = Date.now() - start; return run;
}
