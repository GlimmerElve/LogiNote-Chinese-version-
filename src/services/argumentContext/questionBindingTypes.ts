import type { ReviewAssessmentContract, ReviewAssessmentTaskType, ReviewCriterionId } from '../reviewAssessment';
import type { ReviewReferenceRubric } from '../reviewReferenceRubric';
import type { ArgumentSourceIdentity } from './types';
import type { ArgumentTaskScopedPack } from './taskScopedTypes';

/** Question-time selectors, not a source quality, semantic-review or scope authority. */
export interface ArgumentQuestionFrameSelectors {
  questionMessageId: string;
  knowledgeTargets: string[];
  assessment: ReviewAssessmentContract;
  referenceRubric: ReviewReferenceRubric;
}

export const ARGUMENT_QUESTION_FRAME_REASONS = ['invalid_selectors', 'task_unavailable', 'reference_unavailable',
  'reference_changed', 'reference_membership_invalid', 'ambiguous_target', 'source_unavailable',
  'source_changed', 'projection_unavailable', 'projection_changed', 'source_not_eligible',
  'task_scope_unavailable', 'item_structure_incomplete', 'inference_relation_missing',
  'prerequisite_incomplete', 'contract_invalid', 'snapshot_changed'] as const;
export type ArgumentQuestionFrameReason = typeof ARGUMENT_QUESTION_FRAME_REASONS[number];

export interface ArgumentQuestionSourceFrame {
  frameId: string;
  knowledgeTarget: string;
  noteId: string;
  source: ArgumentSourceIdentity;
  /** Each source has its own stable host scope; the composite is not a fabricated common scope. */
  sourceScopeHash: string;
  sourceBindingHash: string;
  structureHash: string;
  seedNodeIds: string[];
  pack: ArgumentTaskScopedPack;
  items: { itemId: string; criterionId: ReviewCriterionId; start: number; end: number; quote: string;
    nodeIds: string[]; relationIds: string[] }[];
}

/** Shadow baseline only: no student answer, mastery judgement or cognition write is included. */
export interface FrozenArgumentQuestionFrames {
  version: 1;
  contractVersion: 'argument-question-frames-v1';
  contractHash: string;
  originQuestionMessageId: string;
  rootScopeId: string;
  taskType: ReviewAssessmentTaskType | null;
  knowledgeTargets: string[];
  assessment: ReviewAssessmentContract;
  referenceRubric: ReviewReferenceRubric;
  rubricHash: string;
  snapshotBindingHash: string;
  status: 'fixed' | 'held';
  policy: 'all_target_frames';
  frames: ArgumentQuestionSourceFrame[];
  reasons: ArgumentQuestionFrameReason[];
  limitations: { semanticTruth: 'not_certified'; questionRelevance: 'not_independently_assessed';
    answerEvaluation: 'not_performed'; scoreWrite: 'disabled'; cognitionWrite: 'disabled' };
}

/** Recheck the original frozen IDs only. A held contract never becomes fixed after answering. */
export interface ArgumentQuestionFrameVerification {
  status: 'current' | 'held';
  contractHash: string;
  reasons: ArgumentQuestionFrameReason[];
}
