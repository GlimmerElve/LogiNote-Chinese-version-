import type { SourceLocator, SourceBlockKind, ArgumentFunctionType } from '../../types';
import type { ReviewCriterionId } from '../reviewAssessment';

/** Reading intents, not new mastery tasks or scoring rules. */
export const ARGUMENT_CONTEXT_TASKS = ['definition', 'fact', 'condition', 'example', 'distinguish', 'reasoning', 'application', 'comparison', 'general'] as const;
export type ArgumentContextTask = typeof ARGUMENT_CONTEXT_TASKS[number];
export type ArgumentSourceKind = 'knowledge-note' | 'uploaded-document' | 'personal-cognition';
export interface ArgumentSourceIdentity {
  kind: ArgumentSourceKind;
  entityId: string;
  /** Opaque internal scope token, never a local path. */
  rootScopeId: string;
  version: string;
  contentHash: string;
  coordinateSpace: 'saved-note-utf16' | 'parsed-text-utf16' | 'personal-expression-utf16';
  parserVersion: string; segmentationVersion: string; extractorVersion: string; validatorVersion: string;
  personal?: { recordId: string; revisionId: string; branchId: string };
}
export interface ArgumentContextScope {
  scopeId: string;
  rootScopeId: string;
  corpus: 'reference' | 'personal';
  allowedSourceKinds: ArgumentSourceKind[];
  allowedNoteIds: string[];
  allowedDocIds: string[];
  allowedRecordIds: string[];
}
/** All intervals are half-open UTF-16 coordinates in one bound canonical body. */
export interface ArgumentEvidenceSpan { sentenceId: string; start: number; end: number; quote: string }
export interface ArgumentContextHierarchy {
  sections: { id: string; path: string; parentId: string | null }[];
  blocks: { id: string; kind: SourceBlockKind; sectionId: string | null; start: number; end: number;
    previousId: string | null; nextId: string | null; locator?: SourceLocator }[];
  sentences: { id: string; blockId: string; start: number; end: number; quote: string }[];
}
export const ARGUMENT_CONTEXT_ROLES = ['claim', 'premise', 'condition', 'conclusion', 'definition', 'fact', 'hypothesis', 'example', 'comparison', 'exception', 'counterexample'] as const;
export const ARGUMENT_CONTEXT_RELATIONS = ['support', 'oppose', 'requires_condition', 'illustrates', 'contrasts', 'exception_of'] as const;
export interface ArgumentContextNode {
  id: string;
  role: typeof ARGUMENT_CONTEXT_ROLES[number];
  /** Retained legacy label, not a newly inferred argument duty. */
  legacyFunctionType?: ArgumentFunctionType;
  evidence: ArgumentEvidenceSpan[];
  admission: 'admitted' | 'audit_only';
  /** A stored reviewer decision, not a certificate of truth. */
  semanticStatus: 'reviewed' | 'unreviewed';
}
export interface ArgumentContextRelation {
  id: string; sourceNodeId: string; targetNodeId: string;
  kind: typeof ARGUMENT_CONTEXT_RELATIONS[number];
  evidence: ArgumentEvidenceSpan[];
  admission: 'admitted' | 'audit_only'; semanticStatus: 'reviewed' | 'unreviewed';
}
export interface ArgumentPrerequisiteGroup {
  id: string; conclusionNodeId: string;
  premiseNodeIds: string[]; conditionNodeIds: string[]; relationIds: string[];
  operator: 'all' | 'any' | 'unknown';
  admission: 'admitted' | 'audit_only'; semanticStatus: 'reviewed' | 'unreviewed';
}
export const ARGUMENT_CONTEXT_GAP_CODES = ['legacy_structure', 'hierarchy_incomplete', 'structure_unreviewed', 'source_review_only',
  'source_quality_unknown', 'scope_not_reviewed', 'missing_prerequisite', 'missing_node', 'missing_relation', 'missing_group',
  'unadmitted_node', 'unadmitted_relation', 'unadmitted_group', 'unknown_prerequisite_operator',
  'invalid_legacy_node', 'invalid_legacy_relation', 'incomplete_extraction', 'node_budget', 'relation_budget', 'character_budget', 'depth_budget'] as const;
