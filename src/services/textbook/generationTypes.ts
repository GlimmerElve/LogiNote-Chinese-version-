import type { NoteItem, SourceLocator } from '../../types';

export type TextbookStage = 'prepared' | 'context' | 'materials' | 'blueprint' | 'chapters' | 'validating' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type TextbookPipelineStage = 'context' | 'materials' | 'blueprint' | 'chapters' | 'validating' | 'publishing';
/** Bounded diagnostics only; never persist partial output or reasoning text. */
export interface TextbookModelAttempt {
  inputHash: string;
  stage: import('./modelPolicy').TextbookModelStage;
  chapterId?: string;
  truncations: number;
  exhausted: boolean;
  maxTokens: number;
  outputChars: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  hadReasoningContent?: boolean;
}
export interface TextbookFinding {
  stage: 'blueprint' | 'chapters' | 'validating';
  chapterId?: string;
  section?: keyof TextbookChapter['sections'];
  message: string;
}
export type TextbookReviewTarget =
  | { kind: 'chapter'; chapterId: string; section: keyof TextbookChapter['sections']; quote: string }
  | { kind: 'objective'; id: string; quote: string }
  | { kind: 'focus'; id: string; field: 'description' | 'strategy'; quote: string }
  | { kind: 'bridge'; chapterId: string; quote: string };
export type TextbookReviewBasis =
  | { kind: 'source'; sourceId: string; quote: string }
  | { kind: 'textbook'; target: TextbookReviewTarget }
  | { kind: 'task'; index: number; quote: string }
  | { kind: 'personal'; evidenceId: string; quote: string }
  | { kind: 'previous_learning'; quote: string };
