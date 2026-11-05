import type { ArgumentRole, FlowArgumentStructure } from '../argumentDoc/types';

/** Extraction contract is shared with the production adapter; assessment remains separate. */
export const FLOW_SHADOW_PROTOCOL = 'flow-argument-shadow-v2' as const;
export const FLOW_SHADOW_RUBRIC = 'flow-evidence-rubric-v4-temporal-profile' as const;
export const COGNITIVE_EVIDENCE_CONTRACT = 'bipolar-evidence-v1' as const;
export const FLAT_BEHAVIOR_TRANSPORT = 'flat-poles-v1' as const;
export const LITERAL_ARITHMETIC_CONTRACT = 'literal-arithmetic-v1' as const;
export const SHADOW_WRITES = Object.freeze({ profile: false, notes: false, mastery: false, timeline: false, rag: false });
export type ShadowLayer = 'concept' | 'judgment' | 'reasoning';
export type ShadowRole = ArgumentRole;
export type ShadowCriterionId = 'concept_clarity' | 'concept_consistency' | 'concept_application'
  | 'judgment_clarity' | 'judgment_attribution' | 'judgment_calibration'
  | 'reasoning_relevance' | 'reasoning_sufficiency' | 'reasoning_consistency';
export type ShadowBehaviorCode = 'concept_framing' | 'evidence_description' | 'mechanism_explanation' | 'comparison_review' | 'action_application'
  | 'abstract_concrete' | 'structured_connections' | 'explore_converge' | 'uncertainty_calibration' | 'assumption_inspection';
export type ShadowCognitiveAxis = 'abstractVsConcrete' | 'systematicVsScattered' | 'divergentVsConvergent'
  | 'cautiousVsDogmatic' | 'deepVsSurface';
export type ShadowExpressionStyle = 'academic' | 'critical' | 'practical' | 'divergent' | 'objective';
export type ShadowReferenceTier = 1 | 2 | 3 | 4;
export type ShadowReferenceSourceType = 'project_textbook' | 'project_resource' | 'online_resource'
  | 'linked_knowledge' | 'mentioned_knowledge' | 'model_prior';
export type ShadowReferenceRelation = 'definition' | 'boundary' | 'claim' | 'condition' | 'premise' | 'counterexample' | 'method' | 'other';
export interface ShadowInput {
  attemptId: string;
  assessmentRevision: number;
  observedAt: string;
  rawText: string;
  task: { id: string; goal: string; family: 'free_review' | 'explanation' | 'evaluation' | 'derivation'; requiredLayers: ShadowLayer[];
    promptedBehaviors: ShadowBehaviorCode[] };
  assistance: 'none' | 'weak' | 'strong' | 'unknown';
}
export type ShadowNode = FlowArgumentStructure['nodes'][number];
export type ShadowArgument = FlowArgumentStructure['arguments'][number];
export type ShadowRelation = FlowArgumentStructure['relations'][number];
export type ShadowGraph = Omit<FlowArgumentStructure, 'version'>;
export interface ShadowReferenceTarget { id: string; layer: ShadowLayer; nodeIds: string[]; query: string }
export interface ShadowReferenceCandidate {
  id: string; targetId: string; tier: ShadowReferenceTier; sourceType: ShadowReferenceSourceType;
  sourceId: string; title: string; locator: string; relation: ShadowReferenceRelation;
  availability: 'available' | 'unreadable' | 'missing'; text: string; similarity: number | null;
}
export interface ShadowReferencePacket {
  version: 'shadow-reference-packet-v1'; targets: ShadowReferenceTarget[];
  items: ShadowReferenceCandidate[];
  selection: Array<{ targetId: string; primaryTier: 1 | 2 | 3 | null; itemIds: string[] }>;
  gaps: Array<{ targetId: string; tier: ShadowReferenceTier; sourceId: string; reason: string }>;
  limits: { targetLimit: number; itemLimit: number; perTargetLimit: number; characterLimit: number };
}
export interface ShadowEvidence { id: string; quote: string; nodeIds: string[]; attribution: 'user' | 'quoted' | 'assisted' | 'uncertain' }
export interface ShadowCriterion {
  id: ShadowCriterionId;
  state: 'observed' | 'not_demonstrated' | 'not_applicable' | 'uncertain';
  level: number | null;
  evidenceIds: string[];
  /** Semantic opportunity keys, not node counts. Repeated/split nodes do not add weight. */
  opportunityKeys: string[];
  reason: string;
}
export interface ShadowReferenceComparison {
  id: string; targetId: string; layer: ShadowLayer;
  state: 'aligned' | 'partially_aligned' | 'misaligned' | 'conflicted' | 'insufficient_reference' | 'not_applicable';
  level: number | null; userEvidenceIds: string[]; referenceIds: string[]; reason: string;
}
export interface ShadowBehavior { code: ShadowBehaviorCode; state: 'observed' | 'not_observed' | 'uncertain';
  evidenceIds: string[]; reason: string;
  /** Only strategy behaviors use direction: -2/-1 toward the left pole, +1/+2 toward the right pole, 0 balanced. */
  direction?: -2 | -1 | 0 | 1 | 2 | null;
  /** Scope/meaning are judged by the model; local checks verify IDs and declared resolution, not semantics. */
  polarity?: { negative: string[]; positive: string[];
    resolution: 'single_pole' | 'resolved' | 'balanced' | 'mixed' | 'insufficient' } }
