import {
  LlmCallRequest,
  LlmCallResponse,
  LlmProvider,
  LlmWorkflowTemplate,
  LlmWorkflowId,
  LlmTool,
  ChatMessage,
} from '../types';
import { readLlmSettingsForUse, ensureLlmSettingsLoaded, flushLlmSettingsWrites } from './llmStorage';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { sanitizeUnicode, sanitizeUnicodeDeep } from './unicode';
import { buildCallContext } from './llmContext';
import { assembleMemoryContext, type MemoryContextAssembly } from './memory/memoryContextBuilder';
import { ensureJsonObjectPrompt, requestsJsonObject } from '../workflows/structuredOutput';
import { fitSceneContextBudget } from './scene/sceneContextBudget';
import { requireLlmModel } from './llmModelSelection';
import { assertLlmProviderEnabled, selectLlmProvider } from './llmProviderSelection';

/** LLM 服务端返回 HTTP 非 2xx（如 402 余额不足、403 鉴权失败、429 限流）时抛出的可辨识错误 */
export class LlmHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

/**
 * Resolve the effective provider for a given workflow using settings binding.
 * A disabled or removed explicit binding/default is unavailable, never a fallback route.
 */
export function resolveProvider(workflowId: string): LlmProvider | null {
  const settings = readLlmSettingsForUse();
  return selectLlmProvider(settings, workflowId);
}

/**
 * Build the request URL for a provider.
 */
function buildUrl(provider: LlmProvider): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  switch (provider.apiType) {
    case 'openai-compatible':
      return `${base}/chat/completions`;
    case 'anthropic':
      return `${base}/messages`;
    case 'gemini':
      return `${base}/models/${provider.selectedModel || 'gemini-2.5-flash'}:generateContent?key=${encodeURIComponent(provider.apiKey || '')}`;
    case 'ollama':
      return `${base}/api/chat`;
    default:
      return `${base}/chat/completions`;
  }
}

/**
 * Build the request body for the target API.
 */
function buildBody(
  provider: LlmProvider,
  model: string,
  systemPrompt: string,
  userInput: string,
  temperature: number,
  maxTokens: number,
  outputSchema?: object,
  tools?: LlmTool[],
  historyMessages?: ChatMessage[],
): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // 兜底：清除孤立 UTF-16 代理项，避免 DeepSeek/Go 后端 JSON 解析 400
  systemPrompt = sanitizeUnicode(ensureJsonObjectPrompt(systemPrompt, outputSchema));
  userInput = sanitizeUnicode(userInput);
  historyMessages = sanitizeUnicodeDeep(historyMessages);

  switch (provider.apiType) {
    case 'openai-compatible': {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
      const messages: { role: string; content: string }[] = [
        { role: 'system', content: systemPrompt },
      ];
      if (historyMessages && historyMessages.length > 0) {
        for (const msg of historyMessages) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
          ...(requestsJsonObject(outputSchema) ? { response_format: { type: 'json_object' } } : {}),
        }),
        headers,
      };
    }

    case 'anthropic': {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      let combinedUserInput = userInput;
      if (historyMessages && historyMessages.length > 0) {
        const historyText = historyMessages
          .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
          .join('\n');
        combinedUserInput = `${historyText}\n用户: ${userInput}`;
      }
      return {
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: combinedUserInput }],
          max_tokens: maxTokens,
          temperature,
        }),
        headers,
      };
    }

    case 'gemini': {
      let combinedInput = `${systemPrompt}\n\n`;
      if (historyMessages && historyMessages.length > 0) {
        const historyText = historyMessages
          .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
          .join('\n');
        combinedInput += `${historyText}\n`;
      }
      combinedInput += `用户输入：${userInput}`;
      return {
        body: JSON.stringify({
          contents: [{ parts: [{ text: combinedInput }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(requestsJsonObject(outputSchema) ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        headers,
      };
    }

    case 'ollama': {
      const messages: { role: string; content: string }[] = [
        { role: 'system', content: systemPrompt },
      ];
      if (historyMessages && historyMessages.length > 0) {
        for (const msg of historyMessages) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: { temperature, num_predict: maxTokens },
          ...(requestsJsonObject(outputSchema) ? { format: 'json' } : {}),
        }),
        headers,
      };
    }

    default:
      throw new Error(`Unsupported API type: ${provider.apiType}`);
  }
}

/**
 * Parse response from different API types into unified format.
 */
function parseResponse(data: any, apiType: LlmProvider['apiType']): { content: string; usage?: LlmCallResponse['usage'] } {
  switch (apiType) {
    case 'openai-compatible':
      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage
          ? { promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0 }
          : undefined,
      };

    case 'anthropic':
      return {
        content: data.content?.[0]?.text || '',
        usage: data.usage
          ? { promptTokens: data.usage.input_tokens || 0, completionTokens: data.usage.output_tokens || 0 }
          : undefined,
      };

    case 'gemini':
      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
        usage: data.usageMetadata
          ? {
              promptTokens: data.usageMetadata.promptTokenCount || 0,
              completionTokens: data.usageMetadata.candidatesTokenCount || 0,
            }
          : undefined,
      };

    case 'ollama':
      return {
        content: data.message?.content || '',
        usage: data.prompt_eval_count !== undefined
          ? { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 }
          : undefined,
      };

    default:
      return { content: '' };
  }
}

