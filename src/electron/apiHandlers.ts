import {
  LlmIpcRequest,
  LlmIpcResponse,
  LlmModelDiscoveryResponse,
  LlmProbeResponse,
  StreamChunkIpc,
  AutoLinkIpcRequest,
} from './ipcTypes';
import type { ChatMessage, LlmConversationMessage, LlmResponseDiagnostics, LlmTool, LlmToolCall } from '../types';
import { sanitizeUnicode } from '../services/unicode';
import { ensureJsonObjectPrompt, requestsJsonObject } from '../workflows/structuredOutput';
import { safeLlmHttpError, readSafeLlmHttpFailure } from '../services/llmHttpFailure';
import { requireLlmModel } from '../services/llmModelSelection';
import { autoLinkMarkdown } from '../services/markdownAutoLink';
import { imageParts, imageInputRejected, supportsImageInput, validateLlmImages } from '../services/llmImages.ts';
import { createLlmStreamTimeout, normalizeLlmStreamTimeoutPolicy, LlmStreamTimeoutError } from './llmStreamTimeout';
import { effectiveThinkingLevel, isGlm53ThinkingProvider, manualThinkingTimeoutMs, resolveLlmThinkingPolicy } from '../services/llmThinkingPolicy';
import { resolveLlmOutputBudget } from '../services/llmOutputBudget';
import { retainLlmToolContinuation, resolveLlmToolContinuation, prepareLlmToolHistory, type LlmContinuationScope } from './llmToolContinuations';
import { LlmStreamToolCalls, strictToolArguments, ollamaAgentMessages, isCompleteLlmToolFinishReason, validateLlmStreamToolCalls } from './llmStreamToolCalls';

/**
 * 原 server.ts 的 API 逻辑，迁入 Electron 主进程后通过 IPC 调用。
 * - proxyLlmRequest / streamLlmRequest：通用 LLM 转发（无浏览器 CORS 限制）
 * - autoLink：本地自动关联服务
 */

type ApiType = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

// Direct main-process callers need the same provider adaptation as renderer calls.
// Preserve their existing explicit settings outside the verified model policy.
function requestThinkingPolicy(req: LlmIpcRequest, model: string) {
  if (req.thinkingPreference !== undefined && !['default', 'off', 'low', 'medium', 'high'].includes(req.thinkingPreference)) {
    throw new Error('思考模式设置无效。');
  }
  const policy = resolveLlmThinkingPolicy(req.provider, model, req.thinkingMode, req.thinkingPreference);
  const manual = req.thinkingPreference && effectiveThinkingLevel(req.provider, model, req.thinkingPreference) !== undefined;
  const reasoningEffort = manual ? policy.reasoningEffort : policy.reasoningEffort ?? req.reasoningEffort;
  if (reasoningEffort !== undefined && !['low', 'high', 'max'].includes(reasoningEffort)) {
    throw new Error('模型思考强度参数无效。');
  }
  return { thinkingMode: policy.thinkingMode ?? req.thinkingMode, reasoningEffort };
}

function createRequestSignal(externalSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}

/** 构建各 API 类型的请求目标地址 */
function buildUrl(apiType: ApiType, baseUrl: string, model: string, apiKey: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  switch (apiType) {
    case 'openai-compatible':
      return `${base}/chat/completions`;
    case 'anthropic':
      return `${base}/messages`;
    case 'gemini':
      return `${base}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${encodeURIComponent(apiKey || '')}`;
    case 'ollama':
      return `${base}/api/chat`;
    default:
      return `${base}/chat/completions`;
  }
}