export type ArgumentContextGapCode = typeof ARGUMENT_CONTEXT_GAP_CODES[number];
export interface ArgumentContextGap { code: ArgumentContextGapCode; targetId?: string }
export interface ArgumentReviewedScope {
  seedNodeId: string; task: ArgumentContextTask;
  requiredNodeIds: string[]; requiredRelationIds: string[]; requiredGroupIds: string[];
  status: 'reviewed_for_scope' | 'partial' | 'unknown';
}
/** Versioned projection supplied by an authoritative store, not model-facing testimony. */
export interface ArgumentContextProjection {
  version: 1;
  source: ArgumentSourceIdentity;
  hierarchy: ArgumentContextHierarchy;
  nodes: ArgumentContextNode[]; relations: ArgumentContextRelation[]; prerequisiteGroups: ArgumentPrerequisiteGroup[];
  quality: { status: 'eligible' | 'review_only' | 'unassessed' | 'not_applicable' };
  build: { origin: 'legacy-adapter' | 'validated-projection'; scopes: ArgumentReviewedScope[]; gaps: ArgumentContextGap[] };
}
/** A separate canonical authority is required; a caller's projection cannot authenticate itself. */
export interface ArgumentContextAuthority { source: ArgumentSourceIdentity; canonicalText: string; structureHash: string }
export interface ArgumentContextPointer {
  version: 1; scopeId: string; scopeHash: string; source: ArgumentSourceIdentity; structureHash: string; seedNodeIds: string[];
}
export interface ArgumentContextBudget { maxNodes: number; maxRelations: number; maxCharacters: number; maxDepth: number }
export interface ArgumentContextRequest { pointer: ArgumentContextPointer; scope: ArgumentContextScope; task: ArgumentContextTask; budget?: Partial<ArgumentContextBudget> }
/** Complete only for a declared, reviewed reading scope; never says the user mastered anything. */
export interface ArgumentContextPack {
  version: 1; packHash: string; source: ArgumentSourceIdentity; scopeId: string; scopeHash: string; structureHash: string;
  task: ArgumentContextTask; seedNodeIds: string[];
  /** Saved for deterministic replay against the independently supplied stored projection. */
  budget: ArgumentContextBudget;
  hierarchy: ArgumentContextHierarchy;
  nodes: ArgumentContextNode[]; relations: ArgumentContextRelation[]; prerequisiteGroups: ArgumentPrerequisiteGroup[];
  quality: ArgumentContextProjection['quality'];
  completeness: { status: 'complete_for_scope' | 'partial' | 'unknown';
    requiredNodeIds: string[]; requiredRelationIds: string[]; requiredGroupIds: string[];
    readNodeIds: string[]; readRelationIds: string[]; readGroupIds: string[];
    omittedNodeIds: string[]; omittedRelationIds: string[]; omittedGroupIds: string[]; gaps: ArgumentContextGap[] };
  limitations: { semanticTruth: 'not_certified'; questionCoverage: 'not_assessed'; writes: 'disabled' };
}
export interface ArgumentFrameSelection {
  frameId: string; packHash: string;
  /** These are scope evidence only, not newly invented answers or conditions. */
  scopeEvidence: ArgumentEvidenceSpan[];
  items: { itemId: string; criterionId: ReviewCriterionId; nodeIds: string[]; relationIds: string[] }[];
}
export interface FrozenArgumentSourceFrames {
  version: 1; contractVersion: 'argument-source-frames-v1'; contractHash: string;
  questionMessageId: string; scopeId: string; scopeHash: string; task: ArgumentContextTask; scope: 'question_items';
  policy: 'any_allowed_frame' | 'all_selected_frames';
  status: 'fixed' | 'held';
  frames: (ArgumentFrameSelection & { source: ArgumentSourceIdentity; structureHash: string; seedNodeIds: string[] })[];
  reasons: string[];
  limitations: { answerEvaluation: 'not_performed'; scoreWrite: 'disabled'; cognitionWrite: 'disabled' };
}
export const ARGUMENT_CONTEXT_LIMITS = { sourceCharacters: 500000, sections: 2000, blocks: 5000, sentences: 20000,
  nodes: 4000, relations: 8000, groups: 2000, scopes: 4000, gaps: 8000, evidence: 32,
  readNodes: 128, readRelations: 256, readCharacters: 20000, readDepth: 16 } as const;
export const DEFAULT_ARGUMENT_CONTEXT_BUDGET: ArgumentContextBudget = { maxNodes: 64, maxRelations: 128, maxCharacters: 12000, maxDepth: 8 };
