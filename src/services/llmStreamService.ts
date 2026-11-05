/**
 * 流式 LLM 调用 — 通过 Electron IPC 从主进程转发 SSE，返回 ReadableStream。
 */

import { readLlmSettingsForUse, ensureLlmSettingsLoaded, flushLlmSettingsWrites } from './llmStorage';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { LlmCallRequest, LlmProvider, LlmResponseDiagnostics, LlmWorkflowTemplate } from '../types';
import { buildCallContext } from './llmContext';
import { assembleMemoryContext, type MemoryContextAssembly } from './memory/memoryContextBuilder';
import { requireLlmModel } from './llmModelSelection';
import { assertLlmProviderEnabled, selectLlmProvider } from './llmProviderSelection';

export interface StreamChunk {
  type: 'content' | 'diagnostics';
  text: string;
  diagnostics?: LlmResponseDiagnostics;
}

function resolveProvider(workflowId: string): LlmProvider | null {
  const settings = readLlmSettingsForUse();
  return selectLlmProvider(settings, workflowId);
}

/**
 * 流式 LLM 调用 — 返回 ReadableStream<StreamChunk>
 * 每个 chunk 标记 type: 'content'（最终回答）
 */
export async function callLLMStream(
  request: LlmCallRequest,
  options?: {
    onMemoryAssembled?: (memory: MemoryContextAssembly) => void;
    signal?: AbortSignal;
    /** Domain text streams may opt out of the workflow's JSON format without changing other calls. */
    outputSchema?: object | null;
    /** Explicit scoped budgets; existing stream callers retain workflow defaults. */
    maxTokens?: number;
    temperature?: number;
  },
): Promise<ReadableStream<StreamChunk>> {
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  await ensureLlmSettingsLoaded();
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  const provider = resolveProvider(request.workflow);
  if (!provider) throw new Error('工作流绑定或默认模型供应商不可用，请在设置中重新启用或选择供应商。');

  const workflow: LlmWorkflowTemplate | undefined = getWorkflowById(request.workflow);
  const systemPrompt = request.systemPromptOverride || workflow?.systemPrompt || '';
  const temperature = options?.temperature ?? workflow?.defaultParams.temperature ?? 0.7;
  const maxTokens = options?.maxTokens ?? workflow?.defaultParams.maxTokens ?? 4096;
  const model = requireLlmModel(provider, request.model);
  const providerHost = (() => {
    try { return new URL(provider.baseUrl).hostname.toLocaleLowerCase(); } catch { return ''; }
  })();
  const thinkingMode = provider.apiType === 'openai-compatible'
    && (providerHost === 'deepseek.com' || providerHost.endsWith('.deepseek.com'))
    ? request.thinkingMode
    : undefined;

  // 调用方短上下文与长期记忆分层拼装；评分/证据工作流没有配方，保持盲评。
  const callContext = buildCallContext(request.context);
  const baseUserInput = callContext
    ? `${callContext}\n\n【用户当前输入】\n${request.userInput}`
    : request.userInput;
  const memory = request.skipMemoryInjection
    ? undefined
    : await assembleMemoryContext({
        workflow: request.workflow,
        query: baseUserInput,
        skipProfile: request.skipProfileInjection,
      });
  if (memory) options?.onMemoryAssembled?.(memory);
  const userInput = memory?.prefix ? `${memory.prefix}\n\n${baseUserInput}` : baseUserInput;
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');

  const api = (window as any).electronAPI?.llm;
  if (!api) {
    throw new Error('当前环境不支持 IPC 调用（仅桌面版可用）');
  }

  await flushLlmSettingsWrites();
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  assertLlmProviderEnabled(readLlmSettingsForUse(), provider.id);
  const streamId: string = await api.stream({
    provider: {
      id: provider.id,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      selectedModel: model,
      models: provider.models,
    },
    systemPrompt,
    userInput,
    temperature,
    maxTokens,
    outputSchema: options?.outputSchema === null ? undefined : options?.outputSchema ?? workflow?.outputSchema,
    tools: request.tools,
    messages: request.messages,
    agentMessages: request.agentMessages,
    thinkingMode,
  });
  if (options?.signal?.aborted) {
    await api.cancel(streamId);
    throw new DOMException('请求已停止', 'AbortError');
  }

  let cleanup = () => {};
  let settled = false;
  return new ReadableStream<StreamChunk>({
    start(controller) {
      const offChunk = api.onChunk((payload: { streamId: string; chunk: unknown }) => {
        if (payload.streamId !== streamId) return;
        const c = payload.chunk as StreamChunk;
        controller.enqueue(c);
      });
      const offEnd = api.onEnd((payload: { streamId: string }) => {
        if (payload.streamId !== streamId) return;
        if (settled) return;
        settled = true;
        cleanup();
        controller.close();
      });
      const offError = api.onError((payload: { streamId: string; message: string; cancelled?: boolean }) => {
        if (payload.streamId !== streamId) return;
        if (settled) return;
        settled = true;
        cleanup();
        controller.error(payload.cancelled
          ? new DOMException('请求已停止', 'AbortError')
          : new Error(payload.message || '流式请求失败'));
      });
      const abortStream = () => {
        if (settled) return;
        settled = true;
        cleanup();
        void api.cancel(streamId);
        controller.error(new DOMException('请求已停止', 'AbortError'));
      };
      cleanup = () => {
        offChunk();
        offEnd();
        offError();
        options?.signal?.removeEventListener('abort', abortStream);
      };
      options?.signal?.addEventListener('abort', abortStream, { once: true });
    },
    cancel() {
      if (!settled) {
        settled = true;
        cleanup();
      }
      return api.cancel(streamId).then(() => undefined);
    },
  });
}

/**
 * 便捷方法：收集流式响应并返回内容
 */
export async function collectStreamResponse(stream: ReadableStream<StreamChunk>): Promise<{ content: string; diagnostics?: LlmResponseDiagnostics }> {
  const reader = stream.getReader();
  let content = '';
  let diagnostics: LlmResponseDiagnostics | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'diagnostics') diagnostics = value.diagnostics;
      else content += value.text;
    }
  } finally {
    reader.releaseLock();
  }

  return { content, diagnostics };
}