/** 解析统一格式的内容 + usage */
function parseContent(apiType: ApiType, data: any): { content: string; usage?: { promptTokens: number; completionTokens: number } } {
  switch (apiType) {
    case 'openai-compatible':
      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage ? { promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0 } : undefined,
      };
    case 'anthropic':
      return {
        content: (data.content || []).filter((item: any) => item?.type === 'text').map((item: any) => item.text || '').join(''),
        usage: data.usage ? { promptTokens: data.usage.input_tokens || 0, completionTokens: data.usage.output_tokens || 0 } : undefined,
      };
    case 'gemini':
      return {
        content: (data.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join(''),
        usage: data.usageMetadata ? { promptTokens: data.usageMetadata.promptTokenCount || 0, completionTokens: data.usageMetadata.candidatesTokenCount || 0 } : undefined,
      };
    case 'ollama':
      return {
        content: data.message?.content || '',
        usage: data.prompt_eval_count !== undefined ? { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 } : undefined,
      };
    default:
      return { content: '' };
  }
}

/** 只保留定位空响应所需的非敏感元数据，不记录提示词、正文或思维链。 */
export function parseResponseDiagnostics(apiType: ApiType, data: any): LlmResponseDiagnostics | undefined {
  let diagnostics: LlmResponseDiagnostics;
  if (apiType === 'openai-compatible') {
    const choice = data?.choices?.[0];
    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
    diagnostics = {
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      reasoningTokens: Number.isFinite(reasoningTokens) ? Number(reasoningTokens) : undefined,
      hadReasoningContent: Boolean(choice?.message?.reasoning_content),
      responseModel: typeof data?.model === 'string' ? data.model : undefined,
    };
  } else if (apiType === 'anthropic') {
    diagnostics = {
      finishReason: typeof data?.stop_reason === 'string' ? data.stop_reason : undefined,
      responseModel: typeof data?.model === 'string' ? data.model : undefined,
    };
  } else if (apiType === 'gemini') {
    diagnostics = {
      finishReason: typeof data?.candidates?.[0]?.finishReason === 'string' ? data.candidates[0].finishReason : undefined,
      responseModel: typeof data?.modelVersion === 'string' ? data.modelVersion : undefined,
    };
  } else {
    diagnostics = {
      finishReason: typeof data?.done_reason === 'string' ? data.done_reason : undefined,
      responseModel: typeof data?.model === 'string' ? data.model : undefined,
    };
  }
  return Object.values(diagnostics).some((value) => value !== undefined) ? diagnostics : undefined;
}

function asArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Keep only protocol-complete tool exchanges before serializing provider messages.
 * A tool result is valid only when it immediately belongs to an assistant tool_calls
 * message. History trimming, legacy sessions or interrupted approvals can otherwise
 * leave an orphan `role=tool`, which strict OpenAI-compatible gateways reject.
 */
export function normalizeAgentConversationMessages(
  messages: LlmConversationMessage[],
): LlmConversationMessage[] {
  const normalized: LlmConversationMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      normalized.push(message);
      continue;
    }

    const declaredCalls = message.toolCalls.filter((call) => Boolean(call.id && call.name));
    const resultsById = new Map<string, LlmConversationMessage>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      const result = messages[cursor];
      const callId = result.toolCallId || '';
      if (callId && !resultsById.has(callId)) resultsById.set(callId, result);
      cursor += 1;
    }
    const completedCalls = declaredCalls.filter((call) => resultsById.has(call.id));
    if (completedCalls.length > 0) {
      normalized.push({ ...message, toolCalls: completedCalls });
      for (const call of completedCalls) normalized.push(resultsById.get(call.id)!);
    } else if (message.content.trim()) {
      normalized.push({ role: 'assistant', content: message.content });
    }
    index = cursor - 1;
  }
  return normalized;
}

