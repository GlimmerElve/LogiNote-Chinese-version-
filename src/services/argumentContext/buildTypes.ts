import type { ArgumentContextHierarchy, ArgumentContextProjection, ArgumentContextScope, ArgumentContextTask, ArgumentEvidenceSpan, ArgumentSourceIdentity } from './types';

export const ARGUMENT_PROJECTION_BUILD_VERSION = 'argument-projection-build-v1' as const;
export const ARGUMENT_PROJECTION_BUILD_LIMITS = { quotes: 256, nodes: 64, relations: 128, groups: 32, scopes: 32,
  chunks: 256, requestCharacters: 24000, reasons: 16, quoteReferences: 16 } as const;
/** Host-owned canonical source; not a model's claimed authority or quality judgement. */
export interface ArgumentProjectionSourceInput {
  source: ArgumentSourceIdentity;
  canonicalText: string;
  hierarchy: ArgumentContextHierarchy;
  scope: ArgumentContextScope;
  chunks: { id: string; start: number; end: number; content: string; sentenceIds: string[]; forcedSplit: boolean }[];
  /** Explicit host policy, independent of structural extraction. Never defaults to eligible. */
  sourceQualification: { status: 'eligible' | 'review_only' | 'unassessed'; policyVersion: string; evidence: ArgumentEvidenceSpan[] };
}
export interface ArgumentProjectionBuildInput extends ArgumentProjectionSourceInput {
  version: 1; contractVersion: typeof ARGUMENT_PROJECTION_BUILD_VERSION; buildId: string;
  scopeHash: string; sourceBindingHash: string;
  quotes: { quoteId: string; evidence: ArgumentEvidenceSpan; chunkIds: string[]; completeSentence: boolean }[];
  limitations: { semanticTruth: 'not_certified'; productionWrites: 'disabled'; scoreWrite: 'disabled'; cognitionWrite: 'disabled' };
}
export interface ArgumentProjectionDraft {
  version: 1; buildId: string;
  nodes: { id: string; role: ArgumentContextProjection['nodes'][number]['role']; quoteIds: string[] }[];
  relations: { id: string; sourceNodeId: string; targetNodeId: string; kind: ArgumentContextProjection['relations'][number]['kind']; quoteIds: string[] }[];
  groups: { id: string; conclusionNodeId: string; premiseNodeIds: string[]; conditionNodeIds: string[];
    relationIds: string[]; operator: 'all' | 'any' | 'unknown'; quoteIds: string[] }[];
  scopes: { id: string; seedNodeId: string; task: ArgumentContextTask; requiredNodeIds: string[]; requiredRelationIds: string[]; requiredGroupIds: string[]; quoteIds: string[] }[];
}
export interface ArgumentProjectionReviewInput {
  version: 1; contractVersion: typeof ARGUMENT_PROJECTION_BUILD_VERSION; reviewId: string; buildId: string; draftHash: string;
  /** Full bounded canonical source, not just endpoint quotes or a top-k search preview. */
  source: ArgumentSourceIdentity; canonicalText: string; quotes: ArgumentProjectionBuildInput['quotes'];
  hierarchy: ArgumentContextHierarchy; chunks: ArgumentProjectionSourceInput['chunks'];
  scopeHash: string; sourceBindingHash: string;
  draft: ArgumentProjectionDraft;
}
export const ARGUMENT_PROJECTION_DECISIONS = ['accept', 'reject', 'unknown'] as const;
export type ArgumentProjectionDecision = typeof ARGUMENT_PROJECTION_DECISIONS[number];
export interface ArgumentProjectionReviewDecision {
  id: string; decision: ArgumentProjectionDecision; quoteIds: string[]; reason: string;
}
/** One independent response, with exact, closed slots; cannot overwrite the draft or source policy. */
export interface ArgumentProjectionReview {
  version: 1; reviewId: string;
  nodes: (ArgumentProjectionReviewDecision & { roleSupported: boolean })[];
  relations: (ArgumentProjectionReviewDecision & { sourceNodeId: string; targetNodeId: string;
    kind: ArgumentContextProjection['relations'][number]['kind']; relationSupported: boolean; directionSupported: boolean; crossChunkSupported: boolean })[];
  groups: (ArgumentProjectionReviewDecision & { operator: 'all' | 'any' | 'unknown'; membersSupported: boolean; operatorSupported: boolean; necessarySetComplete: boolean })[];
  scopes: (ArgumentProjectionReviewDecision & { requiredSetComplete: boolean; attributionSupported: boolean })[];
}
/** Explicit opt-in: independent source obligations, not candidate self-consistency alone. */
export const ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL = 'argument-projection-source-review-v2' as const;
export const ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL = 'argument-projection-task-review-v3' as const;
export interface ArgumentProjectionSourceReviewInput extends ArgumentProjectionReviewInput {
  protocol: typeof ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL;
  sourceCoverageTargets: { sentenceId: string; quoteId: string }[];
}
export interface ArgumentProjectionTaskReviewInput extends Omit<ArgumentProjectionSourceReviewInput, 'protocol'> {
  protocol: typeof ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL;
}
export interface ArgumentProjectionSourceRestriction {
  kind: 'requires_condition' | 'exception_of'; sourceQuoteIds: string[]; targetQuoteIds: string[];
}
export interface ArgumentProjectionSourceInference {
  conclusionQuoteIds: string[]; premiseQuoteIds: string[]; conditionQuoteIds: string[];
  operator: 'all' | 'any' | 'unknown';
}
export interface ArgumentProjectionSourceReview extends Omit<ArgumentProjectionReview, 'version' | 'nodes'> {
  version: 2; protocol: typeof ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL;
  nodes: (ArgumentProjectionReview['nodes'][number] & { completeMeaning: boolean })[];
  /** Each row independently scans an entire real sentence; missing/unknown coverage stays partial.
   * Q anchors identify source obligations. They cannot add or repair candidate edges. */
  sourceCoverage: { sentenceId: string; quoteId: string; decision: ArgumentProjectionDecision; reason: string;
    restrictions: ArgumentProjectionSourceRestriction[]; inferences: ArgumentProjectionSourceInference[] }[];
}
/** Explicit representation; old v2 obligations are never reinterpreted as embedded. */
export interface ArgumentProjectionTaskReview extends Omit<ArgumentProjectionSourceReview, 'version' | 'protocol' | 'sourceCoverage'> {
  version: 3; protocol: typeof ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL;
  sourceCoverage: (Omit<ArgumentProjectionSourceReview['sourceCoverage'][number], 'restrictions'> & {
    restrictions: (ArgumentProjectionSourceRestriction & { representation: 'edge' | 'embedded' })[];
  })[];
}
export type ArgumentProjectionGroundedReview = ArgumentProjectionSourceReview | ArgumentProjectionTaskReview;
export type ArgumentProjectionGroundedReviewInput = ArgumentProjectionSourceReviewInput | ArgumentProjectionTaskReviewInput;
type ReviewRowKind = 'nodes' | 'relations' | 'groups' | 'scopes';
type ReviewRowSchema<K extends ReviewRowKind> = {
  fields: readonly (keyof ArgumentProjectionReview[K][number] & string)[];
  booleanFields: readonly ({ [P in keyof ArgumentProjectionReview[K][number]]:
    ArgumentProjectionReview[K][number][P] extends boolean ? P : never }[keyof ArgumentProjectionReview[K][number]] & string)[];
};
/** One closed row contract for the decoder and model-facing field definitions.
 * This declares types only: no decision, boolean vote or authorisation default. */
