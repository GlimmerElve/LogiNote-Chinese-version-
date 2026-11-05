import type { LlmCallRequest, LlmCallResponse } from '../../types';
import { callLLM } from '../llmService';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import type { ReviewSemanticModel } from './semanticTypes';
import { REVIEW_DUAL_ALIGNMENT_PROMPT, REVIEW_PERFORMANCE_GRAPH_PROMPT } from './semanticPrompts';
import { buildReviewBoundInput, readReviewBoundComparison, type ReviewComparisonProtocol } from './boundProtocol';
import { REVIEW_BOUND_ALIGNMENT_PROMPT } from './boundPrompts';
import { REVIEW_REFERENCE_ANCHORS_PROMPT, REVIEW_PERSONAL_ANCHORS_PROMPT } from './anchoredPrompts';

/** Reject malformed/truncated JSON instead of rescuing fragments into apparently valid evidence. */
export function readReviewModelJson(response: LlmCallResponse): unknown {
  if (['length', 'max_tokens', 'MAX_TOKENS'].includes(response.diagnostics?.finishReason || '') || typeof response.content !== 'string'
    || response.content.length > 100000 || !response.content.trim()) throw new Error('invalid_model_json');
  try { return JSON.parse(response.content); }
  catch { throw new Error('invalid_model_json'); }
}

/** Dormant adapter: only a deliberate caller runs it. Reuses review's provider, not its old scoring prompt. */
export function createReviewSemanticModel(
  caller: (request: LlmCallRequest, options?: { signal?: AbortSignal }) => Promise<LlmCallResponse> = callLLM,
  options: { comparisonProtocol?: ReviewComparisonProtocol } = {},
): ReviewSemanticModel {
  const comparisonProtocol = options.comparisonProtocol || 'legacy-v1';
  const request = async (systemPrompt: string, input: unknown, maxTokens: number, signal?: AbortSignal) =>
    readReviewModelJson(await caller({
      providerId: '', model: '', workflow: 'review-scoring', userInput: JSON.stringify(input),
      systemPromptOverride: systemPrompt, outputSchema: JSON_OBJECT_OUTPUT, maxTokensOverride: maxTokens,
      skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled',
    }, { signal }));
  return {
    ...(comparisonProtocol === 'isolated-anchors-v3' ? { protocol: 'isolated-anchors-v3' as const,
      reviewReference: (input, signal) => request(REVIEW_REFERENCE_ANCHORS_PROMPT, input, 8192, signal),
      reviewPersonal: (input, signal) => request(REVIEW_PERSONAL_ANCHORS_PROMPT, input, 8192, signal) } : {}),
    extract: (input, signal) => request(REVIEW_PERFORMANCE_GRAPH_PROMPT, input, 4096, signal),
    compare: async (input, signal) => {
      if (comparisonProtocol === 'isolated-anchors-v3') throw new Error('split_protocol_requires_engine');
      if (comparisonProtocol !== 'bound-v2') return request(REVIEW_DUAL_ALIGNMENT_PROMPT, input, 8192, signal);
      const frozen = structuredClone(input);
      const binding = await buildReviewBoundInput(frozen.packet, frozen.graph);
      if (signal?.aborted) throw new Error('semantic_aborted');
      const raw = await request(REVIEW_BOUND_ALIGNMENT_PROMPT, binding, 8192, signal);
      return readReviewBoundComparison(raw, frozen.packet, frozen.graph);
    },
  };
}