/** 将四类供应商的工具调用响应归一为应用内部结构。 */
export function parseToolCalls(apiType: ApiType, data: any, strict = false): LlmToolCall[] {
  const argumentsOf = (value: unknown) => strict ? strictToolArguments(value === undefined ? {} : value) : asArguments(value);
  const list = (value: any): any[] => {
    if (strict && (!Array.isArray(value) || value.length > 256)) throw Error('流式工具调用不完整或参数格式无效，未执行工具。');
    return value;
  };
  const idOf = (value: any, index: number) => strict && ['openai-compatible', 'anthropic'].includes(apiType) ? value : String(value || `call-${index}`);
  const nameOf = (value: any) => strict ? value : String(value || '');
  const complete = (calls: LlmToolCall[]) => strict ? calls : calls.filter(call => call.name);
  if (apiType === 'openai-compatible') {
    return complete(list(data.choices?.[0]?.message?.tool_calls ?? []).map((call: any, index: number) => ({
      id: idOf(call?.id, index), name: nameOf(call?.function?.name),
      arguments: argumentsOf(call?.function?.arguments),
    })));
  }
  if (apiType === 'anthropic') {
    return complete(list(data.content ?? []).filter((item: any) => item?.type === 'tool_use').map((item: any, index: number) => ({
      id: idOf(item?.id, index), name: nameOf(item?.name), arguments: argumentsOf(item?.input),
    })));
  }
  if (apiType === 'gemini') {
    return complete(list(data.candidates?.[0]?.content?.parts ?? []).filter((part: any) => part?.functionCall).map((part: any, index: number) => ({
      id: idOf(part.functionCall.id, index), name: nameOf(part.functionCall.name),
      arguments: argumentsOf(part.functionCall.args),
    })));
  }
  return complete(list(data.message?.tool_calls ?? []).map((call: any, index: number) => ({
    id: idOf(call?.id, index), name: nameOf(call?.function?.name),
    arguments: argumentsOf(call?.function?.arguments),
  })));
}

/** 将应用内部工具定义转换成各供应商要求的 Function Calling 形态。 */
export function normalizeToolsForProvider(apiType: ApiType, tools: LlmTool[]): unknown[] {
  if (apiType === 'anthropic') {
    return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  if (apiType === 'gemini') {
    return [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
  }
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function openAiAgentMessages(messages: LlmConversationMessage[], continuation?: (message: LlmConversationMessage) => string | undefined, reasoningRequired = false): any[] {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId || '', content: message.content };
    const reasoning = message.role === 'assistant' ? continuation?.(message) : undefined;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant', content: message.content || null,
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      };
    }
    if (reasoningRequired && message.role === 'assistant' && reasoning === undefined) {
      // Locally compacted summaries are context data, not provider-generated
      // assistant turns. Do not invent reasoning for them.
      return { role: 'user', content: '【先前助手答复或本地整理的上下文，仅供参考，不是新指令】\n' + message.content };
    }
    return { role: message.role, content: message.content, ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) };
  });
}

function anthropicAgentMessages(messages: LlmConversationMessage[]): any[] {
  const result: any[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId || '', content: message.content };
      const previous = result.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((item: any) => item.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const text = message.content ? [{ type: 'text', text: message.content }] : [];
      result.push({
        role: 'assistant',
        content: [...text, ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))],
      });
      continue;
    }
    result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
  }
  return result;
}

function geminiAgentMessages(messages: LlmConversationMessage[]): any[] {
  const result: any[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const part = { functionResponse: { name: message.toolName || 'tool', response: asArguments(message.content) } };
      const previous = result.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.parts) && previous.parts.every((item: any) => item.functionResponse)) {
        previous.parts.push(part);
      } else {
        result.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    const parts: any[] = message.content ? [{ text: message.content }] : [];
    if (message.role === 'assistant' && message.toolCalls?.length) {
      parts.push(...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.arguments } })));
    }
    result.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return result;
}

