import type { LlmProvider, LlmThinkingPreference } from '../../types';
import { requireLlmModel } from '../llmModelSelection';
import { resolveLlmThinkingPolicy } from '../llmThinkingPolicy';
import { resolveLlmOutputBudget } from '../llmOutputBudget';

export interface InteractiveFigureBudget { configuration: number; html: number }
/** Shared by approval and execution: totals already include any reasoning. */
export function resolveInteractiveFigureBudget(provider: LlmProvider, preference: LlmThinkingPreference = 'default'): InteractiveFigureBudget {
  const model = requireLlmModel(provider);
  const glmResponse = resolveLlmThinkingPolicy(provider, model, 'disabled').reasoningEffort === 'low';
  return { configuration: resolveLlmOutputBudget(provider, model, 4096, 'response', preference),
    html: resolveLlmOutputBudget(provider, model, glmResponse ? 6144 : 4096, 'response', preference) };
}
