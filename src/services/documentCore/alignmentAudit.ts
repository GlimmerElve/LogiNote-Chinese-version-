import { CORE_RELATION_ONLY_PROMPT, prepareCoreRelationOnlyAudit, parseCoreRelationOnlyAudit,
  type CoreRelationOnlyBatch } from './relationOnlyAudit';
import type { CoreDerivationResult } from './derivation';
import type { CoreArgumentInput, CoreArgumentReply } from './types';

const ORIGINAL_SUPPORT_RULE = 'argument_support：这些前提实际被用于支持当前target，可是演绎、解释、概括或建议理由；不要求独立充分，也不因证据较弱就判为无关系。原文真实但推广较强的推断，在reason注明范围或强度限制，不冒充科学证实。';
const ALIGNED_SUPPORT_RULE = `argument_support：先核对内容针对性，再评价证据强弱。
先确定premises在为target的哪个实质判断提供理由，核对对象、变量、比较项、条件和范围。仅同题、同方向或可作背景，不等于提供该判断的论据；不能把总体存在当作特定群体差异，把结果不一致当作某项具体阴性结果，或把A/B无差异直接当作A/C无差异。
这不是要求所有前提与结论同范围，也不要求独立充分。作者确用具体结果作概括、解释或建议的理由时，可保留并在reason注明推广或因果限制；不能仅因缺少独立机制实验而删除真实解释链。区别是：证据较弱仍须针对当前判断，缺失的关键比较不能用“方向一致/一般性支持”补出来。
当前材料可判断仅为背景或内容错配时用method_context/other；若无法确定是否同一对象或推断用途，用uncertain说明缺口，不强行判支持或否定。`;

/** Opt-in single-boundary control. Frozen v1 prompt and parser stay unchanged. */
export const CORE_ALIGNMENT_AUDIT_PROMPT = CORE_RELATION_ONLY_PROMPT.replace(ORIGINAL_SUPPORT_RULE, ALIGNED_SUPPORT_RULE);
export interface CoreAlignmentRequest {
  version: 'core-audit-content-alignment-v1'; systemPrompt: string; userInput: string;
  parameters: { temperature: 0; maxTokens: 3072; thinkingMode: 'disabled' };
}
export interface CoreAlignmentBatch {
  /** Local original-schema validation context. This is NOT the transmitted request. */
  sourceContract: CoreRelationOnlyBatch; request: CoreAlignmentRequest;
}

export function prepareCoreAlignmentAudit(source: CoreArgumentInput, baseline: CoreDerivationResult) {
  if (!CORE_RELATION_ONLY_PROMPT.includes(ORIGINAL_SUPPORT_RULE) || CORE_ALIGNMENT_AUDIT_PROMPT === CORE_RELATION_ONLY_PROMPT) {
    throw new Error('原支持判据已变化，不能静默修改其他提示词');
  }
  const base = prepareCoreRelationOnlyAudit(source, baseline);
  const batches: CoreAlignmentBatch[] = base.batches.map(b => ({ sourceContract: b, request: {
    version: 'core-audit-content-alignment-v1', systemPrompt: CORE_ALIGNMENT_AUDIT_PROMPT,
    userInput: b.request.userInput, parameters: structuredClone(b.request.parameters),
  } }));
  const totalRequestCharacters = batches.reduce((n, b) => n + b.request.systemPrompt.length + b.request.userInput.length, 0);
  if (totalRequestCharacters > 30000) throw new Error('内容对齐审计总预算超限，未发送');
  return { version: 'core-content-alignment-plan-v1' as const, base, batches, totalRequestCharacters,
    outputContract: 'relation-only-v1' as const, localSemanticClassifierAdded: false, semanticCertified: false, productionWrites: false };
}

function validate(batch: CoreAlignmentBatch) {
  const old = batch.sourceContract.request;
  if (old.version !== 'core-audit-relation-only-v1' || old.systemPrompt !== CORE_RELATION_ONLY_PROMPT
    || batch.request.version !== 'core-audit-content-alignment-v1' || batch.request.systemPrompt !== CORE_ALIGNMENT_AUDIT_PROMPT
    || batch.request.userInput !== old.userInput || batch.request.userInput.length > 12000
    || JSON.stringify(batch.request.parameters) !== JSON.stringify(old.parameters)) throw new Error('内容对齐对照改变了冻结请求契约');
  // Pure preflight reuses the old candidate/parameter validator. The empty rows
  // are not a model reply and are neither stored nor treated as audited output.
  parseCoreRelationOnlyAudit('{"decisions":[]}', batch.sourceContract);
}

export function parseCoreAlignmentAudit(raw: string, batch: CoreAlignmentBatch) {
  validate(batch);
  return parseCoreRelationOnlyAudit(raw, batch.sourceContract);
}
export async function runCoreAlignmentAudit(batch: CoreAlignmentBatch,
  model: { call(request: Readonly<CoreAlignmentRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }, signal?: AbortSignal) {
  const input = structuredClone(batch), start = Date.now(); let requests = 0; let reply: CoreArgumentReply | undefined;
  try {
    if (signal?.aborted) throw new Error('内容对齐审计取消，未发送');
    validate(input); requests++;
    reply = await model.call(structuredClone(input.request), signal);
    if (signal?.aborted || reply.finishReason !== 'stop') throw new Error('内容对齐审计取消或输出不完整');
    const result = parseCoreAlignmentAudit(reply.content, input);
    return { status: result.status, batch: input, result, rawResponse: reply.content,
      receipt: { requests, durationMs: Date.now() - start, usage: reply.usage }, semanticCertified: false, productionWrites: false };
  } catch (error) {
    return { status: 'held' as const, batch: input, rawResponse: reply?.content, error: error instanceof Error ? error.message : String(error),
      receipt: { requests, durationMs: Date.now() - start, usage: reply?.usage }, semanticCertified: false, productionWrites: false };
  }
}