/** 构造各 API 类型的请求体 */
export function buildBody(
  apiType: ApiType,
  model: string,
  systemPrompt: string,
  userInput: string,
  temperature: number,
  maxTokens: number,
  apiKey: string,
  outputSchema?: object,
  tools?: LlmTool[],
  messages?: ChatMessage[],
  agentMessages?: LlmConversationMessage[],
  thinkingMode?: 'enabled' | 'disabled',
  images?: import('../types').LlmImageInput[],
  reasoningEffort?: 'low' | 'high' | 'max',
  continuation?: (message: LlmConversationMessage) => string | undefined,
  reasoningRequired = false,
): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const attachments = validateLlmImages(images);
  if (attachments.length && agentMessages?.length) throw new Error('图片附件暂不与工具对话消息混用');

  // 兜底：清除孤立 UTF-16 代理项，避免 DeepSeek/Go 后端 JSON 解析 400
  systemPrompt = sanitizeUnicode(ensureJsonObjectPrompt(systemPrompt, outputSchema));
  userInput = sanitizeUnicode(userInput);
  if (Array.isArray(messages)) {
    messages = messages.map((m: any) => ({ ...m, content: sanitizeUnicode(m?.content || '') }));
  }
  if (Array.isArray(agentMessages)) {
    agentMessages = normalizeAgentConversationMessages(
      agentMessages.map((message) => ({ ...message, content: sanitizeUnicode(message.content || '') })),
    );
  }
  const providerTools = tools?.length ? normalizeToolsForProvider(apiType, tools) : undefined;

  switch (apiType) {
    case 'openai-compatible': {
      headers['Authorization'] = `Bearer ${apiKey}`;
      const msgs: any[] = [{ role: 'system', content: systemPrompt }];
      if (agentMessages?.length) {
        msgs.push(...openAiAgentMessages(agentMessages, continuation, reasoningRequired));
      } else if (messages && Array.isArray(messages)) {
        for (const m of messages as { role: string; content: string }[]) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      if (!agentMessages?.length) msgs.push({ role: 'user', content: attachments.length
        ? [{ type: 'text', text: userInput }, ...imageParts(attachments, apiType)] : userInput });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature,
          max_tokens: maxTokens,
          ...(providerTools ? { tools: providerTools, tool_choice: 'auto' } : {}),
          ...(requestsJsonObject(outputSchema) ? { response_format: { type: 'json_object' } } : {}),
          ...(thinkingMode ? { thinking: { type: thinkingMode } } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        headers,
      };
    }
    case 'anthropic': {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      let combinedUserInput = userInput;
      if (!agentMessages?.length && messages && Array.isArray(messages)) {
        const historyText = (messages as { role: string; content: string }[])
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
          .join('\n');
        combinedUserInput = `${historyText}\n用户: ${userInput}`;
      }
      return {
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: agentMessages?.length ? anthropicAgentMessages(agentMessages) : [{ role: 'user', content: attachments.length
            ? [{ type: 'text', text: combinedUserInput }, ...imageParts(attachments, apiType)] : combinedUserInput }],
          max_tokens: maxTokens,
          temperature,
          ...(providerTools ? { tools: providerTools } : {}),
        }),
        headers,
      };
    }
    case 'gemini': {
      let combinedInput = `${systemPrompt}\n\n`;
      if (!agentMessages?.length && messages && Array.isArray(messages)) {
        const historyText = (messages as { role: string; content: string }[])
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
          .join('\n');
        combinedInput += `${historyText}\n`;
      }
      combinedInput += `用户输入：${userInput}`;
      return {
        body: JSON.stringify({
          contents: agentMessages?.length ? geminiAgentMessages(agentMessages) : [{ parts: [{ text: combinedInput }, ...imageParts(attachments, apiType)] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(requestsJsonObject(outputSchema) ? { responseMimeType: 'application/json' } : {}),
          },
          ...(agentMessages?.length ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
          ...(providerTools ? { tools: providerTools } : {}),
        }),
        headers,
      };
    }
    case 'ollama': {
      const msgs: any[] = [{ role: 'system', content: systemPrompt }];
      if (agentMessages?.length) {
        msgs.push(...ollamaAgentMessages(agentMessages, continuation));
      } else if (messages && Array.isArray(messages)) {
        for (const m of messages as { role: string; content: string }[]) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      if (!agentMessages?.length) msgs.push({ role: 'user', content: userInput,
        ...(attachments.length ? { images: attachments.map(image => image.dataUrl.split(',')[1]) } : {}) });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          stream: false,
          options: { temperature, num_predict: maxTokens },
          ...(providerTools ? { tools: providerTools } : {}),
          ...(requestsJsonObject(outputSchema) ? { format: 'json' } : {}),
        }),
        headers,
      };
    }
    default:
      throw new Error(`Unsupported API type: ${apiType}`);
  }
}

