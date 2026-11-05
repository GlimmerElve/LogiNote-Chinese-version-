import { DOCUMENT_CORE_NARRATIVE_CHAIN_PROMPT, DOCUMENT_CORE_NARRATIVE_CHAIN_VERSION } from '../../workflows/documentCoreNarrativeChainPrompt';
import { prepareCoreInputPacket } from './runner';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply } from './types';
import type { CoreSemanticRequest, CoreSemanticRun } from './semanticBaseline';

export interface NarrativeChainRequest extends Omit<CoreSemanticRequest, 'version'> { version: typeof DOCUMENT_CORE_NARRATIVE_CHAIN_VERSION }
export interface NarrativeChainModel { call(request: Readonly<NarrativeChainRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export interface NarrativeChainRun extends Omit<CoreSemanticRun, 'mode' | 'version' | 'request'> {
  mode: 'narrative-chain-shadow'; version: typeof DOCUMENT_CORE_NARRATIVE_CHAIN_VERSION; request: NarrativeChainRequest;
}
export function prepareNarrativeChainRequest(input: CoreArgumentInput): NarrativeChainRequest {
  return { version: DOCUMENT_CORE_NARRATIVE_CHAIN_VERSION, outputFormat: 'text', systemPrompt: DOCUMENT_CORE_NARRATIVE_CHAIN_PROMPT,
    userInput: prepareCoreInputPacket(input),
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
/** Single reader-facing result. No hidden second call, prose-to-edge parser or semantic pass flag. */
export async function runNarrativeChain(source: CoreArgumentInput, model: NarrativeChainModel, signal?: AbortSignal): Promise<NarrativeChainRun> {
  const input = structuredClone(source), request = prepareNarrativeChainRequest(input);
  const run: NarrativeChainRun = { mode: 'narrative-chain-shadow', version: request.version, input, request, status: 'held',
    receipt: { requests: 0, durationMs: 0 }, boundary: { semanticCertified: false, graphGenerated: false,
      quoteValidation: false, graphValidation: false, automaticRetries: 0, auditRequests: 0, productionWrites: false } };
  const started = Date.now();
  try {
    if (signal?.aborted) throw new Error('论证链摘要已取消，未发送请求');
    run.receipt.requests = 1;
    const reply = await model.call(structuredClone(request), signal);
    run.rawResponse = reply.content; run.receipt.finishReason = reply.finishReason; run.receipt.usage = reply.usage;
    if (signal?.aborted) throw new Error('论证链摘要已取消，仅保留返回诊断');
    if (reply.finishReason && !['stop', 'end_turn', 'STOP', 'eos'].includes(reply.finishReason)) throw new Error(`论证链摘要未完整结束（${reply.finishReason}），未重试`);
    if (typeof reply.content !== 'string' || !reply.content.trim() || reply.content.length > 100000) throw new Error('论证链摘要为空或超过响应安全预算');
    run.result = { text: reply.content, assessment: 'not_evaluated' }; run.status = 'received';
  } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
  run.receipt.durationMs = Date.now() - started;
  return run;
}
