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

/**
 * 原 server.ts 的 API 逻辑，迁入 Electron 主进程后通过 IPC 调用。
 * - proxyLlmRequest / streamLlmRequest：通用 LLM 转发（无浏览器 CORS 限制）
 * - autoLink：本地自动关联服务
 */

type ApiType = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

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
export function parseToolCalls(apiType: ApiType, data: any): LlmToolCall[] {
  if (apiType === 'openai-compatible') {
    return (data.choices?.[0]?.message?.tool_calls || []).map((call: any, index: number) => ({
      id: String(call?.id || `call-${index}`), name: String(call?.function?.name || ''),
      arguments: asArguments(call?.function?.arguments),
    })).filter((call: LlmToolCall) => call.name);
  }
  if (apiType === 'anthropic') {
    return (data.content || []).filter((item: any) => item?.type === 'tool_use').map((item: any, index: number) => ({
      id: String(item?.id || `call-${index}`), name: String(item?.name || ''), arguments: asArguments(item?.input),
    })).filter((call: LlmToolCall) => call.name);
  }
  if (apiType === 'gemini') {
    return (data.candidates?.[0]?.content?.parts || []).filter((part: any) => part?.functionCall).map((part: any, index: number) => ({
      id: String(part.functionCall.id || `call-${index}`), name: String(part.functionCall.name || ''),
      arguments: asArguments(part.functionCall.args),
    })).filter((call: LlmToolCall) => call.name);
  }
  return (data.message?.tool_calls || []).map((call: any, index: number) => ({
    id: String(call?.id || `call-${index}`), name: String(call?.function?.name || ''),
    arguments: asArguments(call?.function?.arguments),
  })).filter((call: LlmToolCall) => call.name);
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

function openAiAgentMessages(messages: LlmConversationMessage[]): any[] {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId || '', content: message.content };
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant', content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      };
    }
    return { role: message.role, content: message.content };
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
        msgs.push(...openAiAgentMessages(agentMessages));
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
        msgs.push(...openAiAgentMessages(agentMessages));
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
  const signal = createRequestSignal(undefined, 20000);
  try {
    const url = buildUrl(apiType, req.provider.baseUrl.trim(), model, req.provider.apiKey);
    const { body, headers } = buildBody(apiType, model, 'You are running a connection check.', 'Reply with OK.', 0, 64, req.provider.apiKey);
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
      ? { ok: false, model, code: 'timeout', error: '模型测试超过 20 秒，请检查网络或等待模型加载后重试。' }
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

/** 通用 LLM 转发（非流式），返回统一响应 */
export async function proxyLlmRequest(req: LlmIpcRequest, externalSignal?: AbortSignal): Promise<LlmIpcResponse> {
  const apiType = req.provider.apiType;
  const model = requireLlmModel(req.provider);
  if (req.images?.length && !supportsImageInput(req.provider, model)) throw new Error('LLM_IMAGE_UNSUPPORTED: 当前模型未明确启用图片输入');
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const { body, headers } = buildBody(
    apiType,
    model,
    req.systemPrompt,
    req.userInput,
    req.temperature,
    req.maxTokens,
    req.provider.apiKey,
    req.outputSchema,
    req.tools,
    req.messages,
    req.agentMessages,
    req.thinkingMode,
    req.images,
  );

  const requestSignal = createRequestSignal(externalSignal, Number.isFinite(req.timeoutMs) ? Math.max(180000, Math.min(900000, req.timeoutMs!)) : 180000);
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
  const toolCalls = parseToolCalls(apiType, data);
  const diagnostics = parseResponseDiagnostics(apiType, data);

  let parsedJson: unknown;
  if (content && toolCalls.length === 0) {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsedJson = JSON.parse(jsonMatch?.[1]?.trim() || content);
    } catch {
      parsedJson = undefined;
    }
  }

  return { content, parsedJson, usage, diagnostics, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
}

/** 通用 LLM 流式转发（SSE），逐片回调 */
export async function streamLlmRequest(
  req: LlmIpcRequest,
  onChunk: (c: StreamChunkIpc) => void,
  externalSignal?: AbortSignal,
): Promise<LlmResponseDiagnostics | undefined> {
  const apiType = req.provider.apiType;
  if (req.images?.length || (apiType !== 'openai-compatible' && apiType !== 'ollama')) {
    // 非流式类型退化为一次性内容回传
    const resp = await proxyLlmRequest(req, externalSignal);
    if (resp.content) onChunk({ type: 'content', text: resp.content });
    return resp.diagnostics;
  }

  const model = requireLlmModel(req.provider);
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string;

  // 兜底：清除孤立 UTF-16 代理项，避免流式请求体解析失败（DeepSeek/Go 严格拒收）
  const sysPrompt = sanitizeUnicode(ensureJsonObjectPrompt(req.systemPrompt, req.outputSchema));
  const usrInput = sanitizeUnicode(req.userInput);

  if (apiType === 'openai-compatible') {
    headers['Authorization'] = `Bearer ${req.provider.apiKey}`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: usrInput },
      ],
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      ...(requestsJsonObject(req.outputSchema) ? { response_format: { type: 'json_object' } } : {}),
      ...(req.thinkingMode ? { thinking: { type: req.thinkingMode } } : {}),
    });
  } else {
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: usrInput },
      ],
      stream: true,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
      ...(requestsJsonObject(req.outputSchema) ? { format: 'json' } : {}),
    });
  }

  const requestSignal = createRequestSignal(externalSignal, 90000);
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | undefined;
    let reasoningTokens: number | undefined;
    let hadReasoningContent = false;
    let responseModel: string | undefined;

    const processLine = (line: string) => {
      let data = line.trim();
      if (!data) return;
      if (data.startsWith('data:')) data = data.slice(5).trim();
      else if (apiType === 'openai-compatible') return;
      if (!data || data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        const content = delta?.content || parsed.message?.content || '';
        const reasoning = delta?.reasoning_content || parsed.message?.reasoning_content || '';
        if (content) onChunk({ type: 'content', text: content });
        if (reasoning) hadReasoningContent = true;
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (typeof parsed.done_reason === 'string') finishReason = parsed.done_reason;
        const reportedReasoningTokens = parsed.usage?.completion_tokens_details?.reasoning_tokens;
        if (Number.isFinite(reportedReasoningTokens)) reasoningTokens = Number(reportedReasoningTokens);
        if (typeof parsed.model === 'string') responseModel = parsed.model;
      } catch {
        // Invalid provider event; keep reading subsequent complete events.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    const diagnostics: LlmResponseDiagnostics = { finishReason, reasoningTokens, hadReasoningContent: hadReasoningContent || undefined, responseModel };
    return Object.values(diagnostics).some((value) => value !== undefined) ? diagnostics : undefined;
  } finally {
    requestSignal.dispose();
  }
}

/** 自动关联（与编辑器共用 Markdown 结构保护，无网络） */
export async function autoLink(
  req: AutoLinkIpcRequest,
): Promise<{ updatedContent: string; addedLinks: string[] }> {
  return autoLinkMarkdown(req.content, req.existingNoteTitles.map((title) => ({ token: title, target: title })));
}