/** Model discovery uses the same configured API base as generation. */
function buildModelListUrl(apiType: ApiType, baseUrl: string, apiKey: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  switch (apiType) {
    case 'openai-compatible':
      return `${base}/models`;
    case 'anthropic':
      return `${base}/models`;
    case 'gemini':
      return `${base}/models?key=${encodeURIComponent(apiKey || '')}`;
    case 'ollama':
      return `${base}/api/tags`;
    default:
      return `${base}/models`;
  }
}

/** Test the exact selected model through the same generation protocol as normal requests. */
export async function probeLlmRequest(req: LlmIpcRequest): Promise<LlmProbeResponse> {
  const apiType = req.provider.apiType;
  let model = '';
  try {
    model = requireLlmModel(req.provider);
    const base = new URL(req.provider.baseUrl.trim());
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error();
    if (!['openai-compatible', 'anthropic', 'gemini', 'ollama'].includes(apiType)) throw new Error();
  } catch {
    return { ok: false, model, code: 'invalid-config', error: '请填写模型名称及有效的 HTTP/HTTPS 服务地址。' };
  }
  const glm = isGlm53ThinkingProvider(req.provider, model);
  const probeTimeoutMs = glm ? 60000 : 20000;
  const signal = createRequestSignal(undefined, probeTimeoutMs);
  try {
    const url = buildUrl(apiType, req.provider.baseUrl.trim(), model, req.provider.apiKey);
    const thinking = resolveLlmThinkingPolicy(req.provider, model);
    const { body, headers } = buildBody(apiType, model, 'You are running a connection check.', 'Reply with OK.', 0, glm ? 2048 : 64,
      req.provider.apiKey, undefined, undefined, undefined, undefined, thinking.thinkingMode, undefined, thinking.reasoningEffort);
    const response = await fetch(url, { method: 'POST', headers, body, signal: signal.signal });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const failure = readSafeLlmHttpFailure(safeLlmHttpError(response.status, raw).message)!;
      const code = failure.reason === 'authentication' ? 'auth' : failure.reason === 'model-invalid' ? 'model'
        : failure.reason === 'rate-limit' ? 'rate-limit' : 'http';
      return { ok: false, model, code, status: response.status, error: `HTTP ${response.status}：${failure.detail}` };
    }
    let content: unknown;
    try { content = parseContent(apiType, await response.json()).content; }
    catch {
      if (signal.signal.aborted) throw signal.signal.reason;
      return { ok: false, model, code: 'invalid-response', error: '接口已响应，但返回格式不符合所选 API 类型，请检查服务地址与协议。' };
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, model, code: 'empty-response', error: '接口已响应，但未返回可读取的文本，尚无法确认模型生成可用。' };
    }
    return { ok: true, model };
  } catch {
    return signal.signal.aborted
      ? { ok: false, model, code: 'timeout', error: `模型测试超过 ${probeTimeoutMs / 1000} 秒，请检查网络或等待模型加载后重试。` }
      : { ok: false, model, code: 'network', error: '无法连接模型服务，请检查地址、网络、代理或证书。' };
  } finally {
    signal.dispose();
  }
}

