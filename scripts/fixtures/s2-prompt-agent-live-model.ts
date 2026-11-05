import type { LlmCallRequest, LlmCallResponse } from '../../src/types';

/** Only IPC is bridged. Model-test preparation/session/parameters use production code. */
export async function callLLM(request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> {
  if (options?.signal?.aborted) throw new DOMException('已取消', 'AbortError');
  const result = await (window as any).__promptLiveModel(request);
  if (options?.signal?.aborted) throw new DOMException('已取消', 'AbortError');
  return result;
}
export async function ensureLlmSettingsLoaded() { /* Only sanitized provider metadata reaches the renderer. */ }
export const readLlmSettingsForUse = () => (window as any).__promptSettings;
export const loadLlmSettings = readLlmSettingsForUse;
export function resolveProvider(workflow: string) {
  const settings = readLlmSettingsForUse();
  return settings.providers.find((provider: any) => provider.enabled && provider.id === (settings.workflowBinding[workflow] || settings.defaultProviderId)) ?? null;
}
