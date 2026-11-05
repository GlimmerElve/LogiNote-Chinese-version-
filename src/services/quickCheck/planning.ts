import { masteryShadowCriterion } from '../masteryShadow/rubric';
import type { QuickCheckDesign, QuickCheckHistoryItem, QuickCheckOperation, QuickCheckQuestion, QuickCheckTarget } from './types';

export const QUICK_CHECK_OPERATIONS: Record<QuickCheckOperation, string> = {
  contrast: '比较两个关键条件不同的案例，指出决定结论差异的条件；闭合题选择能区分两案的判断',
  counterfactual: '改变或移除一个关键条件，判断原结论是否仍成立；不能只再解释原机制',
  diagnose: '定位一个具体判断或解法的错误，说明或选择为什么错以及如何修正',
  construct: '构造满足明确约束的例子、反例或操作方案；闭合题选择真正满足约束的一项',
  predict: '依据给定条件预测变化、计算或推出结果；需使用具体题设，不预先告知结论',
  evidence_gap: '判断现有证据能支持到哪一步，指出缺失的信息、关键前提或额外依据',
  design_test: '设计或选择能区分竞争解释、检验结论的比较、检验步骤或补充观察',
  revise: '把存在范围、条件、归属或推导问题的表述改写成有据的版本；闭合题选择恰当修订',
};
const preferences: Record<string, QuickCheckOperation[]> = {
  concept_accuracy: ['contrast', 'revise', 'construct', 'diagnose', 'predict', 'counterfactual'],
  concept_boundary: ['counterfactual', 'construct', 'contrast', 'diagnose', 'revise', 'evidence_gap'],
  concept_application: ['construct', 'predict', 'design_test', 'counterfactual', 'diagnose', 'contrast'],
  judgment_accuracy: ['diagnose', 'contrast', 'predict', 'evidence_gap', 'counterfactual', 'revise'],
  judgment_conditions: ['counterfactual', 'revise', 'contrast', 'evidence_gap', 'construct', 'diagnose'],
  judgment_attribution: ['revise', 'diagnose', 'contrast', 'evidence_gap', 'construct', 'counterfactual'],
  reasoning_relevance: ['contrast', 'diagnose', 'design_test', 'revise', 'evidence_gap', 'counterfactual'],
  reasoning_sufficiency: ['evidence_gap', 'design_test', 'counterfactual', 'construct', 'diagnose', 'contrast'],
  reasoning_consistency: ['diagnose', 'revise', 'construct', 'counterfactual', 'contrast', 'predict'],
};

export function validQuickCheckDesign(value: unknown): value is QuickCheckDesign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.operation === 'string' && Object.hasOwn(QUICK_CHECK_OPERATIONS, row.operation)
    && ([['scenario', 100], ['focus', 80], ['requiredDetail', 120]] as const).every(([key, max]) =>
      typeof row[key] === 'string' && !!row[key].trim() && row[key].length <= Number(max));
}

export function validQuickCheckHistory(value: unknown): value is QuickCheckHistoryItem[] {
  return Array.isArray(value) && value.length <= 6 && value.every(row => row && typeof row === 'object'
    && typeof row.prompt === 'string' && !!row.prompt.trim() && row.prompt.length <= 800
    && Array.isArray(row.criterionIds) && row.criterionIds.length > 0 && row.criterionIds.length <= 3
    && row.criterionIds.every((id: string) => !!masteryShadowCriterion(id))
    && (row.design === undefined || validQuickCheckDesign(row.design))
    && (row.gaps === undefined || Array.isArray(row.gaps) && row.gaps.length <= 3
      && row.gaps.every((gap: any) => gap && row.criterionIds.includes(gap.id) && typeof gap.summary === 'string' && gap.summary.length <= 120)));
}

/** Choose the cognitive operation locally; the model chooses a source-supported
 * new domain, case and indispensable details. No forced real-world story for a
 * formal proof, no extra model call, and no source-independent truth judgment. */
export function quickCheckQuestionPlans(targets: QuickCheckTarget[], slots: string[], history: QuickCheckHistoryItem[], retained: QuickCheckQuestion[]) {
  const used = new Set(retained.flatMap(question => question.design ? [question.design.operation] : []));
  const reasoning = targets.find(target => target.layer === 'reasoning');
  const order = reasoning ? [reasoning, ...targets.filter(target => target.id !== reasoning.id)] : targets;
  return slots.map(id => {
    const index = Number(id.slice(1)) - 1;
    const target = order[index % order.length];
    const preferred = [...preferences[target.id]];
    if (target.state === 'needs_review') preferred.sort((a, b) => Number(['diagnose', 'revise'].includes(b)) - Number(['diagnose', 'revise'].includes(a)));
    const latestUse = (operation: QuickCheckOperation) => {
      let found = -1;
      history.forEach((item, index) => { if (item.design?.operation === operation) found = index; });
      return found < 0 ? -1 : found;
    };
    const operation = preferred.map((operation, index) => ({ operation, index })).sort((a, b) =>
      Number(used.has(a.operation)) - Number(used.has(b.operation)) || latestUse(a.operation) - latestUse(b.operation) || a.index - b.index)[0].operation;
    used.add(operation);
    const latestGap = [...history].reverse().flatMap(item => item.gaps || []).find(gap => gap.id === target.id)?.summary;
    return { questionId: id, primaryCriterionId: target.id, operation, instruction: QUICK_CHECK_OPERATIONS[operation],
      purpose: target.state === 'provisional' ? '用不同场景和不同检验任务独立确认，不重做上次同一命题'
        : target.state === 'needs_review' ? '围绕已核验的具体缺口换题验证，不默认用户仍会犯错' : '提供本分项的实质观察机会，不先给出待判断结论',
      ...(latestGap ? { gapToProbe: latestGap } : {}) };
  });
}
