import type { LlmConversationMessage, LlmTool, LlmToolCall } from '../types';

const MAX_CALLS = 256;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_LABEL_LENGTH = 512;
function invalid(): never { throw new Error('流式工具调用不完整或参数格式无效，未执行工具。'); }
/** Missing finish reasons are allowed only for an atomic, successfully read
 * fallback response. A true stream additionally requires its terminal signal. */
export function isCompleteLlmToolFinishReason(reason: string | undefined): boolean {
  return reason === undefined || ['stop', 'tool_calls', 'function_call', 'tool_use', 'eos_token', 'end_turn'].includes(reason.toLowerCase());
}

export function validateLlmStreamToolCalls(calls: LlmToolCall[], declared: LlmTool[] | undefined): void {
  if (calls.length > MAX_CALLS || new Set(calls.map(call => call.id)).size !== calls.length) invalid();
  let size = 0;
  for (const call of calls) {
    label(call.id); label(call.name);
    if (!declared?.some(tool => tool.name === call.name)) throw new Error('模型返回了本次请求未声明的工具，未执行工具。');
    size += Buffer.byteLength(JSON.stringify(call.arguments));
  }
  if (size > MAX_ARGUMENT_BYTES) invalid();
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

function validateJson(value: unknown, parents: Set<object>, depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (depth > 64 || !value || typeof value !== 'object' || parents.has(value)) invalid();
  if (!Array.isArray(value) && !record(value)) invalid();
  parents.add(value);
  for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!property.enumerable) continue;
    if (!('value' in property)) invalid();
    validateJson(property.value, parents, depth + 1);
  }
  parents.delete(value);
}

/** Complete object only. Empty argument text is the no-argument form; a partial
 * object must never silently become {} and authorize a different operation. */
export function strictToolArguments(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_ARGUMENT_BYTES) invalid();
    if (!value.trim()) return {};
    try { parsed = JSON.parse(value); } catch { return invalid(); }
  }
  if (!record(parsed)) invalid();
  validateJson(parsed, new Set());
  let serialized: string;
  try { serialized = JSON.stringify(parsed); } catch { return invalid(); }
  if (Buffer.byteLength(serialized) > MAX_ARGUMENT_BYTES) invalid();
  // Detach native complete objects from an event object the caller may reuse.
  return JSON.parse(serialized);
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_LABEL_LENGTH) return invalid();
  return value;
}

interface OpenAiCall { id: string; name: string; arguments: string }

/** OpenAI deltas and Ollama complete objects are different protocols. Never
 * interpret an Ollama object's index as an OpenAI fragment accumulator key. */
export class LlmStreamToolCalls {
  private readonly openAi = new Map<number, OpenAiCall>();
  private readonly ollama: LlmToolCall[] = [];
  private argumentBytes = 0;
  private failed = false;

  constructor(private readonly apiType: 'openai-compatible' | 'ollama') {
    if (!['openai-compatible', 'ollama'].includes(apiType)) invalid();
  }

  get hasCalls(): boolean { return this.openAi.size > 0 || this.ollama.length > 0; }

  appendOpenAi(value: unknown): void {
    if (this.failed) invalid();
    try {
    if (this.apiType !== 'openai-compatible') invalid();
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) invalid();
    for (const piece of value) {
      if (!record(piece) || !Number.isSafeInteger(piece.index) || (piece.index as number) < 0 || (piece.index as number) >= MAX_CALLS
        || piece.type !== undefined && piece.type !== 'function') invalid();
      if (piece.function !== undefined && !record(piece.function)) invalid();
      const index = piece.index as number;
      const current = this.openAi.get(index) || { id: '', name: '', arguments: '' };
      const fn = piece.function as Record<string, unknown> | undefined;
      for (const [part, target] of [[piece.id, 'id'], [fn?.name, 'name']] as const) {
        if (part === undefined) continue;
        if (typeof part !== 'string' || current[target].length + part.length > MAX_LABEL_LENGTH) invalid();
        // The documented protocol sends fragments. Repeated first pieces are
        // not guessed/deduplicated into an alternative tool identity.
        current[target] += part;
      }
      if (fn?.arguments !== undefined) {
        if (typeof fn.arguments !== 'string') invalid();
        const bytes = Buffer.byteLength(fn.arguments);
        if (this.argumentBytes + bytes > MAX_ARGUMENT_BYTES) invalid();
        this.argumentBytes += bytes;
        current.arguments += fn.arguments;
      }
      this.openAi.set(index, current);
      if (this.openAi.size > MAX_CALLS) invalid();
    }
    } catch (error) { this.failed = true; throw error; }
  }

  appendOllama(value: unknown): void {
    if (this.failed) invalid();
    try {
    if (this.apiType !== 'ollama') invalid();
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) invalid();
    for (const item of value) {
      if (!record(item) || !record(item.function) || !record(item.function.arguments)
        || item.type !== undefined && item.type !== 'function' || this.ollama.length >= MAX_CALLS) invalid();
      const args = strictToolArguments(item.function.arguments);
      const bytes = Buffer.byteLength(JSON.stringify(args));
      if (this.argumentBytes + bytes > MAX_ARGUMENT_BYTES) invalid();
      this.argumentBytes += bytes;
      this.ollama.push({ id: item.id === undefined ? `call-${this.ollama.length}` : label(item.id),
        name: label(item.function.name), arguments: args });
    }
    } catch (error) { this.failed = true; throw error; }
  }

  finish(): LlmToolCall[] {
    if (this.failed) invalid();
    try {
    const calls = this.apiType === 'openai-compatible'
      ? [...this.openAi].sort(([a], [b]) => a - b).map(([, call]) => ({ id: label(call.id), name: label(call.name), arguments: strictToolArguments(call.arguments) }))
      : this.ollama.map(call => ({ ...call, arguments: strictToolArguments(call.arguments) }));
    if (new Set(calls.map(call => call.id)).size !== calls.length) invalid();
    return calls;
    } catch (error) { this.failed = true; throw error; }
  }
}

/** Ollama /api/chat uses native objects and tool_name. The opaque reasoning
 * callback resolves provider-required thinking only inside the main process. */
export function ollamaAgentMessages(messages: LlmConversationMessage[], continuation?: (message: LlmConversationMessage) => string | undefined): unknown[] {
  let callNames = new Map<string, string>();
  return messages.map(message => {
    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId || '') || message.toolName;
      return { role: 'tool', tool_name: label(name), content: message.content };
    }
    // Native streams may reuse generated internal ids in later rounds. Match
    // a result only to its immediately preceding assistant tool declaration.
    callNames = new Map((message.toolCalls || []).map(call => [call.id, call.name]));
    const thinking = message.role === 'assistant' ? continuation?.(message) : undefined;
    return { role: message.role, content: message.content || '',
      ...(thinking !== undefined ? { thinking } : {}),
      ...(message.role === 'assistant' && message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ type: 'function',
        function: { name: label(call.name), arguments: strictToolArguments(call.arguments ?? {}) } })) } : {}) };
  });
}
