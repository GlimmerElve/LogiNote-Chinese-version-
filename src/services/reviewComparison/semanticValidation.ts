import { validateGroundedAlignment } from '../cognition/alignment';
import type { ReviewComparisonPacket } from './types';
import { incompleteReviewReferenceContext } from './referenceScope';
import type { ReviewAlignmentObservation, ReviewClaimAlignment, ReviewPerformanceGraph,
  ReviewSemanticComparison, ReviewEdgeCheck, ReviewPersonalLink } from './semanticTypes';
import { semanticArray, semanticObject } from './performanceGraph';
import type { ReviewReferenceCriterionCheck } from './semanticTypes';

export const REVIEW_SEMANTIC_CONFIDENCE = 0.85;
const confidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const quote = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 600;

export function readReviewSemanticComparison(
  raw: unknown, packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph, personalChannelOnly = false,
): ReviewSemanticComparison {
  const root = semanticObject(raw);
  if (root.version !== 1 || root.packetId !== packet.packetId) throw new Error('wrong_semantic_packet');
  const audit = semanticObject(root.referenceAudit);
  const sourceIds = semanticArray(audit.sourceIds, 7);
  if (!['compatible', 'conflict', 'unknown'].includes(audit.status as string)
    || sourceIds.some((id) => typeof id !== 'string') || new Set(sourceIds).size !== sourceIds.length
    || JSON.stringify([...sourceIds].sort()) !== JSON.stringify(packet.references.map((s) => s.sourceId).sort())) {
    throw new Error('incomplete_reference_audit');
  }
  const seen = new Set<string>();
  const alignments = semanticArray(root.alignments, 36).map((item) => {
    const value = semanticObject(item);
    if (typeof value.claimId !== 'string' || !graph.claims.some((claim) => claim.id === value.claimId)
      || !['personal', 'reference'].includes(value.corpus as string) || typeof value.targetId !== 'string'
      || !confidence(value.confidence)) throw new Error('invalid_alignment_target');
    if (value.corpus === 'personal') {
      if (packet.personal.status !== 'ready' || value.targetId !== packet.questionIntent.cognitionTarget?.nodeId
        || !packet.personal.graph?.nodes.some((node) => node.id === value.targetId)
        || value.knowledgeTarget !== undefined) throw new Error('invalid_personal_target');
    } else if (!packet.references.some((source) => source.sourceId === value.targetId)
      || typeof value.knowledgeTarget !== 'string' || !packet.questionIntent.knowledgeTargets.includes(value.knowledgeTarget)) {
      throw new Error('invalid_reference_target');
    }
    const key = JSON.stringify([value.claimId, value.corpus, value.targetId, value.knowledgeTarget]);
    if (seen.has(key)) throw new Error('duplicate_alignment');
    seen.add(key);
    // Relation/axes/quotes are projected only after the shared grounding gate below.
    return { claimId: value.claimId, corpus: value.corpus, targetId: value.targetId,
      ...(value.corpus === 'reference' ? { knowledgeTarget: value.knowledgeTarget } : {}),
      confidence: value.confidence, relation: value.relation, personalQuote: value.personalQuote,
      documentQuote: value.documentQuote, axes: value.axes, sourcesCompatible: value.sourcesCompatible,
      ...(value.relationBasis === undefined ? {} : { relationBasis: value.relationBasis }) } as ReviewClaimAlignment;
  });
  const edgeSeen = new Set<string>();
  const edgeChecks = semanticArray(root.edgeChecks, 16).map((item): ReviewEdgeCheck => {
    const value = semanticObject(item);
    if (typeof value.edgeId !== 'string' || !graph.edges.some((edge) => edge.id === value.edgeId)
      || edgeSeen.has(value.edgeId) || typeof value.knowledgeTarget !== 'string'
      || !packet.questionIntent.knowledgeTargets.includes(value.knowledgeTarget)
      || typeof value.sourceId !== 'string' || !packet.references.some((source) => source.sourceId === value.sourceId)
      || !quote(value.referenceQuote) || !packet.references.find((source) => source.sourceId === value.sourceId)!.text.includes(value.referenceQuote)
      || !['support', 'oppose'].includes(value.relation as string)
      || !['supported', 'contradicted', 'unverifiable'].includes(value.verdict as string)
      || !['source_to_target', 'target_to_source', 'undetermined'].includes(value.direction as string)
      || typeof value.basisClaimId !== 'string' || !graph.claims.some((claim) => claim.id === value.basisClaimId)
      || typeof value.conclusionClaimId !== 'string' || !graph.claims.some((claim) => claim.id === value.conclusionClaimId)
      || !['sufficient', 'missing'].includes(value.premiseStatus as string) || !confidence(value.confidence)) throw new Error('invalid_edge_check');
    edgeSeen.add(value.edgeId);
    return { edgeId: value.edgeId, knowledgeTarget: value.knowledgeTarget, sourceId: value.sourceId,
      referenceQuote: value.referenceQuote, direction: value.direction as ReviewEdgeCheck['direction'],
      relation: value.relation as ReviewEdgeCheck['relation'], verdict: value.verdict as ReviewEdgeCheck['verdict'],
      basisClaimId: value.basisClaimId, conclusionClaimId: value.conclusionClaimId,
      premiseStatus: value.premiseStatus as ReviewEdgeCheck['premiseStatus'], confidence: value.confidence };
  });
  const linkSeen = new Set<string>();
  const personalLinks = semanticArray(root.personalLinks, 12).map((item): ReviewPersonalLink => {
    const value = semanticObject(item);
    const claim = graph.claims.find((c) => c.id === value.claimId);
    const node = packet.personal.graph?.nodes.find((n) => n.id === value.targetNodeId);
    if (!claim || !node || packet.personal.status !== 'ready' || value.targetNodeId !== packet.questionIntent.cognitionTarget?.nodeId
      || linkSeen.has(claim.id) || !quote(value.answerQuote) || !claim.quote.includes(value.answerQuote)
      || !quote(value.personalQuote) || !node.text.includes(value.personalQuote)
      || !['support', 'oppose'].includes(value.relation as string)
      || !['answer_to_personal', 'personal_to_answer', 'undetermined'].includes(value.direction as string)
      || !['answer', 'personal'].includes(value.basis as string) || !['answer', 'personal'].includes(value.conclusion as string)
      || !['sufficient', 'missing'].includes(value.premiseStatus as string) || !confidence(value.confidence)) throw new Error('invalid_personal_link');
    linkSeen.add(claim.id);
    return { claimId: claim.id, targetNodeId: node.id, answerQuote: value.answerQuote, personalQuote: value.personalQuote,
      relation: value.relation as ReviewPersonalLink['relation'], direction: value.direction as ReviewPersonalLink['direction'],
      basis: value.basis as ReviewPersonalLink['basis'], conclusion: value.conclusion as ReviewPersonalLink['conclusion'],
      premiseStatus: value.premiseStatus as ReviewPersonalLink['premiseStatus'], confidence: value.confidence };
  });
  const rubric = packet.questionIntent.referenceRubric;
  let rubricChecks: ReviewReferenceCriterionCheck[] | undefined;
  if (personalChannelOnly && (alignments.some((item) => item.corpus !== 'personal') || root.rubricChecks !== undefined)) throw new Error('invalid_rubric_check');
  if (rubric?.status === 'fixed' && !personalChannelOnly) {
    const seen = new Set<string>();
    rubricChecks = semanticArray(root.rubricChecks, 12).map((raw) => {
      const check = semanticObject(raw), item = rubric.items.find((item) => item.itemId === check.itemId);
      const claimIds = semanticArray(check.claimIds, 12), edgeIds = semanticArray(check.edgeIds, 16);
      if (Object.keys(check).sort().join('|') !== 'claimIds|confidence|edgeIds|itemId|verdict'
        || !item || seen.has(item.itemId) || !['covered', 'contradicted', 'unobserved'].includes(check.verdict as string)
        || !confidence(check.confidence) || new Set(claimIds).size !== claimIds.length || new Set(edgeIds).size !== edgeIds.length
        || claimIds.some((id) => typeof id !== 'string' || !graph.claims.some((claim) => claim.id === id))
        || edgeIds.some((id) => typeof id !== 'string' || !graph.edges.some((edge) => edge.id === id))
        || (check.verdict === 'unobserved' ? claimIds.length + edgeIds.length !== 0 : claimIds.length + edgeIds.length === 0)) throw new Error('invalid_rubric_check');
      seen.add(item.itemId);
      return { itemId: item.itemId, verdict: check.verdict as ReviewReferenceCriterionCheck['verdict'],
        claimIds: claimIds as string[], edgeIds: edgeIds as string[], confidence: check.confidence };
    });
    if (rubricChecks.length !== rubric.items.length) throw new Error('incomplete_rubric_checks');
  } else if (root.rubricChecks !== undefined) throw new Error('invalid_rubric_check');
  return { version: 1, packetId: packet.packetId,
    referenceAudit: { status: audit.status as ReviewSemanticComparison['referenceAudit']['status'], sourceIds: sourceIds as string[] },
    alignments, edgeChecks, personalLinks, ...(rubricChecks ? { rubricChecks } : {}) };
}

