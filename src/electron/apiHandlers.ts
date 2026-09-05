import {
  LlmIpcRequest,
  LlmIpcResponse,
  StreamChunkIpc,
  SegmentIpcRequest,
  AutoLinkIpcRequest,
  ResourceSearchIpcRequest,
  ConceptGenIpcRequest,
} from './ipcTypes';
import type { LogicSegment, ResourceItem } from '../types';
import { TEXT_SEGMENTATION_PROMPT } from '../workflows/textSegmentationPrompt';
import { RESOURCE_SEARCH_PROMPT } from '../workflows/resourceSearchPrompt';
import { CONCEPT_GENERATION_PROMPT } from '../workflows/conceptGenerationPrompt';
import { sanitizeUnicode } from '../services/unicode';

/**
 * 原 server.ts 的 API 逻辑，迁入 Electron 主进程后通过 IPC 调用。
 * - proxyLlmRequest / streamLlmRequest：通用 LLM 转发（无浏览器 CORS 限制）
 * - segmentText / autoLink / resourceSearch / conceptGeneration：AI 服务
 */

type ApiType = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

/** 构建各 API 类型的请求目标地址 */
function buildUrl(apiType: ApiType, baseUrl: string, model: string, apiKey: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
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
        content: data.content?.[0]?.text || '',
        usage: data.usage ? { promptTokens: data.usage.input_tokens || 0, completionTokens: data.usage.output_tokens || 0 } : undefined,
      };
    case 'gemini':
      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
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

/** 构造各 API 类型的请求体 */
function buildBody(
  apiType: ApiType,
  model: string,
  systemPrompt: string,
  userInput: string,
  temperature: number,
  maxTokens: number,
  apiKey: string,
  outputSchema?: object,
  tools?: unknown[],
  messages?: unknown[],
): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // 兜底：清除孤立 UTF-16 代理项，避免 DeepSeek/Go 后端 JSON 解析 400
  systemPrompt = sanitizeUnicode(systemPrompt);
  userInput = sanitizeUnicode(userInput);
  if (Array.isArray(messages)) {
    messages = messages.map((m: any) => ({ ...m, content: sanitizeUnicode(m?.content || '') }));
  }

  switch (apiType) {
    case 'openai-compatible': {
      headers['Authorization'] = `Bearer ${apiKey}`;
      const msgs: { role: string; content: string }[] = [{ role: 'system', content: systemPrompt }];
      if (messages && Array.isArray(messages)) {
        for (const m of messages as { role: string; content: string }[]) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      msgs.push({ role: 'user', content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature,
          max_tokens: maxTokens,
          ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
          ...(outputSchema ? { response_format: { type: 'json_object' } } : {}),
        }),
        headers,
      };
    }
    case 'anthropic': {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      let combinedUserInput = userInput;
      if (messages && Array.isArray(messages)) {
        const historyText = (messages as { role: string; content: string }[])
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
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
      if (messages && Array.isArray(messages)) {
        const historyText = (messages as { role: string; content: string }[])
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
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
      const msgs: { role: string; content: string }[] = [{ role: 'system', content: systemPrompt }];
      if (messages && Array.isArray(messages)) {
        for (const m of messages as { role: string; content: string }[]) {
          msgs.push({ role: m.role, content: m.content });
        }
      }
      msgs.push({ role: 'user', content: userInput });
      return {
        body: JSON.stringify({
          model,
          messages: msgs,
          stream: false,
          options: { temperature, num_predict: maxTokens },
        }),
        headers,
      };
    }
    default:
      throw new Error(`Unsupported API type: ${apiType}`);
  }
}

/** 构造探活 URL（各家官方列表端点，不消耗推理 token） */
function buildProbeUrl(apiType: ApiType, baseUrl: string, apiKey: string, model: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  switch (apiType) {
    case 'openai-compatible':
      return `${base}/models`;
    case 'anthropic':
      return `${base}/models`;
    case 'gemini':
      return `${base}/v1beta/models?key=${encodeURIComponent(apiKey || '')}`;
    case 'ollama':
      return `${base}/api/tags`;
    default:
      return `${base}/models`;
  }
}

/** 探活某服务商：调用官方列表端点，HTTP 2xx 即视为可用（Node 内无 CORS 限制） */
export async function probeLlmRequest(req: LlmIpcRequest): Promise<boolean> {
  const apiType = req.provider.apiType;
  const model = req.provider.selectedModel || req.provider.models[0] || 'gemini-2.5-flash';
  const url = buildProbeUrl(apiType, req.provider.baseUrl, req.provider.apiKey, model);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiType === 'openai-compatible') headers['Authorization'] = `Bearer ${req.provider.apiKey}`;
  else if (apiType === 'anthropic') {
    headers['x-api-key'] = req.provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  try {
    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 通用 LLM 转发（非流式），返回统一响应 */
export async function proxyLlmRequest(req: LlmIpcRequest): Promise<LlmIpcResponse> {
  const apiType = req.provider.apiType;
  const model = req.provider.selectedModel || req.provider.models[0] || 'gemini-2.5-flash';
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
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(180000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`LLM 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const { content, usage } = parseContent(apiType, data);

  let parsedJson: unknown;
  if (content) {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsedJson = JSON.parse(jsonMatch?.[1]?.trim() || content);
    } catch {
      parsedJson = undefined;
    }
  }

  return { content, parsedJson, usage };
}

/** 通用 LLM 流式转发（SSE），逐片回调 */
export async function streamLlmRequest(
  req: LlmIpcRequest,
  onChunk: (c: StreamChunkIpc) => void,
): Promise<void> {
  const apiType = req.provider.apiType;
  if (apiType !== 'openai-compatible' && apiType !== 'ollama') {
    // 非流式类型退化为一次性内容回传
    const resp = await proxyLlmRequest(req);
    if (resp.content) onChunk({ type: 'content', text: resp.content });
    return;
  }

  const model = req.provider.selectedModel || req.provider.models[0] || 'gemini-2.5-flash';
  const url = buildUrl(apiType, req.provider.baseUrl, model, req.provider.apiKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string;

  // 兜底：清除孤立 UTF-16 代理项，避免流式请求体解析失败（DeepSeek/Go 严格拒收）
  const sysPrompt = sanitizeUnicode(req.systemPrompt);
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
      ...(req.outputSchema ? { response_format: { type: 'json_object' } } : {}),
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
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`LLM 流式请求失败 (${response.status}): ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim() || !line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        const content = delta?.content || parsed.message?.content || '';
        if (content) onChunk({ type: 'content', text: content });
      } catch {
        // partial chunk, ignore
      }
    }
  }
}

/** AI 逻辑分词（主进程兜底路径，走通用 LLM + text-segmentation workflow） */
export async function segmentText(req: SegmentIpcRequest): Promise<unknown> {
  const llmReq: LlmIpcRequest = {
    provider: {
      apiType: req.provider.apiType,
      baseUrl: req.provider.baseUrl,
      apiKey: req.provider.apiKey,
      selectedModel: req.provider.selectedModel,
      models: req.provider.models,
    },
    systemPrompt: TEXT_SEGMENTATION_PROMPT,
    userInput: `【笔记标题】: ${req.noteTitle || '未命名笔记'}\n【已有笔记节点列表】: ${req.existingNotes.join(', ') || '无'}\n\n【待分析长文本】:\n${req.text}`,
    temperature: 0.5,
    maxTokens: 8192,
    outputSchema: {},
  };

  const resp = await proxyLlmRequest(llmReq);
  return resp.parsedJson || {};
}

/** 自动关联（纯本地字符串替换，无网络） */
export async function autoLink(
  req: AutoLinkIpcRequest,
): Promise<{ updatedContent: string; addedLinks: string[] }> {
  let updatedContent = req.content;
  const addedLinks: string[] = [];

  for (const title of req.existingNoteTitles) {
    if (!title || title.trim().length === 0) continue;
    const regex = new RegExp(`(?<!\\[\\[)${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\]\\])`, 'g');
    if (regex.test(updatedContent)) {
      updatedContent = updatedContent.replace(regex, `[[${title}]]`);
      addedLinks.push(title);
    }
  }

  return { updatedContent, addedLinks };
}

/** 从 Markdown 解析资源清单 */
function parseResourcesFromMarkdown(md: string): ResourceItem[] {
  const resources: ResourceItem[] = [];
  const lines = md.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s*\[([^\]]+)\]\(((?:https?:\/\/)[^)\s]+)\)(?:\s*[—\-–]\s*(.+))?$/);
    if (!match) continue;
    const title = match[1].trim();
    const url = match[2].trim();
    const platform = match[3]?.trim() || undefined;
    if (!title || !url) continue;
    resources.push({ title, url, platform });
  }
  return resources;
}

