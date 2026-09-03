import type { LlmProvider, LlmTool, ChatMessage } from '../types';

/**
 * 渲染进程 → 主进程 的 IPC 类型定义（LLM / AI 服务）。
 * 主进程侧通过 import type 复用，避免在 preload 与 main 之间重复维护。
 */

/** LLM 统一请求（渲染进程收集好 provider 配置后传给主进程） */
export interface LlmIpcRequest {
  provider: {
    apiType: LlmProvider['apiType'];
    baseUrl: string;
    apiKey: string;
    selectedModel?: string;
    models: string[];
  };
  systemPrompt: string;
  userInput: string;
  temperature: number;
  maxTokens: number;
  outputSchema?: object;
  tools?: LlmTool[];
  messages?: ChatMessage[];
}

/** LLM 统一响应 */
export interface LlmIpcResponse {
  content: string;
  parsedJson?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

/** LLM 流式分片 */
export interface StreamChunkIpc {
  type: 'reasoning' | 'content';
  text: string;
}

/** AI 逻辑分词请求 */
export interface SegmentIpcRequest {
  text: string;
  noteTitle: string;
  existingNotes: string[];
  provider: LlmProvider;
}

/** 自动关联请求 */
export interface AutoLinkIpcRequest {
  content: string;
  existingNoteTitles: string[];
}

/** DeepSeek 资源搜索请求 */
export interface ResourceSearchIpcRequest {
  title: string;
  pathText: string;
  provider: LlmProvider;
}

/** DeepSeek 概念补全请求 */
export interface ConceptGenIpcRequest {
  term: string;
  provider: LlmProvider;
}