import {
  LlmCallRequest,
  LlmCallResponse,
  LlmProvider,
  LlmWorkflowTemplate,
  LlmTool,
  ChatMessage,
} from '../types';
import { loadLlmSettings } from './llmStorage';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { searchNotes, buildRagContext } from './ragService';
import { buildProfilePrefix } from './profile/profileContext';
import { sanitizeUnicode, sanitizeUnicodeDeep } from './unicode';

/** LLM 服务端返回 HTTP 非 2xx（如 402 余额不足、403 鉴权失败、429 限流）时抛出的可辨识错误 */
export class LlmHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

/** 需要 RAG 检索增强的工作流（学习场景：复习/心流分析/问题解答） */
const RAG_WORKFLOWS = new Set<string>([
  'review-questioning',
  'review-tutor',
  'review-scoring',
  'flow-analysis',
  'question-answer',
]);

/**
 * Resolve the effective provider for a given workflow using settings binding.
 * Falls back to first enabled provider if none bound.
 */
export function resolveProvider(workflowId: string): LlmProvider | null {
  const settings = loadLlmSettings();
  const boundProviderId = settings.workflowBinding[workflowId as 'plan-generation' | 'text-segmentation' | 'auto-link' | 'flow-analysis'];
  const providerId = boundProviderId || settings.defaultProviderId;
  if (providerId) {
    const provider = settings.providers.find(p => p.id === providerId && p.enabled);
    if (provider) return provider;
  }
  // Fallback: first enabled provider
  return settings.providers.find(p => p.enabled) || null;
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
  systemPrompt = sanitizeUnicode(systemPrompt);
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
          ...(outputSchema ? { response_format: { type: 'json_object' } } : {}),
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
          generationConfig: { temperature, maxOutputTokens: maxTokens },
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
export async function callLLM(request: LlmCallRequest): Promise<LlmCallResponse> {
  const provider = resolveProvider(request.workflow);
  if (!provider) {
    throw new Error('未找到可用的 LLM 服务商，请在设置中配置并启用至少一个。');
  }

  const workflow: LlmWorkflowTemplate | undefined = getWorkflowById(request.workflow);
  const systemPrompt = workflow?.systemPrompt || '';
  const temperature = workflow?.defaultParams.temperature ?? 0.7;
  const maxTokens = workflow?.defaultParams.maxTokens ?? 4096;

  // RAG 自动增强 + 画像上下文注入（失败静默回退）
  let userInput = request.userInput;
  const prefixes: string[] = [];
  if (RAG_WORKFLOWS.has(request.workflow) && userInput) {
    try {
      const results = await searchNotes(userInput, 3);
      const ragContext = buildRagContext(results, 3);
      if (ragContext) prefixes.push(ragContext);
    } catch (e: any) {
      console.warn('[rag] 检索增强失败，使用原始输入:', e?.message);
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

  const model = request.model || provider.selectedModel || provider.models[0] || 'gemini-2.5-flash';
  const resp = await api.request({
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

  return resp as LlmCallResponse;
}

/** 构造探活 URL（各家官方列表端点，不消耗推理 token） */
function buildProbeUrl(provider: LlmProvider): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  switch (provider.apiType) {
    case 'openai-compatible':
      return `${base}/models`;
    case 'anthropic':
      return `${base}/models`;
    case 'gemini': {
      const key = provider.apiKey || '';
      return `${base}/v1beta/models?key=${encodeURIComponent(key)}`;
    }
    case 'ollama':
      return `${base}/api/tags`;
    default:
      return `${base}/models`;
  }
}

/** 构造探活请求头 */
function buildProbeHeaders(provider: LlmProvider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  switch (provider.apiType) {
    case 'openai-compatible':
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
      break;
    case 'anthropic':
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    default:
      break;
  }
  return headers;
}

/**
 * 探活某服务商：调用官方模型列表端点，HTTP 200 即视为「网络可达 + key 有效」。
 * 不消耗推理 token；短超时（8s）避免假死拖长。
 */
export async function probeLlmProvider(provider: LlmProvider): Promise<boolean> {
  const api = (window as any).electronAPI?.llm;
  if (!api) return false;
  const model = provider.selectedModel || provider.models[0] || 'gemini-2.5-flash';
  try {
    return await api.probe({
      provider: {
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
  } catch {
    return false;
  }
}

/**
 * 按某个 workflow 解析其服务商并探活；未找到服务商直接判 false。
 */
export async function probeLlmConnection(workflowId: string): Promise<boolean> {
  const provider = resolveProvider(workflowId);
  if (!provider) return false;
  return probeLlmProvider(provider);
}
