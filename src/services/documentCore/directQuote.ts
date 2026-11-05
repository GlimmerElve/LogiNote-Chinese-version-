import { DOCUMENT_CORE_QUOTE_PROMPT, DOCUMENT_CORE_QUOTE_VERSION, DOCUMENT_CORE_ALIGNED_QUOTE_PROMPT, DOCUMENT_CORE_ALIGNED_QUOTE_VERSION,
  DOCUMENT_CORE_FUNCTIONAL_QUOTE_PROMPT, DOCUMENT_CORE_FUNCTIONAL_QUOTE_VERSION,
  DOCUMENT_CORE_CONTRACT_QUOTE_PROMPT, DOCUMENT_CORE_CONTRACT_QUOTE_VERSION } from '../../workflows/documentCoreQuotePrompt';
import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import type { IdenticalJsonCoalescence } from './identicalJson';
import { parseCoreQuoteEnvelope, type CoreUnresolvedIsolation } from './quoteEnvelope';
import { parseCoreDerivations, type CoreDerivationResult } from './derivation';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentModel, type CoreArgumentRequest, type CoreArgumentRun } from './types';

interface BoundQuote { key: string; passageId: string; quote: string; passageOrder: number; start: number; end: number }
export interface CoreQuoteAnnotation {
  id: string; reason: string;
  source?: { passageId: string; quote: string; start: number; end: number };
  nodeId?: string;
  binding: 'exact-source-range' | 'contained-source-range' | 'unbound' | 'no-source';
}
export interface CoreDirectQuoteResult extends CoreDerivationResult {
  quoteProtocol: { version: typeof DOCUMENT_CORE_QUOTE_VERSION; bindings: Array<{ nodeId: string; passageId: string; start: number; end: number }>;
    identity: 'same-passage-and-exact-source-range'; generatedIds: true; sourceResponse: unknown;
    jsonPolicy: 'identical-duplicates-only'; jsonNormalizations: IdenticalJsonCoalescence[];
    envelopePolicy: 'strict-core-isolated-terminal-unresolved-v1';
    sourceResponseScope: 'complete-json' | 'core-fields-with-quarantined-unresolved';
    unresolvedIsolation?: CoreUnresolvedIsolation;
    annotationPolicy: 'evidence-only-no-new-nodes'; annotations: CoreQuoteAnnotation[] };
}
type QuoteRun = Omit<CoreArgumentRun, 'result'> & { result?: CoreDirectQuoteResult };
function demand(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function shape(value: any, keys: string[]) {
  demand(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), '字段结构不匹配');
}
function rows(value: any, limit: number): any[] { demand(Array.isArray(value) && value.length <= limit, '数组类型或预算非法'); return value; }
function words(value: any, limit: number): string { demand(typeof value === 'string' && value.trim() && value.length <= limit, '文字为空或超预算'); return value; }

