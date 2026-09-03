/**
 * 流式 LLM 调用 — 通过 Electron IPC 从主进程转发 SSE，返回 ReadableStream。
 * 支持 DeepSeek reasoning_content（思考过程）。
 */

import { loadLlmSettings } from './llmStorage';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { LlmCallRequest, LlmProvider, LlmWorkflowTemplate } from '../types';
import { searchNotes, buildRagContext } from './ragService';
import { buildProfilePrefix } from './profile/profileContext';

/** 需要 RAG 检索增强的工作流（复习对话场景） */
const RAG_WORKFLOWS = new Set<string>([
  'review-tutor',
  'review-scoring',
]);

export interface StreamChunk {
  type: 'reasoning' | 'content';
  text: string;
}

function resolveProvider(workflowId: string): LlmProvider | null {
  const settings = loadLlmSettings();
  const bound = (settings.workflowBinding as Record<string, string | undefined>)[workflowId];
  const pid = bound || settings.defaultProviderId;
  if (pid) {
    const p = settings.providers.find(p => p.id === pid && p.enabled);
    if (p) return p;
  }
  return settings.providers.find(p => p.enabled) || null;
}

/**
 * 流式 LLM 调用 — 返回 ReadableStream<StreamChunk>
 * 每个 chunk 标记 type: 'reasoning'（思考过程）或 'content'（最终回答）
 */
export async function callLLMStream(request: LlmCallRequest): Promise<ReadableStream<StreamChunk>> {
  const provider = resolveProvider(request.workflow);
  if (!provider) throw new Error('未找到可用的 LLM 服务商');

  const workflow: LlmWorkflowTemplate | undefined = getWorkflowById(request.workflow);
  const systemPrompt = workflow?.systemPrompt || '';
  const temperature = workflow?.defaultParams.temperature ?? 0.7;
  const maxTokens = workflow?.defaultParams.maxTokens ?? 4096;
  const model = request.model || provider.selectedModel || provider.models[0] || 'gemini-2.5-flash';

  // RAG 自动增强 + 画像上下文注入
  let userInput = request.userInput;
  const prefixes: string[] = [];
  if (RAG_WORKFLOWS.has(request.workflow) && userInput) {
    try {
      const results = await searchNotes(userInput, 3);
      const ragContext = buildRagContext(results, 3);
      if (ragContext) prefixes.push(ragContext);
    } catch (e: any) {
      console.warn('[rag] 流式检索增强失败，使用原始输入:', e?.message);
    }
  }
  const profilePrefix = buildProfilePrefix(request.workflow);
  if (profilePrefix) prefixes.push(profilePrefix);
  if (prefixes.length > 0) {
    userInput = `${prefixes.join('\n\n')}\n\n【用户当前输入】\n${request.userInput}`;
  }

  const api = (window as any).electronAPI?.llm;
  if (!api) {
    throw new Error('当前环境不支持 IPC 调用（仅桌面版可用）');
  }

  const streamId: string = await api.stream({
    provider: {
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
    outputSchema: workflow?.outputSchema,
    tools: request.tools,
    messages: request.messages,
  });

  return new ReadableStream<StreamChunk>({
    start(controller) {
      const offChunk = api.onChunk((payload: { streamId: string; chunk: unknown }) => {
        if (payload.streamId !== streamId) return;
        const c = payload.chunk as StreamChunk;
        controller.enqueue(c);
      });
      const offEnd = api.onEnd((payload: { streamId: string }) => {
        if (payload.streamId !== streamId) return;
        offChunk();
        offEnd();
        offError();
        controller.close();
      });
      const offError = api.onError((payload: { streamId: string; message: string }) => {
        if (payload.streamId !== streamId) return;
        offChunk();
        offEnd();
        offError();
        controller.error(new Error(payload.message || '流式请求失败'));
      });
    },
    cancel() {
      // 取消时由主进程流自然结束；无显式取消接口，保持幂等
    },
  });
}

/**
 * 便捷方法：收集流式响应并分别返回思考和内容
 */
export async function collectStreamResponse(stream: ReadableStream<StreamChunk>): Promise<{ reasoning: string; content: string }> {
  const reader = stream.getReader();
  let reasoning = '';
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'reasoning') {
        reasoning += value.text;
      } else {
        content += value.text;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { reasoning, content };
}