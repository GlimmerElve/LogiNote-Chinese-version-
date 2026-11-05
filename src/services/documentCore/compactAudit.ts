import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import { validateCoreAuditInput, RELATION_FUNCTION_PROMPT, parseCoreAuditDecisions,
  type AuditInput, type AuditQuote } from './semanticAudit';
import type { CoreArgumentReply } from './types';

export const CORE_COMPACT_AUDIT_VERSION = 'document-core-semantic-audit-compact-v5';
const OPTIONS = { visibility: 'blind-candidates', contract: 'relation-function' } as const;
export interface CompactAuditRequest {
  version: typeof CORE_COMPACT_AUDIT_VERSION; systemPrompt: string; userInput: string;
  parameters: { temperature: 0; maxTokens: 3072; thinkingMode: 'disabled' };
}
export function prepareCompactCoreAudit(input: AuditInput): CompactAuditRequest {
  validateCoreAuditInput(input, 12);
  const passages = new Map(input.source.passages.map((p, order) => [p.id, { ...p, order }]));
  const spans = new Map<string, { passageId: string; quote: string; start: number; end: number; order: number }>();
  const bind = (ref: AuditQuote) => {
    const passage = passages.get(ref.passageId)!;
    const { start, end } = locateDocumentArgumentQuote(passage.text, ref.quote);
    const key = JSON.stringify([passage.id, start, end]);
    spans.set(key, { passageId: passage.id, quote: passage.text.slice(start, end), start, end, order: passage.order });
    return key;
  };
  const keys = input.candidates.map(c => ({ id: c.id, kind: c.kind, target: bind(c.target), premises: c.premises.map(bind) }));
  if (spans.size > 60) throw new Error('紧凑审计引文超过60项，未静默截断');
  const ordered = [...spans.entries()].sort(([, a], [, b]) => a.order - b.order || a.start - b.start || a.end - b.end);
  const ids = new Map(ordered.map(([key], i) => [key, `Q${i + 1}`]));
  const quotes = Object.fromEntries(ordered.map(([key, value]) => [ids.get(key)!, { passageId: value.passageId, quote: value.quote }]));
  const candidates = keys.map(c => ({ ...c, target: ids.get(c.target)!, premises: c.premises.map(k => ids.get(k)!) }));
  const userInput = JSON.stringify({ quotes, candidates });
  if (userInput.length > 12000) throw new Error('紧凑审计请求超过12000字符，未静默裁剪');
  const prelude = '传输格式：quotes是原文引文字典；candidates的target与premises是字典ID。先按ID逐项读取原话，再按以下同一语义契约复核。共享字典不代表共享前提：只能用本候选premises列出的引文，不能把target或其他候选材料借作依据。输出仍用decisions且每个候选恰好一次；若retarget，target仍填{passageId,quote}原话对象，不填字典ID。\n';
  return { version: CORE_COMPACT_AUDIT_VERSION, systemPrompt: prelude + RELATION_FUNCTION_PROMPT, userInput,
    parameters: { temperature: 0, maxTokens: 3072, thinkingMode: 'disabled' } };
}
export function parseCompactCoreAudit(raw: string, input: AuditInput) {
  prepareCompactCoreAudit(input);
  return parseCoreAuditDecisions(raw, input, OPTIONS);
}
/** Experimental all-item transport; one call, no retry, no automatic repair. */
export async function runCompactCoreAudit(source: AuditInput,
  model: { call(request: Readonly<CompactAuditRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }, signal?: AbortSignal) {
  const input = structuredClone(source), request = prepareCompactCoreAudit(input), start = Date.now();
  const boundary = { productionWrites: false, automaticallyApplied: false, automaticRetries: 0, semanticCertified: false } as const;
  let requests = 0; let reply: CoreArgumentReply | undefined;
  try {
    if (signal?.aborted) throw new Error('紧凑审计已取消');
    requests++;
    reply = await model.call(structuredClone(request), signal);
    if (signal?.aborted || reply.finishReason !== 'stop') throw new Error('紧凑审计取消或输出不完整');
    const decisions = parseCompactCoreAudit(reply.content, input);
    return { status: 'proposed' as const, input, request, decisions, rawResponse: reply.content,
      receipt: { requests, durationMs: Date.now() - start, usage: reply.usage }, boundary };
  } catch (error) {
    return { status: 'held' as const, input, request, rawResponse: reply?.content,
      error: error instanceof Error ? error.message : String(error),
      receipt: { requests, durationMs: Date.now() - start, usage: reply?.usage }, boundary };
  }
}
