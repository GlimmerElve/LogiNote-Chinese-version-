import type { LlmProvider, LlmSettings } from '../types';

/** A configured route is authoritative: unavailable targets never fall through to another supplier. */
export function selectLlmProvider(settings: LlmSettings, workflowId: string): LlmProvider | null {
  const binding = (settings.workflowBinding as Record<string, string | undefined>)[workflowId];
  const selectedId = binding || settings.defaultProviderId;
  if (selectedId) return settings.providers.find(provider => provider.id === selectedId && provider.enabled === true) ?? null;
  return settings.providers.find(provider => provider.enabled === true) ?? null;
}

/** Snapshots retain model/address approval, but cannot retain permission after disabling or deleting their supplier. */
export function assertLlmProviderEnabled(settings: LlmSettings | null, providerId: string): void {
  const matches = settings?.providers?.filter(provider => provider.id === providerId) ?? [];
  if (!providerId || matches.length !== 1) throw new Error('模型供应商已不存在，请重新选择供应商。');
  if (matches[0].enabled !== true) throw new Error('模型供应商已停用，请重新启用或选择其他供应商。');
}
