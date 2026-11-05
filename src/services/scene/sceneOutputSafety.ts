import type { LlmCallResponse } from '../../types';

/** Providers use different spellings; valid JSON does not prove the output is complete. */
export function isSceneOutputTruncated(response: LlmCallResponse): boolean {
  const reason = response.diagnostics?.finishReason?.trim().toLowerCase().replace(/[-\s]+/gu, '_');
  return Boolean(reason && ['length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'token_limit'].includes(reason));
}
