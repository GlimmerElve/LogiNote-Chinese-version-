/**
 * Demo-first UI 改造的跨页面冻结契约。
 *
 * 这里只定义壳层与不可破坏的流程语义，不承载页面临时状态，也不替代
 * NoteItem / LearningEpisode / SceneSpec 等业务模型。P1 改造应让 App 的显示
 * 条件逐步收敛到这份表，而不是继续堆叠分散的 currentView 判断。
 */

import type { ViewMode } from '../../types';

export const UI_REFACTOR_CONTRACT_VERSION = 1 as const;

export type AppShellMode = 'workspace' | 'focus' | 'result' | 'standalone';

export type RefactorSurfaceId =
  | 'home'
  | 'profile'
  | 'profile-evidence'
  | 'editor'
  | 'graph'
  | 'timeline'
  | 'plan'
  | 'documents'
  | 'settings'
  | 'learn'
  | 'flow-session'
  | 'flow-result'
  | 'review-picker'
  | 'review-session'
  | 'review-result'
  | 'scene-builder'
  | 'scene-s1'
  | 'scene-s4'
  | 'argument-editor';

export interface SurfaceShellPolicy {
  shell: AppShellMode;
  showGlobalHeader: boolean;
  showGlobalSidebar: boolean;
  /** 当前 surface 自己负责返回/退出/窗口控制。 */
  ownsNavigation: boolean;
}

