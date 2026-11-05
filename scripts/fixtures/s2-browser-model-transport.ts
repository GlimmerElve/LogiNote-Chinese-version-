import { S2ModelTestSession, type S2ModelTestLimits } from '../../src/services/scene/sceneS2ModelTest';
import { browserFixtureState, notifyBrowserFixture } from './s2-browser-model';
import { validateLlmImages } from '../../src/services/llmImages';

interface SyntheticTransportControl {
  onPrepare(): void;
  onSession(): void;
  beforeResponse(signal: AbortSignal): Promise<void>;
}

/** Isolated browser boundary. No settings, real provider, network, persistent IO or actual model. */
export async function prepareS2ModelTestProvider(signal?: AbortSignal) {
  const active = () => { if (signal?.aborted) throw new DOMException('Synthetic model preparation cancelled', 'AbortError'); };
  active();
  const control = (globalThis as unknown as { __s2SyntheticTransportControl?: SyntheticTransportControl }).__s2SyntheticTransportControl;
  control?.onPrepare();
  const providerLabel = '隔离合成传输（非真实模型）', model = 'synthetic-model-test', resourceId = `SyntheticModel-${crypto.randomUUID()}`;
  let claimed = false;
  return Object.freeze({ providerLabel, model, resourceId, supportsImages: true,
    createSession(sceneId: string, runId: string, limits: S2ModelTestLimits) {
      active(); if (claimed) throw new Error('Synthetic model preparation already claimed');
      const session = new S2ModelTestSession({ sceneId, runId, resourceId, providerId: 'SyntheticProvider', providerLabel, model,
        contextWindowTokens: 32768, supportsImages: true, limits,
        invoke: async (request, options) => {
          if (options.signal.aborted) throw new DOMException('Synthetic model request cancelled', 'AbortError');
          if (request.workflow !== 'scene-model-experiment' || request.skipMemoryInjection !== true || request.skipProfileInjection !== true
            || request.model !== model || request.providerId !== 'SyntheticProvider' || request.tools?.length) throw new Error('Unexpected synthetic test request');
          const images = validateLlmImages(request.images);
          browserFixtureState.syntheticModelRequests.push({ prompt: request.systemPromptOverride!, input: request.userInput,
            maxOutputTokens: request.maxTokensOverride!, ...(images.length ? { imageIds: images.map(image => image.assetId) } : {}) });
          const requestNumber = browserFixtureState.syntheticModelRequests.length;
          notifyBrowserFixture();
          await control?.beforeResponse(options.signal);
          return { content: `合成模型回包：已接收${control ? '本次测试提交' : '用户逐次确认'}的完整提示词与输入。\n输入原文：${request.userInput}${images.length ? `\n已接收本次${control ? '测试' : '确认'}的一张原图（仅合成传输）` : ''}\n这不是实际LLM回答，不证明提示词效果或业务指标合格。${control ? `\n合成调用编号：${requestNumber}` : ''}`, diagnostics: { finishReason: 'stop' } };
        },
      });
      control?.onSession();
      claimed = true; return session;
    },
  });
}
