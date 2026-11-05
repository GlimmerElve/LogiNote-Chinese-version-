import type { LlmCallRequest, LlmCallResponse, NoteItem } from '../../types';
import type { FlowReferenceReaders } from '../flowAnalysis/referenceProvider';
import type { MasteryShadowEvaluationInput, MasteryShadowEvaluationResult, MasteryShadowReferenceItem,
  MasteryShadowResponseType } from '../masteryShadow/evaluator';
import type { MasteryShadowCriterionId } from '../masteryShadow/rubric';
import type { MasteryShadowLayer, MasteryShadowLayerState } from '../masteryShadow/types';

export interface QuickCheckLaunchRequest {
  noteId: string;
  criterionIds?: MasteryShadowCriterionId[];
  source?: string;
  /** Explicit user/Agent request; never silently discards an unfinished answer. */
  regenerate?: boolean;
}
export interface QuickCheckTarget {
  id: MasteryShadowCriterionId;
  label: string;
  layer: MasteryShadowLayer;
  state: MasteryShadowLayerState;
}
export type QuickCheckOperation = 'contrast' | 'counterfactual' | 'diagnose' | 'construct' | 'predict' | 'evidence_gap' | 'design_test' | 'revise';
/** Small design history, never an answer key or a mastery certificate. */
export interface QuickCheckDesign {
  operation: QuickCheckOperation;
  scenario: string;
  focus: string;
  requiredDetail: string;
}
export interface QuickCheckHistoryItem {
  prompt: string;
  criterionIds: MasteryShadowCriterionId[];
  design?: QuickCheckDesign;
  gaps?: Array<{ id: MasteryShadowCriterionId; summary: string }>;
}
export interface QuickCheckQuestion {
  id: string;
  type: MasteryShadowResponseType;
  prompt: string;
  criterionIds: MasteryShadowCriterionId[];
  referenceIds: string[];
  /** Required for newly generated v2 questions, optional on historical cards. */
  design?: QuickCheckDesign;
  options?: Array<{ id: string; text: string }>;
  /** Never render these fields before the attempt is submitted. They are not truth authority. */
  privateAnswer: { optionId?: string; explanation: string;
    referenceQuotes: Array<{ referenceId: string; quote: string }> };
}
export interface QuickCheckSession {
  version: 1;
  id: string;
  noteId: string;
  noteTitle: string;
  source?: string;
  sourceKey: string;
  masteryKey: string;
  createdAt: string;
  targets: QuickCheckTarget[];
  /** Planned automatic targets not actually tested by these questions; never score them. */
  uncoveredCriterionIds?: MasteryShadowCriterionId[];
  questions: QuickCheckQuestion[];
  references: MasteryShadowReferenceItem[];
  /** Accidental mutation/cache coordinate, not a security signature. */
  contractKey: string;
}
export interface QuickCheckAnswer {
  questionId: string;
  text?: string;
  optionId?: string;
  skipped?: boolean;
  assisted?: boolean;
}
export interface QuickCheckAssessment {
  version: 1;
  sessionId: string;
  attemptId: string;
  assessedAt: string;
  input: MasteryShadowEvaluationInput;
  evaluation: MasteryShadowEvaluationResult;
  answers: QuickCheckAnswer[];
  /** Frozen per-question judgments; legacy card-wide receipts remain readable. */
  questionEvaluations?: QuickCheckQuestionEvaluation[];
}
export interface QuickCheckQuestionEvaluation {
  questionId: string;
  evaluation: MasteryShadowEvaluationResult;
  /** Local receipt metadata; never accepted from a live model response. */
  answerKeyPolicy?: 'independent' | 'legacy';
  /** Independently solved from supplied references, never copied from generation's key. */
  answerKey?: { optionId: string; explanation: string; referenceQuotes: Array<{ referenceId: string; quote: string }> };
}
export interface QuickCheckResult {
  headline: string;
  remaining: string[];
  nextAction: string;
  changed: boolean;
  details: Array<{ questionId: string; prompt: string; answer: string;
    correct?: boolean; referenceAnswer?: string; explanation: string }>;
}
export type QuickCheckCall = (request: LlmCallRequest) => Promise<LlmCallResponse>;
export interface QuickCheckGenerateOptions {
  note: NoteItem;
  requestedCriterionIds?: MasteryShadowCriterionId[];
  /** Question stems only; never send old answers, grading, or private keys. */
  previousQuestions?: string[];
  /** At most six recent tasks; no student answers, options or private keys. */
  recentQuestions?: QuickCheckHistoryItem[];
  /** Retain skipped questions while their own criterion states and source remain unchanged. */
  reuseSkipped?: { session: QuickCheckSession; answers: QuickCheckAnswer[] };
  source?: string;
  call?: QuickCheckCall;
  readers?: Partial<FlowReferenceReaders>;
  now?: () => Date;
  /** Deterministic test seam; production uses unbiased local randomness. */
  optionRandomInt?: (upperBound: number) => number;
}