export interface ShadowIssue { id: string; kind: 'extraction' | 'argument_gap' | 'confirmed_internal' | 'external_unverified' | 'asr_uncertain';
  targetIds: string[]; evidenceIds: string[]; severity: 'low' | 'medium' | 'high'; reason: string }
export interface ShadowArithmeticCheck {
  id: string; start: number; end: number; quote: string; left: string; right: string; operator: '+' | '-' | '*' | '/';
  claimed: string; expected: string; status: 'match' | 'mismatch'; unit: 'number' | 'percentage_point';
}
export interface ShadowCalculationReview {
  checkId: string; usage: 'current' | 'retracted' | 'quoted' | 'hypothetical' | 'uncertain';
  evidenceIds: string[]; criterionIds: ShadowCriterionId[]; reason: string;
}
export interface ShadowLocalVerification {
  contract: typeof LITERAL_ARITHMETIC_CONTRACT;
  /** Local arithmetic facts only, never proof that the user endorses an expression. */
  arithmeticChecks: ShadowArithmeticCheck[];
  calculationReviews: ShadowCalculationReview[];
}
export interface ShadowAssessment { evidence: ShadowEvidence[]; criteria: ShadowCriterion[]; referenceComparisons: ShadowReferenceComparison[]; behaviors: ShadowBehavior[];
  /** Missing on historical replies; current live requests require this evidence audit. */
  behaviorContract?: typeof COGNITIVE_EVIDENCE_CONTRACT;
  /** Opt-in provenance. Never taken from arbitrary LLM fields or enabled on historical records. */
  localVerification?: ShadowLocalVerification;
  /** Text-only observation; optional for saved V3 results, never an ability/profile score. */
  clarity?: { score: number | null; comment: string; evidenceIds: string[] };
  issues: ShadowIssue[]; summary: string; recommendation: string }
export interface ShadowWarning { code: string; target: string; message: string }
export interface ShadowLayerScore { layer: ShadowLayer; score: number | null; applicable: number; scored: number;
  coverage: number | null; evidenceCount: number; opportunityCount: number; eligibleForProfile: boolean;
  verificationPending?: boolean;
  status: 'insufficient' | 'provisional'; reasons: string[] }
export interface ShadowScoring { layers: ShadowLayerScore[]; warnings: ShadowWarning[] }
export interface ShadowReferenceLayerScore { layer: ShadowLayer; score: number | null; evaluableTargets: number; scoredTargets: number;
  coverage: number | null; eligibleForMastery: boolean; status: 'insufficient' | 'provisional'; reasons: string[]; verificationPending?: boolean }
export interface ShadowReferenceScoring { layers: ShadowReferenceLayerScore[]; warnings: ShadowWarning[] }
export interface ShadowCallReceipt { stage: 'extract' | 'assess'; promptId: string;
  promptTokens: number | null; completionTokens: number | null; status: 'completed' | 'failed' }
export interface ShadowRecord {
  protocol: typeof FLOW_SHADOW_PROTOCOL;
  rubricVersion: typeof FLOW_SHADOW_RUBRIC;
  mode: 'shadow'; writes: typeof SHADOW_WRITES;
  input: ShadowInput; graph: ShadowGraph; references: ShadowReferencePacket; assessment: ShadowAssessment;
  scoring: ShadowScoring; referenceScoring: ShadowReferenceScoring; warnings: ShadowWarning[];
  receipts: ShadowCallReceipt[];
  /** Transport provenance only. Saved references/comparison IDs retain the historical full-packet contract. */
  referenceTransport?: 'shared-sources-v1';
  behaviorTransport?: typeof FLAT_BEHAVIOR_TRANSPORT;
  semanticCertification: 'not_certified';
}
export interface ShadowProfileMetric { key: string; dimension: 'ability' | 'knowledge' | 'cognitive_style' | 'expression_style';
  label: string; value: number | null; state: 'insufficient' | 'provisional';
  scale: 'score_0_100' | 'bipolar_-100_100' | 'relative_0_100';
  poles?: { negative: string; positive: string };
  /** Recency-weighted current state. Historical evidence remains available below. */
  historicalMean: number | null; baselineValue: number | null; trendDelta: number | null;
  aggregation: { currentAlpha: number; baselineAlpha: number };
  observations: Array<{ attemptId: string; observedAt: string; taskId: string; value: number }>;
  sampleCount: number; days: number; taskCount: number; sampleAttemptIds: string[]; reasons: string[] }
export interface ShadowProfilePreview { mode: 'shadow'; writes: typeof SHADOW_WRITES; rubricVersion: typeof FLOW_SHADOW_RUBRIC;
  metrics: ShadowProfileMetric[]; warnings: string[]; attempts: number;
  errors: { confirmed: number; gaps: number; extraction: number; unverified: number; unclear: number; evaluatedAttempts: number } }