export const SURFACE_SHELL_POLICY: Readonly<Record<RefactorSurfaceId, SurfaceShellPolicy>> = {
  home: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  profile: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  'profile-evidence': { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  editor: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: true, ownsNavigation: false },
  graph: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  timeline: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  plan: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  documents: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  settings: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: true, ownsNavigation: false },
  learn: { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  'review-picker': { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  'scene-builder': { shell: 'workspace', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: false },
  'flow-session': { shell: 'focus', showGlobalHeader: false, showGlobalSidebar: false, ownsNavigation: true },
  'review-session': { shell: 'focus', showGlobalHeader: false, showGlobalSidebar: false, ownsNavigation: true },
  'scene-s1': { shell: 'focus', showGlobalHeader: false, showGlobalSidebar: false, ownsNavigation: true },
  'scene-s4': { shell: 'focus', showGlobalHeader: false, showGlobalSidebar: false, ownsNavigation: true },
  'flow-result': { shell: 'result', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: true },
  'review-result': { shell: 'result', showGlobalHeader: true, showGlobalSidebar: false, ownsNavigation: true },
  'argument-editor': { shell: 'standalone', showGlobalHeader: false, showGlobalSidebar: false, ownsNavigation: true },
};

/**
 * 当前 App 仍以 ViewMode 驱动路由。先在这里完成旧路由到新壳层的唯一映射，
 * 后续页面改造不得在 App.tsx 内继续维护排除名单。
 *
 * scene 的 S1/S4 在 App 层共享同一个入口，二者的壳层约束相同；具体运行
 * 视图仍由 SceneMode 根据 sceneSkill 分流。
 */
export const APP_VIEW_SHELL_POLICY: Readonly<Record<ViewMode, SurfaceShellPolicy>> = {
  home: SURFACE_SHELL_POLICY.home,
  profile: SURFACE_SHELL_POLICY.profile,
  'profile-evidence': SURFACE_SHELL_POLICY['profile-evidence'],
  editor: SURFACE_SHELL_POLICY.editor,
  graph: SURFACE_SHELL_POLICY.graph,
  timeline: SURFACE_SHELL_POLICY.timeline,
  plan: SURFACE_SHELL_POLICY.plan,
  settings: SURFACE_SHELL_POLICY.settings,
  learn: SURFACE_SHELL_POLICY.learn,
  documents: SURFACE_SHELL_POLICY.documents,
  bubble: SURFACE_SHELL_POLICY['review-picker'],
  flow: SURFACE_SHELL_POLICY['flow-session'],
  review: SURFACE_SHELL_POLICY['review-session'],
  scene: SURFACE_SHELL_POLICY['scene-s1'],
  argument: SURFACE_SHELL_POLICY['argument-editor'],
};

export type FlowExitAnalysisMode = 'save_only' | 'save_then_analyze';

export const FLOW_EXIT_POLICY = {
  analysisOff: 'save_only',
  analysisOn: 'save_then_analyze',
  alwaysSaveBeforeExit: true,
  analysisFailureMustNotRollbackSave: true,
} as const satisfies {
  analysisOff: FlowExitAnalysisMode;
  analysisOn: FlowExitAnalysisMode;
  alwaysSaveBeforeExit: boolean;
  analysisFailureMustNotRollbackSave: boolean;
};

/**
 * STT 原文是复盘评分的历史证据；清洗文本只是分析输入投影。
 * paraphrase-multilingual-MiniLM-L12-v2 仅用于相似度/分段辅助，不承担改写。
 */
export const FLOW_TRANSCRIPT_POLICY = {
  preserveRawTranscript: true,
  deterministicCleanup: ['filler_words', 'adjacent_repetition', 'pause_boundaries'] as const,
  optionalLlmOutputRole: 'analysis_copy_only',
  embeddingModelRole: 'similarity_and_segmentation_only',
  scoreAgainst: 'raw_transcript',
} as const;

export const REVIEW_EVIDENCE_POLICY = {
  minimumMasterySamples: 2,
  hiddenReasoningMustNotBeDisplayed: true,
  visibleTraceSource: 'user_answer_and_structured_observation',
} as const;

/**
 * 项目教材阶段零：以下仅冻结目标契约，不表示生成、存储或折叠组件已实现。
 * 独立版本不改变既有 UI / 心流 / 复习契约，后续实现须通过集成检查证明遵守。
 */
export const PROJECT_TEXTBOOK_CONTRACT_VERSION = 1 as const;

export const PROJECT_TEXTBOOK_POLICY = {
  identity: 'stable_project_note_id',
  defaultWhenPresent: 'continue_existing_revision',
  automaticRegenerationTriggers: [] as const,
  operations: {
    create: { requiresExplicitApproval: true, whenPresent: 'return_existing', writeScope: 'textbook_region' },
    rewrite: { requiresExplicitApproval: true, preserveHistory: true, writeScope: 'textbook_region' },
    append: { requiresExplicitApproval: true, preserveExistingChapters: true, writeScope: 'textbook_region_end' },
  },
  approvalBindings: ['projectNoteId', 'operation', 'localMaterialScope', 'networkPermission', 'jobId'] as const,
  changedScopeInvalidatesApproval: true,
  expiredApprovalCannotBeResumed: true,
  idempotency: 'one_publication_per_authorized_operation',
  maximumConcurrentWritersPerProject: 1,
  changedTextbookBaseHash: 'reject_and_preserve_draft',
  unrelatedNoteChanges: 'merge_from_latest_note',
  publish: 'atomic_or_recoverable_transaction',
  successEvidence: 'persisted_publication_receipt',
  materialOrder: 'local_first_network_for_identified_gaps_only',
  sufficientLocalMaterialsNetworkCalls: 0,
  review: 'suggest_in_chat_use_existing_entry',
  previousLessonReviewInsideTextbook: false,
} as const;

export const TEXTBOOK_EVIDENCE_POLICY = {
  roles: {
    generatedTextbook: 'teaching_material',
    knowledgeNote: 'reference_material',
    importedDocument: 'reference_material',
    publicWebpage: 'reference_material',
    projectRestatement: 'unconfirmed_personal_material',
    publishedUserArgument: 'unconfirmed_personal_material',
    confirmedCognition: 'confirmed_personal_cognition',
  },
  generatedTextbookIsUserRestatement: false,
  generatedTextbookIsConfirmedCognition: false,
  editedTextbookRetainsSourceRole: true,
  graphBlockMarkupIsRestatement: false,
  learningRecordTitleIsRestatement: false,
  learningRecordGraphUsesExistingChannel: true,
  retrievedMaterialsAreInstructions: false,
  searchSnippetIsReadFulltext: false,
  missingPersonalEvidenceMeansMisconception: false,
  recentLearningScope: 'current_root_project_actual_learning_time',
} as const;

export const FLOW_REVIEW_RECORD_POLICY = {
  identity: 'stable_flow_session_id',
  recordsPerCompletedSession: 1,
  sameDayDifferentSessions: 'separate_records',
  repeatedSaveOrAnalysisRetry: 'update_same_record',
  restatementInput: 'session_text_not_note_body',
  temporarySave: 'session_data_before_analysis_without_body_replacement',
  finalSave: 'record_text_and_graph_reference_together',
  analysisOffOrFailure: 'retain_text_without_fabricated_graph',
  block: 'LearningReviewBlock',
  expandedContents: ['session_restatement', 'existing_ArgumentBlock'] as const,
  defaultTitle: 'actual_learning_time',
  titleEditable: true,
  preserveUserEditedTitle: true,
  argumentDocumentStore: 'NoteItem.argumentDocs',
  argumentEditSave: 'update_original_graph_and_record',
  preserveArgumentEntry: true,
  preserveArgumentQualityAndPublicationRules: true,
  ambiguousLegacyAssociation: 'leave_original_text_and_graph_entry_in_place',
  migration: 'versioned_idempotent_with_recoverable_original',
  textbookRevisionChangesPreserveRecords: true,
  collapseStateAndReadingProgress: 'personal_state',
  textbookOnlyShareIncludesPersonalRestatement: false,
  fullPersonalBackupPreservesRecordsAndGraphReferences: true,
} as const;

export const TEXTBOOK_ISOLATION_POLICY = {
  resourceRecommendation: 'unchanged',
  resourceDraftIsTextbookDraft: false,
  automaticallyAppendProjectResources: false,
  conceptFill: 'independent_exact_knowledge_title_and_aliases',
  automaticallyOverwriteKnowledgeNotes: false,
  reuseMathLiveKatexAndExistingRag: true,
  generationOrReadingAddsMasterySample: false,
  generationPublishesUserArgument: false,
  generationCompletesPlanTask: false,
  generationUpdatesConfirmedCognition: false,
} as const;
