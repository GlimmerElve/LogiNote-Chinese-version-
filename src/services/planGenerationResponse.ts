import type { LlmCallResponse } from '../types';

const MAX_RESPONSE_CHARS = 2_000_000;

function decodeJsonString(value: unknown): unknown {
  for (let round = 0; round < 2 && typeof value === 'string'; round++) {
    if (value.length > MAX_RESPONSE_CHARS) return undefined;
    try { value = JSON.parse(value.trim()); } catch { return undefined; }
  }
  return value;
}

/** Recover one complete JSON value surrounded by formatting/prose only. Never
 * repair missing brackets, extract a partial child, or choose among two values. */
function readCompleteJson(text: string): unknown {
  if (text.length > MAX_RESPONSE_CHARS) return undefined;
  const trimmed = text.trim();
  try { return decodeJsonString(JSON.parse(trimmed)); } catch { /* Inspect formatting around a complete value. */ }
  let start = -1, quoted = false, escaped = false, count = 0;
  const stack: string[] = [];
  let value: unknown;
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (start < 0) {
      if (character === '}' || character === ']') return undefined;
      if (character !== '{' && character !== '[') continue;
      start = index;
      stack.push(character);
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '{' || character === '[') {
      if (stack.length >= 256) return undefined;
      stack.push(character);
    } else if (character === '}' || character === ']') {
      if (stack.pop() !== (character === '}' ? '{' : '[')) return undefined;
      if (!stack.length) {
        if (++count > 1) return undefined;
        try { value = JSON.parse(trimmed.slice(start, index + 1)); } catch { return undefined; }
        start = -1;
      }
    }
  }
  return start < 0 && count === 1 ? decodeJsonString(value) : undefined;
}

/** Plan-wizard-only compatibility. Other workflows and Agent receipts keep
 * their existing parsers and validation policies. No extra model calls occur. */
export function isPlanGenerationTruncated(response: Pick<LlmCallResponse, 'diagnostics'>): boolean {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(response.diagnostics?.finishReason?.toLowerCase() || '');
}

export function readPlanGenerationResponse(response: LlmCallResponse): Record<string, any> {
  const finishReason = response.diagnostics?.finishReason?.toLowerCase();
  if (isPlanGenerationTruncated(response)) {
    throw new Error('模型输出被截断，计划尚未完整返回。请缩小本次规划范围或调整模型输出上限后重试，当前草图与输入已保留。');
  }
  if (finishReason && ['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content'].includes(finishReason)) {
    throw new Error('模型响应被安全限制，未返回完整计划。请检查学习主题或模型设置后重试。');
  }
  if (response.toolCalls?.length) throw new Error('计划 JSON 不符合约定字段：本流程需要计划或追问，而不是工具调用。');
  const content = typeof response.content === 'string' ? response.content.trim() : '';
  const value = content ? readCompleteJson(content) : decodeJsonString(response.parsedJson);
  if (value === undefined) {
    if (!content && response.parsedJson === undefined) {
      throw new Error(response.diagnostics?.hadReasoningContent
        ? '模型只返回了思考信息，没有返回计划正文。请检查模型设置后重试。'
        : '模型未返回计划正文，请检查模型服务或稍后重试，当前草图与输入已保留。');
    }
    throw new Error('模型已响应，但计划 JSON 格式无效或不完整。请重试生成；不会把残缺内容写入蓝图。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('计划 JSON 不符合约定字段：需要顶层追问 question 或项目数组 planTree，请重试生成。');
  }
  const result = value as Record<string, any>;
  const question = typeof result.question === 'string' && result.question.trim();
  if (question && !result.isComplete) return { ...result, question };
  if (!Array.isArray(result.planTree) || !result.planTree.length) {
    throw new Error('计划 JSON 不符合约定字段：需要顶层追问 question 或非空项目数组 planTree，请重试生成。');
  }
  return result;
}
