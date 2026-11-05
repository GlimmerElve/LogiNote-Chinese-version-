import type { LlmCallRequest } from '../../src/types';

/** Upgrade SYNTHETIC test verdicts to the live per-question transport. Correct
 * option IDs are an explicit test oracle, never taken from a generation key. */
export function quickCheckEvaluationFixture(request: LlmCallRequest, raw: any, correctOptions: Record<string, string> = { Q2: 'A', Q3: 'A' }) {
  const input = JSON.parse(request.userInput);
  return { protocol: 'quick-check-evaluation-v2', sessionId: input.sessionId,
    questionEvaluations: input.questionTasks.map((task: any) => {
      const ids = task.criteria.map((criterion: any) => criterion.id);
      const reference = input.references.find((reference: any) => task.task.verificationScopes[0].referenceIds.includes(reference.id));
      return { questionId: task.questionId,
        result: { ...raw, evaluationId: task.evaluationId,
          baselines: raw.baselines?.filter((baseline: any) => ids.includes(baseline.id)),
          criteria: raw.criteria?.filter((criterion: any) => ids.includes(criterion.id)) },
        ...(correctOptions[task.questionId] && reference ? { answerKey: { optionId: correctOptions[task.questionId],
          explanation: 'Synthetic independent answer oracle for transport/state tests only.',
          referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 160) }] } } : {}) };
    }) };
}