/** Semantic review only. Membership, syntax, scope and privacy remain code gates. */
export interface TextbookReviewFinding {
  severity: 'blocker' | 'warning';
  impact?: 'critical' | 'minor';
  certainty?: 'clear' | 'uncertain';
  category: 'factual_support' | 'internal_consistency' | 'task_alignment' | 'personalization' | 'pedagogy';
  target: TextbookReviewTarget;
  message: string;
  reason: string;
  basis: TextbookReviewBasis[];
}
export interface TextbookReviewReport { schemaVersion: 2 | 3; passed: boolean; findings: TextbookReviewFinding[] }
/** Private, bounded report diagnostics. Quote excerpts never enter progress or agent context. */
export interface TextbookReviewDiagnostic {
  findingIndex: number;
  field: string;
  message: string;
  disposition: 'ignored_advice' | 'needs_recheck';
  chapterId?: string;
  section?: keyof TextbookChapter['sections'];
  quote?: string;
}
export interface TextbookQuality {
  passed: boolean;
  issues: string[];
  findings?: TextbookFinding[];
  artifactHash?: string;
  schemaVersion?: 2 | 3;
  origin?: 'deterministic' | 'reviewer';
  reviewCriteriaVersion?: 3;
  status?: 'passed' | 'blocked' | 'needs_recheck';
  report?: TextbookReviewReport;
  warnings?: TextbookReviewFinding[];
  reviewErrors?: string[];
  reviewDiagnostics?: TextbookReviewDiagnostic[];
}
export interface TextbookProgressState {
  currentStage: TextbookPipelineStage;
  label: string;
  startedAt: string;
  stageStartedAt: string;
  steps: Array<{ stage: TextbookPipelineStage; status: 'pending' | 'running' | 'saved' | 'failed' | 'cancelled' }>;
  chapterId?: string;
  chapterTitle?: string;
  chapterIndex?: number;
  retry: number;
  retryLimit: number;
  requestMaxTokens?: number;
  requestThinkingMode?: 'enabled' | 'disabled';
  /** Actual transport parameters prepared for the pending request, not policy intent. */
  requestThinkingResolved?: boolean;
  requestReasoningEffort?: 'low' | 'high' | 'max';
  requestThinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  requestThinkingPreference?: import('../../types').LlmThinkingPreference;
  history: Array<{ at: string; stage: TextbookPipelineStage; label: string }>;
}
/** Safe UI snapshot: no sources, private profile, cognition or generated drafts. */
export interface TextbookProgress extends TextbookProgressState {
  jobId: string;
  projectNoteId: string;
  projectTitle: string;
  jobStage: TextbookStage;
  running: boolean;
  attempt: number;
  updatedAt: string;
  completed: number;
  total: number;
  chapters: Array<{ id: string; title: string; status: 'saved' | 'pending' | 'running' | 'needs_repair' }>;
  repairTargets?: Array<Pick<TextbookFinding, 'stage' | 'chapterId' | 'section'>>;
  qualityReview?: { status: 'passed' | 'blocked' | 'needs_recheck'; blockerCount: number; warningCount: number;
    ignoredAdviceCount?: number; reportIssues?: Array<{ findingIndex: number; field: string; chapterId?: string; section?: keyof TextbookChapter['sections'] }> };
  modelDiagnostics?: Omit<TextbookModelAttempt, 'inputHash'>;
  requiresReprepare?: boolean;
  /** Code revalidated an old impossible-field failure; no chapter repair is needed. */
  resumeAfterCodeFix?: boolean;
  archived?: boolean;
  modelPolicyVersion?: 1 | 2 | 3 | 4;
  complexChapterThinkingLimit?: number;
  materialStatus?: import('./webTypes').TextbookWebReadStatus[];
  localMaterialWarnings?: string[];
  supplementStatus?: { sources: number; searches: number; warnings: number };
  cost?: TextbookCostLedger & { limits: import('./modelPolicy').TextbookCostLimits };
  thinkingModes?: { blueprint: 'enabled' | 'disabled'; chapter: 'enabled' | 'disabled' };
  thinkingPreferences?: import('./thinkingSnapshot').TextbookThinkingSnapshot['preferences'];
  thinkingAdjustmentNotes?: string[];
  error?: string;
}
/** Numeric cost ledger, persisted before dispatch. Reasoning is part of completion tokens. */
export interface TextbookCostLedger {
  promptTokens: number; completionTokens: number; reservedTokens: number; requests: number;
  repairRounds: number; reviewRechecks: number; legacyUsageIncomplete: boolean;
  stopped?: 'tokens' | 'requests' | 'repairs' | 'reviews';
}
export interface TextbookSource {
  formulaEvidence?: import('./materialTypes').MaterialExcerpt['formulaEvidence'];
  sourceId: string;
  kind: 'document' | 'knowledge' | 'web';
  id: string;
  title: string;
  version: string;
  text: string;
  locator?: SourceLocator;
  textStart?: number;
  textEnd?: number;
  blockId?: string;
  assets?: import('./types').TextbookImageAsset[];
  web?: import('./webTypes').TextbookWebPointer;
}
export interface TextbookContext {
  project: { id: string; rootId: string; title: string; rootTitle: string; tasks: string[]; knowledgeTitles: string[] };
  profile: string;
  preferences: unknown;
  personal: Array<{ evidenceId: string; kind: 'confirmed_view' | 'unconfirmed_material' | 'learning_record'; text: string; reference: unknown; usableAsFactEvidence: false }>;
  previousLearning?: { id: string; title: string; endedAt: string; summary: string; unresolvedQuestions: string[] };
  mastery: unknown;
  warnings: string[];
}
/** Optional teaching presentation metadata, not factual claims or a new quality gate. */
export interface TeachingVisualPlan {
  format: 'mindmap' | 'flowchart' | 'sequenceDiagram' | 'timeline' | 'table' | 'chart' | 'function-plot' | 'science-diagram' | 'molecule' | 'textbook-image';
  section: 'explanation' | 'boundaries' | 'workedExample' | 'practice' | 'summary';
  purpose: string;
  readingQuestion: string;
}
export interface TeachingBlueprint {
  title: string;
  teachingTypes?: import('./teachingTypes').TextbookTeachingType[];
  /** Soft writing allocation, only attached to newly designed blueprints. */
  teachingPlan?: { version: 1; depth: 'focused' | 'extended'; targetChars: number };
  objectives: Array<{ id: string; text: string }>;
  focuses: Array<{ id: string; kind: 'expressed_view' | 'possible_confusion' | 'not_expressed'; description: string; evidenceIds: string[]; sourceIds: string[]; strategy: string }>;
  chapters: Array<{ id: string; title: string; objectiveIds: string[]; focusIds: string[]; sourceIds: string[]; bridge: string; visuals?: TeachingVisualPlan[];
    teachingTypes?: import('./teachingTypes').TextbookTeachingType[];
    reasoning?: import('./modelPolicy').TextbookReasoningKind;
    writingPlan?: { targetChars: number; sections: Array<keyof TextbookChapter['sections']>;
      /** Locally assigned for new blueprints only; uses the existing selfCheck slot. */
      restatement?: 1 } }>;
}
export interface TextbookChapter {
  id: string;
  sections: { explanation: string; boundaries: string; workedExample: string; practice: string; answer: string; selfCheck: string; summary: string };
}
/** The only sections rendered/published. Model-added metadata is not Markdown. */
export const TEXTBOOK_CHAPTER_SECTIONS = ['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'] as const;
export function textbookChapterContent(chapter: TextbookChapter): TextbookChapter {
  return { id: chapter.id, sections: Object.fromEntries(TEXTBOOK_CHAPTER_SECTIONS.map((name) => [name, chapter.sections[name]])) as TextbookChapter['sections'] };
}
export interface TextbookJobSpec {
  schemaVersion: 1;
  projectNoteId: string;
  rootProjectId: string;
  projectTitle: string;
  planningHash: string;
  allowedDocIds: string[];
  documentHashes: Record<string, string>;
  knowledgeHashes: Record<string, string>;
  providerHash: string;
  /** Frozen proposed model scope, not an execution/consent receipt. Generation still requires approval. */
  allowCloud: boolean;
  /** Independent of model cloud permission. Absent on legacy jobs: no network acquisition. */
  boundUrls?: import('./webTypes').TextbookBoundUrl[];
  readBoundUrls?: boolean;
  /** Only new, explicitly confirmed tasks gain optional discovery permission. */
  webSupplement?: import('./supplement').TextbookSupplementPolicy;
  sourceTitles?: string[];
  modelSummary?: string[];
  /** Local authoring capability version. Absent on old jobs: preserve their prompts/retry identities. */
  visualCapabilitiesVersion?: 2 | 3;
  /** New authoring instructions only. Missing on legacy jobs: never upgrade on resume. */
  promptVersion?: import('./promptVersion').TextbookPromptVersion;
  /** Absent only on legacy jobs, which must be prepared again before new model calls. */
  modelPolicy?: import('./modelPolicy').TextbookModelPolicy;
  /** Only new manual-thinking approvals carry this optional sidecar. */
  thinkingSnapshot?: import('./thinkingSnapshot').TextbookThinkingSnapshot;
}
export interface TextbookJob {
  schemaVersion: 1;
  id: string;
  spec: TextbookJobSpec;
  stage: TextbookStage;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  archivedAt?: string;
  cacheClearRevision?: string;
  cacheClearHistory?: Array<{ at: string; scope: TextbookDraftCacheSelection['scope']; chapterIds: string[]; backupChapterIds: string[] }>;
  checkpoint: {
    /** Capability failures only, bound to this job's pinned provider snapshot. Never image bytes. */
    visionFallbackModels?: string[];
    context?: TextbookContext; sources?: TextbookSource[]; blueprint?: TeachingBlueprint; chapters?: TextbookChapter[]; body?: string;
    webReads?: import('./webTypes').TextbookWebReadStatus[];
    localMaterialWarnings?: string[];
    webSupplement?: { queries: string[]; warnings: string[]; count: number };
    quality?: TextbookQuality;
    repairIssues?: string[];
    repair?: { findings: TextbookFinding[]; applied: boolean; origin?: 'deterministic' | 'reviewer' };
    /** Dependencies of a validated chapter, including its preceding summary. */
    chapterInputs?: Record<string, string>;
    progress?: TextbookProgressState;
    modelAttempts?: TextbookModelAttempt[];
    cost?: TextbookCostLedger;
    sectionRepairs?: Record<string, Array<keyof TextbookChapter['sections']>>;
    reviewCache?: { environmentHash: string; chapterHashes: Record<string, string>; report: TextbookReviewReport; reviewDiagnostics?: TextbookReviewDiagnostic[] };
    /** One recoverable private backup; explicit chapter regeneration never resets usage. */
    chapterRegeneration?: { requestedIds: string[]; pendingIds: string[]; previousChapters: TextbookChapter[]; requestedAt: string };
    /** Private recovery snapshot. Published reading content stays unchanged until safe commit. */
    publishedRevision?: { revisionId: string; nextRevisionId: string; originalPlanningHash: string; body: string; chapterIds: string[] };
  };
  error?: string;
}
export interface TextbookDraftCacheSelection {
  scope: 'all_generated' | 'selected_chapters' | 'backups_only';
  chapterIds?: string[];
}
export interface TextbookDraftCachePreview {
  jobId: string; projectNoteId: string; projectTitle: string; revision: string;
  scope: TextbookDraftCacheSelection['scope']; chapterIds: string[]; backupChapterIds: string[];
  clearsAssembledBody: boolean; autoArchive: boolean; hasContent: boolean;
  beforeBytes: number; afterBytes: number; freedBytes: number;
}
export type TextbookJobCommand = { op: 'create'; spec: TextbookJobSpec; reuseExisting?: boolean }
  | ({ op: 'preview-clear-cache'; jobId: string } & TextbookDraftCacheSelection)
  | ({ op: 'clear-cache'; jobId: string; expectedRevision: string } & TextbookDraftCacheSelection)
  | { op: 'archive'; jobId: string; archived: boolean }
  | { op: 'get'; jobId: string }
  | { op: 'claim'; jobId: string; expectedCacheClearRevision?: string; publishedRevision?: { expectedRevisionId: string; chapterIds: string[] } }
  | { op: 'checkpoint'; jobId: string; token: string; stage: TextbookStage; checkpoint: TextbookJob['checkpoint'] }
  | { op: 'stop'; jobId: string; token: string; cancelled: boolean; error: string }
  | { op: 'finish'; jobId: string; token: string };
export interface TextbookJobReply { job: TextbookJob; token?: string; reused?: boolean; running?: boolean; cacheClear?: TextbookDraftCachePreview }
export interface TextbookJobSummary { jobId: string; projectNoteId: string; stage: TextbookStage; title: string; completedChapters: number; totalChapters: number; updatedAt: string; error?: string; progress?: TextbookProgress; preferred?: boolean; archivedAt?: string }
export interface TextbookPublishInput { job: TextbookJob; body: string; signal?: AbortSignal }
export type TextbookPublisher = (input: TextbookPublishInput) => Promise<NoteItem>;
