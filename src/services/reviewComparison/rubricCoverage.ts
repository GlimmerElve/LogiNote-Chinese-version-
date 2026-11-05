import { bindReviewReferenceItems, parseReviewReferenceRubric } from '../reviewReferenceRubric';
import { REVIEW_SEMANTIC_CONFIDENCE } from './semanticValidation';
import type { ReviewComparisonPacket } from './types';
import type { ReviewAlignmentObservation, ReviewMasteryShadow, ReviewPerformanceGraph, ReviewReferenceCoverage, ReviewSemanticComparison } from './semanticTypes';
import type { ReviewCriterionId } from '../reviewAssessment';

const fits = (criterion: ReviewCriterionId, role: ReviewPerformanceGraph['claims'][number]['role']) => {
  switch (criterion) {
    case 'concept_meaning': return role === 'definition';
    case 'concept_boundary': return role === 'definition' || role === 'condition' || role === 'counterexample';
    case 'example_fit': return role === 'example' || role === 'counterexample';
    case 'distinction': return role === 'definition' || role === 'fact' || role === 'condition';
    case 'fact_scope': return role === 'fact' || role === 'premise' || role === 'conclusion';
    case 'condition_scope': return role === 'condition' || role === 'counterexample';
    case 'attribution_scope': return role === 'fact' || role === 'premise' || role === 'conclusion' || role === 'condition';
    case 'actual_premise': return role === 'premise';
    case 'inference_link': return false; // Requires a verified explicit relation, not isolated facts.
  }
};

/** No string similarity, keyword coverage, new LLM call, implicit error or real score. */
export function buildReviewReferenceCoverage(packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph,
  comparison: ReviewSemanticComparison, observations: ReviewAlignmentObservation[], row: ReviewMasteryShadow): ReviewReferenceCoverage {
  const rubric = parseReviewReferenceRubric(packet.questionIntent.referenceRubric, packet.questionIntent.assessment!, packet.questionIntent.knowledgeTargets);
  const items = rubric.items.filter((item) => item.knowledgeTarget === row.knowledgeTarget);
  const held = (reasons: string[]): ReviewReferenceCoverage => ({ scope: 'question_items', status: 'held',
    items: items.map((item) => ({ itemId: item.itemId, criterionId: item.criterionId, status: 'unobserved', reasons })), reasons });
  if (rubric.status !== 'fixed' || !items.length) return held(['question_reference_rubric_unavailable']);
  // Existing source compatibility, complete-context and channel safety gates remain in force.
  if (row.status === 'held') return held(row.reasons);
  if (packet.answer.hintLevel !== 0) return held(['independent_expression_unproven']);
  let bindings: ReturnType<typeof bindReviewReferenceItems>;
  try { bindings = bindReviewReferenceItems(packet); } catch { return held(['rubric_reference_outside_window']); }
  const results: ReviewReferenceCoverage['items'] = items.map((item) => {
    const base = { itemId: item.itemId, criterionId: item.criterionId };
    const unseen = (reason: string): ReviewReferenceCoverage['items'][number] => ({ ...base, status: 'unobserved', reasons: [reason] });
    const check = comparison.rubricChecks?.find((check) => check.itemId === item.itemId);
    if (!check || check.verdict === 'unobserved') return unseen('criterion_unobserved');
    if (check.confidence < REVIEW_SEMANTIC_CONFIDENCE) return unseen('low_criterion_confidence');
    const binding = bindings.find((b) => b.itemId === item.itemId)!;
    const grounded = (id: string, positive: boolean) => observations.some((o) => o.corpus === 'reference'
      && o.knowledgeTarget === item.knowledgeTarget && o.claimId === id && o.targetId === binding.sourceId && o.accepted && !!o.alignment
      && item.quote.includes(o.alignment.documentQuote)
      && (positive ? o.alignment.relation === 'consistent' : o.alignment.relation === 'contradiction'));
    if (check.verdict === 'contradicted') {
      if (!check.claimIds.length || !check.claimIds.every((id) => grounded(id, false))) return unseen('criterion_conflict_unproven');
      return { ...base, status: 'contradicted', reasons: ['grounded_criterion_conflict'] };
    }
    if (item.criterionId === 'inference_link') {
      if (!check.edgeIds.length || !check.edgeIds.every((edgeId) => row.layers.reasoning.observations.some((o) => o.kind === 'explicit_relation'
        && o.edgeId === edgeId && o.verdict === 'supported' && o.sourceIds.includes(binding.sourceId)))
        || !check.edgeIds.every((edgeId) => comparison.edgeChecks.some((e) => e.edgeId === edgeId && e.sourceId === binding.sourceId
          && item.quote.includes(e.referenceQuote)))) return unseen('criterion_relation_unproven');
    } else if (!check.claimIds.length || check.edgeIds.length || !check.claimIds.every((id) => {
      const claim = graph.claims.find((c) => c.id === id);
      return !!claim && fits(item.criterionId, claim.role) && grounded(id, true);
    })) return unseen('criterion_match_unproven');
    if (check.claimIds.some((id) => !grounded(id, true))) return unseen('criterion_match_unproven');
    return { ...base, status: 'covered', reasons: [] };
  });
  return { scope: 'question_items', status: results.every((item) => item.status === 'covered') ? 'complete' : 'partial',
    items: results, reasons: results.every((item) => item.status === 'covered') ? [] : ['question_items_not_fully_covered'] };
}