/**
 * Universal LLM call — routes to the correct API based on provider config.
 * Tries direct browser → API first; falls back to /api/ai/proxy for CORS bypass.
 */
export async function callLLM(
  request: LlmCallRequest,
  options?: {
    onMemoryAssembled?: (memory: MemoryContextAssembly) => void;
    signal?: AbortSignal;
    /** Trusted approval-bound callers can pin their in-memory provider for this call.
     * Not part of model/user input; ordinary workflows continue resolving settings. */
    providerSnapshot?: LlmProvider;
  },
): Promise<LlmCallResponse> {
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  await ensureLlmSettingsLoaded();
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  const provider = options?.providerSnapshot ? structuredClone(options.providerSnapshot) : resolveProvider(request.workflow);
  if (!provider) {
    throw new Error('工作流绑定或默认模型供应商不可用，请在设置中重新启用或选择供应商。');
  }
  assertLlmProviderEnabled(readLlmSettingsForUse(), provider.id);

  const workflow: LlmWorkflowTemplate | undefined = getWorkflowById(request.workflow);
  const systemPrompt = request.systemPromptOverride || workflow?.systemPrompt || '';
  const temperature = request.temperatureOverride === undefined ? workflow?.defaultParams.temperature ?? 0.7
    : Math.max(0, Math.min(2, request.temperatureOverride));
  const configuredMaxTokens = workflow?.defaultParams.maxTokens ?? 4096;
  const maxTokens = request.maxTokensOverride === undefined
    ? configuredMaxTokens
    : Math.max(256, Math.min(request.workflow === 'document-knowledge-extract' ? 65536 : 32768, Math.round(request.maxTokensOverride)));

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
  const memoryPrefix = memory?.prefix || '';
  const userInput = memoryPrefix ? `${memoryPrefix}\n\n${baseUserInput}` : baseUserInput;
  const sceneBudget = fitSceneContextBudget({ ...request, context: undefined, userInput }, {
    provider, systemPrompt, maxOutputTokens: maxTokens, outputSchema: request.outputSchema ?? workflow?.outputSchema,
  });
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');

  const api = (window as any).electronAPI?.llm;
  if (!api) {
    throw new Error('当前环境不支持 IPC 调用（仅桌面版可用）');
  }

  const model = requireLlmModel(provider, request.model);
  await flushLlmSettingsWrites();
  if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
  assertLlmProviderEnabled(readLlmSettingsForUse(), provider.id);
  const providerHost = (() => {
    try { return new URL(provider.baseUrl).hostname.toLocaleLowerCase(); } catch { return ''; }
  })();
  const thinkingMode = provider.apiType === 'openai-compatible'
    && (providerHost === 'deepseek.com' || providerHost.endsWith('.deepseek.com'))
    ? request.thinkingMode
    : undefined;
  const requestId = `llm-request-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const cancelRequest = () => { void api.cancel?.(requestId); };
  options?.signal?.addEventListener('abort', cancelRequest, { once: true });
  let resp: unknown;
  try {
    resp = await api.request({
      requestId,
      provider: {
        id: provider.id,
        apiType: provider.apiType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        selectedModel: model,
        models: provider.models,
        visionModels: provider.visionModels,
      },
      systemPrompt,
      userInput: sceneBudget.request.userInput,
      images: request.images,
      temperature,
      maxTokens: Math.min(maxTokens, sceneBudget.diagnostics?.outputReserveTokens ?? maxTokens),
      outputSchema: request.outputSchema ?? workflow?.outputSchema,
      tools: request.tools,
      messages: sceneBudget.request.messages,
      agentMessages: sanitizeUnicodeDeep(request.agentMessages),
      thinkingMode,
      ...(request.workflow === 'document-knowledge-extract' && request.timeoutMsOverride
        ? {timeoutMs:Math.max(180000, Math.min(900000, request.timeoutMsOverride))} : {}),
    });
  } catch (error) {
    if (options?.signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
    throw error;
  } finally {
    options?.signal?.removeEventListener('abort', cancelRequest);
  }

  const response = resp as LlmCallResponse;
  return sceneBudget.diagnostics ? { ...response, diagnostics: { ...response.diagnostics, sceneContextBudget: sceneBudget.diagnostics } } : response;
}

/** Confirm a short generation by the selected model; the test uses a small token budget. */
export async function probeLlmProvider(provider: LlmProvider): Promise<boolean> {
  const api = (window as any).electronAPI?.llm;
  if (!api) return false;
  try {
    await ensureLlmSettingsLoaded();
    await flushLlmSettingsWrites();
    assertLlmProviderEnabled(readLlmSettingsForUse(), provider.id);
    const model = requireLlmModel(provider);
    const result = await api.probe({
      provider: {
        id: provider.id,
        apiType: provider.apiType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        selectedModel: model,
        models: provider.models,
      },
      systemPrompt: '',
      userInput: '',
      temperature: 0,
      maxTokens: 10,
    });
    return typeof result === 'boolean' ? result : result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * 按某个 workflow 解析其服务商并探活；未找到服务商直接判 false。
 */
export async function probeLlmConnection(workflowId: string): Promise<boolean> {
  await ensureLlmSettingsLoaded();
  const provider = resolveProvider(workflowId);
  if (!provider) return false;
  return probeLlmProvider(provider);
}
