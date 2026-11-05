import { UNIFIED_MEANING_PROMPT, UNIFIED_MEANING_VERSION } from '../../workflows/documentCoreUnifiedMeaningPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedRequest, projectUnifiedRelations, type UnifiedRequest, type UnifiedResult, type UnifiedRun } from './unifiedRelations';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedMeaningRequest = Omit<UnifiedRequest, 'version'> & { version: typeof UNIFIED_MEANING_VERSION };
export type UnifiedMeaningResult = Omit<UnifiedResult, 'provenance'> & {
  provenance: Omit<UnifiedResult['provenance'], 'version'> & { version: typeof UNIFIED_MEANING_VERSION };
};
export type UnifiedMeaningRun = Omit<UnifiedRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_MEANING_VERSION; request: UnifiedMeaningRequest; result?: UnifiedMeaningResult;
};
/** Only the prompt changes. Wire schema, local projection, budgets, source packet and transport are frozen. */
export function prepareUnifiedMeaningRequest(input: NarrativeGraphInput): UnifiedMeaningRequest {
  return { ...prepareUnifiedRequest(input), version: UNIFIED_MEANING_VERSION, systemPrompt: UNIFIED_MEANING_PROMPT };
}
export function projectUnifiedMeaning(raw: string, input: NarrativeGraphInput): UnifiedMeaningResult {
  const result = projectUnifiedRelations(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_MEANING_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedMeaningRequest,
  model: { call(request: Readonly<UnifiedMeaningRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedMeaningResult, signal?: AbortSignal
) => Promise<Omit<UnifiedMeaningRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedMeaning(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedMeaningRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedMeaningRequest(narrative), model, raw => projectUnifiedMeaning(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
