import { DOCUMENT_CORE_SEMANTIC_PROMPT, DOCUMENT_CORE_SEMANTIC_VERSION } from '../../workflows/documentCoreSemanticPrompt';
import { prepareCoreInputPacket } from './runner';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply, type CoreArgumentRequest } from './types';

export interface CoreSemanticRequest extends Omit<CoreArgumentRequest, 'version'> {
  version: typeof DOCUMENT_CORE_SEMANTIC_VERSION; outputFormat: 'text';
}
export interface CoreSemanticModel { call(request: Readonly<CoreSemanticRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export interface CoreSemanticRun {
  mode: 'semantic-baseline'; version: typeof DOCUMENT_CORE_SEMANTIC_VERSION;
  status: 'received' | 'held'; input: CoreArgumentInput; request: CoreSemanticRequest;
  rawResponse?: string; error?: string;
  result?: { text: string; assessment: 'not_evaluated' };
  receipt: { requests: number; durationMs: number; finishReason?: string; usage?: CoreArgumentReply['usage'] };
  boundary: { semanticCertified: false; graphGenerated: false; quoteValidation: false; graphValidation: false;
    automaticRetries: 0; auditRequests: 0; productionWrites: false };
}

/** Keep source scope, packet and generation budget identical; remove all graph output obligations. */
export function prepareCoreSemanticRequest(input: CoreArgumentInput): CoreSemanticRequest {
  return { version: DOCUMENT_CORE_SEMANTIC_VERSION, outputFormat: 'text', systemPrompt: DOCUMENT_CORE_SEMANTIC_PROMPT,
    userInput: prepareCoreInputPacket(input),
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}

/** Receive prose without JSON/quote/role/edge parsing, automatic grading or graph projection.
 * "received" means transport completed, NOT that the semantic interpretation passed. */
export async function runCoreSemanticBaseline(source: CoreArgumentInput, model: CoreSemanticModel,
  signal?: AbortSignal): Promise<CoreSemanticRun> {
  const input = structuredClone(source), request = prepareCoreSemanticRequest(input);
  const run: CoreSemanticRun = { mode: 'semantic-baseline', version: request.version, status: 'held', input, request,
    receipt: { requests: 0, durationMs: 0 }, boundary: { semanticCertified: false, graphGenerated: false, quoteValidation: false,
      graphValidation: false, automaticRetries: 0, auditRequests: 0, productionWrites: false } };
  const started = Date.now();
  try {
    if (signal?.aborted) throw new Error('语义基线已取消，未发送请求');
    run.receipt.requests = 1;
    const reply = await model.call(structuredClone(request), signal);
    run.rawResponse = reply.content; run.receipt.finishReason = reply.finishReason; run.receipt.usage = reply.usage;
    if (signal?.aborted) throw new Error('语义基线已取消，返回内容仅保留诊断');
    if (reply.finishReason && !['stop', 'end_turn', 'STOP', 'eos'].includes(reply.finishReason)) {
      throw new Error(`语义归纳未完整结束（${reply.finishReason}），未自动重试`);
    }
    if (typeof reply.content !== 'string' || !reply.content.trim() || reply.content.length > 100000) throw new Error('语义归纳为空或超过响应安全预算');
    run.result = { text: reply.content, assessment: 'not_evaluated' }; run.status = 'received';
  } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
  run.receipt.durationMs = Date.now() - started;
  return run;
}
