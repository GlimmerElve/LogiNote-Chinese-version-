import { LlmSettings, LlmProvider } from '../types';
import { saveLlmState } from './electronUserState';
import { createSettingsHydration } from './ui/settingsHydration';
import { createSettingsPersistence } from './ui/settingsPersistence';

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
    workflowBinding: { 'plan-generation': 'deepseek-default', 'flow-analysis': 'deepseek-default' },
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
  const pending = llmPersistence.getDraft();
  if (pending) return pending;
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

function normalizeLlmSettings(raw: unknown): LlmSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型配置格式错误');
  const value = raw as LlmSettings;
  if (!Array.isArray(value.providers) || value.providers.some(provider => !provider || typeof provider !== 'object'
    || typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.baseUrl !== 'string'
    || !['openai-compatible', 'anthropic', 'gemini', 'ollama'].includes(provider.apiType)
    || !Array.isArray(provider.models) || provider.models.some(model => typeof model !== 'string')
    || (provider.visionModels !== undefined && (!Array.isArray(provider.visionModels)
      || provider.visionModels.length > 500 || provider.visionModels.some(model => typeof model !== 'string')))
    || typeof provider.enabled !== 'boolean')) throw new Error('模型服务商配置格式错误');
  if (value.workflowBinding !== undefined && (!value.workflowBinding || typeof value.workflowBinding !== 'object'
    || Array.isArray(value.workflowBinding) || Object.values(value.workflowBinding).some(id => typeof id !== 'string'))) throw new Error('模型工作流绑定格式错误');
  return migrateToDeepSeek({ providers: value.providers,
    defaultProviderId: typeof value.defaultProviderId === 'string' ? value.defaultProviderId : '', workflowBinding: value.workflowBinding || {} });
}
function readCachedLlmSettings(): LlmSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? getDefaultLlmSettings() : normalizeLlmSettings(JSON.parse(raw));
}
let cacheAtRead: string | null = null;
const llmHydration = createSettingsHydration(async () => {
  cacheAtRead = localStorage.getItem(STORAGE_KEY);
  const api = typeof window === 'undefined' ? undefined : (window as any).electronAPI?.userState;
  if (api?.loadLlm) {
    const value = await api.loadLlm();
    if (value !== null) return normalizeLlmSettings(value);
  }
  return readCachedLlmSettings();
}, value => {
  // A different window may have edited the shared cache while this read awaited IPC.
  if (localStorage.getItem(STORAGE_KEY) !== cacheAtRead) { readCachedLlmSettings(); return; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}, readCachedLlmSettings);

export const getLlmSettingsLoadState = llmHydration.getSnapshot;
export const subscribeLlmSettingsLoad = llmHydration.subscribe;
export const ensureLlmSettingsLoaded = () => llmHydration.load();
export const retryLlmSettingsLoad = () => llmHydration.load(true);

/** Model routes cannot silently use a stale desktop startup cache. */
export function readLlmSettingsForUse(): LlmSettings {
  const api = typeof window === 'undefined' ? undefined : (window as any).electronAPI?.userState;
  const status = llmHydration.getSnapshot();
  if (api?.loadLlm && status.status !== 'ready') throw new Error(status.status === 'error'
    ? '模型配置读取失败，请在设置中重新读取模型配置。' : '模型配置正在读取，请稍后重试。');
  return llmPersistence.getDraft() || readCachedLlmSettings();
}

const llmPersistence = createSettingsPersistence<LlmSettings>(s => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  llmHydration.edited();
}, saveLlmState);
export const getLlmSettingsSaveState = llmPersistence.getSnapshot;
export const subscribeLlmSettingsSave = llmPersistence.subscribe;
export const retryLlmSettingsSave = llmPersistence.retry;
export const flushLlmSettingsWrites = llmPersistence.flush;
export const hasUnsavedLlmSettings = llmPersistence.hasUnsavedChanges;
export const saveLlmSettings = llmPersistence.write;

export function getProviderById(s: LlmSettings, id: string): LlmProvider | undefined {
  return s.providers.find((p) => p.id === id && p.enabled);
}
