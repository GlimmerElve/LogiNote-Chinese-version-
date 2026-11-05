import { prepareCompactCoreAudit, parseCompactCoreAudit, type CompactAuditRequest } from './compactAudit';
import { RELATION_FUNCTION_PROMPT, type AuditInput } from './semanticAudit';
import type { CoreArgumentReply } from './types';

export const CORE_EVIDENCE_AUDIT_VERSION = 'document-core-semantic-audit-evidence-v6' as const;
/** Prompt-only experiment: same v5 dictionary, decision schema and budgets. */
export const EVIDENCE_FUNCTION_PROMPT = RELATION_FUNCTION_PROMPT
  .replace('targetKind：observation=观测/记录/数量事实；judgment=比较、解释、因果、适用边界等判断；other=其他。',
    'targetKind：observation=作者报告实际发生的结果，包括定性的专注、兴趣、感受或表现，不限数字；judgment=预期、一般规律、因果解释、建议及适用边界；other=其他。这是句子功能，不代表该报告已被独立核实。')
  .replace('四、给动作', `补充边界：解释怎样发生，不等于举证确实发生。
当目标是“学生更专注/动力提高”等实际结果，而前提只有教学安排或操作过程时，安排本身没有记录结果；即使原文说“在这样的情境下”或“作者认为”，也不能只凭做法证明效果存在。仅说明实施情境用method_context；只是作者给出的产生原因但没有结果依据用other；不能从可见片段确定作者论证用途用uncertain。保留材料，不为了避免孤立而keep。
作者报告的结果本身可以作为后续判断的依据，不强制要求量化、对照或外部核实。数据支持比较、计算支持数值、实际结果反对原预期均可保留；结果支持作者明确提出的解释也不等于机制已被证明。不得因缺少独立机制实验就一律撤销解释性推断。
目标若是建议，要看前提是否说明采纳它的理由，而非已有安排是否被实施。效益或约束可以支持建议；单纯“先评估、后分层”的程序先后不自动是理由。若说明评估为何有助于匹配任务，则按实际论证判断，不按方法词一律排除。
只有本候选可见原话可用；缺少必要语境时说明不确定，不能借目标自身的效果或其他候选补证据。不要给作者添加“已证实”立场，也不要改写其解释或命名。

四、给动作`);

export type CoreEvidenceAuditRequest = Omit<CompactAuditRequest, 'version'> & { version: typeof CORE_EVIDENCE_AUDIT_VERSION };
export function prepareCoreEvidenceAudit(input: AuditInput): CoreEvidenceAuditRequest {
  const compact = prepareCompactCoreAudit(input);
  if (!compact.systemPrompt.endsWith(RELATION_FUNCTION_PROMPT)) throw new Error('紧凑传输提示词边界已变化，不能静默替换');
  return { ...compact, version: CORE_EVIDENCE_AUDIT_VERSION,
    systemPrompt: compact.systemPrompt.slice(0, -RELATION_FUNCTION_PROMPT.length) + EVIDENCE_FUNCTION_PROMPT };
}

/** v6 changes semantic instructions, not the decision wire or local verdicts.
 * Proposals can be replayed with decisionContract=compact-v5; no new graph kind. */
export async function runCoreEvidenceAudit(source: AuditInput,
  model: { call(request: Readonly<CoreEvidenceAuditRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }, signal?: AbortSignal) {
  const input = structuredClone(source), request = prepareCoreEvidenceAudit(input), start = Date.now();
  const boundary = { productionWrites: false, automaticallyApplied: false, automaticRetries: 0,
    semanticCertified: false, decisionWireContract: 'compact-v5' } as const;
  let requests = 0; let reply: CoreArgumentReply | undefined;
  try {
    if (signal?.aborted) throw new Error('证据用途复核已取消');
    requests++;
    reply = await model.call(structuredClone(request), signal);
    if (signal?.aborted || reply.finishReason !== 'stop') throw new Error('证据用途复核取消或输出不完整');
    const decisions = parseCompactCoreAudit(reply.content, input);
    return { status: 'proposed' as const, input, request, decisions, rawResponse: reply.content,
      receipt: { requests, durationMs: Date.now() - start, usage: reply.usage }, boundary };
  } catch (error) {
    return { status: 'held' as const, input, request, rawResponse: reply?.content,
      error: error instanceof Error ? error.message : String(error),
      receipt: { requests, durationMs: Date.now() - start, usage: reply?.usage }, boundary };
  }
}
