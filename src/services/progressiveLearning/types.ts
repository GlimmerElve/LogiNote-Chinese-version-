import type { ProgressiveReviewSummary, ProgressiveCompletion, ProgressiveReviewCommand, ProgressiveReviewReply, ProgressiveReviewRecord, ProgressiveReviewWork, ProgressiveReviewPacket, ProgressiveAuxiliaryResult } from './reviewTypes';
import type { StudyQuestionCard } from '../../types';

/** Teaching content is projected explicitly; sources, progress and jobs stay private. */
export interface ProgressiveMainlinePage {
  id: string;
  title: string;
  objectives: string[];
}
export interface ProgressiveMainline {
  title: string;
  objectives: string[];
  pages: ProgressiveMainlinePage[];
}
export interface ProgressiveReflectionHook {
  id: string;
  kind: 'reflection';
  prompt: string;
}
export interface ProgressiveQuestion {
  id: string;
  kind: 'choice' | 'judgment' | 'application';
  prompt: string;
  objective: string;
  conceptKeys: string[];
  focus: 'concept' | 'calculation' | 'transfer';
  options?: Array<{ id: string; text: string }>;
  correctOptionId?: string;
  referenceAnswer: string;
  explanation: string;
  /** Optional teaching hint, not proof or a requirement to publish a question. */
  referenceQuote?: string;
}
export interface ProgressiveAnswerDraft { text: string; optionId?: string; formulaDraft?: string }
export interface ProgressiveJudgment {
  outcome: 'correct' | 'incorrect' | 'unverifiable';
  errorKind: 'concept' | 'calculation' | 'expression' | 'unknown' | 'none';
  explanation: string; referenceAnswer: string; referenceQuote?: string;
}
export interface ProgressiveAttempt {
  id: string; submissionId: string; questionId: string; questionHash: string; pageHash: string;
  question: ProgressiveQuestion; answer: ProgressiveAnswerDraft; submittedAt: string;
  judgment?: ProgressiveJudgment; gradedAt?: string;
  assistance?:'independent'|'assisted';
}
export interface ProgressiveQuestionFeedback {
  id: string; questionId: string; attemptId?: string; category: 'question' | 'answer' | 'grading';
  text: string; createdAt: string; status: 'pending' | 'confirmed' | 'not-confirmed'; explanation?: string;
}
export interface ProgressivePageStudy {
  schemaVersion: 1; pageId: string; version: number; updatedAt: string;
  drafts: Record<string, ProgressiveAnswerDraft>; attempts: ProgressiveAttempt[]; feedback: ProgressiveQuestionFeedback[];
  explanationViews?: Array<{attemptId:string;viewedAt:string}>;
}
export interface ProgressiveStudySummary {
  pageId: string; version: number; updatedAt: string; submitted: number; pending: number; attempts: number;
}
export type ProgressiveStudyMutation =
  | { kind: 'view-explanation'; attemptId:string }
  | { kind: 'draft'; drafts: Record<string, ProgressiveAnswerDraft> }
  | { kind: 'submit'; submissionId: string; questionIds: string[] }
  | { kind: 'grade'; results: Array<{ attemptId: string; judgment: ProgressiveJudgment }> }
  | { kind: 'feedback'; feedback: Pick<ProgressiveQuestionFeedback, 'id' | 'questionId' | 'attemptId' | 'category' | 'text'> }
  | { kind: 'verify-feedback'; feedbackId: string; status: ProgressiveQuestionFeedback['status']; explanation: string };
