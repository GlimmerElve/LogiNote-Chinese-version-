import type { LlmProvider } from '../../types';
import { S2ModelTestSession, type S2ModelTestLimits } from './sceneS2ModelTest';
import { supportsImageInput } from '../llmImages';

/** Exact existing llmService transport gate, not an inferred model capability or a remote probe. */
export function supportsS2ThinkingControl(provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>): boolean {
  let host = ''; try { host = new URL(provider.baseUrl).hostname.toLocaleLowerCase(); } catch { return false; }
  return provider.apiType === 'openai-compatible' && (host === 'deepseek.com' || host.endsWith('.deepseek.com'));
}

/** Only an explicit user preparation reads configuration; never probes, changes settings or sends a request. */
export async function prepareS2ModelTestProvider(signal?: AbortSignal): Promise<{
  providerLabel: string; model: string; resourceId: string; supportsImages: boolean; supportsThinking?: boolean;
  createSession: (sceneId: string, runId: string, limits: S2ModelTestLimits) => S2ModelTestSession;
}> {
  const checkActive = () => { if (signal?.aborted) throw new DOMException('模型测试准备已取消', 'AbortError'); };
  checkActive();
  let loaded: { provider: LlmProvider | null; callLLM: typeof import('../llmService')['callLLM'] };
  try {
    const { ensureLlmSettingsLoaded } = await import('../llmStorage');
    checkActive(); await ensureLlmSettingsLoaded(); checkActive();
    const { resolveProvider, callLLM } = await import('../llmService');
    checkActive(); loaded = { provider: resolveProvider('scene-model-experiment'), callLLM };
  } catch {
    checkActive(); throw new Error('无法准备场景实验模型配置；未建立授权或发送请求，请检查本地模型设置');
  }
  const { provider, callLLM } = loaded;
  if (!provider || !provider.enabled) throw new Error('未配置可用的场景实验模型；未建立授权或发送请求');
  const configuredModel = typeof provider.selectedModel === 'string' && provider.selectedModel.trim() ? provider.selectedModel
    : Array.isArray(provider.models) ? provider.models.find(model => typeof model === 'string' && model.trim()) : undefined;
  if (typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.name !== 'string' || !provider.name.trim() || !configuredModel) throw new Error('场景实验模型配置不完整；不猜测服务商或新模型');
  if ([provider.id, provider.name, configuredModel].some(value => value.length > 200 || /[\u0000-\u001f]/u.test(value))) throw new Error('场景实验模型名称或标识格式无效；未建立授权');
  const frozen: LlmProvider = structuredClone(provider);
  Object.freeze(frozen.models); if (frozen.visionModels) Object.freeze(frozen.visionModels); Object.freeze(frozen);
  const resourceId = `model-test-${crypto.randomUUID()}`, providerLabel = frozen.name, model = configuredModel;
  let claimed = false;
  const supportsImages = supportsImageInput(frozen, model);
  const supportsThinking = supportsS2ThinkingControl(frozen);
  return Object.freeze({ providerLabel, model, resourceId, supportsImages, supportsThinking,
    createSession(sceneId: string, runId: string, limits: S2ModelTestLimits) {
      checkActive();
      if (claimed) throw new Error('此模型测试准备已用于建立会话，不能重新创建以重置预算');
      const session = new S2ModelTestSession({ sceneId, runId, resourceId, providerId: frozen.id, providerLabel, model,
        contextWindowTokens: frozen.contextWindowTokens, supportsImages, supportsThinking, limits,
        invoke: (request, options) => callLLM(request, { signal: options.signal, providerSnapshot: frozen }) });
      claimed = true; return session;
    },
  });
}
