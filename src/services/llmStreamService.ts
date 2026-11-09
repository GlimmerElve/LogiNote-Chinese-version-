/**
 * 流式 LLM 调用 — 通过 Electron IPC 从主进程转发 SSE，返回 ReadableStream。
 */

import { readLlmSettingsForUse, ensureLlmSettingsLoaded, flushLlmSettingsWrites } from './llmStorage';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { LlmCallRequest, LlmProvider, LlmResponseDiagnostics, LlmToolCall, LlmWorkflowTemplate } from '../types';
import { buildCallContext } from './llmContext';
import { assembleMemoryContext, type MemoryContextAssembly } from './memory/memoryContextBuilder';
import { requireLlmModel } from './llmModelSelection';
import { assertLlmProviderEnabled, selectLlmProvider, describeLlmProviderUnavailable } from './llmProviderSelection';
import { manualThinkingTimeoutMs, resolveLlmThinkingPolicy, workflowThinkingPreference } from './llmThinkingPolicy';
import { resolveLlmOutputBudget } from './llmOutputBudget';
import type { LlmStreamTimeoutPolicy } from '../electron/ipcTypes';

export interface StreamChunk {
  type: 'content' | 'diagnostics' | 'activity' | 'response';
  text: string;
  diagnostics?: LlmResponseDiagnostics;
  /** Phase metadata only; never a provider's reasoning text. */
  activity?: { phase: 'reasoning' | 'responding' };
  /** Completed response metadata only; partial arguments and raw reasoning never cross this boundary. */
  toolCalls?: LlmToolCall[];
  toolContinuationId?: string;
}

function resolveProvider(workflowId: string): LlmProvider | null {
  const settings = readLlmSettingsForUse();
  return selectLlmProvider(settings, workflowId);
}

/**
 * 流式 LLM 调用 — 返回 ReadableStream<StreamChunk>
 * 仅 content 事件含可显示正文；response 是完整工具调用与不透明接续元数据，
 * 由调用方显式处理，本层不会执行工具。
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
    streamTimeout?: LlmStreamTimeoutPolicy;
    includeActivity?: boolean;
  },
): Promise<ReadableStream<StreamChunk>> {
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  await ensureLlmSettingsLoaded();
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  const workflow: LlmWorkflowTemplate | undefined = getWorkflowById(request.workflow);
  const provider = resolveProvider(request.workflow);
  if (!provider) throw new Error(describeLlmProviderUnavailable(readLlmSettingsForUse(), request.workflow, workflow?.name));

  const systemPrompt = request.systemPromptOverride || workflow?.systemPrompt || '';
  const temperature = options?.temperature ?? workflow?.defaultParams.temperature ?? 0.7;
  const model = requireLlmModel(provider, request.model);
  const thinkingPreference = workflowThinkingPreference(readLlmSettingsForUse(), request.workflow, request.thinkingPreference);
  const maxTokens = resolveLlmOutputBudget(provider, model, options?.maxTokens ?? workflow?.defaultParams.maxTokens ?? 4096, request.tokenBudgetMode, thinkingPreference);
  const thinkingPolicy = resolveLlmThinkingPolicy(provider, model, request.thinkingMode, thinkingPreference);
  const manualTimeout = manualThinkingTimeoutMs(provider, model, thinkingPreference);
  const streamTimeout = options?.streamTimeout ?? (manualTimeout ? { firstResponseMs: 180000, idleMs: 90000, totalMs: manualTimeout } : undefined);

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
    tokenBudgetMode: 'total',
    outputSchema: options?.outputSchema === null ? undefined : options?.outputSchema ?? workflow?.outputSchema,
    tools: request.tools,
    messages: request.messages,
    agentMessages: request.agentMessages,
    ...thinkingPolicy,
    thinkingPreference,
    ...(streamTimeout ? { streamTimeout } : {}),
    ...(options?.includeActivity ? { includeActivity: true } : {}),
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
        if (c.type === 'activity' && !options?.includeActivity) return;
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
export async function collectStreamResponse(stream: ReadableStream<StreamChunk>): Promise<{
  content: string; diagnostics?: LlmResponseDiagnostics; toolCalls?: LlmToolCall[]; toolContinuationId?: string;
}> {
  const reader = stream.getReader();
  let content = '';
  let diagnostics: LlmResponseDiagnostics | undefined;
  let toolCalls: LlmToolCall[] | undefined;
  let toolContinuationId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'diagnostics') diagnostics = value.diagnostics;
      else if (value.type === 'content') content += value.text;
      else if (value.type === 'response') {
        if (value.toolCalls?.length) toolCalls = value.toolCalls;
        if (value.toolContinuationId) toolContinuationId = value.toolContinuationId;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, diagnostics, ...(toolCalls ? { toolCalls } : {}), ...(toolContinuationId ? { toolContinuationId } : {}) };
}