export interface ProgressiveStudyRequest {
  environmentId: string; courseId: string; pageId: string; expectedVersion: number; mutation: ProgressiveStudyMutation;
}
export interface ProgressiveStudyReply { course: ProgressiveCourse; study: ProgressivePageStudy }
export interface ProgressiveRestatementSpan { pageId: string; start: number; end: number }
export interface ProgressiveRoute {
  kind: 'mainline' | 'expansion' | 'finish'; reason: string; correction?: string;
}
export interface ProgressiveAdaptation {
  feedbackKey: string; fresh: boolean; restatement: string;
  answers: Array<{ question: string; answer: string; outcome: ProgressiveJudgment['outcome']; errorKind: ProgressiveJudgment['errorKind']; explanation: string }>;
  remainingMainline: number; expansionAvailable: boolean;
  signals?: { restatementKey?: string; attemptIds: string[] };
}
export interface ProgressiveSupplementScope { text: string; before?: string; after?: string; pageHash: string }
export interface ProgressiveLessonPage {
  id: string;
  kind: 'mainline' | 'expansion';
  mainlineIndex: number;
  parentPageId?: string;
  title: string;
  body: string;
  hook: ProgressiveReflectionHook;
  createdAt: string;
  updatedAt: string;
  concepts?: ProgressiveConcept[];
  questions?: ProgressiveQuestion[];
  /** Private provenance snapshot for this page, independent of later added sources. */
  sourcePackets?: ProgressiveSourcePacket[];
}
export interface ProgressiveConcept { key: string; title: string; summary: string }
export interface ProgressivePageSummary {
  id: string; kind: 'mainline' | 'expansion'; mainlineIndex: number; parentPageId?: string;
  title: string; contentHash: string; createdAt: string; updatedAt: string;
  questionCount?: number;
}
export interface ProgressiveNextRequest {
  /** Teaching/generation revision; personal reading/study/review writes do not change it. */
  environmentId: string; courseId: string; expectedRevision: number;
  requestId: string; intent: 'mainline' | 'expansion' | 'auto'; fromPageId: string;
  sourcePackets?: ProgressiveSourcePacket[];
  scope?: ProgressiveSupplementScope;
}
export interface ProgressiveSourcePacket {
  id: string;
  title: string;
  kind: 'document' | 'knowledge' | 'web' | 'model_knowledge';
  text: string;
  locator?: string;
}
export interface ProgressiveProgress {
  /** Private progress concurrency version, independent of the teaching revision. */
  version: number;
  currentPageId: string | null;
  scrollTop: number;
  restatementDraft: string;
  summaryDraft: string;
  /** Personal question clues, not textbook quiz components. Optional for old course files. */
  questions?: StudyQuestionCard[];
  questionDraft?: string;
  restatementSpans?: ProgressiveRestatementSpan[];
}
export type ProgressiveProgressPatch = Partial<Pick<ProgressiveProgress,
  'currentPageId' | 'scrollTop' | 'restatementDraft' | 'summaryDraft' | 'questions' | 'questionDraft' | 'restatementSpans'>>;
