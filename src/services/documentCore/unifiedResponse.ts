import { UNIFIED_RESPONSE_PROMPT, UNIFIED_RESPONSE_VERSION } from '../../workflows/documentCoreUnifiedResponsePrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedInlineRequest, projectUnifiedInline, type UnifiedInlineRequest, type UnifiedInlineResult, type UnifiedInlineRun } from './unifiedInline';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedResponseRequest = Omit<UnifiedInlineRequest, 'version'> & { version: typeof UNIFIED_RESPONSE_VERSION };
export type UnifiedResponseResult = Omit<UnifiedInlineResult, 'provenance'> & {
  provenance: Omit<UnifiedInlineResult['provenance'], 'version'> & { version: typeof UNIFIED_RESPONSE_VERSION };
};
export type UnifiedResponseRun = Omit<UnifiedInlineRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_RESPONSE_VERSION; request: UnifiedResponseRequest; result?: UnifiedResponseResult;
};
/** Only the response-use instruction changes. All v5 projection and contract diagnostics remain unchanged. */
export function prepareUnifiedResponseRequest(input: NarrativeGraphInput): UnifiedResponseRequest {
  return { ...prepareUnifiedInlineRequest(input), version: UNIFIED_RESPONSE_VERSION, systemPrompt: UNIFIED_RESPONSE_PROMPT };
}
export function projectUnifiedResponse(raw: string, input: NarrativeGraphInput): UnifiedResponseResult {
  const result = projectUnifiedInline(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_RESPONSE_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedResponseRequest,
  model: { call(request: Readonly<UnifiedResponseRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedResponseResult, signal?: AbortSignal
) => Promise<Omit<UnifiedResponseRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedResponse(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedResponseRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedResponseRequest(narrative), model, raw => projectUnifiedResponse(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
