import { LlmSettings, LlmProvider } from '../types';
import { saveLlmState } from './electronUserState';

const STORAGE_KEY = 'loginote_llm_settings';

function getDefaultDeepSeekProvider(): LlmProvider {
  return {
    id: 'deepseek-default', name: 'DeepSeek', apiType: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com', apiKey: '',
    models: ['deepseek-chat'], selectedModel: 'deepseek-chat',
    enabled: true, createdAt: new Date().toISOString(),
  };
}

export function getDefaultLlmSettings(): LlmSettings {
  return {
    providers: [getDefaultDeepSeekProvider()], defaultProviderId: 'deepseek-default',
    workflowBinding: { 'plan-generation': 'deepseek-default', 'text-segmentation': 'deepseek-default', 'auto-link': 'deepseek-default', 'flow-analysis': 'deepseek-default' },
  };
}

/**
 * 迁移旧默认配置：旧版默认是 Gemini（id='gemini-default'）。
 * 若检测到旧默认仍存在，则把默认项 + 工作流绑定从 gemini 迁移到 deepseek，
 * 保留用户自行添加的其它 provider 不动。
 */
function migrateToDeepSeek(parsed: LlmSettings): LlmSettings {
  const deepseek = getDefaultDeepSeekProvider();
  const providers = parsed.providers || [];
  const hasGemini = providers.some((p) => p.id === 'gemini-default');
  const hasDeepSeek = providers.some((p) => p.id === 'deepseek-default');

  if (!hasGemini && !hasDeepSeek) {
    // 既无旧默认也无新默认：补一个 DeepSeek
    return {
      providers: [deepseek, ...providers],
      defaultProviderId: 'deepseek-default',
      workflowBinding: { ...getDefaultLlmSettings().workflowBinding, ...parsed.workflowBinding },
    };
  }

  if (hasGemini && !hasDeepSeek) {
    // 旧默认存在且没有新默认：用 DeepSeek 替换原本 gemini-default 对应的位置逻辑
    const nextProviders = providers.map((p) => (p.id === 'gemini-default' ? deepseek : p));
    const nextBinding: LlmSettings['workflowBinding'] = {};
    for (const [k, v] of Object.entries(parsed.workflowBinding || {})) {
      nextBinding[k as keyof LlmSettings['workflowBinding']] = v === 'gemini-default' ? 'deepseek-default' : v;
    }
    // 确保 defaultProviderId 也迁移
    const defaultProviderId = parsed.defaultProviderId === 'gemini-default' ? 'deepseek-default' : parsed.defaultProviderId;
    return { providers: nextProviders, defaultProviderId, workflowBinding: nextBinding };
  }

  // hasDeepSeek：无需迁移，保留现状（但兜底补全 defaultProviderId）
  return {
    providers,
    defaultProviderId: parsed.defaultProviderId || 'deepseek-default',
    workflowBinding: { ...getDefaultLlmSettings().workflowBinding, ...parsed.workflowBinding },
  };
}

export function loadLlmSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as LlmSettings;
      return migrateToDeepSeek({
        providers: Array.isArray(p.providers) ? p.providers : [],
        defaultProviderId: typeof p.defaultProviderId === 'string' ? p.defaultProviderId : '',
        workflowBinding: { ...getDefaultLlmSettings().workflowBinding, ...(p.workflowBinding || {}) },
      });
    }
  } catch { /* ignore */ }
  return getDefaultLlmSettings();
}

export function saveLlmSettings(s: LlmSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  saveLlmState(s).catch(() => {});
}

export function getProviderById(s: LlmSettings, id: string): LlmProvider | undefined {
  return s.providers.find((p) => p.id === id && p.enabled);
}