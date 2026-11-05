import type { LlmCallRequest, LlmCallResponse } from '../../types';
import { callLLM } from '../llmService';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { readReviewModelJson } from './semanticClient';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT } from './frozenExtractionPrompt';
import { createFrozenReferenceShadowModel } from './frozenReferenceModel';
import { evaluateFrozenReviewReferenceShadow, FROZEN_SELECTED_ENDPOINT_POLICY,
  type FrozenReferenceShadowDependencies, type FrozenReferenceShadowModel } from './frozenReferenceShadow';
import type { ReviewComparisonAnswer } from './types';

/** Dormant opt-in factory. Creation sends nothing, and legacy v4 stays byte-identical. */
export function createFrozenAtomicReferenceShadowModel(
  caller: (request: LlmCallRequest, options?: { signal?: AbortSignal }) => Promise<LlmCallResponse> = callLLM,
): FrozenReferenceShadowModel {
  const legacy = createFrozenReferenceShadowModel(caller);
  return { ...legacy, extract: async (input, signal) => readReviewModelJson(await caller({
    providerId: '', model: '', workflow: 'review-scoring', userInput: JSON.stringify(input),
    systemPromptOverride: FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT, outputSchema: JSON_OBJECT_OUTPUT,
    maxTokensOverride: 4096, thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true,
  }, { signal })) };
}

/**
 * Explicit experiment/service entry only, not a UI or score adapter. This checks
 * selected inference endpoints, not truth, learning or reference atomicity.
 * Reference proposition anchors need a separately retained, authenticated
 * pre-question bundle before any future model-facing integration.
 */
export function evaluateFrozenAtomicReviewReferenceShadow(
  answer: ReviewComparisonAnswer, dependencies: FrozenReferenceShadowDependencies, model: FrozenReferenceShadowModel,
  options: { signal?: AbortSignal; timeoutMs?: number; readTimeoutMs?: number } = {},
) {
  return evaluateFrozenReviewReferenceShadow(answer, dependencies, model,
    { ...options, inferenceAtomicity: FROZEN_SELECTED_ENDPOINT_POLICY });
}
