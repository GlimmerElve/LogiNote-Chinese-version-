import type { LlmCallRequest } from '../../src/types';
import { flowMasteryTextKey } from '../../src/services/masteryShadow/sourceKey';
import { generateQuickCheck, type QuickCheckGenerateOptions } from '../../src/services/quickCheck';

/** Old transport/state fixtures assume fixed A/B answers. Keep those tests
 * deterministic; actual shuffling is exhaustively checked in its own suite. */
export function generateQuickCheckFixture(options: QuickCheckGenerateOptions) {
  return generateQuickCheck({ ...options, optionRandomInt: options.optionRandomInt || (upperBound => upperBound - 1) });
}

/** Transport fixture only: these opaque synthetic labels do NOT prove semantic
 * diversity. Real task/case acceptance must inspect actual model questions. */
export function quickCheckDesignFixture<T extends { questions: any[] }>(request: LlmCallRequest, raw: T) {
  const input = JSON.parse(request.userInput);
  return { ...raw, protocol: 'quick-check-card-v2', questions: raw.questions.map(question => ({ ...question,
    design: { operation: input.questionPlans.find((plan: any) => plan.questionId === question.id).operation,
      scenario: `合成契约场景 ${flowMasteryTextKey(question.prompt)}`,
      focus: `合成契约检验分界 ${question.id} ${flowMasteryTextKey(question.prompt)}`,
      requiredDetail: '只用于验证协议、缓存及状态流转，不代表真实出题质量。' } })) };
}
