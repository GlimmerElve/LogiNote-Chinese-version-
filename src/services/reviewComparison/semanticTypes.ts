import type { CognitionAlignment } from '../cognition/alignment';
import type { ReviewCognitionTarget } from '../reviewIntent';
import type { ReviewComparisonPacket } from './types';
import type { ReviewAnchoredInput } from './anchoredProtocol';
import type { ReviewAssessmentContract, ReviewCriterionId } from '../reviewAssessment';

export const REVIEW_CLAIM_ROLES = ['definition', 'fact', 'condition', 'example', 'premise', 'conclusion', 'counterexample'] as const;
export type ReviewClaimRole = typeof REVIEW_CLAIM_ROLES[number];
export type ReviewEvidenceLayer = 'concept' | 'judgment' | 'reasoning';
export interface ReviewQuoteSpan { quote: string; start: number; end: number }
export interface ReviewAnswerClaim extends ReviewQuoteSpan { id: string; role: ReviewClaimRole }
export interface ReviewAnswerEdge extends ReviewQuoteSpan {
  id: string; source: string; target: string; relation: 'support' | 'oppose';
}
export interface ReviewQuestionRequirement extends ReviewQuoteSpan {
  knowledgeTarget: string; layer: ReviewEvidenceLayer;
  /** A question context span for audit, not an LLM-inferred scoring requirement. */
  origin?: 'frozen_task'; criterionIds?: ReviewCriterionId[];
}
/** Temporary performance graph, never a confirmed cognition graph. */
export interface ReviewPerformanceGraph {
  version: 1; packetId: string; claims: ReviewAnswerClaim[]; edges: ReviewAnswerEdge[];
  requirements: ReviewQuestionRequirement[];
}
export interface ReviewClaimAlignment extends Omit<CognitionAlignment, 'personalIndex' | 'sourceId'> {
  claimId: string; corpus: 'personal' | 'reference'; targetId: string;
  /** Required only on the reference side, from frozen knowledgeTargets. */
  knowledgeTarget?: string;
  confidence: number;
}
export interface ReviewEdgeCheck {
  edgeId: string; knowledgeTarget: string; sourceId: string; referenceQuote: string;
  relation: 'support' | 'oppose'; verdict: 'supported' | 'contradicted' | 'unverifiable';
  direction: 'source_to_target' | 'target_to_source' | 'undetermined';
  basisClaimId: string; conclusionClaimId: string;
  premiseStatus: 'sufficient' | 'missing'; confidence: number;
}
export interface ReviewPersonalLink {
  claimId: string; targetNodeId: string; answerQuote: string; personalQuote: string;
  relation: 'support' | 'oppose'; direction: 'answer_to_personal' | 'personal_to_answer' | 'undetermined';
  basis: 'answer' | 'personal'; conclusion: 'answer' | 'personal';
  premiseStatus: 'sufficient' | 'missing'; confidence: number;
}
export interface ReviewSemanticComparison {
  version: 1; packetId: string;
  /** Must enumerate ALL supplied reference IDs; this is still a model judgement. */
  referenceAudit: { status: 'compatible' | 'conflict' | 'unknown'; sourceIds: string[] };
  alignments: ReviewClaimAlignment[]; edgeChecks: ReviewEdgeCheck[]; personalLinks: ReviewPersonalLink[];
  rubricChecks?: ReviewReferenceCriterionCheck[];
}
export interface ReviewReferenceCriterionCheck {
  itemId: string; verdict: 'covered' | 'contradicted' | 'unobserved'; claimIds: string[]; edgeIds: string[]; confidence: number;
}
export interface ReviewReferenceCoverage {
  scope: 'question_items'; status: 'complete' | 'partial' | 'held';
  items: { itemId: string; criterionId: ReviewCriterionId; status: 'covered' | 'contradicted' | 'unobserved'; reasons: string[] }[];
  reasons: string[];
}
export interface ReviewAlignmentObservation {
  claimId: string; corpus: 'personal' | 'reference'; targetId: string; knowledgeTarget?: string;
  accepted: boolean; code: string; confidence: number;
  alignment?: ReviewClaimAlignment;
}
export interface CognitionGrowthProposal {
  version: 1; proposalId: string; packetId: string; messageId: string;
  status: 'pending_confirmation'; target: ReviewCognitionTarget; branchHash: string;
  operation: 'supplement' | 'contextual' | 'review_conflict' | 'certainty_review';
  /** Never replace C merely because a newly stated result D was found. */
  preserveOriginal: true; claim: ReviewAnswerClaim; alignment: ReviewClaimAlignment;
  /** Optional verified direction, not a permission to persist an edge. */
  link?: ReviewPersonalLink;
  authorship: 'own_expression' | 'adopted_with_assistance';
}
export interface ReviewLayerObservation {
  kind: 'claim_alignment' | 'explicit_relation'; claimIds: string[]; edgeId?: string;
  sourceIds: string[]; verdict: 'supported' | 'contradicted';
}
export interface ReviewLayerShadow {
  status: 'not_required' | 'unassessed' | 'supported' | 'contradicted' | 'mixed';
  observations: ReviewLayerObservation[]; reasons: string[];
}
export interface ReviewMasteryShadow {
  knowledgeTarget: string; status: 'evidence_ready' | 'held'; reasons: string[];
  layers: Record<ReviewEvidenceLayer, ReviewLayerShadow>;
  /** Evidence only. Complete-chain/deltas and real scores are deliberately not inferred here. */
  scoreWrite: 'disabled';
  /** Completeness of frozen QUESTION items only, never overall knowledge mastery. */
  referenceCoverage?: ReviewReferenceCoverage;
}
export interface ReviewSemanticResult {
  version: 1; protocol: 'review-dual-alignment-v1' | 'review-isolated-anchors-v3'; evaluationId: string; packetId: string;
  snapshotHash: string; status: 'reviewed' | 'held'; reasons: string[];
  assistance: { hintLevel: 0 | 1 | 2 | 3 | 4; consultedMaterialCount: number };
  graph?: ReviewPerformanceGraph; alignments: ReviewAlignmentObservation[];
  growth: { status: 'proposed' | 'no_change' | 'held'; reasons: string[]; proposals: CognitionGrowthProposal[] };
  mastery: ReviewMasteryShadow[];
  writes: 'disabled';
  /** Only v3: actual invocations, not hidden extra requests inside compare(). */
  modelRequests?: { extract: number; reference: number; personal: number; total: number; limit: 3 };
  channels?: Record<'reference' | 'personal', { status: 'reviewed' | 'held' | 'not_requested'; reasons: string[] }>;
}
/** A caller must explicitly supply a reviewer. Tests use mocks; creating packets does not invoke a model. */
export interface ReviewSemanticModel {
  protocol?: 'isolated-anchors-v3';
  extract(input: Pick<ReviewComparisonPacket, 'packetId' | 'questionText' | 'answer'> & { knowledgeTargets: string[]; assessment?: ReviewAssessmentContract }, signal?: AbortSignal): Promise<unknown>;
  compare(input: { packet: ReviewComparisonPacket; graph: ReviewPerformanceGraph }, signal?: AbortSignal): Promise<unknown>;
  reviewReference?(input: ReviewAnchoredInput, signal?: AbortSignal): Promise<unknown>;
  reviewPersonal?(input: ReviewAnchoredInput, signal?: AbortSignal): Promise<unknown>;
}
