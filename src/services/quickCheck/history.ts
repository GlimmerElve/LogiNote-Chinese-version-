import type { QuickCheckAssessment, QuickCheckHistoryItem, QuickCheckSession } from './types';

/** Whitelist history fields; neither cached extras nor old private answers can
 * leak into a future generation request. History guides questions, not grading. */
export function quickCheckHistorySnapshot(items: QuickCheckHistoryItem[]): QuickCheckHistoryItem[] {
  return items.map(item => ({ prompt: item.prompt, criterionIds: [...item.criterionIds],
    ...(item.design ? { design: { operation: item.design.operation, scenario: item.design.scenario,
      focus: item.design.focus, requiredDetail: item.design.requiredDetail } } : {}),
    ...(item.gaps?.length ? { gaps: item.gaps.map(gap => ({ id: gap.id, summary: gap.summary })) } : {}) }));
}

export function appendQuickCheckHistory(previous: QuickCheckHistoryItem[] = [], session?: QuickCheckSession, assessment?: QuickCheckAssessment) {
  const current: QuickCheckHistoryItem[] = session?.questions.map(question => {
    const evaluation = assessment?.questionEvaluations?.find(row => row.questionId === question.id)?.evaluation;
    const gaps = (evaluation?.criteria || []).filter(criterion => question.criterionIds.includes(criterion.id)
      && ['fail', 'partial'].includes(criterion.state)).slice(0, 3).map(criterion => ({ id: criterion.id, summary: criterion.reason.slice(0, 120) }));
    return { prompt: question.prompt, criterionIds: question.criterionIds, design: question.design, ...(gaps.length ? { gaps } : {}) };
  }) || [];
  const merged = new Map<string, QuickCheckHistoryItem>();
  for (const item of [...previous, ...current]) { merged.delete(item.prompt); merged.set(item.prompt, item); }
  return quickCheckHistorySnapshot([...merged.values()].slice(-6));
}
