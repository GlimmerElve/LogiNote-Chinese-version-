import type { LlmProvider, LlmResponseDiagnostics, LlmTool, LlmToolCall, ChatMessage, LlmConversationMessage, LlmThinkingPreference } from '../types';

/**
 * 渲染进程 → 主进程 的 IPC 类型定义（LLM / AI 服务）。
 * 主进程侧通过 import type 复用，避免在 preload 与 main 之间重复维护。
 */

/** LLM 统一请求（渲染进程收集好 provider 配置后传给主进程） */
export interface LlmStreamTimeoutPolicy {
  firstResponseMs: number;
  idleMs: number;
  totalMs: number;
}

export interface LlmIpcRequest {
  /** Renderer-generated id used to cancel the matching in-flight request. */
  requestId?: string;
  provider: {
    /** Saved supplier identity, checked again by the desktop before dispatch. */
    id?: string;
    apiType: LlmProvider['apiType'];
    baseUrl: string;
    apiKey: string;
    selectedModel?: string;
    models: string[];
    visionModels?: string[];
  };
  systemPrompt: string;
  userInput: string;
  images?: import('../types').LlmImageInput[];
  temperature: number;
  maxTokens: number;
  /** Renderer-prepared and approval-bound totals must never be expanded again. */
  tokenBudgetMode?: 'response' | 'total';
  outputSchema?: object;
  tools?: LlmTool[];
  messages?: ChatMessage[];
  agentMessages?: LlmConversationMessage[];
  thinkingMode?: 'enabled' | 'disabled';
  /** Captured by the caller; the main process never reloads UI preferences mid-call. */
  thinkingPreference?: LlmThinkingPreference;
  reasoningEffort?: 'low' | 'high' | 'max';
  includeActivity?: boolean;
  timeoutMs?: number;
  /** Scoped streaming deadlines; omitted callers retain the legacy 90s total. */
  streamTimeout?: LlmStreamTimeoutPolicy;
}

/** LLM 统一响应 */
export interface LlmIpcResponse {
  content: string;
  parsedJson?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
  toolCalls?: LlmToolCall[];
  toolContinuationId?: string;
  diagnostics?: LlmResponseDiagnostics;
}

export interface LlmModelDiscoveryResponse {
  ok: boolean;
  models: string[];
  error?: string;
}

/** A successful test confirms generation by the selected model, not just a model-list endpoint. */
export interface LlmProbeResponse {
  ok: boolean;
  model: string;
  error?: string;
  code?: 'invalid-config' | 'auth' | 'model' | 'rate-limit' | 'http' | 'timeout' | 'network' | 'empty-response' | 'invalid-response';
  status?: number;
}

/** LLM 流式分片 */
export interface StreamChunkIpc {
  type: 'content' | 'diagnostics' | 'activity' | 'response';
  text: string;
  /** Complete response metadata only; partial arguments are never executable. */
  toolCalls?: LlmToolCall[];
  toolContinuationId?: string;
  diagnostics?: LlmResponseDiagnostics;
  /** Phase only, never raw reasoning text. Emitted for opted-in callers. */
  activity?: { phase: 'reasoning' | 'responding' };
}

/** AI 逻辑分词请求 */
/** 自动关联请求 */
export interface AutoLinkIpcRequest {
  content: string;
  existingNoteTitles: string[];
}

