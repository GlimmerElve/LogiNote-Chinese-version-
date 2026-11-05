import type { LlmConversationMessage } from '../../types';

function answerEnvelope(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 200_000 || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'answer')) return;
    const answer = (value as { answer: unknown }).answer;
    return typeof answer === 'string' && answer.trim() ? answer : undefined;
  } catch { /* Incomplete JSON and ordinary prose remain untouched. */ }
}

/** Decode only a complete, single-field answer envelope, never prose/code escapes. */
export function normalizeAgentAnswerText(text: string): string {
  const answer = answerEnvelope(text);
  // Do not recursively peel nested data. Keep normalization idempotent across
  // the final gate, persisted reply and legacy-message presentation.
  return answer !== undefined && answerEnvelope(answer) === undefined ? answer : text;
}

/** Presentation-only compatibility for old chats; user/tool/code messages stay literal. */
export function agentMessageDisplayContent(message: Pick<LlmConversationMessage, 'role' | 'content' | 'toolCalls'>): string {
  return message.role === 'assistant' && !message.toolCalls?.length
    ? normalizeAgentAnswerText(message.content) : message.content;
}