export const ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS = Object.freeze({
  nodes: Object.freeze({
    fields: Object.freeze(['id', 'decision', 'quoteIds', 'reason', 'roleSupported'] as const),
    booleanFields: Object.freeze(['roleSupported'] as const),
  }),
  relations: Object.freeze({
    fields: Object.freeze(['id', 'decision', 'quoteIds', 'reason', 'sourceNodeId', 'targetNodeId', 'kind',
      'relationSupported', 'directionSupported', 'crossChunkSupported'] as const),
    booleanFields: Object.freeze(['relationSupported', 'directionSupported', 'crossChunkSupported'] as const),
  }),
  groups: Object.freeze({
    fields: Object.freeze(['id', 'decision', 'quoteIds', 'reason', 'operator', 'membersSupported',
      'operatorSupported', 'necessarySetComplete'] as const),
    booleanFields: Object.freeze(['membersSupported', 'operatorSupported', 'necessarySetComplete'] as const),
  }),
  scopes: Object.freeze({
    fields: Object.freeze(['id', 'decision', 'quoteIds', 'reason', 'requiredSetComplete', 'attributionSupported'] as const),
    booleanFields: Object.freeze(['requiredSetComplete', 'attributionSupported'] as const),
  }),
} satisfies { [K in ReviewRowKind]: ReviewRowSchema<K> });
export const ARGUMENT_PROJECTION_SOURCE_REVIEW_ROW_SCHEMAS = Object.freeze({
  ...ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS,
  nodes: Object.freeze({
    fields: Object.freeze([...ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS.nodes.fields, 'completeMeaning'] as const),
    booleanFields: Object.freeze([...ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS.nodes.booleanFields, 'completeMeaning'] as const),
  }),
});
export interface ArgumentProjectionBuildResult {
  version: 1; contractVersion: typeof ARGUMENT_PROJECTION_BUILD_VERSION; buildId: string; reviewId: string; draftHash: string; resultHash: string;
  status: 'reviewed_complete' | 'reviewed_partial' | 'reviewed_scoped';
  projection: ArgumentContextProjection;
  authority: { source: ArgumentSourceIdentity; canonicalText: string; structureHash: string };
  audit: { nodes: ArgumentProjectionReviewDecision[]; relations: ArgumentProjectionReviewDecision[];
    groups: ArgumentProjectionReviewDecision[]; scopes: ArgumentProjectionReviewDecision[] };
  limitations: ArgumentProjectionBuildInput['limitations'];
}
/** Independent host replay dependencies. The result cannot authenticate its own semantic flags. */
export interface ArgumentProjectionBuildProof {
  input: ArgumentProjectionBuildInput; draft: ArgumentProjectionDraft; review: ArgumentProjectionReview | ArgumentProjectionGroundedReview;
}
