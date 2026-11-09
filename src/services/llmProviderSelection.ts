import type { LlmProvider, LlmSettings, LlmWorkflowId } from '../types';

/** Adding the first configured supplier is the only automatic route setup.
 * Stored defaults and explicit bindings remain authoritative on later edits. */
export function addLlmProviderWithInitialRoutes(
  settings: LlmSettings, provider: LlmProvider, workflows: readonly LlmWorkflowId[],
): LlmSettings {
  const providers = [...settings.providers, provider];
  if (settings.providers.length > 0 || settings.defaultProviderId || !provider.enabled) return { ...settings, providers };
  const workflowBinding = { ...settings.workflowBinding };
  for (const workflow of workflows) {
    if (!workflowBinding[workflow]) workflowBinding[workflow] = provider.id;
  }
  return { ...settings, providers, defaultProviderId: provider.id, workflowBinding };
}

/** Also used by settings to show the actual route, including unavailable legacy targets. */
export function getLlmProviderRouteId(settings: LlmSettings, workflowId: string): string {
  const binding = (settings.workflowBinding as Record<string, string | undefined>)[workflowId];
  const selectedId = binding || settings.defaultProviderId;
  return selectedId || settings.providers.find(provider => provider.enabled === true)?.id || '';
}

/** A configured route is authoritative: unavailable targets never fall through to another supplier. */
export function selectLlmProvider(settings: LlmSettings, workflowId: string): LlmProvider | null {
  const selectedId = getLlmProviderRouteId(settings, workflowId);
  return settings.providers.find(provider => provider.id === selectedId && provider.enabled === true) ?? null;
}

/** Explain the configured route without revealing IDs, credentials or addresses.
 * This is diagnostic only: it never selects a replacement supplier. */
export function describeLlmProviderUnavailable(settings: LlmSettings, workflowId: string, workflowName = '当前功能'): string {
  const safeLabel = (value: string) => {
    // Remove complete addresses first, including query/fragment text appended
    // to a configured base URL inside an accidentally pasted display name.
    let label = value.replace(/(?:https?|ftp):\/\/[^\s"'<>]+/giu, '（服务地址）');
    for (const provider of settings.providers) {
      for (const secret of [provider.apiKey, provider.baseUrl]) {
        if (secret) label = label.split(secret).join('（已隐藏）');
      }
    }
    return label.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80);
  };
  const feature = safeLabel(workflowName) || '当前功能';
  const binding = (settings.workflowBinding as Record<string, string | undefined>)[workflowId];
  const selectedId = binding || settings.defaultProviderId;
  const workflowSetting = workflowId.startsWith('textbook-') ? '教材生成' : feature;
  const bindAction = `“AI 配置 → 工作流绑定 → ${workflowSetting}”`;
  if (!selectedId) {
    const reason = settings.providers.length ? '尚无可用的已启用供应商' : '尚未配置模型供应商';
    return `“${feature}”的模型供应商不可用：${reason}。请在“AI 配置”添加或启用供应商，再在${bindAction}选择。`;
  }
  const target = settings.providers.find(provider => provider.id === selectedId);
  const origin = binding ? '工作流绑定指向' : '当前兼容旧配置的供应商为';
  const name = target ? `“${safeLabel(target.name) || '未命名供应商'}”` : '';
  const reason = !target ? '该供应商已删除或尚未配置' : target.enabled !== true ? '该供应商已停用' : '该供应商当前无法使用';
  const action = `请在${bindAction}改选已启用的供应商。`;
  return `“${feature}”的模型供应商不可用：${origin}${name}，${reason}。${action}`;
}

/** Snapshots retain model/address approval, but cannot retain permission after disabling or deleting their supplier. */
export function assertLlmProviderEnabled(settings: LlmSettings | null, providerId: string): void {
  const matches = settings?.providers?.filter(provider => provider.id === providerId) ?? [];
  if (!providerId || matches.length !== 1) throw new Error('模型供应商已不存在，请重新选择供应商。');
  if (matches[0].enabled !== true) throw new Error('模型供应商已停用，请重新启用或选择其他供应商。');
}
