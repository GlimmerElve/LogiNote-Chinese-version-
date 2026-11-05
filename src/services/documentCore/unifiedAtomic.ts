import { UNIFIED_ATOMIC_PROMPT, UNIFIED_ATOMIC_VERSION } from '../../workflows/documentCoreUnifiedAtomicPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedRequest, projectUnifiedRelations, type UnifiedRequest, type UnifiedResult, type UnifiedRun } from './unifiedRelations';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedAtomicRequest = Omit<UnifiedRequest, 'version'> & { version: typeof UNIFIED_ATOMIC_VERSION };
export type UnifiedAtomicResult = Omit<UnifiedResult, 'provenance'> & {
  provenance: Omit<UnifiedResult['provenance'], 'version'> & { version: typeof UNIFIED_ATOMIC_VERSION };
};
export type UnifiedAtomicRun = Omit<UnifiedRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_ATOMIC_VERSION; request: UnifiedAtomicRequest; result?: UnifiedAtomicResult;
};
/** Isolated v4 request. Reuses the frozen parser, source packet, budgets and single-call transport. */
export function prepareUnifiedAtomicRequest(input: NarrativeGraphInput): UnifiedAtomicRequest {
  return { ...prepareUnifiedRequest(input), version: UNIFIED_ATOMIC_VERSION, systemPrompt: UNIFIED_ATOMIC_PROMPT };
}
export function projectUnifiedAtomic(raw: string, input: NarrativeGraphInput): UnifiedAtomicResult {
  const result = projectUnifiedRelations(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_ATOMIC_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedAtomicRequest,
  model: { call(request: Readonly<UnifiedAtomicRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedAtomicResult, signal?: AbortSignal
) => Promise<Omit<UnifiedAtomicRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedAtomic(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedAtomicRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedAtomicRequest(narrative), model, raw => projectUnifiedAtomic(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
