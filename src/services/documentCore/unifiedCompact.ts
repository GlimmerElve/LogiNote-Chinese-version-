import { UNIFIED_COMPACT_PROMPT, UNIFIED_COMPACT_VERSION } from '../../workflows/documentCoreUnifiedCompactPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedInlineRequest, projectUnifiedInline, type UnifiedInlineRequest, type UnifiedInlineResult, type UnifiedInlineRun } from './unifiedInline';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedCompactRequest = Omit<UnifiedInlineRequest, 'version'> & { version: typeof UNIFIED_COMPACT_VERSION };
export type UnifiedCompactResult = Omit<UnifiedInlineResult, 'provenance'> & {
  provenance: Omit<UnifiedInlineResult['provenance'], 'version'> & { version: typeof UNIFIED_COMPACT_VERSION };
};
export type UnifiedCompactRun = Omit<UnifiedInlineRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_COMPACT_VERSION; request: UnifiedCompactRequest; result?: UnifiedCompactResult;
};
/** Isolated compact-prompt test. Frozen projection has no semantic repair. */
export function prepareUnifiedCompactRequest(input: NarrativeGraphInput): UnifiedCompactRequest {
  return { ...prepareUnifiedInlineRequest(input), version: UNIFIED_COMPACT_VERSION, systemPrompt: UNIFIED_COMPACT_PROMPT };
}
export function projectUnifiedCompact(raw: string, input: NarrativeGraphInput): UnifiedCompactResult {
  const result = projectUnifiedInline(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_COMPACT_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedCompactRequest,
  model: { call(request: Readonly<UnifiedCompactRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedCompactResult, signal?: AbortSignal
) => Promise<Omit<UnifiedCompactRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedCompact(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedCompactRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedCompactRequest(narrative), model, raw => projectUnifiedCompact(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
