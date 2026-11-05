import type { ReviewComparisonPacket } from './types';
import { incompleteReviewReferenceContext } from './referenceScope';
import type { CognitionGrowthProposal, ReviewAlignmentObservation, ReviewEvidenceLayer, ReviewLayerShadow,
  ReviewMasteryShadow, ReviewPerformanceGraph, ReviewSemanticComparison, ReviewSemanticResult } from './semanticTypes';
import { REVIEW_SEMANTIC_CONFIDENCE } from './semanticValidation';
import { reviewSnapshotHash } from './packet';
import { checkArgumentDirection } from '../argumentRelation/direction';
import { frozenReviewRequirements } from './performanceGraph';
import { buildReviewReferenceCoverage } from './rubricCoverage';

function edgeDirectionAccepted(
  edge: ReviewPerformanceGraph['edges'][number], graph: ReviewPerformanceGraph,
  check: ReviewSemanticComparison['edgeChecks'][number],
): boolean {
  try {
    return checkArgumentDirection({ id: edge.id,
      sentences: graph.claims.map((claim) => ({ id: claim.id, text: claim.quote })),
      sourceSentenceIds: [edge.source], targetSentenceIds: [edge.target] },
    { id: edge.id, label: edge.relation, evidenceSentenceIds: [edge.source, edge.target], explanation: '' },
    { direction: check.direction, basisSentenceIds: [check.basisClaimId], conclusionSentenceIds: [check.conclusionClaimId],
      premiseStatus: check.premiseStatus }).status === 'accepted';
  } catch { return false; }
}

export async function buildCognitionGrowthProposals(
  packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph, comparison: ReviewSemanticComparison,
  observations: ReviewAlignmentObservation[],
): Promise<ReviewSemanticResult['growth']> {
  const target = packet.questionIntent.cognitionTarget;
  const reasons = [...packet.preparation.growthReasons];
  if (!target || !packet.personal.branchHash) reasons.push('no_cognition_target');
  if (target && packet.personal.reviewNeededNodeIds?.includes(target.nodeId)) reasons.push('target_needs_review');
  if (reasons.length) return { status: 'held', reasons: [...new Set(reasons)], proposals: [] };
  const proposals: CognitionGrowthProposal[] = [];
  const personal = observations.filter((item) => item.corpus === 'personal');
  for (const item of personal) {
    if (!item.accepted || !item.alignment) continue;
    const alignment = item.alignment;
    const claim = graph.claims.find((value) => value.id === item.claimId)!;
    // Intent alone is not a link. Require an independently returned, grounded, sufficient direction check.
    const link = comparison.personalLinks.find((value) => value.claimId === claim.id
      && alignment.personalQuote.includes(value.personalQuote) && alignment.documentQuote.includes(value.answerQuote)
      && value.confidence >= REVIEW_SEMANTIC_CONFIDENCE && value.premiseStatus === 'sufficient'
      && ((value.direction === 'answer_to_personal' && value.basis === 'answer' && value.conclusion === 'personal')
        || (value.direction === 'personal_to_answer' && value.basis === 'personal' && value.conclusion === 'answer'))
      && (value.relation === 'oppose' ? alignment.relation === 'contradiction'
        : alignment.relation === 'supplement' || (alignment.relation === 'consistent' && value.direction === 'answer_to_personal')));
    const operation: CognitionGrowthProposal['operation'] | undefined = alignment.relation === 'supplement'
      || (alignment.relation === 'consistent' && link) ? 'supplement'
      : alignment.relation === 'condition_difference' ? 'contextual'
        : alignment.relation === 'contradiction' ? 'review_conflict'
          : alignment.relation === 'certainty_change' ? 'certainty_review' : undefined;
    if (!operation) continue;
    if (operation === 'supplement' && packet.personal.graph!.nodes.some((node) => node.text === claim.quote)) continue;
    const body = { version: 1 as const, packetId: packet.packetId, messageId: packet.messageId,
      status: 'pending_confirmation' as const, target: structuredClone(target!), branchHash: packet.personal.branchHash!,
      operation, preserveOriginal: true as const, claim: structuredClone(claim), alignment: structuredClone(alignment),
      ...(link ? { link: structuredClone(link) } : {}),
      authorship: packet.answer.hintLevel === 0 ? 'own_expression' as const : 'adopted_with_assistance' as const };
    const proposalId = `cognition-growth:${await reviewSnapshotHash(body)}`;
    proposals.push({ ...body, proposalId });
  }
  const rejected = personal.filter((item) => !item.accepted).map((item) => item.code);
  if (proposals.length) return { status: 'proposed', reasons: [...new Set(rejected)], proposals };
  return { status: personal.length && !rejected.length ? 'no_change' : 'held',
    reasons: [...new Set(rejected.length ? rejected : personal.length ? [] : ['personal_alignment_unobserved'])], proposals: [] };
}

