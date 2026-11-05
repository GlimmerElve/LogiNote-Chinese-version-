import { UNIFIED_INLINE_PROMPT, UNIFIED_INLINE_VERSION } from '../../workflows/documentCoreUnifiedInlinePrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedRequest, projectUnifiedRelations, type UnifiedRequest, type UnifiedResult, type UnifiedRun } from './unifiedRelations';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedInlineRequest = Omit<UnifiedRequest, 'version'> & { version: typeof UNIFIED_INLINE_VERSION };
export type UnifiedInlineResult = Omit<UnifiedResult, 'provenance'> & {
  provenance: Omit<UnifiedResult['provenance'], 'version'> & { version: typeof UNIFIED_INLINE_VERSION };
};
export type UnifiedInlineRun = Omit<UnifiedRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_INLINE_VERSION; request: UnifiedInlineRequest; result?: UnifiedInlineResult;
};
/** Isolated v5 request. Reuses the frozen parser, source packet, budgets and single-call transport. */
export function prepareUnifiedInlineRequest(input: NarrativeGraphInput): UnifiedInlineRequest {
  return { ...prepareUnifiedRequest(input), version: UNIFIED_INLINE_VERSION, systemPrompt: UNIFIED_INLINE_PROMPT };
}
export function projectUnifiedInline(raw: string, input: NarrativeGraphInput): UnifiedInlineResult {
  const result = projectUnifiedRelations(raw, input);
  // Generation contract is narrower; legacy condition edges stay readable and are never rewritten or dropped.
  for (const link of result.declaredLinks) if (link.use === 'condition') result.issues.push({
    id: link.id, code: 'condition_edge_outside_generation_contract',
    reason: 'v5将适用前提内联到结论，不生成condition边；原提议及节点完整保留，仅记录越界，不替换用途或改写语义'
  });
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_INLINE_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedInlineRequest,
  model: { call(request: Readonly<UnifiedInlineRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedInlineResult, signal?: AbortSignal
) => Promise<Omit<UnifiedInlineRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedInline(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedInlineRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedInlineRequest(narrative), model, raw => projectUnifiedInline(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
