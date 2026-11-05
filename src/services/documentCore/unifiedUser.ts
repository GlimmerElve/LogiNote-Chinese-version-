import { UNIFIED_USER_PROMPT, UNIFIED_USER_VERSION } from '../../workflows/documentCoreUnifiedUserPrompt';
import { narrativeGraphSource, type NarrativeGraphInput } from './narrativeGraph';
import { prepareUnifiedInlineRequest, projectUnifiedInline, type UnifiedInlineRequest, type UnifiedInlineResult, type UnifiedInlineRun } from './unifiedInline';
import { runPreparedCoreExtraction } from './runner';
import type { CoreArgumentInput, CoreArgumentReply, CoreArgumentRun } from './types';

export type UnifiedUserRequest = Omit<UnifiedInlineRequest, 'version'> & { version: typeof UNIFIED_USER_VERSION };
export type UnifiedUserResult = Omit<UnifiedInlineResult, 'provenance'> & {
  provenance: Omit<UnifiedInlineResult['provenance'], 'version'> & { version: typeof UNIFIED_USER_VERSION };
};
export type UnifiedUserRun = Omit<UnifiedInlineRun, 'version' | 'request' | 'result'> & {
  version: typeof UNIFIED_USER_VERSION; request: UnifiedUserRequest; result?: UnifiedUserResult;
};
/** Uses the user-supplied v8 prompt verbatim. All v5 projection and contract diagnostics remain unchanged. */
export function prepareUnifiedUserRequest(input: NarrativeGraphInput): UnifiedUserRequest {
  return { ...prepareUnifiedInlineRequest(input), version: UNIFIED_USER_VERSION, systemPrompt: UNIFIED_USER_PROMPT };
}
export function projectUnifiedUser(raw: string, input: NarrativeGraphInput): UnifiedUserResult {
  const result = projectUnifiedInline(raw, input);
  return { ...result, provenance: { ...result.provenance, version: UNIFIED_USER_VERSION } };
}
const run = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: UnifiedUserRequest,
  model: { call(request: Readonly<UnifiedUserRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> },
  parser: (raw: string, input: CoreArgumentInput) => UnifiedUserResult, signal?: AbortSignal
) => Promise<Omit<UnifiedUserRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
export async function runUnifiedUser(input: NarrativeGraphInput, model: Parameters<typeof run>[2], signal?: AbortSignal): Promise<UnifiedUserRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await run(source, prepareUnifiedUserRequest(narrative), model, raw => projectUnifiedUser(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}
