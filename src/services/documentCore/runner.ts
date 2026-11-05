import { DOCUMENT_CORE_ARGUMENT_PROMPT, DOCUMENT_CORE_ARGUMENT_VERSION } from '../../workflows/documentCoreArgumentPrompt';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentModel, type CoreArgumentRequest, type CoreArgumentRun } from './types';
import { parseCoreArguments } from './protocol';

/** Pure request preparation. Refuse oversized scope; never slice source paragraphs. */
export function prepareCoreInputPacket(input: CoreArgumentInput): string {
  if (!input.docId?.trim() || !input.sourceVersion?.trim() || !['document', 'chapter', 'excerpt'].includes(input.scope?.kind)
    || !input.scope.label?.trim() || !Array.isArray(input.passages) || !input.passages.length || input.passages.length > 120) {
    throw new Error('核心抽取缺少资料身份、范围或原文段落');
  }
  const ids = new Set<string>();
  let characters = 0;
  for (const passage of input.passages) {
    if (!passage.id?.trim() || ids.has(passage.id) || typeof passage.section !== 'string' || !passage.text?.trim()) {
      throw new Error('核心抽取段落身份重复或正文为空');
    }
    ids.add(passage.id); characters += passage.text.length;
  }
  if (characters > CORE_ARGUMENT_LIMITS.inputCharacters) throw new Error('核心抽取原文超过16000字符，请按完整章节/段落分批；未截断原文');
  const omitted = input.omittedPassageIds || [];
  if (new Set(omitted).size !== omitted.length || omitted.some(id => typeof id !== 'string' || !id.trim() || ids.has(id))) {
    throw new Error('未读范围与已提供段落冲突');
  }
  const userInput = JSON.stringify({ scope: input.scope, passages: input.passages,
    boundary: { selection: 'core-claims-and-required-chains', inspectedScope: 'provided-passages-only',
      fullTextNodeCoverageRequired: false, omittedPassageIds: omitted } });
  if (userInput.length > CORE_ARGUMENT_LIMITS.packetCharacters) throw new Error('核心抽取请求包超过22000字符，未发送、未截断');
  return userInput;
}

export function prepareCoreArgumentRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { version: DOCUMENT_CORE_ARGUMENT_VERSION, systemPrompt: DOCUMENT_CORE_ARGUMENT_PROMPT, userInput: prepareCoreInputPacket(input),
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}

/** One injected model request. No provider lookup, persistence, embeddings, repair or bridging. */
export async function runCoreArgumentExtraction(source: CoreArgumentInput, model: CoreArgumentModel, signal?: AbortSignal): Promise<CoreArgumentRun> {
  const input = structuredClone(source);
  return runPreparedCoreExtraction(input, prepareCoreArgumentRequest(input), model,
    (raw, input) => parseCoreArguments(raw, input, { requireMembership: true }), signal);
}

/** Shared transport boundary; callers supply a versioned parser, never a repair call. */
export async function runPreparedCoreExtraction(source: CoreArgumentInput, prepared: CoreArgumentRequest, model: CoreArgumentModel,
  parse: (raw: string, input: CoreArgumentInput) => NonNullable<CoreArgumentRun['result']>, signal?: AbortSignal): Promise<CoreArgumentRun> {
  const input = structuredClone(source), request = structuredClone(prepared);
  const boundary: CoreArgumentRun['boundary'] = { sourceBasis: 'experiment-passages-v1', coverageGoal: 'selected-core',
    semanticCertified: false, bridgeRequests: 0, automaticRetries: 0, productionWrites: false };
  const run: CoreArgumentRun = { mode: 'shadow', version: request.version, status: 'held', input, request,
    boundary, receipt: { requests: 0, durationMs: 0 } };
  const started = Date.now();
  try {
    if (signal?.aborted) throw new Error('核心抽取已取消，未发送请求');
    // The caller cannot mutate the source or preparation contract while awaiting a reply.
    run.receipt.requests = 1;
    const reply = await model.call(structuredClone(request), signal);
    run.rawResponse = reply.content;
    run.receipt.finishReason = reply.finishReason;
    run.receipt.usage = reply.usage;
    if (signal?.aborted) throw new Error('核心抽取已取消，返回内容仅保留诊断');
    if (reply.finishReason && !['stop', 'end_turn', 'STOP', 'eos'].includes(reply.finishReason)) {
      throw new Error(`核心抽取未完整结束（${reply.finishReason}），未自动重试`);
    }
    run.result = parse(reply.content, input);
    run.status = run.result.issues.length ? 'review_required' : 'extracted';
  } catch (error) {
    // No automatic generation or repair call on a bad quote/shape/transport response.
    run.error = error instanceof Error ? error.message : String(error);
  }
  run.receipt.durationMs = Date.now() - started;
  return run;
}
