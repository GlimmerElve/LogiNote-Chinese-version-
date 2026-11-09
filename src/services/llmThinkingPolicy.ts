import type { LlmProvider, LlmSettings, LlmThinkingPreference } from '../types';

export type LlmThinkingMode = 'enabled' | 'disabled';
export type LlmReasoningEffort = 'low' | 'high' | 'max';
export interface LlmThinkingPolicy {
  thinkingMode?: LlmThinkingMode;
  reasoningEffort?: LlmReasoningEffort;
}

export function workflowThinkingPreference(settings: LlmSettings, workflowId: string, explicit?: LlmThinkingPreference): LlmThinkingPreference {
  const value = explicit ?? settings.workflowThinking?.[workflowId as keyof NonNullable<LlmSettings['workflowThinking']>] ?? 'default';
  return ['default', 'off', 'low', 'medium', 'high'].includes(value) ? value : 'default';
}

type ThinkingCapability = 'glm53' | 'glm52' | 'switch' | 'deepseek-effort' | 'unsupported';
function thinkingCapability(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>, model: string): ThinkingCapability {
  if (provider.apiType !== 'openai-compatible') return 'unsupported';
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { return 'unsupported'; }
  if (url.protocol !== 'https:') return 'unsupported';
  const host = url.hostname.toLowerCase();
  if (isHost(host, 'open.bigmodel.cn') || isHost(host, 'api.z.ai')) {
    if (['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].includes(model)) return 'glm53';
    if (model === 'glm-5.2') return 'glm52';
    if (['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5'].includes(model)) return 'switch';
  }
  if (isHost(host, 'deepseek.com')) {
    if (['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return 'deepseek-effort';
    if (['deepseek-chat', 'deepseek-reasoner'].includes(model)) return 'switch';
  }
  return 'unsupported';
}

export function describeThinkingPreference(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>, model: string, preference: LlmThinkingPreference): string {
  if (preference === 'default') return '';
  const capability = thinkingCapability(provider, model);
  if (capability === 'unsupported') return '当前接口尚未适配思考控制，保留模型原有行为。';
  if (capability === 'glm53' && preference === 'off') return '该模型不能关闭思考，实际使用最低档。';
  if (capability === 'glm52' && preference === 'medium') return '该模型只有两个有效档位，中档采用较低的增强推理档。';
  if (capability === 'switch' && preference !== 'off') return '该模型仅提供思考开关，所选档位按开启思考处理。';
  return '';
}

/** Effective level drives reserve size; unsupported settings never invent API fields. */
export function effectiveThinkingLevel(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>, model: string,
  preference: LlmThinkingPreference): 'off' | 'low' | 'medium' | 'high' | undefined {
  if (preference === 'default' || !['off', 'low', 'medium', 'high'].includes(preference)) return;
  const capability = thinkingCapability(provider, model);
  if (capability === 'unsupported') return;
  if (preference === 'off') return capability === 'glm53' ? 'low' : 'off';
  if (capability === 'switch') return 'low';
  if (capability === 'glm52' && preference === 'medium') return 'low';
  return preference;
}

/** Only an explicit, supported manual thinking choice extends model waiting.
 * Default workflows and genuine off retain their existing deadlines. */
export function manualThinkingTimeoutMs(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>, model: string,
  preference: LlmThinkingPreference = 'default'): number | undefined {
  const level = effectiveThinkingLevel(provider, model, preference);
  return level === 'high' ? 600000 : level === 'medium' ? 480000 : level === 'low' ? 300000 : undefined;
}

const isHost = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

export function isGlm53ThinkingProvider(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>, model: string): boolean {
  if (provider.apiType !== 'openai-compatible' || model !== 'glm-5.3') return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === 'https:' && (isHost(url.hostname.toLowerCase(), 'open.bigmodel.cn') || isHost(url.hostname.toLowerCase(), 'api.z.ai'));
  } catch { return false; }
}

/** Provider-specific request adaptation only. Never changes saved settings,
 * model selection, prompts or approval-bound course checkpoints.
 * GLM-5.3 cannot disable thinking; its official low-latency setting is enabled
 * with low reasoning effort. Explicit enabled keeps the provider's default max.
 * https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3 */
export function resolveLlmThinkingPolicy(
  provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>,
  model: string,
  requested?: LlmThinkingMode,
  preference: LlmThinkingPreference = 'default',
): LlmThinkingPolicy {
  if (preference !== 'default') {
    const capability = thinkingCapability(provider, model);
    if (capability !== 'unsupported') {
      if (preference === 'off') return capability === 'glm53'
        ? { thinkingMode: 'enabled', reasoningEffort: 'low' } : { thinkingMode: 'disabled' };
      if (['low', 'medium', 'high'].includes(preference)) {
        if (capability === 'switch') return { thinkingMode: 'enabled' };
        const effort = capability === 'glm52' ? (preference === 'high' ? 'max' : 'high')
          : ({ low: 'low', medium: 'high', high: 'max' } as const)[preference as 'low' | 'medium' | 'high'];
        return { thinkingMode: 'enabled', reasoningEffort: effort };
      }
    }
  }
  if (provider.apiType !== 'openai-compatible' || requested !== undefined && !['enabled', 'disabled'].includes(requested)) return {};
  // Calls that never needed reasoning should not inherit GLM's expensive max
  // default merely because they omitted a DeepSeek-specific thinking toggle.
  if (isGlm53ThinkingProvider(provider, model)) return requested === 'enabled'
    ? { thinkingMode: 'enabled' } : { thinkingMode: 'enabled', reasoningEffort: 'low' };
  if (requested === undefined) return {};
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { return {}; }
  const host = url.hostname.toLowerCase();
  // Preserve the existing DeepSeek behavior, including custom endpoint paths.
  if (isHost(host, 'deepseek.com')) return { thinkingMode: requested };
  return {};
}
