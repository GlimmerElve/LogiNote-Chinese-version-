import { UNIFIED_GROUNDED_PROMPT, UNIFIED_GROUNDED_VERSION } from '../../workflows/documentCoreUnifiedGroundedPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedInlineRequest, projectUnifiedInline, type UnifiedInlineRequest, type UnifiedInlineResult, type UnifiedInlineRun } from './unifiedInline';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedGroundedRequest = Omit<UnifiedInlineRequest, 'version'> & { version: typeof UNIFIED_GROUNDED_VERSION };
export type UnifiedGroundedResult = Omit<UnifiedInlineResult, 'provenance'> & {
  provenance: Omit<UnifiedInlineResult['provenance'], 'version'> & { version: typeof UNIFIED_GROUNDED_VERSION };
};
export type UnifiedGroundedRun = Omit<UnifiedInlineRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_GROUNDED_VERSION; request: UnifiedGroundedRequest; result?: UnifiedGroundedResult;
};
/** Only the unresolved grounding instruction changes. All v5 projection and contract diagnostics remain unchanged. */
export function prepareUnifiedGroundedRequest(input: NarrativeGraphInput): UnifiedGroundedRequest {
  return { ...prepareUnifiedInlineRequest(input), version: UNIFIED_GROUNDED_VERSION, systemPrompt: UNIFIED_GROUNDED_PROMPT };
}
export function projectUnifiedGrounded(raw: string, input: NarrativeGraphInput): UnifiedGroundedResult {
  const result = projectUnifiedInline(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_GROUNDED_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedGroundedRequest,
  model: { call(request: Readonly<UnifiedGroundedRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedGroundedResult, signal?: AbortSignal
) => Promise<Omit<UnifiedGroundedRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedGrounded(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedGroundedRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedGroundedRequest(narrative), model, raw => projectUnifiedGrounded(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