const layers = ['concept', 'judgment', 'reasoning'] as const;
const claimLayer = (role: ReviewPerformanceGraph['claims'][number]['role']): ReviewEvidenceLayer =>
  ['definition', 'example', 'counterexample'].includes(role) ? 'concept' : 'judgment';

/** Deterministic evidence projection only. Missing content never becomes an error or a score delta. */
function buildLayerMasteryShadow(
  packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph, comparison: ReviewSemanticComparison,
  observations: ReviewAlignmentObservation[],
): ReviewMasteryShadow[] {
  const requirements = frozenReviewRequirements(packet) ?? graph.requirements;
  return packet.questionIntent.knowledgeTargets.map((knowledgeTarget) => {
    const required = new Set(requirements.filter((r) => r.knowledgeTarget === knowledgeTarget).map((r) => r.layer));
    const resultLayers = Object.fromEntries(layers.map((layer) => [layer, {
      status: required.has(layer) ? 'unassessed' : 'not_required', observations: [], reasons: [],
    }])) as Record<ReviewEvidenceLayer, ReviewLayerShadow>;
    const reasons = [...packet.preparation.masteryReasons];
    if (packet.questionIntent.assessment?.status === 'unavailable') reasons.push('question_assessment_unavailable');
    if (packet.questionIntent.assessment?.status === 'not_assessed') reasons.push('question_not_assessed');
    if (!required.size) reasons.push('question_requirement_unobserved');
    if (packet.coverage.missingTargetNames.includes(knowledgeTarget)) reasons.push('target_reference_missing');
    if (comparison.referenceAudit.status !== 'compatible') reasons.push(comparison.referenceAudit.status === 'conflict' ? 'reference_conflict' : 'reference_compatibility_unknown');
    // Whole-note evidence still requires complete context. A frozen question-items rubric
    // certifies only its selected intervals, never the remainder of the knowledge point.
    if (packet.references.some(source => incompleteReviewReferenceContext(packet, source))) reasons.push('incomplete_reference_context');
    if (reasons.length) {
      for (const layer of layers) if (required.has(layer)) resultLayers[layer].reasons = [...new Set(reasons)];
      return { knowledgeTarget, status: 'held', reasons: [...new Set(reasons)], layers: resultLayers, scoreWrite: 'disabled' };
    }
    const relevant = observations.filter((item) => item.corpus === 'reference' && item.knowledgeTarget === knowledgeTarget);
    const conflicted = new Set(graph.claims.filter((claim) => {
      const relations = relevant.filter((a) => a.claimId === claim.id && a.accepted).map((a) => a.alignment!.relation);
      return relations.includes('consistent') && (relations.includes('contradiction') || relations.includes('certainty_change'));
    }).map((claim) => claim.id));
    if (conflicted.size) {
      for (const layer of layers) if (required.has(layer)) resultLayers[layer].reasons = ['reference_conflict'];
      return { knowledgeTarget, status: 'held', reasons: ['reference_conflict'], layers: resultLayers, scoreWrite: 'disabled' };
    }
    const usedClaims = new Set<string>();
    for (const item of relevant) {
      const claim = graph.claims.find((c) => c.id === item.claimId)!;
      const layer = item.alignment?.relation === 'certainty_change' ? 'judgment' : claimLayer(claim.role);
      if (!required.has(layer)) continue;
      if (!item.accepted || !item.alignment) { resultLayers[layer].reasons.push(item.code); continue; }
      const relation = item.alignment.relation;
      if (!['consistent', 'contradiction', 'certainty_change'].includes(relation)) {
        resultLayers[layer].reasons.push('reference_relation_not_support'); continue;
      }
      if (relation === 'consistent' && packet.answer.hintLevel >= 3) {
        resultLayers[layer].reasons.push('assisted_positive_held'); continue;
      }
      const key = `${layer}:${claim.id}:${relation === 'consistent' ? 'supported' : 'contradicted'}`;
      // Multiple agreeing sources do not multiply performance evidence.
      if (usedClaims.has(key)) continue;
      usedClaims.add(key);
      resultLayers[layer].observations.push({ kind: 'claim_alignment', claimIds: [claim.id], sourceIds: [item.targetId],
        verdict: relation === 'consistent' ? 'supported' : 'contradicted' });
    }
    if (required.has('reasoning')) {
      for (const check of comparison.edgeChecks.filter((c) => c.knowledgeTarget === knowledgeTarget)) {
        const edge = graph.edges.find((e) => e.id === check.edgeId)!;
        const supported = (id: string) => relevant.some((a) => a.claimId === id && a.targetId === check.sourceId
          && a.accepted && a.alignment?.relation === 'consistent' && check.referenceQuote.includes(a.alignment.documentQuote));
        const source = packet.references.find((s) => s.sourceId === check.sourceId)!;
        if (check.verdict !== 'supported' || check.relation !== edge.relation
          || !edgeDirectionAccepted(edge, graph, check) || check.confidence < REVIEW_SEMANTIC_CONFIDENCE
          || incompleteReviewReferenceContext(packet, source) || !supported(edge.source) || !supported(edge.target)) {
          resultLayers.reasoning.reasons.push('edge_not_established'); continue;
        }
        if (packet.answer.hintLevel >= 3) { resultLayers.reasoning.reasons.push('assisted_positive_held'); continue; }
        resultLayers.reasoning.observations.push({ kind: 'explicit_relation', claimIds: [edge.source, edge.target],
          edgeId: edge.id, sourceIds: [source.sourceId], verdict: 'supported' });
      }
    }
    for (const layer of layers) {
      const row = resultLayers[layer];
      if (!required.has(layer)) continue;
      const positive = row.observations.some((o) => o.verdict === 'supported');
      const negative = row.observations.some((o) => o.verdict === 'contradicted');
      row.status = positive && negative ? 'mixed' : positive ? 'supported' : negative ? 'contradicted' : 'unassessed';
      if (!row.observations.length) row.reasons.push('evidence_unobserved');
      row.reasons = [...new Set(row.reasons)];
    }
    const observed = layers.some((layer) => resultLayers[layer].observations.length);
    return { knowledgeTarget, status: observed ? 'evidence_ready' : 'held', reasons: observed ? [] : ['evidence_unobserved'],
      layers: resultLayers, scoreWrite: 'disabled' };
  });
}

export function buildReviewMasteryShadow(packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph,
  comparison: ReviewSemanticComparison, observations: ReviewAlignmentObservation[]): ReviewMasteryShadow[] {
  const rows = buildLayerMasteryShadow(packet, graph, comparison, observations);
  if (!packet.questionIntent.referenceRubric) return rows;
  return rows.map((row) => ({ ...row, referenceCoverage: buildReviewReferenceCoverage(packet, graph, comparison, observations, row) }));
}