export interface ProgressiveGeneration {
  requestId: string;
  pageId: string;
  status: 'prepared' | 'generating' | 'interrupted' | 'failed' | 'ready';
  attempts: number;
  sequence: number;
  rawDraft: string;
  bodyDraft: string;
  error?: string;
  kind?: 'mainline' | 'expansion';
  mainlineIndex?: number;
  parentPageId?: string;
  fromPageId?: string;
  previousTeaching?: { title: string; excerpt: string };
  routePending?: boolean;
  adaptation?: ProgressiveAdaptation;
  route?: ProgressiveRoute;
  scope?: ProgressiveSupplementScope;
  originPageId?: string;
  originScrollTop?: number;
}
export interface ProgressiveCourse {
  schemaVersion: 1;
  /** Opaque current storage identity; private and rebound when a vault is moved. */
  environmentId: string;
  id: string;
  projectNoteId: string;
  rootProjectId: string;
  title: string;
  /** Teaching/content and generation reservation version. Never advanced by private learning records. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  budget: { estimatedMinutes: number | null; totalPageLimit: number; maxMainlinePages: number };
  plan: ProgressiveMainline | null;
  firstPage: ProgressiveLessonPage | null;
  /** Directory only: no previous page bodies are copied on save or next-page requests. */
  pages?: ProgressivePageSummary[];
  /** Only the currently requested page is read. firstPage is the stage-one alias for main-1. */
  page?: ProgressiveLessonPage | null;
  progress: ProgressiveProgress;
  generation: ProgressiveGeneration;
  /** Private, including source excerpts and document identifiers. Never shared. */
  sourcePackets: ProgressiveSourcePacket[];
  study?: ProgressivePageStudy | null;
  studyPages?: ProgressiveStudySummary[];
  consumedFeedback?: Record<string, string>;
  consumedSignals?: Record<string, { restatements: string[]; attemptIds: string[] }>;
  lastDecision?: ProgressiveRoute & { requestId: string; fromPageId: string; at: string };
  currentFeedback?: ProgressiveAdaptation;
  reviews?: ProgressiveReviewSummary[];
  lastSuccessfulReview?: { reviewId:string; textKey:string; completedAt:string };
  completion?: ProgressiveCompletion;
}
export interface ProgressiveLease {
  environmentId: string;
  projectNoteId: string;
  courseId: string;
  requestId: string;
  pageId: string;
  token: string;
}
export interface ProgressiveBeginReply { course: ProgressiveCourse; lease?: ProgressiveLease; running: boolean }
export interface ProgressiveCheckpoint {
  sequence: number;
  rawDraft: string;
  bodyDraft: string;
  plan?: ProgressiveMainline;
}
export interface ProgressivePublication {
  sequence: number;
  plan: ProgressiveMainline;
  title: string;
  body: string;
  hook: ProgressiveReflectionHook;
  concepts?: ProgressiveConcept[];
  questions?: ProgressiveQuestion[];
}
export interface ProgressiveProgressRequest {
  environmentId: string;
  courseId: string;
  expectedProgressVersion: number;
  patch: ProgressiveProgressPatch;
}
export type ProgressiveCommand = ProgressiveReviewCommand
  | { op: 'load'; projectNoteId: string }
  | { op: 'read-page'; projectNoteId: string; pageId: string }
  | { op: 'study'; projectNoteId: string; request: ProgressiveStudyRequest }
  | { op: 'route'; lease: ProgressiveLease; route: ProgressiveRoute }
  | { op: 'begin'; projectNoteId: string; sourcePackets?: ProgressiveSourcePacket[] }
  | { op: 'next'; projectNoteId: string; request: ProgressiveNextRequest }
  | { op: 'update-page'; projectNoteId: string; environmentId: string; courseId: string; pageId: string; expectedHash: string; body: string }
  | { op: 'delete-page'; projectNoteId: string; environmentId: string; courseId: string; pageId: string; expectedHash: string }
  | { op: 'checkpoint'; lease: ProgressiveLease; checkpoint: ProgressiveCheckpoint }
  | { op: 'publish'; lease: ProgressiveLease; teaching: ProgressivePublication }
  | { op: 'save-progress'; projectNoteId: string; progress: ProgressiveProgressRequest }
  | { op: 'interrupt'; lease: ProgressiveLease; error?: string };
export type ProgressiveReply = ProgressiveCourse | ProgressiveBeginReply | ProgressiveStudyReply | ProgressiveReviewReply | ProgressiveReviewRecord | ProgressiveReviewWork[] | ProgressiveReviewPacket | ProgressiveAuxiliaryResult | import("../flowAnalysis/productionV2").FlowAnalysisV2Bundle | null;
export interface ProgressiveLearningApi {
  command(input: ProgressiveCommand): Promise<ProgressiveReply>;
  derived?(input: { op: 'status' | 'retry' | 'search'; projectNoteId: string; query?: string }): Promise<unknown>;
  onChange?(callback: (projectNoteId:string,reason?:'review'|'knowledge') => void): () => void;
  onKnowledge?(callback: (notes: import('../../types').NoteItem[], change?: import('./knowledgeProjection').ProgressiveKnowledgeChange) => void): () => void;
}
export interface SharedProgressiveTeaching {
  schemaVersion: 1;
  title: string;
  pages: Array<{ title: string; body: string; hook: { kind: 'reflection'; prompt: string }; questions?: ProgressiveQuestion[] }>;
}
