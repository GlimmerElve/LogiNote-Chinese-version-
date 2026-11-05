import { UNIFIED_REFINED_PROMPT, UNIFIED_REFINED_VERSION } from '../../workflows/documentCoreUnifiedRefinedPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedInlineRequest, projectUnifiedInline, type UnifiedInlineRequest, type UnifiedInlineResult, type UnifiedInlineRun } from './unifiedInline';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedRefinedRequest = Omit<UnifiedInlineRequest, 'version'> & { version: typeof UNIFIED_REFINED_VERSION };
export type UnifiedRefinedResult = Omit<UnifiedInlineResult, 'provenance'> & {
  provenance: Omit<UnifiedInlineResult['provenance'], 'version'> & { version: typeof UNIFIED_REFINED_VERSION };
};
export type UnifiedRefinedRun = Omit<UnifiedInlineRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_REFINED_VERSION; request: UnifiedRefinedRequest; result?: UnifiedRefinedResult;
};
/** Isolated refined-prompt test. Frozen projection has no semantic repair. */
export function prepareUnifiedRefinedRequest(input: NarrativeGraphInput): UnifiedRefinedRequest {
  return { ...prepareUnifiedInlineRequest(input), version: UNIFIED_REFINED_VERSION, systemPrompt: UNIFIED_REFINED_PROMPT };
}
export function projectUnifiedRefined(raw: string, input: NarrativeGraphInput): UnifiedRefinedResult {
  const result = projectUnifiedInline(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_REFINED_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedRefinedRequest,
  model: { call(request: Readonly<UnifiedRefinedRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedRefinedResult, signal?: AbortSignal
) => Promise<Omit<UnifiedRefinedRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedRefined(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedRefinedRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedRefinedRequest(narrative), model, raw => projectUnifiedRefined(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
