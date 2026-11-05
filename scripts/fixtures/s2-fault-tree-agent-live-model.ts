import type { LlmCallRequest, LlmCallResponse } from '../../src/types';

/** Test-only process bridge. Credentials stay in Node; no synthetic answers or replay. */
export async function callLLM(request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> {
  if (options?.signal?.aborted) throw new DOMException('已停止', 'AbortError');
  const response = await (window as any).__ftaLiveModel(request);
  if (options?.signal?.aborted) throw new DOMException('已停止', 'AbortError');
  return response;
}
export async function ensureLlmSettingsLoaded() { /* Private settings are held in the test process. */ }
export function readLlmSettingsForUse() { return (window as any).__ftaPublicSettings; }
export const loadLlmSettings = readLlmSettingsForUse;