function modelId(value: unknown, apiType: ApiType): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const normalized = apiType === 'gemini' ? trimmed.replace(/^models\//, '') : trimmed;
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

/** Parse callable IDs by protocol; display labels must never become extra model choices. */
export function parseDiscoveredLlmModels(apiType: ApiType, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.data) ? record.data
    : Array.isArray(record.models) ? record.models
      : [];
  const values = rows.flatMap((row) => {
    if (typeof row === 'string') return [row];
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (apiType === 'gemini' && Array.isArray(item.supportedGenerationMethods)
      && !item.supportedGenerationMethods.includes('generateContent')) return [];
    // OpenAI/Anthropic use id; Gemini uses a models/... resource name.
    // Ollama exposes model/name aliases: prefer model and fall back to name.
    const identifier = apiType === 'gemini' ? item.name
      : apiType === 'ollama' ? modelId(item.model, apiType) || item.name
        : item.id;
    return typeof identifier === 'string' ? [identifier] : [];
  });
  return [...new Set(values.map(value => modelId(value, apiType)).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500);
}

/** Fetch available model ids from the endpoint implied by the selected API format. */
export async function discoverLlmModels(req: LlmIpcRequest): Promise<LlmModelDiscoveryResponse> {
  const apiType = req.provider.apiType;
  const url = buildModelListUrl(apiType, req.provider.baseUrl, req.provider.apiKey);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiType === 'openai-compatible') headers.Authorization = `Bearer ${req.provider.apiKey}`;
  else if (apiType === 'anthropic') {
    headers['x-api-key'] = req.provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, models: [], error: `模型列表接口返回 HTTP ${response.status}` };
    const models = parseDiscoveredLlmModels(apiType, await response.json());
    return models.length > 0
      ? { ok: true, models }
      : { ok: false, models: [], error: '接口可访问，但没有返回可用的模型名称。' };
  } catch {
    return { ok: false, models: [], error: '获取模型列表失败，请检查服务地址、API 类型、网络或证书后重试。' };
  }
}

/** One source of truth for HTTP fields, shared by sync and streamed requests. */
export function buildLlmHttpRequest(req: LlmIpcRequest, continuationScope?: LlmContinuationScope) {
  const apiType = req.provider.apiType;
  const model = requireLlmModel(req.provider);
  if (req.images?.length && !supportsImageInput(req.provider, model)) throw new Error('LLM_IMAGE_UNSUPPORTED: 当前模型未明确启用图片输入');
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const thinkingPolicy = requestThinkingPolicy(req, model);
  const { body, headers } = buildBody(
    apiType,
    model,
    req.systemPrompt,
    req.userInput,
    req.temperature,
    resolveLlmOutputBudget(req.provider, model, req.maxTokens, req.tokenBudgetMode, req.thinkingPreference),
    req.provider.apiKey,
    req.outputSchema,
    req.tools,
    req.messages,
    req.agentMessages ? prepareLlmToolHistory(req, continuationScope, normalizeAgentConversationMessages(req.agentMessages)) : undefined,
    thinkingPolicy.thinkingMode,
    req.images,
    thinkingPolicy.reasoningEffort,
    thinkingPolicy.thinkingMode === 'disabled' ? undefined : message => resolveLlmToolContinuation(req, continuationScope, message),
    Boolean(req.tools?.length && thinkingPolicy.thinkingMode === 'enabled'),
  );
  return { apiType, model, url, body, headers, thinkingPolicy };
}

/** 通用 LLM 转发（非流式），返回统一响应 */
export async function proxyLlmRequest(req: LlmIpcRequest, externalSignal?: AbortSignal, continuationScope?: LlmContinuationScope, strictTools = false): Promise<LlmIpcResponse> {
  const { apiType, model, url, body, headers } = buildLlmHttpRequest(req, continuationScope);
  const requestSignal = createRequestSignal(externalSignal, Number.isFinite(req.timeoutMs) ? Math.max(180000, Math.min(900000, req.timeoutMs!))
    : manualThinkingTimeoutMs(req.provider, model, req.thinkingPreference) ?? 180000);
  let data: any;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: requestSignal.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      if (req.images?.length && imageInputRejected(response.status, errorText)) throw new Error('LLM_IMAGE_UNSUPPORTED: 服务端不支持图片输入，原图保留供显示');
      throw safeLlmHttpError(response.status, errorText);
    }
    data = await response.json();
  } finally {
    requestSignal.dispose();
  }
  const { content, usage } = parseContent(apiType, data);
  const diagnostics = parseResponseDiagnostics(apiType, data);
  const incompleteTools = strictTools && !isCompleteLlmToolFinishReason(diagnostics?.finishReason);
  const toolCalls = incompleteTools ? [] : parseToolCalls(apiType, data, strictTools);
  if (strictTools) validateLlmStreamToolCalls(toolCalls, req.tools);

  let parsedJson: unknown;
  if (content && toolCalls.length === 0) {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsedJson = JSON.parse(jsonMatch?.[1]?.trim() || content);
    } catch {
      parsedJson = undefined;
    }
  }

  const toolContinuationId = incompleteTools ? undefined : retainLlmToolContinuation(req, continuationScope,
    apiType === 'ollama' ? data?.message?.thinking ?? data?.message?.reasoning_content : data?.choices?.[0]?.message?.reasoning_content, toolCalls);
  return { content, parsedJson, usage, diagnostics, ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolContinuationId ? { toolContinuationId } : {}) };
}