/** Quote identity is positional, never semantic. No inferred edges or automatic slicing. */
export function parseCoreDirectQuotes(raw: string, input: CoreArgumentInput): CoreDirectQuoteResult {
  const decoded = parseCoreQuoteEnvelope(raw), value = decoded.value; shape(value, ['steps', 'conclusions', 'unresolved']);
  const issues: CoreDerivationResult['issues'] = decoded.coalesced.map(entry => ({ id: `JSON:${entry.position}`,
    code: 'identical_duplicate_key_coalesced', reason: `同值重复字段已无损合并并留痕：${entry.path}` }));
  const quarantined: CoreDerivationResult['quarantined'] = [];
  if (decoded.unresolvedIsolation) {
    issues.push({ id: 'UNRESOLVED', code: 'unresolved_section_quarantined', reason: decoded.unresolvedIsolation.reason });
    quarantined.push({ layer: 'quote_unresolved_section', id: 'UNRESOLVED', value: decoded.unresolvedIsolation });
  }
  const bound = new Map<string, BoundQuote>();
  const passages = new Map(input.passages.map((passage, order) => [passage.id, { ...passage, order }]));
  function locate(ref: any): BoundQuote {
    shape(ref, ['passageId', 'quote']); const passage = passages.get(ref.passageId); demand(passage, '引用段落不存在');
    const range = locateDocumentArgumentQuote(passage.text, words(ref.quote, 5000));
    const key = JSON.stringify([passage.id, range.start, range.end]);
    return { key, passageId: passage.id, quote: passage.text.slice(range.start, range.end), passageOrder: passage.order, ...range };
  }
  function bind(ref: any): string {
    const quote = locate(ref); bound.set(quote.key, quote); return quote.key;
  }
  function refs(value: any): string[] {
    const keys = rows(value, 60).map(bind); demand(new Set(keys).size === keys.length, '引用列表重复'); return keys;
  }
  function reject(layer: string, id: string, value: unknown, error: unknown) {
    issues.push({ id, code: `${layer}_quarantined`, reason: error instanceof Error ? error.message : String(error) });
    quarantined.push({ layer, id, value });
  }
  const failedTargets = new Set<string>();
  const steps = rows(value.steps, 30).flatMap((row, index) => {
    const id = `S${index + 1}`; let target: string | undefined;
    try {
      shape(row, ['target', 'kind', 'premises', 'reason']); target = bind(row.target);
      demand(['support', 'oppose'].includes(row.kind), '推导用途非法'); words(row.reason, 100);
      return [{ id, conclusion: target, kind: row.kind, premises: refs(row.premises), reason: row.reason }];
    } catch (error) { if (target) failedTargets.add(target); reject('quote_step', id, row, error); return []; }
  });
  const attachmentKeys = ['conditions', 'limitations', 'methods', 'context'] as const;
  const conclusions = rows(value.conclusions, 12).flatMap((row, index) => {
    const id = `C${index + 1}`;
    try {
      shape(row, ['target', ...attachmentKeys, 'reason', 'gaps']); const target = bind(row.target); words(row.reason, 160);
      const gaps = rows(row.gaps, 8).map(gap => words(gap, 200));
      const attachments = { conditions: [], limitations: [], methods: [], context: [] } as Record<typeof attachmentKeys[number], string[]>;
      for (const key of attachmentKeys) {
        let items: any[];
        try { items = rows(row[key], 60); }
        catch (error) { reject('quote_attachment', `${id}:${key}`, row[key], error); continue; }
        for (const [i, ref] of items.entries()) {
          try { attachments[key].push(bind(ref)); }
          catch (error) { reject('quote_attachment', `${id}:${key}:${i + 1}`, ref, error); }
        }
      }
      return [{ nodeId: target, ...attachments, reason: row.reason, gaps }];
    } catch (error) { reject('quote_conclusion', id, row, error); return []; }
  });
  const unresolved = rows(value.unresolved, 20).flatMap((row, index) => {
    try {
      shape(row, Object.hasOwn(row ?? {}, 'target') ? ['target', 'reason'] : ['reason']); words(row.reason, 200);
      // An annotation is evidence about the extraction, not another assertion.
      // Resolve its span without registering a graph material.
      return [{ annotationId: `U${index + 1}`, source: Object.hasOwn(row, 'target') ? locate(row.target) : undefined, reason: row.reason }];
    } catch (error) { reject('quote_unresolved', `U${index + 1}`, row, error); return []; }
  });
  // Never retain just the first 60 fragments and pretend the chosen chain is complete.
  demand(bound.size <= CORE_ARGUMENT_LIMITS.nodes, '不同原文片段超过60项，未截断为伪完整链');
  const ordered = [...bound.values()].sort((a, b) => a.passageOrder - b.passageOrder || a.start - b.start || a.end - b.end);
  const nodeIds = new Map(ordered.map((quote, index) => [quote.key, `N${index + 1}`]));
  const id = (key: string) => { const found = nodeIds.get(key); demand(found, '内部引用缺失'); return found; };
  const annotations: CoreQuoteAnnotation[] = unresolved.map(entry => {
    const quote = entry.source;
    if (!quote) return { id: entry.annotationId, reason: entry.reason, binding: 'no-source' };
    const exact = bound.get(quote.key);
    const containers = exact ? [exact] : ordered.filter(item => item.passageId === quote.passageId && item.start <= quote.start && item.end >= quote.end);
    const nodeId = containers.length === 1 ? id(containers[0].key) : undefined;
    return { id: entry.annotationId, reason: entry.reason,
      source: { passageId: quote.passageId, quote: quote.quote, start: quote.start, end: quote.end },
      ...(nodeId ? { nodeId } : {}), binding: exact ? 'exact-source-range' : nodeId ? 'contained-source-range' : 'unbound' };
  });
  const normalized = {
    materials: ordered.map(quote => ({ id: id(quote.key), source: [{ passageId: quote.passageId, quote: quote.quote }] })),
    steps: steps.map(step => ({ ...step, conclusion: id(step.conclusion), premises: step.premises.map(id) })),
    conclusions: conclusions.map(conclusion => ({ ...conclusion, nodeId: id(conclusion.nodeId),
      ...Object.fromEntries(attachmentKeys.map(key => [key, conclusion[key].map(id)])) })),
    unresolved: annotations.map(entry => ({ reason: entry.reason, ...(entry.nodeId ? { nodeId: entry.nodeId } : {}) })),
  };
  const result = parseCoreDerivations(JSON.stringify(normalized), input, { unboundStepTargets: [...failedTargets].map(id) });
  // Failed quote binding is a projection problem, not evidence that the source lacks a reason.
  for (const key of failedTargets) {
    const targetId = id(key);
    for (const argument of result.graph.arguments.filter(argument => argument.claim === targetId)) argument.status = 'incomplete';
    for (const chain of result.chains.filter(chain => chain.claimId === targetId)) chain.modelStatus = 'incomplete';
  }
  result.issues.unshift(...issues); result.quarantined.unshift(...quarantined);
  if (decoded.unresolvedIsolation) result.graph.unresolved.push({ batch: 1, reason: '模型备注段未能解析，原始片段完整保存在unresolvedIsolation中；未将其视为已解决或补写内容' });
  if (result.issues.length) for (const chain of result.chains) chain.state = 'source_review_required';
  return { ...result, quoteProtocol: { version: DOCUMENT_CORE_QUOTE_VERSION, generatedIds: true, identity: 'same-passage-and-exact-source-range',
    bindings: ordered.map(quote => ({ nodeId: id(quote.key), passageId: quote.passageId, start: quote.start, end: quote.end })), sourceResponse: value,
    jsonPolicy: 'identical-duplicates-only', jsonNormalizations: decoded.coalesced,
    envelopePolicy: 'strict-core-isolated-terminal-unresolved-v1',
    sourceResponseScope: decoded.unresolvedIsolation ? 'core-fields-with-quarantined-unresolved' : 'complete-json',
    ...(decoded.unresolvedIsolation ? { unresolvedIsolation: decoded.unresolvedIsolation } : {}),
    annotationPolicy: 'evidence-only-no-new-nodes', annotations } };
}

export function prepareCoreDirectQuoteRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { version: DOCUMENT_CORE_QUOTE_VERSION, systemPrompt: DOCUMENT_CORE_QUOTE_PROMPT, userInput: prepareCoreInputPacket(input),
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
/** Request-only opt-in: same source and output budget, no automatic migration or model call. */
export function prepareCoreAlignedQuoteRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { ...prepareCoreDirectQuoteRequest(input), version: DOCUMENT_CORE_ALIGNED_QUOTE_VERSION, systemPrompt: DOCUMENT_CORE_ALIGNED_QUOTE_PROMPT };
}
/** Same quote wire format; semantic distinctions are prompt instructions, not local vetoes. */
export function prepareCoreFunctionalQuoteRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { ...prepareCoreDirectQuoteRequest(input), version: DOCUMENT_CORE_FUNCTIONAL_QUOTE_VERSION, systemPrompt: DOCUMENT_CORE_FUNCTIONAL_QUOTE_PROMPT };
}
/** Opt-in contract experiment; parser and production entry point remain unchanged. */
export function prepareCoreContractQuoteRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { ...prepareCoreDirectQuoteRequest(input), version: DOCUMENT_CORE_CONTRACT_QUOTE_VERSION, systemPrompt: DOCUMENT_CORE_CONTRACT_QUOTE_PROMPT };
}
export async function runCoreDirectQuoteExtraction(source: CoreArgumentInput, model: CoreArgumentModel, signal?: AbortSignal): Promise<QuoteRun> {
  const input = structuredClone(source);
  return runPreparedCoreExtraction(input, prepareCoreDirectQuoteRequest(input), model, parseCoreDirectQuotes, signal) as Promise<QuoteRun>;
}
