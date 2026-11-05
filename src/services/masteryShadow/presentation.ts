import type { MasteryShadowEvaluationResult, MasteryShadowReferenceItem } from './evaluator';
import { MASTERY_SHADOW_CRITERIA } from './rubric';
import type { MasteryShadowLayer, MasteryShadowPresentation } from './types';

/** Preserve the existing evaluation's display evidence without rescoring or model calls. */
export function masteryLayerAssessment(
  item: { evaluation?: MasteryShadowEvaluationResult; references: MasteryShadowReferenceItem[] },
  layer: MasteryShadowLayer,
): MasteryShadowPresentation['layers'][MasteryShadowLayer]['assessment'] {
  if (!item.evaluation) return undefined;
  const criteria = MASTERY_SHADOW_CRITERIA.filter(definition => definition.layer === layer)
    .flatMap(definition => {
      const result = item.evaluation!.criteria.find(criterion => criterion.id === definition.id);
      return result ? [{ ...result, label: definition.label }] : [];
    });
  const evidenceIds = new Set(criteria.flatMap(criterion => criterion.evidenceIds));
  const referenceIds = new Set(criteria.flatMap(criterion => criterion.referenceIds));
  return {
    criteria: criteria.map(({ id, label, state, reason, referenceQuotes }) => ({ id, label, state, reason,
      ...(referenceQuotes?.length ? { referenceQuotes } : {}) })),
    evidence: item.evaluation.evidence.filter(evidence => evidenceIds.has(evidence.id))
      .map(({ id, quote }) => ({ id, quote })),
    references: item.references.filter(reference => referenceIds.has(reference.id))
      .map(({ id, sourceLabel, locator, quote }) => ({ id, label: sourceLabel, locator, quote })),
  };
}