/** Both channels share the same scope rules, but have distinct source allowlists and consumers. */
export function validateReviewAlignments(
  comparison: ReviewSemanticComparison, packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph,
): ReviewAlignmentObservation[] {
  return comparison.alignments.map((value) => {
    const claim = graph.claims.find((item) => item.id === value.claimId)!;
    const node = value.corpus === 'personal' ? packet.personal.graph!.nodes.find((item) => item.id === value.targetId) : undefined;
    const reference = value.corpus === 'reference' ? packet.references.find((item) => item.sourceId === value.targetId) : undefined;
    const base = { claimId: claim.id, corpus: value.corpus, targetId: value.targetId, confidence: value.confidence,
      ...(value.knowledgeTarget ? { knowledgeTarget: value.knowledgeTarget } : {}) };
    // Personal: old belief -> new answer. Reference: new answer -> source.
    // In particular, evidence_limit must constrain the OLD certainty, not accidentally the new wording.
    const grounded = node
      ? quote(value.personalQuote) && node.text.includes(value.personalQuote) && value.documentQuote === claim.quote
      : value.personalQuote === claim.quote && quote(value.documentQuote) && reference!.text.includes(value.documentQuote);
    if (!grounded) {
      return { ...base, accepted: false, code: 'ungrounded_quote' };
    }
    const decision = validateGroundedAlignment(value, {
      claim: node ? node.text : packet.answer.text,
      ...(node ? { context: [packet.personal.context || '', ...packet.personal.graph!.nodes.filter((n) => n.id !== node.id).map((n) => n.text)].join('\n') } : {}),
      comparison: node ? packet.answer.text : reference!.text,
      incompleteContext: node ? packet.personal.truncated : incompleteReviewReferenceContext(packet, reference!),
    });
    if (!decision.accepted || !decision.alignment) return { ...base, accepted: false, code: decision.code };
    if (value.confidence < REVIEW_SEMANTIC_CONFIDENCE) return { ...base, accepted: false, code: 'low_semantic_confidence' };
    // Identical COMPLETE bodies cannot establish disagreement between this answer and its reference.
    // A conflict with an unrelated OLD belief belongs only to the personal channel. Do not repair the
    // model's relation to consistent or award positive evidence; hold this observation instead.
    // Exact identity only: no normalization, similarity inference or guessed semantic negation.
    if (reference && packet.answer.text === reference.text
      && ['contradiction', 'certainty_change'].includes(value.relation)) {
      return { ...base, accepted: false, code: 'identical_reference_not_conflict' };
    }
    const a = decision.alignment;
    return { ...base, accepted: true, code: 'aligned', alignment: {
      ...base, relation: a.relation, personalQuote: a.personalQuote, documentQuote: a.documentQuote,
      axes: a.axes, sourcesCompatible: a.sourcesCompatible, ...(a.relationBasis ? { relationBasis: a.relationBasis } : {}),
    } };
  });
}