/** 通用 LLM 流式转发（SSE），逐片回调 */
export async function streamLlmRequest(
  req: LlmIpcRequest,
  onChunk: (c: StreamChunkIpc) => void,
  externalSignal?: AbortSignal,
  continuationScope?: LlmContinuationScope,
): Promise<LlmResponseDiagnostics | undefined> {
  const manualTimeout = manualThinkingTimeoutMs(req.provider, req.provider.selectedModel || req.provider.models[0], req.thinkingPreference);
  const streamTimeout = normalizeLlmStreamTimeoutPolicy(req.streamTimeout !== undefined ? req.streamTimeout
    : (manualTimeout ? { firstResponseMs: 180000, idleMs: 90000, totalMs: manualTimeout } : undefined));
  const apiType = req.provider.apiType;
  if (req.images?.length || (apiType !== 'openai-compatible' && apiType !== 'ollama')) {
    // 非流式类型退化为一次性内容回传
    const resp = await proxyLlmRequest(req, externalSignal, continuationScope, true);
    externalSignal?.throwIfAborted();
    if (resp.content) onChunk({ type: 'content', text: resp.content });
    if (resp.toolCalls?.length || resp.toolContinuationId) {
      if (isCompleteLlmToolFinishReason(resp.diagnostics?.finishReason)) {
        onChunk({ type: 'response', text: '', ...(resp.toolCalls?.length ? { toolCalls: resp.toolCalls } : {}),
          ...(resp.toolContinuationId ? { toolContinuationId: resp.toolContinuationId } : {}) });
      }
    }
    return resp.diagnostics;
  }

  const { url, body: syncBody, headers } = buildLlmHttpRequest(req, continuationScope);
  const body = JSON.stringify({ ...JSON.parse(syncBody), stream: true });

  const requestSignal = createLlmStreamTimeout(externalSignal, streamTimeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: requestSignal.signal,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw safeLlmHttpError(response.status, errorText);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | undefined;
    let reasoningTokens: number | undefined;
    let hadReasoningContent = false;
    let responseModel: string | undefined;
    const tools = new LlmStreamToolCalls(apiType);
    let sawDone = false, invalidEvent = false;
    let continuationReasoning: string | undefined;
    let reasoningBytes = 0;
    const captureReasoning = Boolean(req.tools?.length && continuationScope);
    let activityPhase: 'reasoning' | 'responding' | undefined;
    const emitActivity = (phase: 'reasoning' | 'responding') => {
      if (!req.includeActivity || activityPhase === phase || activityPhase === 'responding') return;
      activityPhase = phase;
      onChunk({ type: 'activity', text: '', activity: { phase } });
    };

    const processLine = (line: string) => {
      let data = line.trim();
      if (!data) return;
      if (data.startsWith('data:')) data = data.slice(5).trim();
      else if (apiType === 'openai-compatible') return;
      if (!data) return;
      if (data === '[DONE]') { sawDone = true; return; }
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        invalidEvent = true;
        return; // Keep legacy text-stream tolerance; tools fail closed below.
      }
      if (!parsed || typeof parsed !== 'object') { invalidEvent = true; return; }
      if (parsed.error) throw Error('模型流式响应返回错误，已保留此前接收的内容。');
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const choice = choices.find((item: any) => item?.index === 0)
        || (choices.length === 1 && choices[0]?.index === undefined ? choices[0] : undefined);
      const selected = apiType === 'ollama' ? parsed.message
        : choice?.delta || choice?.message || (choices.length === 0 ? parsed.message : undefined);
      const content = selected?.content;
      const reasoning = apiType === 'ollama' ? selected?.thinking ?? selected?.reasoning_content : selected?.reasoning_content;
      if (typeof reasoning === 'string') {
        if (reasoning) { hadReasoningContent = true; emitActivity('reasoning'); }
        if (captureReasoning) {
          reasoningBytes += Buffer.byteLength(reasoning);
          if (reasoningBytes > 1024 * 1024) throw Error('模型工具接续内容超过本地上限；已停止后续操作。');
          continuationReasoning = (continuationReasoning || '') + reasoning;
        }
      }
      if (typeof content === 'string' && content) { emitActivity('responding'); onChunk({ type: 'content', text: content }); }
      if (selected?.tool_calls !== undefined) {
        if (apiType === 'ollama') tools.appendOllama(selected.tool_calls);
        else tools.appendOpenAi(choice?.message && !choice.delta && Array.isArray(selected.tool_calls)
          ? selected.tool_calls.map((call: any, index: number) => ({ ...call, index: call.index ?? index })) : selected.tool_calls);
      }
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      if (apiType === 'ollama') {
        if (typeof parsed.done_reason === 'string') finishReason = parsed.done_reason;
        if (parsed.done === true) sawDone = true;
      }
      const reportedReasoningTokens = parsed.usage?.completion_tokens_details?.reasoning_tokens;
      if (Number.isFinite(reportedReasoningTokens)) reasoningTokens = Number(reportedReasoningTokens);
      if (typeof parsed.model === 'string') responseModel = parsed.model;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) requestSignal.touch();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw Error('模型流式响应片段超过本地上限，已停止接收。');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) { if (sawDone) break; processLine(line); }
      if (sawDone) break;
    }
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) processLine(buffer);
    externalSignal?.throwIfAborted();
    const reason = finishReason?.toLowerCase();
    const blocked = !isCompleteLlmToolFinishReason(reason);
    const complete = sawDone || Boolean(reason && !blocked);
    if (!blocked && (tools.hasCalls || req.tools?.length)) {
      if ((tools.hasCalls && !complete) || invalidEvent) throw Error('模型流式工具输出未完整结束，未执行任何工具。');
    }
    if (complete && !blocked && !invalidEvent) {
      const toolCalls = tools.hasCalls ? tools.finish() : [];
      validateLlmStreamToolCalls(toolCalls, req.tools);
      const toolContinuationId = retainLlmToolContinuation(req, continuationScope, continuationReasoning, toolCalls);
      if (toolCalls.length || toolContinuationId) onChunk({ type: 'response', text: '',
        ...(toolCalls.length ? { toolCalls } : {}), ...(toolContinuationId ? { toolContinuationId } : {}) });
    }
    const diagnostics: LlmResponseDiagnostics = { finishReason, reasoningTokens, hadReasoningContent: hadReasoningContent || undefined, responseModel };
    return Object.values(diagnostics).some((value) => value !== undefined) ? diagnostics : undefined;
  } catch (error) {
    // Fetch body readers can replace an abort reason with a generic AbortError.
    // Retain our safe phase-specific reason, without rewriting user cancellation.
    if (requestSignal.signal.aborted && requestSignal.signal.reason instanceof LlmStreamTimeoutError) throw requestSignal.signal.reason;
    throw error;
  } finally {
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    requestSignal.dispose();
  }
}

/** 自动关联（与编辑器共用 Markdown 结构保护，无网络） */
export async function autoLink(
  req: AutoLinkIpcRequest,
): Promise<{ updatedContent: string; addedLinks: string[] }> {
  return autoLinkMarkdown(req.content, req.existingNoteTitles.map((title) => ({ token: title, target: title })));
}

