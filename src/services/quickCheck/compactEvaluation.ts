import { restoredReferenceQuote, type MasteryShadowEvaluationInput } from '../masteryShadow/evaluator';
import type { QuickCheckSession } from './types';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Compact transport only. The existing semantic/grounding validator remains
 * authoritative on evaluation, save and replay. Bind only immutable coordinates;
 * never infer applicability, coverage, truth, rules or contradictions locally. */
export function expandQuickCheckEvaluation(raw: Record<string, any>, session: QuickCheckSession, input: MasteryShadowEvaluationInput) {
  if (raw.protocol !== 'quick-check-evaluation-v3') return raw;
  if (raw.sessionId !== session.id || !Array.isArray(raw.questionEvaluations))
    throw new Error('简测评价响应与当前卡片不匹配，请重试。');
  return { ...raw, protocol: 'quick-check-evaluation-v2', questionEvaluations: raw.questionEvaluations.map((value: unknown) => {
    const row = record(value), question = session.questions.find(question => question.id === row.questionId);
    const scope = input.task.verificationScopes?.find(scope => scope.id === row.questionId);
    if (!question || !scope) throw new Error('简测逐题评价的题号不匹配。');
    const items = Array.isArray(row.criteria) ? row.criteria : [];
    const ids = items.map((value: unknown) => record(value).id);
    // A corrupt known question becomes a missing local result, not a verdict.
    // Other questions remain parseable. Never pick a winner among duplicate IDs.
    const validItems = new Set(ids).size === ids.length && ids.every((id: any) => question.criterionIds.includes(id)) ? items : [];
    const evidence: Array<{ id: string; quote: string }> = [];
    const baselines: Record<string, unknown>[] = [];
    const criteria = validItems.map((value: unknown, index: number) => {
      const criterion = record(value), baseline = record(criterion.baseline);
      const evidenceIds = (Array.isArray(criterion.evidenceQuotes) ? criterion.evidenceQuotes : []).slice(0, 3).map((quote: unknown, offset: number) => {
        const id = `E${index + 1}-${offset + 1}`, text = typeof quote === 'string' ? quote.trim() : '';
        evidence.push({ id, quote: restoredReferenceQuote(scope.answer, text) || text });
        return id;
      });
      const referenceQuotes = Array.isArray(baseline.referenceQuotes) ? baseline.referenceQuotes : [];
      const referenceIds = [...new Set(referenceQuotes.map((value: unknown) => record(value).referenceId))];
      baselines.push({ ...baseline, reason: baseline.reason || criterion.reason, id: criterion.id, scopeIds: [question.id], referenceIds, referenceQuotes });
      const comparison = record(criterion.comparison);
      return { id: criterion.id, state: criterion.state, reason: criterion.reason, evidenceIds,
        ...(criterion.comparison ? { comparison: { ...comparison, evidenceIds, referenceIds, scopeIds: [question.id] } } : {}) };
    });
    return { questionId: question.id, answerKey: row.answerKey,
      result: { protocol: 'mastery-shadow-evaluator-v1', evaluationId: `${input.evaluationId}:${question.id}`,
        knowledgePointId: input.knowledgePointId, evidence, baselines, criteria, summary: row.summary || '' } };
  }) };
}
