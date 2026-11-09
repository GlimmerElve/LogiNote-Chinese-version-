import { LlmSettings, LlmProvider } from '../types';
import { saveLlmState } from './electronUserState';
import { createSettingsHydration } from './ui/settingsHydration';
import { createSettingsPersistence } from './ui/settingsPersistence';

const STORAGE_KEY = 'loginote_llm_settings';

export function getDefaultLlmSettings(): LlmSettings {
  return { providers: [], defaultProviderId: '', workflowBinding: {} };
}

export function loadLlmSettings(): LlmSettings {
  const pending = llmPersistence.getDraft();
  if (pending) return pending;
  try { return readCachedLlmSettings(); }
  // The settings form can still open to report/retry a corrupt cache. Never
  // invent a different supplier here; authoritative hydration remains strict.
  catch { return { providers: [], defaultProviderId: '', workflowBinding: {} }; }
}

function validateWorkflowThinking(value: unknown): void {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(mode => !['default', 'off', 'low', 'medium', 'high'].includes(mode)))) throw new Error('模型工作流思考设置格式错误');
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
  validateWorkflowThinking(value.workflowThinking);
  // Stored choices are authoritative, including empty lists, disabled/deleted
  // targets and unbound workflows. Missing bindings inherit the user's default;
  // normalization must not change vendors or revive a removed provider.
  return { providers: value.providers,
    defaultProviderId: typeof value.defaultProviderId === 'string' ? value.defaultProviderId : '', workflowBinding: value.workflowBinding || {},
    ...(value.workflowThinking === undefined ? {} : { workflowThinking: value.workflowThinking }) };
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
export const saveLlmSettings = (settings: LlmSettings): Promise<void> => {
  try { validateWorkflowThinking(settings.workflowThinking); }
  catch (error) { return Promise.reject(error); }
  return llmPersistence.write(settings);
};

export function getProviderById(s: LlmSettings, id: string): LlmProvider | undefined {
  return s.providers.find((p) => p.id === id && p.enabled);
}
