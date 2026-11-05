import { UNIFIED_ALIGNED_PROMPT, UNIFIED_ALIGNED_VERSION } from '../../workflows/documentCoreUnifiedAlignedPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedRequest, projectUnifiedRelations, type UnifiedRequest, type UnifiedResult, type UnifiedRun } from './unifiedRelations';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedAlignedRequest = Omit<UnifiedRequest, 'version'> & { version: typeof UNIFIED_ALIGNED_VERSION };
export type UnifiedAlignedResult = Omit<UnifiedResult, 'provenance'> & {
  provenance: Omit<UnifiedResult['provenance'], 'version'> & { version: typeof UNIFIED_ALIGNED_VERSION };
};
export type UnifiedAlignedRun = Omit<UnifiedRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_ALIGNED_VERSION; request: UnifiedAlignedRequest; result?: UnifiedAlignedResult;
};
/** Isolated v3 request. Reuses the frozen parser, source packet, budgets and single-call transport. */
export function prepareUnifiedAlignedRequest(input: NarrativeGraphInput): UnifiedAlignedRequest {
  return { ...prepareUnifiedRequest(input), version: UNIFIED_ALIGNED_VERSION, systemPrompt: UNIFIED_ALIGNED_PROMPT };
}
export function projectUnifiedAligned(raw: string, input: NarrativeGraphInput): UnifiedAlignedResult {
  const result = projectUnifiedRelations(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_ALIGNED_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedAlignedRequest,
  model: { call(request: Readonly<UnifiedAlignedRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedAlignedResult, signal?: AbortSignal
) => Promise<Omit<UnifiedAlignedRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedAligned(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedAlignedRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedAlignedRequest(narrative), model, raw => projectUnifiedAligned(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