/** DeepSeek responses + web_search 的统一调用，返回 markdown */
async function deepSeekWebSearch(markdownPrompt: string, provider: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
  const baseUrl = (provider.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = provider.model || 'deepseek-chat';
  const safePrompt = sanitizeUnicode(markdownPrompt);

  const resp = await fetch(baseUrl + '/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
    body: JSON.stringify({ model, input: safePrompt, tools: [{ type: 'web_search' }] }),
    signal: AbortSignal.timeout(180000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'Unknown error');
    throw new Error('DeepSeek 请求失败: ' + errText.slice(0, 300));
  }

  const data = await resp.json();
  let final = '';
  let fallback = '';
  for (const item of data.output || []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      const text = typeof c.text === 'string' ? c.text : '';
      if (!text) continue;
      if (item.phase === 'final_answer') final += text;
      else fallback += text;
    }
  }
  return final.trim() || fallback;
}

/** 资源推荐（DeepSeek web_search） */
export async function resourceSearch(
  req: ResourceSearchIpcRequest,
): Promise<{ markdown: string; resources: ResourceItem[] }> {
  const provider = req.provider;
  if (!provider.apiKey) {
    throw new Error('未配置 DeepSeek API Key，请在设置中配置');
  }

  const model = provider.selectedModel || provider.models?.[0] || 'deepseek-chat';
  const prompt = RESOURCE_SEARCH_PROMPT
    .replace(/<<TITLE>>/g, req.title.trim())
    .replace(/<<PATH_TEXT>>/g, req.pathText);

  const markdown = await deepSeekWebSearch(prompt, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
  });

  if (!markdown) {
    throw new Error('未能获取到推荐内容');
  }

  const resources = parseResourcesFromMarkdown(markdown);
  return { markdown, resources };
}

/** 概念补全（DeepSeek web_search） */
export async function conceptGeneration(req: ConceptGenIpcRequest): Promise<{ content: string }> {
  const provider = req.provider;
  if (!provider.apiKey) {
    throw new Error('未配置 DeepSeek API Key，请在设置中配置');
  }

  const model = provider.selectedModel || provider.models?.[0] || 'deepseek-chat';
  const prompt = CONCEPT_GENERATION_PROMPT.replace(/<<TERM>>/g, req.term.trim());

  const markdown = await deepSeekWebSearch(prompt, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
  });

  if (!markdown) {
    throw new Error('未能获取到概念内容');
  }

  return { content: markdown };
}