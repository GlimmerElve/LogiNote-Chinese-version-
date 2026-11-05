import { ProgressiveReviewWorker } from './services/progressiveLearning/reviewWorker';
import { rebasePreparedResources, plannedPreparationDocuments } from './services/progressiveLearning/preparation';
import { buildLearningProjectQueue } from './services/learningProjectQueue';
import { progressiveReviewCommand } from './services/progressiveLearning/reviewClient';
import { loadProgressiveCourse } from './services/progressiveLearning/client';
import {registerCommunitySourceFlush} from './services/community/sourceFlush';
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { resolveEditorNote, shouldPublishNoteSnapshot } from './services/ui/noteSnapshotPublication';
import { prepareAgentNoteCreation } from './services/agent/noteCreation';
import { createResourceDownloadClient } from './services/agent/resourceDownloadClient';
import { bindDownloadedProjectResources } from './services/resourceDownloads';
import { captureRestatementCognition } from './services/cognition/store';
import {
  NoteItem, NoteType, ViewMode, VaultSettings, SyncStatus, DueDateItem, PlanMeta, PlanNode, StudyQuestionCard,
  KnowledgePointCandidate, KnowledgePointMasteryResult, ProfileInsight, ResourceItem, ReviewMessage,
  ResourceBrowserCandidateDecisionEvent,
  ResourceBrowserClosedEvent,
  ResourceWorkbenchCommitEvent,
} from "./types";
import {
  loadNotesFromStorage, readNotesForCognition, saveAllNotesToStorage, loadSettingsFromStorage, loadAppSettingsFromStorage, saveSettingsToStorage,
  parseNoteMetadata, recalculateBacklinks
} from "./services/storage";
import { WorkspaceNavigation, WorkspaceTopbar } from "./components/Header";
import { FocusShellHeader } from "./components/FocusShellHeader";
import { Sidebar, type SidebarTreeSnapshot } from "./components/Sidebar";
import { lazyFeature } from './components/lazyFeature';
import { LearningCompletionCard } from './components/LearningCompletionCard';
import { getLearningCompletionTarget, getProjectCompletionTarget, type LearningCompletionTarget, type LearningTaskBinding } from './services/learningCompletion';
import type { HomeFocusProject } from './services/homepage/homepageViewModel';
import { resolveHomeContinueAction } from './services/homepage/homeTaskLaunch';
import { commitLearningCompletion } from './services/ui/learningCompletionWrite';
import { commitPlanWrite } from './services/ui/planWrite';
import { commitReviewExitWrite, prepareReviewExitOutcome, type ReviewExitProgress } from './services/ui/reviewExitWrite';
import { enqueueLearningWrite, enqueueLatestNotesSave, flushLatestNoteWrites } from './services/ui/learningWriteQueue';
import { prepareCommunityNoteAppend } from './services/ui/communityNoteAppend';
import { trackReadingOnlySave, saveReadingPositionOnly, type ReadingOnlySave } from './services/ui/readingPositionSave';
import { trackPersonalOnlySave, savePersonalStateOnly, acknowledgePersonalSave, type PersonalOnlySave } from './services/ui/personalNoteSave';
import { isPersonalOnlyNoteChange, personalNotePatches } from './services/personalNoteState';
import { applyWindowTheme, connectPreferredWindowTheme, normalizeWindowTheme } from './services/ui/windowAppearance';
import { ContextNotePages, ContextSourceForward } from './components/ContextNotePages';
import { useSceneGuard } from './components/useSceneGuard';
import { useReviewExitGuard } from './components/useReviewExitGuard';
import { allowCognitionLeave } from './services/ui/cognitionLeave';
import type { ReviewExitSaveState } from './services/ui/reviewExitNavigation';
import { planDraftKey, clearManualPlanDraft } from './services/ui/manualPlanDraft';
import { acknowledgedSaveState, type NoteSaveState } from './services/ui/saveFeedback';
import { createOptimisticNoteDeletionState, stageOptimisticNoteDeletion, acknowledgeOptimisticNoteDeletion,
  rollbackOptimisticNoteDeletions, rejectLateDeletedNoteUpdate } from './services/ui/optimisticNoteDeletion';
import { connectApplicationExit, rendererExitPreparation, waitForExitCondition } from './services/ui/applicationExit';
import { documentBackgroundJobs } from './services/documentBackgroundJobs';
import { documentJobActive } from './services/documentBackgroundQueue';
import { conceptBatchJobs } from './services/conceptBatchService';
import { backgroundWorkflows } from './services/agent/backgroundWorkflowService';
import { backgroundWorkflowActive } from './services/agent/backgroundWorkflowTypes';
import { conceptBatchActive } from './services/conceptBatchTypes';
import { initializeWikiKnowledge } from './services/wikiKnowledge';
import { agentTaskScope } from './services/agent/taskStateClient';
import { NoteSaveRecovery } from './components/NoteSaveRecovery';
import './components/NoteSaveRecovery.css';
import { useNoteSaveLeaveProtection } from './components/useNoteSaveLeaveProtection';
import { useVaultStartup } from './components/useVaultStartup';
import { VaultStartupView } from './components/VaultStartupView';
import './components/VaultStartupView.css';
import { useAppSettings } from './components/useAppSettings';
import { ensureLlmSettingsLoaded, flushLlmSettingsWrites, retryLlmSettingsSave } from './services/llmStorage';
import { useLlmSettingsWrite } from './components/useLlmSettingsWrite';
import { ModelSettingsFeedback } from './components/ModelSettingsFeedback';
import { AppSettingsFeedback } from './components/AppSettingsFeedback';
import './components/AppSettingsFeedback.css';
import { hasActiveDialog } from './components/useDialog';
import { useContextNavigation } from './components/useContextNavigation';
import { getContextFocusedNote, getContextSourceLabel } from './services/ui/contextNavigation';
import { createNoteNavigationSave, confirmNoteNavigation, NOTE_AUTOSAVE_IDLE_MS, type NavigationSave } from './services/ui/noteAutosave';
import { availableNoteTitle } from './services/noteCreation';
import { homeLocalDate } from './services/homepage/homeTaskScheduling';
import type { PlanAdjustmentScope, PlanTaskCreateInput } from "./components/PlanWorkspace";
import type { PlanBuilderDraftValue } from "./components/PlanBuilder";
import { assertHardDraftCapacity, buildLearningCapacity, learningCapacitySummary, prepareLearningCapacityPatch, weekStartDate } from './services/learningCapacity';
import { CommandPalette } from "./components/CommandPalette";
import { PrivacyPolicyModal } from "./components/PrivacyPolicyModal";
import { ArgumentActionDialog, type ArgumentActionRequest } from './components/ArgumentActionDialog';
import { prepareStormNoteWrite } from "./services/stormNoteWrite";
import { prepareConceptNoteWrite } from './services/ui/conceptNoteWrite';
import type { FlowResultData } from "./components/FlowResultView";
import { FlowResultWriteController, type FlowResultOperation } from './services/ui/flowResultWrite';
import { useCanvasStore } from './modules/argumentCanvas/store/canvasStore';
import { QuickCheckProvider, QuickCheckButton, type QuickCheckController } from './components/quickCheck';
import { applyQuickCheckAssessment, type QuickCheckSession, type QuickCheckAssessment } from './services/quickCheck';
import { commitQuickCheckWrite, type QuickCheckWriteProgress } from './services/ui/quickCheckWrite';
import { buildReviewOpeningQuestion } from './services/reviewAssessment';
import { createSceneProjectNoteSource } from './services/scene/sceneProjectNoteAccess';
import { SCENE_S1_DEMO_NOTES } from './components/scene/sceneS1DemoNotes';
import type { SceneInitialRequest, SceneRunState, SceneSpec } from "./types";
import { prepareDocumentProjectBindings } from './services/documentProjectBindings';
import { createDocumentBindingPort } from './services/agent/documentBindings';
import { listDocuments } from './services/documentRagClient';
import { HomeView } from "./components/HomeView";
import { AgentOrb } from "./components/AgentOrb";
import { SelectionActionHub } from "./components/SelectionActionHub";
import { useKnowledgeDiscovery } from './components/useKnowledgeDiscovery';
import { indexNote, finishDeletedNoteIndexCleanup, indexAllNotes } from "./services/ragService";
import { prepareNotesMetadata, prepareSelectedNoteMetadata } from './services/noteMetadataClient';
import { saveSelectedKnowledgeDelta } from './services/storage';
import { prepareKnowledgeDeletion, prepareKnowledgeMerge } from './services/knowledgeMaintenance';
import { KnowledgeMaintenanceHub } from './components/KnowledgeMaintenanceHub';
import { persistedNoteSaveBaseline } from './services/noteSaveBaseline';
import { rebaseProgressiveKnowledge, type ProgressiveKnowledgeChange } from './services/progressiveLearning/knowledgeProjection';
import { prepareNoteSaveRecovery } from './services/noteSaveRecovery';
import { requestNoteIndexRefresh, setNoteIndexEditing } from './services/ragService';
import { ReviewAnalysis } from "./types";
import { FlowSession } from "./types";
import { saveFlowReviewRecord, finishFlowReviewRecord, saveReviewArgument, patchLearningReviewRecord, detachReviewArgument } from './services/textbook/reviewRecordStore';
import { flowReviewAdmission } from './services/textbook/reviewAdmission';
import type { LearningReviewPatch, LearningReviewStatus } from './services/textbook/types';
import { recordNewMastered, recordStudyDuration } from "./services/learningAbility/timelineStore";
import { flushProfileStateWrites, hydrateFromUserState } from "./services/electronUserState";
import { hydrateProfileFromUserState } from "./services/profile/profileStore";
import { discoverKnowledgePointsDetailed } from "./services/knowledgeScoringService";
import { evaluateFlowKnowledgeMastery, prepareFlowMasteryOutcome } from './services/masteryShadow/flow';
import { resolveNoteByTitleOrAlias, resolveNoteReference, ambiguousNoteReferenceMessage, noteAliasesError, findNotesByTitleOrAlias, parseWikiLink } from "./services/noteResolver";
import { applyNoteRenameReferences } from './services/noteRename';
import { buildProjectReviewKnowledgeContext } from "./services/knowledgePointSelector";
import type { AnalysisPhase } from "./components/AnalysisProgressModal";
import type { ArgDoc } from "./services/argumentDoc/types";
import {
  appendArgumentQualityAudit,
  createPublishedSnapshot,
} from "./services/argumentDoc/quality";
import { prepareArgumentPublication, type ArgumentPublicationChoice } from './services/ui/argumentPublication';
import type { FlowAnalysisReport, FlowReviewAnalysisResultV2 } from "./services/flowAnalysis/types";
import { createMockFlowResult } from "./services/flowAnalysis/mockResult";
import { reassessArgumentStructure } from "./services/argumentDoc/reassess";
import { clearReviewDraftsForNote, flushLearningEpisodeWrites, patchLearningEpisode, saveLearningEpisode } from "./services/memory/episodeStore";
import type { ReviewAnswerEvidence, ReviewEpisodeCapture } from "./services/memory/types";
import {
  extractFlowEvidence,
  extractPlanEvidence,
  extractReviewEvidence,
  extractSceneEvidence,
  summarizePlan,
} from "./services/memory/evidenceExtractor";
import { ingestProfileSignals } from "./services/profile/evidenceGate";
import { buildFlowStatisticsSubmission, saveFlowStatistics } from './services/flowAnalysis/postStatistics';
import {
  adjustPlanAfterNoteUpdate,
  appendProjectStudyTaskBatch,
  appendProjectStudyTasks,
  applyPlanTaskChange,
  buildProjectPlanNotes,
} from "./services/planAdjustmentService";
import { AGENT_ROLES } from "./services/agent/agentEngine";
import { ensureDataFresh, registerPendingFlush, capturePendingChanges, flushPendingChanges } from "./services/agent/dataFreshness";
import { publishTextbookAfterSave } from './services/textbook/publication';
import { patchTextbookReadingPosition, retainLatestTextbookReadingPosition, type TextbookReadingPosition } from './services/textbook/readingState';
import { applyWorkspaceNoteChange, prepareNoteEdit, type WorkspaceNoteChange } from './services/agent/workspaceOperations';
import { agentOperationStore, commitAgentWorkspaceChange, prepareOperationUndo } from './services/agent/operationStore';
import { applyAccentAppearance } from './services/ui/accentAppearance';
import { bootstrapAgentRuntime } from "./services/agent/bootstrap";
import { normalizeAgentPersona } from "./services/agent/persona";
import { normalizeAgentReviewLaunchRequest } from "./services/agent/reviewLaunchRequest";
import {
  buildPlanDraftMutation,
  createPortfolioPlanDraftSession,
  createPlanDraftSession,
  stagePlanDraftBatch,
  stagePlanExecutionPatches,
  stagePlanMetaPatch,
  stagePlanMilestonePatches,
  stagePortfolioPlanPatches,
  stagePlanStructurePatches,
  summarizePlanDraft,
  assertPlanDraftFresh,
} from "./services/agent/planDraftService";
import {
  applyConfirmedWorkbenchResources,
  applyTrustedAutoResources,
  buildResourceDraftMutation,
  createResourceDraftSession,
  registerDiscoveredResources,
  registerResourceBrowserSession,
  setResourceCandidateDecision,
  stageResourceDraftBatch,
  summarizeResourceDraft,
  validateResourceSearchTarget,
  assertResourceDraftFresh,
} from "./services/agent/resourceDraftService";
import {
  getResourceStateSnapshot,
  recordResourceDiscoveryPreference,
  recordResourceDiscoveryPreferences,
  selectResourcesForAutomaticCollection,
  summarizeAutomaticResourceSkips,
  trustedResourceHosts,
} from "./services/resourceState";
import { buildAutomaticResourcePlan, summarizeResourceMix, RESOURCE_CATEGORY_LABELS } from './services/resourceCuration';
import { planResourceSearch, reviewResourceCandidates, type ResourceSemanticModel } from './services/resourceSemanticSearch';
import { callLLM } from './services/llmService';
import type { AgentObservedOutcome, AgentPlanDraftSession, AgentProjectPlanNode, AgentResourceDraftSession, AgentReviewLaunchRequest, AgentRuntimeContext, AgentWorkspaceEvent, AgentWorkflowHandoff } from "./services/agent/types";
import { buildPersistedPlanHandoff, buildReviewHandoff, buildSceneHandoff, loadWorkflowHandoff, saveWorkflowHandoff } from "./services/agent/workflowHandoff";
import { flushAgentAuditWrites, recordAgentHandoffAudit } from "./services/agent/auditStore";
import {
  buildAgentWorkflowDraftFile,
  buildPlanEditorBaseRevisions,
  cacheAgentWorkflowDraftFile,
  isPlanEditorDraftFresh,
  loadAgentWorkflowDraftState,
  saveAgentWorkflowDraftFile,
  type AgentWorkflowDraftFile,
  type AgentWorkflowResumeView,
} from "./services/agent/workflowDraftStore";
import { flushSceneInteractionAuditWrites } from "./services/scene/sceneInteractionAudit";
import { flushSceneAssemblyAuditWrites } from "./services/scene/sceneAssemblyAudit";
import { buildSelectionAgentPrompt, type SelectionActionId, type SelectionContext } from "./services/selectionActions";
import { collectKnowledgePoints } from "./services/scene/sceneKnowledgePoints";
import { APP_VIEW_SHELL_POLICY } from "./services/ui/refactorContracts";
import { withReviewDemoFixtures } from "./services/reviewDemoFixtures";
import { withKnowledgeGraphDemoFixtures } from "./services/knowledgeGraphDemoFixtures";
import { createPlanWorkspaceDemoNotes } from "./services/planDemoFixtures";
import { createPlanTaskId, formatPlanTaskLine } from "./services/planTaskAnchor";
import { getScheduledProjectState } from "./services/planProjectState";
import { applyPlanCompletionIntent, type PlanCompletionIntent } from "./services/planCompletion";
import {
  addPublishedPlanStructureItem,
  buildPublishedPlanEditorValue,
  replacePublishedPlanFromEditor,
  type PublishedPlanEditorValue,
  type PublishedPlanStructureAddInput,
} from "./services/publishedPlanEditor";

// Keep the home/navigation shell eager. Feature code is fetched only when its
// route or dialog is actually used; each boundary leaves the shell interactive.
const NoteEditor = lazyFeature('笔记编辑器', () => import('./components/RetainedNoteEditor').then(module => ({ default: module.RetainedNoteEditor })));
const GraphView = lazyFeature('知识图谱', () => import('./components/GraphView').then(module => ({ default: module.GraphView })));
const PlanWorkspace = lazyFeature('学习计划', () => import('./components/PlanWorkspace').then(module => ({ default: module.PlanWorkspace })));
const PlanBuilder = lazyFeature('计划编排', () => import('./components/PlanBuilder').then(module => ({ default: module.PlanBuilder })));
const SettingsModal = lazyFeature('设置', () => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const LearnHub = lazyFeature('学习', () => import('./components/LearnHub').then(module => ({ default: module.LearnHub })));
const FlowMode = lazyFeature('心流学习', () => import('./components/FlowMode').then(module => ({ default: module.FlowMode })));
const FlowAnalysisPanel = lazyFeature('复盘分析', () => import('./components/FlowAnalysisPanel').then(module => ({ default: module.FlowAnalysisPanel })));
const FlowResultView = lazyFeature('复盘结果', () => import('./components/FlowResultView').then(module => ({ default: module.FlowResultView })));
const ReviewChat = lazyFeature('复习对话', () => import('./components/ReviewChat').then(module => ({ default: module.ReviewChat })));
const ReviewHub = lazyFeature('复习', () => import('./components/ReviewHub').then(module => ({ default: module.ReviewHub })));
const SceneMode = lazyFeature('场景模拟', () => import('./components/SceneMode').then(module => ({ default: module.SceneMode })));
const SceneS2CanvasTrial = lazyFeature('场景画布', () => import('./components/scene/SceneS2PackBoundary').then(module => ({ default: module.SceneS2PackBoundary })));
const SceneRichMessage = lazyFeature('笔记内容', () => import('./components/scene/SceneRichMessage').then(module => ({ default: module.SceneRichMessage })));
const SceneReferenceDialog = lazyFeature('引用笔记', () => import('./components/scene/SceneReferenceDialog').then(module => ({ default: module.SceneReferenceDialog })));
const DocumentsView = lazyFeature('资料库', () => import('./components/DocumentsView').then(module => ({ default: module.DocumentsView })));
const ProfileOverviewView = lazyFeature('学习画像', () => import('./components/ProfileOverviewView').then(module => ({ default: module.ProfileOverviewView })));
const ProfileEvidenceView = lazyFeature('画像证据', () => import('./components/ProfileEvidenceView').then(module => ({ default: module.ProfileEvidenceView })));
const AgentPanel = lazyFeature('学习助手', () => import('./components/AgentConversationWorkspace').then(module => ({ default: module.AgentConversationWorkspace })),
  { when: props => props.open || Boolean(props.externalRequest), visible: props => props.open, stateClassName: 'agent-panel' });
const ConceptFillModal = lazyFeature('概念补全', () => import('./components/ConceptFillModal').then(module => ({ default: module.ConceptFillModal })));
const KnowledgePointSelectionModal = lazyFeature('知识点选择', () => import('./components/KnowledgePointSelectionModal').then(module => ({ default: module.KnowledgePointSelectionModal })));
const AnalysisProgressModal = lazyFeature('分析进度', () => import('./components/AnalysisProgressModal').then(module => ({ default: module.AnalysisProgressModal })));
const SceneS1DemoPage = lazyFeature('场景示例', () => import('./components/scene/SceneS1DemoPage').then(module => ({ default: module.SceneS1DemoPage })));
const SceneS4DemoPage = lazyFeature('推导示例', () => import('./components/scene/SceneS4DemoPage').then(module => ({ default: module.SceneS4DemoPage })));
const LearningCompletionDemoPage = lazyFeature('学习收尾示例', () => import('./components/LearningCompletionDemoPage').then(module => ({ default: module.LearningCompletionDemoPage })));
const ReviewExitDemoPage = lazyFeature('复习示例', () => import('./components/ReviewExitDemoPage').then(module => ({ default: module.ReviewExitDemoPage })));

bootstrapAgentRuntime(AGENT_ROLES.default);

function isProjectWithinPlanRoot(notes: NoteItem[], projectId: string, rootId: string): boolean {
  const projects = new Map(
    notes.filter((note) => note.noteType === 'project').map((note) => [note.id, note]),
  );
  let current = projects.get(projectId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === rootId) return true;
    visited.add(current.id);
    current = current.parentId ? projects.get(current.parentId) : undefined;
  }
  return false;
}

const REVIEW_SESSION_DEMO_MESSAGES: ReviewMessage[] = [
  {
    id: 'review-session-demo-tutor-1',
    role: 'tutor',
    content: '如果先验概率很低，仅凭一次阳性结果，我们能直接下结论吗？为什么？',
    timestamp: new Date(Date.now() - 260_000).toISOString(),
  },
  {
    id: 'review-session-demo-user-1',
    role: 'user',
    content: '我觉得不能直接下结论。因为即使一个事件的先验概率很低，如果检测方法不够准确，仍然可能出现假阳性。一次阳性结果只是提供了新的证据，会提高该事件发生的后验概率，但不一定使它变得很高。',
    timestamp: new Date(Date.now() - 180_000).toISOString(),
  },
  {
    id: 'review-session-demo-tutor-2',
    role: 'tutor',
    content: '很好，你已经区分了“新证据”与“最终结论”。那么后验概率变化的幅度主要取决于哪些因素？请结合似然度和假阳性率继续分析。',
    timestamp: new Date(Date.now() - 80_000).toISOString(),
  },
];

const REVIEW_SESSION_DEMO_EVIDENCE: ReviewAnswerEvidence[] = [{
  answer: REVIEW_SESSION_DEMO_MESSAGES[1].content,
  hintLevel: 0,
  targetKnowledgeNames: ['贝叶斯定理'],
}];

function closeDraftBrowserSessions(session: AgentResourceDraftSession | null): void {
  const browser = (window as any).electronAPI?.resourceBrowser;
  if (!browser?.close || !session) return;
  const ids = new Set([
    ...session.browserSessionIds,
    ...session.discoveredResources.map((resource) => resource.browserSessionId).filter(Boolean),
  ]);
  ids.forEach((sessionId) => { void browser.close(sessionId); });
}

export default function App() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  // This mirrors only published React state, never the authoritative draft ref.
  const publishedNotesRef = useRef(notes); publishedNotesRef.current = notes;
  useEffect(() => window.electronAPI?.learningPreparation?.onChange((_id, change) => {
    if (!change) return;
    void enqueueLearningWrite(learningWriteQueueRef, async () => {
      const before = persistedNoteSaveBaseline.snapshot()?.find(note => note.id === change.noteId);
      const current = notesRef.current.find(note => note.id === change.noteId);
      if (!notesReadyRef.current || !before || !current) return;
      const rebased = rebasePreparedResources(current, before, change); if (!rebased) return;
      persistedNoteSaveBaseline.acknowledgeDelta({ upserts: [{ before, note: rebased.saved }], removed: [] });
      const next = notesRef.current.map(note => note.id === change.noteId ? rebased.note : note);
      notesRef.current = next;
      if (pendingNotesRef.current) { pendingNotesRef.current = next; readingOnlySaveRef.current = null; personalOnlySaveRef.current = null; }
      setNotes(next);
    }).catch(error => console.warn('[learning-preparation] 已保存的资源可稍后刷新:', error));
  }), []);
  useEffect(() => window.electronAPI?.progressiveLearning?.onKnowledge?.((saved: NoteItem[], change?: ProgressiveKnowledgeChange) => {
    void enqueueLearningWrite(learningWriteQueueRef, async () => {
      const baseline = persistedNoteSaveBaseline.snapshot();
      if (!notesReadyRef.current || !baseline) return;
      // Bounded new objects only. Never reload or replace an editor draft during background indexing.
      const appended = prepareCommunityNoteAppend(notesRef.current, saved, baseline);
      persistedNoteSaveBaseline.acknowledgeNew(appended.added);
      // The host already committed these objects. Do not parse the entire library on the UI thread for each page.
      let next = appended.notes;
      if (change) {
        const before = baseline.find(note => note.id === change.note.id), current = next.find(note => note.id === change.note.id);
        const rebased = before && current ? rebaseProgressiveKnowledge(current, before, change) : null;
        if (rebased) {
          persistedNoteSaveBaseline.acknowledgeDelta({ upserts: [{ before: change.before, note: change.note }], removed: [] });
          next = next.map(note => note.id === rebased.id ? rebased : note);
        }
        const backlinks = new Map(change.knowledgeBacklinks?.map(item => [item.id, item.backlinks]) || []);
        const refreshed = next.filter(note => backlinks.has(note.id)).map(note => ({ ...note, backlinks: backlinks.get(note.id)! }));
        if (refreshed.length) {
          persistedNoteSaveBaseline.acknowledgeFields(refreshed, ['backlinks']);
          const byId = new Map(refreshed.map(note => [note.id, note])); next = next.map(note => byId.get(note.id) || note);
        }
      }
      if (next === notesRef.current) return;
      notesRef.current = next;
      if (pendingNotesRef.current) { pendingNotesRef.current = next; readingOnlySaveRef.current = null; personalOnlySaveRef.current = null; }
      setNotes(next);
      for(const note of appended.added)if(note.parentId)progressiveReviewWorkerRef.current?.kick(note.parentId);
    }).catch(error => console.warn('[progressive-learning] 知识点刷新失败，已保留本地文件:', error));
  }), []);
  useEffect(() => window.electronAPI?.community?.onNotesChanged(() => {
    void enqueueLearningWrite(learningWriteQueueRef, async () => {
      if (!notesReadyRef.current) return;
      // Import notifications are additive reads, not a new whole-vault baseline.
      // Keep drafts and locally pending deletions anchored to their original before.
      const saved = await readNotesForCognition();
      const baseline = persistedNoteSaveBaseline.snapshot();
      if (!notesReadyRef.current || !baseline) return;
      const appended = prepareCommunityNoteAppend(notesRef.current, saved, baseline);
      if (!appended.added.length) return;
      const next = recalculateBacklinks(appended.notes);
      persistedNoteSaveBaseline.acknowledgeNew(appended.added);
      notesRef.current = next;
      if (pendingNotesRef.current) {
        pendingNotesRef.current = next;
        readingOnlySaveRef.current = null; personalOnlySaveRef.current = null;
      }
      setNotes(next);
    }).catch(error => console.warn('[community] 导入笔记刷新失败，磁盘内容仍已保留:', error));
  }), []);
  const notesRef = useRef<NoteItem[]>([]);
  const notesReadyRef = useRef(false);
  const sidebarTreeStateRef = useRef<SidebarTreeSnapshot | null>(null);
  const [sidebarRevealRevision, setSidebarRevealRevision] = useState(0);
  const [activeNoteId, setActiveNoteIdState] = useState<string | null>(null);
  const [activeProjectContextId, setActiveProjectContextId] = useState<string | null>(null);
  const [currentView, setCurrentViewState] = useState<ViewMode>(() => {
    const demo = new URLSearchParams(window.location.search).get('demo');
    return demo === 'review-picker' ? 'bubble'
      : demo === 'review-session' ? 'review'
      : demo === 'knowledge-graph' ? 'graph'
      : demo === 'learning-plan' ? 'timeline'
      : demo === 'plan-builder' ? 'plan'
      : demo === 'scene-s1' || demo === 'scene-s4' ? 'scene'
      : 'home';
  });
  const navigationSave = useRef(createNoteNavigationSave());
  const navigationSaveIO = useRef<NavigationSave>({ capture: () => {}, dirty: () => false, revision: () => 0, flush: async () => {} });
  const requestNoteNavigation = useCallback((action: () => void, cancel?: () => void) => navigationSave.current.request(action, navigationSaveIO.current, cancel), []);
  // Every identity change uses the same save boundary, including restored jobs
  // and Agent result callbacks that do not go through the sidebar handler.
  const setActiveNoteId = useCallback((value: React.SetStateAction<string | null>) => {
    if (!allowCognitionLeave()) return;
    requestNoteNavigation(() => { if (allowCognitionLeave()) setActiveNoteIdState(value); });
  }, [requestNoteNavigation]);
  const contextNavigation = useContextNavigation(requestNoteNavigation);
  const sceneGuard = useSceneGuard();
  const reviewExitGuard = useReviewExitGuard();
  const currentViewRef = useRef(currentView);
  const navigationRevisionRef = useRef(0);
  currentViewRef.current = currentView;
  const allowWorkspaceNavigation = useCallback(() => notesReadyRef.current && reviewExitGuard.allowNavigation() && sceneGuard.allowNavigation() && allowCognitionLeave(),
    [reviewExitGuard.allowNavigation, sceneGuard.allowNavigation]);
  const [sceneReferenceNote, setSceneReferenceNote] = useState<NoteItem | null>(null);
  // Deliberate workspace navigation ends the reference branch; opening a note does not.
  const setCurrentView = useCallback((view: React.SetStateAction<ViewMode>) => {
    if (!reviewExitGuard.allowNavigation()) return;
    if (!sceneGuard.allowNavigation()) return;
    if (!allowCognitionLeave()) return;
    requestNoteNavigation(() => {
      if (!reviewExitGuard.allowNavigation() || !sceneGuard.allowNavigation() || !allowCognitionLeave()) return;
      const next = typeof view === 'function' ? view(currentViewRef.current) : view;
      navigationRevisionRef.current++;
      currentViewRef.current = next;
      contextNavigation.reset();
      setCurrentViewState(next);
    });
  }, [contextNavigation.reset, reviewExitGuard.allowNavigation, sceneGuard.allowNavigation, requestNoteNavigation]);
  const [initialSettings] = useState<VaultSettings>(() => {
    const cached = loadSettingsFromStorage();
    const initialTheme = normalizeWindowTheme((window as any).electronAPI?.appearance?.initialTheme);
    return initialTheme ? { ...cached, theme: initialTheme } : cached;
  });
  const appSettings = useAppSettings(initialSettings, loadAppSettingsFromStorage, saveSettingsToStorage);
  const llmSaveState = useLlmSettingsWrite(true);
  const settings = appSettings.settings;
  const agentPersona = useMemo(() => normalizeAgentPersona(settings.agentPersona), [settings.agentPersona]);
  const agentRole = useMemo(() => ({ ...AGENT_ROLES.default, name: agentPersona.displayName }), [agentPersona.displayName]);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [argumentAction, setArgumentAction] = useState<ArgumentActionRequest | null>(null);
  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const [agentExternalRequest, setAgentExternalRequest] = useState<{ id: string; text: string; targetSkillId?: string; observedOutcome?: AgentObservedOutcome } | null>(null);
  const [agentRecentEvents, setAgentRecentEvents] = useState<AgentWorkspaceEvent[]>([]);
  const recordAgentWorkspaceEvent = useCallback((event: AgentWorkspaceEvent) => {
    setAgentRecentEvents((current) => [...current.filter((item) => item.id !== event.id), event].slice(-12));
  }, []);
  const [planDraftSession, setPlanDraftSession] = useState<AgentPlanDraftSession | null>(null);
  const [resourceDraftSession, setResourceDraftSession] = useState<AgentResourceDraftSession | null>(null);
  const [resourceActivity, setResourceActivity] = useState<{ id: string; text: string } | null>(null);
  const [workflowHandoff, setWorkflowHandoff] = useState<AgentWorkflowHandoff | null>(() => loadWorkflowHandoff());
  const [conceptFillNote, setConceptFillNote] = useState<NoteItem | null>(null);
  const [flowTargetNote, setFlowTargetNote] = useState<NoteItem | null>(null);
  const [flowInitialResource, setFlowInitialResource] = useState<ResourceItem | null>(null);
  const [flowReviewInterval, setFlowReviewInterval] = useState(20);
  const [flowSpeakingContent, setFlowSpeakingContent] = useState("");
  const [flowSummaryText, setFlowSummaryText] = useState("");
  const [flowQuestions, setFlowQuestions] = useState<StudyQuestionCard[]>([]);
  const [isFlowAnalysisOpen, setIsFlowAnalysisOpen] = useState(false);
  const [flowResult, setFlowResultState] = useState<FlowResultData | null>(() => {
    const demo = new URLSearchParams(window.location.search).get('demo');
    return demo === 'flow-result' ? createMockFlowResult() : null;
  });
  const flowResultRef = useRef(flowResult);
  const setFlowResult = useCallback((value: React.SetStateAction<FlowResultData | null>) => {
    const next = typeof value === 'function' ? value(flowResultRef.current) : value;
    flowResultRef.current = next;
    setFlowResultState(next);
  }, []);
  const [flowResultOperation, setFlowResultOperation] = useState<FlowResultOperation | null>(null);
  const [flowResultNotice, setFlowResultNotice] = useState('');
  const flowResultWriteRef = useRef(new FlowResultWriteController());
  useEffect(() => { setFlowResultNotice(''); }, [flowResult?.createdAt, flowResult?.noteId]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!flowResultRef.current && !flowResultWriteRef.current.busy) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const [reviewNoteId, setReviewNoteId] = useState(() => new URLSearchParams(window.location.search).get('demo') === 'review-session' ? 'review-demo-bayes' : "");
  const reviewNoteIdRef = useRef(reviewNoteId);
  reviewNoteIdRef.current = reviewNoteId;
  const reviewExitProgressRef = useRef(new Map<string, ReviewExitProgress>());
  const reviewActivationRef = useRef(0);
  const reviewActivation = reviewActivationRef.current;
  const [reviewNoteTitle, setReviewNoteTitle] = useState(() => new URLSearchParams(window.location.search).get('demo') === 'review-session' ? '贝叶斯定理' : "");
  const [reviewQuestion, setReviewQuestion] = useState(() => new URLSearchParams(window.location.search).get('demo') === 'review-session' ? REVIEW_SESSION_DEMO_MESSAGES[0].content : "");
  const [reviewContext, setReviewContext] = useState(() => new URLSearchParams(window.location.search).get('demo') === 'review-session'
    ? '贝叶斯定理描述在已有证据的条件下，如何使用先验概率、似然与证据概率更新后验概率。检测灵敏度、特异度和基础发生率会共同影响阳性结果对应的后验概率。'
    : "");
  const [reviewReturnView, setReviewReturnView] = useState<ViewMode>("learn");
  const handleReviewExitSaveStateChange = useCallback((phase: ReviewExitSaveState, sessionId: string) => {
    if (reviewActivationRef.current !== reviewActivation || currentViewRef.current !== 'review') return;
    if (!reviewExitGuard.updateStatus(phase, sessionId)) return;
    if (phase !== 'idle') { setIsCommandPaletteOpen(false); setIsAgentOpen(false); }
  }, [reviewActivation, reviewExitGuard.updateStatus]);
  const [reviewHubLaunchRequest, setReviewHubLaunchRequest] = useState<(AgentReviewLaunchRequest & { id: string }) | null>(null);
  const [sceneRequest, setSceneRequest] = useState<SceneInitialRequest | null>(null);
  const s2ProjectNoteAccess = useMemo(() => {
    if (sceneRequest?.sceneSkill !== 'S2') return {};
    try { return { source: createSceneProjectNoteSource(sceneRequest.taskBinding?.noteId, () => notesRef.current) }; }
    catch { return { error: '所选项目笔记范围无效或过大，请返回搭建面板重新选择。' }; }
  }, [sceneRequest]);
  const [sceneDraftSnapshot, setSceneDraftSnapshot] = useState<SceneSpec | null>(null);
  const [workflowDraftReady, setWorkflowDraftReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    lastSyncedAt: null, isSyncing: false, syncedNotesCount: 0, cloudStorageUsed: "1.2 MB", statusText: "本地状态正常"
  });
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgePointMasteryResult[]>([]);
  const [analysisProgressOpen, setAnalysisProgressOpen] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('mastery');
  const [analysisOffline, setAnalysisOffline] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [editorRefreshVersion, setEditorRefreshVersion] = useState(0);
  const flowEpisodeIdRef = useRef<string | null>(null);
  const flowSessionRef = useRef<FlowSession | null>(null);
  const knowledgeDiscovery = useKnowledgeDiscovery(
    (text) => discoverKnowledgePointsDetailed(text, notesRef.current),
    (id) => flowSessionRef.current?.id === id,
  );
  const [flowReviewSession, setFlowReviewSession] = useState<FlowSession | null>(null);
  const [flowCompletionPrompt, setFlowCompletionPrompt] = useState<{ sessionId: string; binding: LearningTaskBinding } | null>(null);
  const flowTaskBindingRef = useRef<LearningTaskBinding | null>(null);
  const learningWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const quickCheckControllerRef = useRef<QuickCheckController | null>(null);
  const quickCheckWritesRef = useRef(new Map<string, QuickCheckWriteProgress>());
  const [quickCheckStorageScope, setQuickCheckStorageScope] = useState<string>();
  const getQuickCheckNotes = useCallback(() => notesRef.current, []);
  const isReviewPickerDemo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'review-picker',
    [],
  );
  const isReviewSessionDemo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'review-session',
    [],
  );
  const reviewPickerNotes = useMemo(
    () => isReviewPickerDemo || isReviewSessionDemo ? withReviewDemoFixtures(notes) : notes,
    [isReviewPickerDemo, isReviewSessionDemo, notes],
  );
  const isKnowledgeGraphDemo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'knowledge-graph',
    [],
  );
  const isSceneS1Demo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'scene-s1',
    [],
  );
  const isSceneS4Demo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'scene-s4',
    [],
  );
  const isLearningCompletionDemo = useMemo(
    () => new URLSearchParams(window.location.search).get('demo') === 'learning-completion',
    [],
  );
  const isReviewExitDemo = useMemo(() => new URLSearchParams(window.location.search).get('demo') === 'review-save', []);
  const graphNotes = useMemo(
    () => isKnowledgeGraphDemo ? withKnowledgeGraphDemoFixtures(notes) : notes,
    [isKnowledgeGraphDemo, notes],
  );
  const isPlanPreviewDemo = useMemo(() => {
    const demo = new URLSearchParams(window.location.search).get('demo');
    return demo === 'learning-plan' || demo === 'plan-builder';
  }, []);
  const [planPreviewNotes, setPlanPreviewNotes] = useState<NoteItem[]>(() => (
    new URLSearchParams(window.location.search).get('demo') === 'learning-plan'
      || new URLSearchParams(window.location.search).get('demo') === 'plan-builder'
      ? createPlanWorkspaceDemoNotes()
      : []
  ));
  const [editingPlanRootId, setEditingPlanRootId] = useState<string | null>(null);
  const [learningSettingsOrigin, setLearningSettingsOrigin] = useState<'plan' | 'timeline' | null>(null);
  useEffect(() => { if (currentView !== 'settings') setLearningSettingsOrigin(null); }, [currentView]);
  const openPlanLearningSettings = (origin: 'plan' | 'timeline') => {
    if (!allowWorkspaceNavigation()) return;
    setLearningSettingsOrigin(origin);
    setCurrentView('settings');
  };
  const [agentNewPlanDraft, setAgentNewPlanDraft] = useState<{ id: string; value: PlanBuilderDraftValue } | null>(null);
  const [agentPlanEditorQueue, setAgentPlanEditorQueue] = useState<PublishedPlanEditorValue[]>([]);
  const [agentPlanEditorBaseRevisions, setAgentPlanEditorBaseRevisions] = useState<Record<string, string>>({});
  const planCreateIdsRef = useRef<{ signature: string; projects: Map<string, string>; tasks: Map<string, string> } | null>(null);
  const [planWorkspaceFocusId, setPlanWorkspaceFocusId] = useState<string | null>(null);
  const planPreviewNotesRef = useRef(planPreviewNotes);
  const planWorkspaceNotes = isPlanPreviewDemo ? planPreviewNotes : notes;
  const editingPlanInitialValue = useMemo(() => {
    if (agentPlanEditorQueue.length > 0) return agentPlanEditorQueue[0];
    return editingPlanRootId ? buildPublishedPlanEditorValue(planWorkspaceNotes, editingPlanRootId) : null;
  }, [agentPlanEditorQueue, editingPlanRootId, planWorkspaceNotes]);
  useEffect(() => { planPreviewNotesRef.current = planPreviewNotes; }, [planPreviewNotes]);

  const persistPlanCompletion = async (intent: PlanCompletionIntent): Promise<void> => {
    if (!isPlanPreviewDemo) {
      await persistPlanMutation(current => ({ notes: applyPlanCompletionIntent(current, intent) }));
      return;
    }
    const updated = applyPlanCompletionIntent(planPreviewNotesRef.current, intent);
    planPreviewNotesRef.current = updated;
    setPlanPreviewNotes(updated);
  };
  const handleTogglePlanWorkspaceTask = (noteId: string, taskId: string, occurrenceDate?: string, completed?: boolean): Promise<void> => {
    const current = isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current;
    const task = current.find(note => note.id === noteId)?.dueDates.find(item => item.id === taskId);
    const recurring = task?.recurrence && task.recurrence.frequency !== 'none';
    const binding = { noteId, taskId, ...(recurring && occurrenceDate ? { occurrenceDate } : {}) };
    const target = getLearningCompletionTarget(current, binding);
    if (!target || target.kind !== 'execution') return Promise.reject(new Error('该执行事项已调整或移除，请重新查看计划。'));
    return persistPlanCompletion({ kind: 'execution', binding: target.binding, completed: completed ?? !target.completed });
  };
  const handleTogglePlanWorkspaceProject = (projectId: string, completed?: boolean): Promise<void> => {
    const current = isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current;
    return persistPlanCompletion({ kind: 'project', projectId, completed: completed ?? !getScheduledProjectState(current, projectId).completed });
  };
  const handleTogglePlanWorkspaceMilestone = (rootId: string, milestoneId: string, completed?: boolean): Promise<void> => {
    const current = isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current;
    const milestone = current.find(note => note.id === rootId)?.planMeta?.milestones?.find(item => item.id === milestoneId);
    return persistPlanCompletion({ kind: 'milestone', rootId, milestoneId, completed: completed ?? !milestone?.completed });
  };

  const handleAddPlanWorkspaceTask = async (input: PlanTaskCreateInput) => {
    if (!isPlanPreviewDemo) {
      await handleAddNewScheduleTask(input);
      return;
    }
    if (!isProjectWithinPlanRoot(planPreviewNotesRef.current, input.noteId, input.scopeRootId)) throw new Error('请选择当前计划中的项目');
    setPlanPreviewNotes((current) => {
      if (!isProjectWithinPlanRoot(current, input.noteId, input.scopeRootId)) return current;
      return current.map((note) => note.id !== input.noteId ? note : {
      ...note,
      dueDates: [...note.dueDates, {
        id: `plan-demo-manual-${Date.now()}`,
        noteId: note.id,
        noteTitle: note.title,
        taskText: input.taskText,
        startDate: input.dueDate,
        dueDate: input.dueDate,
        completed: false,
        priority: 'medium' as const,
        kind: input.kind,
        executionKind: input.executionKind,
        recurrence: input.recurrenceFrequency && input.recurrenceFrequency !== 'none'
          ? { frequency: input.recurrenceFrequency, weekdays: input.recurrenceWeekdays }
          : undefined,
        estimatedMinutes: input.estimatedMinutes,
        source: 'manual' as const,
      }],
      });
    });
  };

  const handleAddPlanWorkspaceStructureItem = async (input: PublishedPlanStructureAddInput): Promise<boolean> => {
      if (isPlanPreviewDemo) {
      const mutation = addPublishedPlanStructureItem(planPreviewNotesRef.current, input);
      const nextNotes = recalculateBacklinks(mutation.notes);
        planPreviewNotesRef.current = nextNotes;
        setPlanPreviewNotes(nextNotes);
      } else {
        await persistPlanMutation((current) => addPublishedPlanStructureItem(current, input), input.rootId);
      }
      setPlanWorkspaceFocusId(input.rootId);
      return true;
  };

  const handleSelectPlanWorkspaceNote = (noteId: string, title?: string) => {
    if (!allowWorkspaceNavigation()) return;
    if (isPlanPreviewDemo) {
      const note = planPreviewNotes.find((note) => note.id === noteId)
        || (title ? resolveNoteByTitleOrAlias(title, planPreviewNotes) : null);
      contextNavigation.open(note?.id || noteId, note?.noteType === 'project' ? note.id : activeProjectContextId);
      return;
    }
    const direct = notes.find((note) => note.id === noteId);
    if (direct) {
      handleOpenContextNote(direct.id);
      return;
    }
    if (title) handleSelectNoteByTitle(title);
  };

  const vaultStartup = useVaultStartup(loadNotesFromStorage, (loaded) => {
    sidebarTreeStateRef.current = null;
    setSidebarRevealRevision(0);
    notesRef.current = loaded;
    setNotes(loaded);
    setActiveNoteId(loaded[0]?.id ?? null);
    notesReadyRef.current = true;
    // Desktop startup recovers derived indexes from saved originals, not renderer drafts.
    if (!(window as any).electronAPI?.noteRag) indexAllNotes(loaded).catch(() => {});
  });
  const notesHydrated = vaultStartup.status === 'ready';
  useEffect(() => {
    let cancelled = false;
    setQuickCheckStorageScope(undefined);
    if (notesHydrated) void agentTaskScope().then(scope => {
      if (!cancelled) setQuickCheckStorageScope(scope);
    }).catch(error => {
      if (!cancelled) setSyncStatus(current => ({ ...current,
        statusText: `简测暂不可用：${error instanceof Error ? error.message : '无法读取资料库标识，请重启应用'}` }));
    });
    return () => { cancelled = true; };
  }, [notesHydrated]);
  // 启动时把 user-state 文件（画像/设置/LLM/心流会话）灌入 localStorage 缓存，供同步读取
  useEffect(() => {
    hydrateFromUserState({ skipSettings: true, skipLlm: true }).catch(() => {});
    void ensureLlmSettingsLoaded().catch(() => {});
  }, []);
  // 启动时把画像灌入新 profileStore 内存缓存（A1，唯一权威读入口）
  useEffect(() => { hydrateProfileFromUserState().catch(() => {}); }, []);
  useEffect(() => {
    const stop = connectPreferredWindowTheme(settings.theme, window.matchMedia('(prefers-color-scheme: dark)'), theme => {
      applyWindowTheme(theme, document.documentElement);
      applyAccentAppearance(settings.accentColor, theme === 'dark', document.documentElement);
      void (window as any).electronAPI?.appearance?.updateTheme?.(theme).catch((error: unknown) => console.warn('[appearance] 同步窗口主题失败', error));
    });
    document.documentElement.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
    return stop;
  }, [settings]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.isComposing || e.keyCode === 229) return; if (!e.defaultPrevented && !hasActiveDialog() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (allowWorkspaceNavigation()) setIsCommandPaletteOpen(p => !p); } }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [allowWorkspaceNavigation]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.isComposing || e.keyCode === 229) return; if (!e.defaultPrevented && !hasActiveDialog() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); if (allowWorkspaceNavigation()) setIsAgentOpen(p => !p); } }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [allowWorkspaceNavigation]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotesRef = useRef<NoteItem[] | null>(null);
  const readingOnlySaveRef = useRef<ReadingOnlySave | null>(null);
  const personalOnlySaveRef = useRef<PersonalOnlySave | null>(null);
  const [noteSaveState, setNoteSaveState] = useState<NoteSaveState>('saved');
  const [noteSaveError, setNoteSaveError] = useState('');
  const [recoveringNoteDrafts, setRecoveringNoteDrafts] = useState(false);
  const [noteRecoveryNotice, setNoteRecoveryNotice] = useState('');
  const noteSaveRevisionRef = useRef(0);
  const noteSaveRetryLockRef = useRef(false);
  const optimisticDeletionsRef = useRef(createOptimisticNoteDeletionState());
  const editingIndexLeaseRef = useRef(false);
  const editingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingActivityRef = useRef(0);
  const [pendingDeletionCount, setPendingDeletionCount] = useState(0);
  const [restoredDeletionCount, setRestoredDeletionCount] = useState(0);
  useEffect(() => { if (noteSaveState === 'saved') setNoteSaveError(''); }, [noteSaveState]);
  useNoteSaveLeaveProtection(noteSaveState, pendingNotesRef);
  const flushSave = useCallback(async (_requested: NoteItem[]) => enqueueLatestNotesSave(learningWriteQueueRef,
    () => notesRef.current, async (ns) => {
    // A preceding review/publication may already have saved this latest state.
    if (!pendingNotesRef.current) return;
    const revision = noteSaveRevisionRef.current;
    const readingOnly = readingOnlySaveRef.current?.latest === ns;
    if (!readingOnly) setNoteSaveState('saving');
    try {
      if (!await saveReadingPositionOnly(ns, readingOnlySaveRef.current)
        && !await savePersonalStateOnly(ns, personalOnlySaveRef.current)) {
        const prepared = await prepareNotesMetadata(ns);
        await saveAllNotesToStorage(prepared);
        // Never overwrite edits made while the worker or disk write was in flight.
        if (notesRef.current === ns) {
          notesRef.current = prepared;
          if (shouldPublishNoteSnapshot(publishedNotesRef.current, prepared)) setNotes(prepared);
        }
      }
      // Background viewport updates do not dirty the visible content state.
      // Pending refs still protect exit, and errors are never hidden.
      setNoteSaveState(readingOnlySaveRef.current?.latest === notesRef.current
        ? 'saved' : acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
      if (pendingNotesRef.current === ns) pendingNotesRef.current = null;
      if (readingOnlySaveRef.current?.latest === ns) readingOnlySaveRef.current = null;
      personalOnlySaveRef.current = acknowledgePersonalSave(personalOnlySaveRef.current, ns);
    } catch (error) {
      pendingNotesRef.current = notesRef.current;
      setNoteSaveError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
      setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, false));
      console.error('[note-save] 保存失败，保留最新内容以便重试:', error);
      throw error;
    }
  }), []);
  navigationSaveIO.current = {
    capture: capturePendingChanges, dirty: () => Boolean(pendingNotesRef.current), revision: () => noteSaveRevisionRef.current,
    flush: async () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      if (pendingNotesRef.current) await flushSave(notesRef.current);
    },
  };
  useEffect(()=>registerCommunitySourceFlush(async()=>{if(!notesReadyRef.current)throw Error('笔记仍在载入，请稍后分享。');if(saveTimerRef.current){clearTimeout(saveTimerRef.current);saveTimerRef.current=null;}await flushSave(notesRef.current);}),[flushSave]);
  const retryNoteSave = () => {
    if (noteSaveRetryLockRef.current) return;
    noteSaveRetryLockRef.current = true;
    setNoteSaveState('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    pendingNotesRef.current = notesRef.current;
    void flushSave(notesRef.current).catch(() => {}).finally(() => { noteSaveRetryLockRef.current = false; });
  };
  const recoverNoteDrafts = () => {
    if (noteSaveRetryLockRef.current || !allowCognitionLeave()) return;
    try { capturePendingChanges(); } catch { return; }
    noteSaveRetryLockRef.current = true;
    setRecoveringNoteDrafts(true);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    void enqueueLearningWrite(learningWriteQueueRef, async () => {
      // An explicit recovery is allowed to read the library. Keep all latest
      // local source edits as separate drafts, never overwrite the saved copy.
      const baseline = persistedNoteSaveBaseline.snapshot();
      const saved = await loadNotesFromStorage();
      capturePendingChanges();
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      const recovery = prepareNoteSaveRecovery(notesRef.current, saved, baseline);
      const next = recalculateBacklinks(recovery.notes);
      notesRef.current = next; pendingNotesRef.current = next;
      readingOnlySaveRef.current = null; personalOnlySaveRef.current = null;
      optimisticDeletionsRef.current = createOptimisticNoteDeletionState();
      setPendingDeletionCount(0); setRestoredDeletionCount(0);
      const revision = ++noteSaveRevisionRef.current;
      setNotes(next); setNoteSaveState('saving');
      const selected = recovery.copiedIds[0] || recovery.retainedNewIds[0] || activeNoteId;
      contextNavigation.reset();
      setActiveNoteIdState(selected && next.some(note => note.id === selected) ? selected : next[0]?.id || null);
      await saveAllNotesToStorage(next);
      setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
      if (pendingNotesRef.current === next) pendingNotesRef.current = null;
      setNoteRecoveryNotice(recovery.message);
    }).catch(error => {
      pendingNotesRef.current = notesRef.current;
      setNoteSaveError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
      setNoteSaveState('error');
    }).finally(() => { noteSaveRetryLockRef.current = false; setRecoveringNoteDrafts(false); });
  };
  const handleTextbookReadingPosition = (noteId: string, revisionId: string, position: TextbookReadingPosition) => {
    const previous = notesRef.current;
    const next = patchTextbookReadingPosition(previous, noteId, revisionId, position);
    if (next === previous) return;
    readingOnlySaveRef.current = trackReadingOnlySave(previous, next, pendingNotesRef.current, readingOnlySaveRef.current);
    personalOnlySaveRef.current = readingOnlySaveRef.current ? null
      : trackPersonalOnlySave(previous, next, pendingNotesRef.current, personalOnlySaveRef.current);
    noteSaveRevisionRef.current += 1;
    notesRef.current = next;
    pendingNotesRef.current = next;
    // Keep the published content array stable: sidebar, links, diagrams and
    // hidden editors must not rerender for a change of viewport alone.
    if (!readingOnlySaveRef.current) setNoteSaveState('pending');
    // Reading updates are a bounded batch, not a trailing debounce: continuous
    // scrolling must neither starve persistence nor postpone a pending body save.
    if (!saveTimerRef.current) saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave(notesRef.current).catch(() => {});
    }, readingOnlySaveRef.current ? 2000 : NOTE_AUTOSAVE_IDLE_MS);
  };
  const getTextbookReadingPosition = useCallback((noteId: string, revisionId: string) => {
    const note = notesRef.current.find(item => item.id === noteId);
    return note?.textbook?.revisionId === revisionId && note.textbookReadingState?.revisionId === revisionId
      ? note.textbookReadingState : undefined;
  }, []);
  const planDraftSessionRef = useRef<AgentPlanDraftSession | null>(null);
  const resourceDraftSessionRef = useRef<AgentResourceDraftSession | null>(null);
  const workflowHandoffRef = useRef<AgentWorkflowHandoff | null>(workflowHandoff);
  const workflowDraftFileRef = useRef<AgentWorkflowDraftFile | null>(null);
  const workflowDraftSaveTimerRef = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  // All publishers update notesRef before setNotes. Mirroring a lagging React
  // render back into this ref would overwrite keystrokes captured meanwhile.
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const updatePlanDraftSession = (session: AgentPlanDraftSession | null) => {
    planDraftSessionRef.current = session;
    setPlanDraftSession(session);
  };
  const updateResourceDraftSession = (session: AgentResourceDraftSession | null) => {
    resourceDraftSessionRef.current = session;
    setResourceDraftSession(session);
  };
  useEffect(() => {
    if (!notesHydrated) return undefined;
    if (isPlanPreviewDemo) {
      setWorkflowDraftReady(true);
      return undefined;
    }
    let cancelled = false;
    void loadAgentWorkflowDraftState()
      .then((result) => {
        if (cancelled || result.status !== 'restored' || !result.record) return;
        const record = result.record;
        let restoredPlan = record.planDraftSession;
        let restoredResource = record.resourceDraftSession;
        let restoredEditor = record.planEditor;
        try { if (restoredPlan) assertPlanDraftFresh(notes, restoredPlan); }
        catch (error) { console.warn('[agent-workflow-draft] discarded stale plan draft:', error); restoredPlan = null; }
        try { if (restoredResource) assertResourceDraftFresh(notes, restoredResource); }
        catch (error) { console.warn('[agent-workflow-draft] discarded stale resource draft:', error); restoredResource = null; }
        if (restoredEditor && !isPlanEditorDraftFresh(notes, restoredEditor)) {
          console.warn('[agent-workflow-draft] discarded stale plan editor draft');
          restoredEditor = null;
        }
        updatePlanDraftSession(restoredPlan);
        updateResourceDraftSession(restoredResource);
        if (restoredResource) {
          setResourceActivity({
            id: `resource-draft-restored-${Date.now()}`,
            text: `已恢复“${restoredResource.scopeProjectTitle}”的资源草案；浏览器临时会话不会自动重开，可继续检索、筛选或放弃草案。`,
          });
        }
        if (restoredEditor) {
          setAgentNewPlanDraft(restoredEditor.newPlanDraft);
          setAgentPlanEditorQueue(restoredEditor.editorQueue);
          setAgentPlanEditorBaseRevisions(restoredEditor.baseProjectRevisions);
          setEditingPlanRootId(restoredEditor.editingPlanRootId || restoredEditor.editorQueue[0]?.rootId || null);
        }
        // Background recovery keeps the drafts, but cannot override a page the user chose.
        if (navigationRevisionRef.current !== 0 || currentViewRef.current !== 'home' || !allowWorkspaceNavigation()) return;
        const activeId = record.context.activeNoteId;
        if (activeId && notes.some((note) => note.id === activeId)) setActiveNoteId(activeId);
        const focusId = record.context.planWorkspaceFocusId;
        if (focusId && notes.some((note) => note.id === focusId && note.noteType === 'project')) setPlanWorkspaceFocusId(focusId);
        if (record.scenePreview) {
          setSceneRequest(record.scenePreview.request);
          setSceneDraftSnapshot(record.scenePreview.draft);
          setCurrentView('scene');
        } else if (restoredEditor) {
          setCurrentView('plan');
        } else if (record.context.view !== 'scene') {
          setCurrentView(record.context.view);
        }
      })
      .finally(() => { if (!cancelled) setWorkflowDraftReady(true); });
    return () => { cancelled = true; };
    // Restore once from the note revision snapshot loaded at application start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesHydrated, isPlanPreviewDemo]);

  useEffect(() => {
    if (!workflowDraftReady || isPlanPreviewDemo) return undefined;
    const resumeView: AgentWorkflowResumeView = ['home', 'editor', 'timeline', 'plan', 'learn', 'scene'].includes(currentView)
      ? currentView as AgentWorkflowResumeView
      : 'home';
    const planEditor = agentNewPlanDraft || agentPlanEditorQueue.length > 0 ? {
      newPlanDraft: agentNewPlanDraft,
      editorQueue: agentPlanEditorQueue,
      editingPlanRootId,
      baseProjectRevisions: agentPlanEditorBaseRevisions,
    } : null;
    try {
      workflowDraftFileRef.current = buildAgentWorkflowDraftFile({
        planDraftSession,
        resourceDraftSession,
        planEditor,
        scenePreview: sceneRequest && sceneDraftSnapshot ? { request: sceneRequest, draft: sceneDraftSnapshot } : null,
        context: { view: resumeView, activeNoteId, planWorkspaceFocusId },
      });
      cacheAgentWorkflowDraftFile(workflowDraftFileRef.current);
      if (workflowDraftSaveTimerRef.current) window.clearTimeout(workflowDraftSaveTimerRef.current);
      workflowDraftSaveTimerRef.current = window.setTimeout(() => {
        workflowDraftSaveTimerRef.current = null;
        const file = workflowDraftFileRef.current;
        if (file) void saveAgentWorkflowDraftFile(file).catch((error) => console.warn('[agent-workflow-draft] save failed:', error));
      }, 180);
    } catch (error) {
      console.warn('[agent-workflow-draft] snapshot rejected:', error);
    }
    return () => {
      if (workflowDraftSaveTimerRef.current) {
        window.clearTimeout(workflowDraftSaveTimerRef.current);
        workflowDraftSaveTimerRef.current = null;
      }
    };
  }, [
    activeNoteId,
    agentNewPlanDraft,
    agentPlanEditorBaseRevisions,
    agentPlanEditorQueue,
    currentView,
    editingPlanRootId,
    isPlanPreviewDemo,
    planDraftSession,
    planWorkspaceFocusId,
    resourceDraftSession,
    sceneDraftSnapshot,
    sceneRequest,
    workflowDraftReady,
  ]);
  useEffect(() => {
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.onCandidateDecision) return undefined;
    return browser.onCandidateDecision((payload: ResourceBrowserCandidateDecisionEvent) => {
      const session = resourceDraftSessionRef.current;
      const resource = payload?.resource;
      if (!session || payload?.draftSessionId !== session.id || !resource?.url) return;
      try {
        const registered = registerDiscoveredResources(notesRef.current, session, [resource], {
          taskText: String(resource.taskText || ''),
          knowledgeTitles: resource.knowledgeTitles || [],
        });
        const next = setResourceCandidateDecision(
          notesRef.current,
          registered,
          resource,
          payload.decision,
        );
        updateResourceDraftSession(next);
        void recordResourceDiscoveryPreference(session.scopeProjectId, resource, payload.decision);
        setResourceActivity({
          id: `${Date.now()}-${resource.candidateId || resource.url}`,
          text: payload.decision === 'selected'
            ? `已将“${resource.title}”加入备选并记录偏好。可继续浏览；完成后让助手整理已选资源。`
            : `已记录对“${resource.title}”不感兴趣，后续整理会排除它。`,
        });
        setIsAgentOpen(true);
      } catch (error) {
        setResourceActivity({
          id: `${Date.now()}-error`,
          text: error instanceof Error ? error.message : '资源选择未能回传到草案',
        });
      }
    });
  }, []);
  useEffect(() => {
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.onClosed) return undefined;
    return browser.onClosed((payload: ResourceBrowserClosedEvent) => {
      const session = resourceDraftSessionRef.current;
      if (payload?.interactionMode !== 'review'
        || !session
        || session.origin !== 'note-editor'
        || payload.draftSessionId !== session.id) return;
      updateResourceDraftSession(null);
    });
  }, []);
  useEffect(() => {
    const workbench = (window as any).electronAPI?.resourceWorkbench;
    if (!workbench?.onCommitted) return undefined;
    return workbench.onCommitted((payload: ResourceWorkbenchCommitEvent) => { void (async () => {
      const session = resourceDraftSessionRef.current;
      if (!session || payload?.draftSessionId !== session.id) {
        await workbench.completeCommit?.({
          sessionId: payload.sessionId,
          commitId: payload.commitId,
          ok: false,
          message: '当前资源收录会话已变更，请保留工作台并重新发起。',
        }).catch((error: unknown) => console.warn('[resource-workbench] stale acknowledgement failed:', error));
        return;
      }
      const shouldNotifyAgent = session.origin !== 'note-editor';
      let resourcesSaved = false;
      try {
        let next = session;
        for (const resource of [...payload.selectedResources, ...payload.rejectedResources]) {
          next = registerDiscoveredResources(notesRef.current, next, [resource], {
            taskText: String(resource.taskText || ''),
            knowledgeTitles: resource.knowledgeTitles || [],
          });
        }
        for (const resource of payload.selectedResources) {
          next = setResourceCandidateDecision(notesRef.current, next, resource, 'selected');
        }
        for (const resource of payload.rejectedResources) {
          next = setResourceCandidateDecision(notesRef.current, next, resource, 'rejected');
        }
        next = registerResourceBrowserSession(next, payload.sessionId);
        const mutation = await persistPlanMutation((current) => {
          if (resourceDraftSessionRef.current?.id !== session.id) {
            throw new Error('当前资源收录会话已变更，请保留工作台并重新发起。');
          }
          return applyConfirmedWorkbenchResources(current, next, payload);
        }, session.scopeProjectId);
        resourcesSaved = true;
        let preferencesSaved = true;
        await recordResourceDiscoveryPreferences(session.scopeProjectId, [
          ...payload.selectedResources.map((resource) => ({ resource, decision: 'selected' as const })),
          ...payload.rejectedResources.map((resource) => ({ resource, decision: 'rejected' as const })),
        ]).catch((error) => { preferencesSaved = false; console.warn('[resource-workbench] preference save failed:', error); });

        const downloadText = mutation.summary.localResourceCount
          ? `，${mutation.summary.localResourceCount} 个文件已加入本地资料库并关联项目`
          : '';
        const failureText = payload.downloadErrors.length
          ? `；${payload.downloadErrors.length} 个文件下载失败，已改为收录其 URL`
          : '';
        const message = `已收录 ${payload.selectedResources.length} 个资源到 ${mutation.summary.projectCount} 个项目${downloadText}${failureText}。${preferencesSaved ? '' : ' 偏好保存失败，需要时可重新标记。'}`;
        const acknowledged = await workbench.completeCommit?.({
          sessionId: payload.sessionId,
          commitId: payload.commitId,
          ok: true,
          message,
        });
        if (acknowledged !== true) throw new Error('资源已保存，但工作台确认回执未送达；请先核对项目资源，避免重复收录。');
        if (resourceDraftSessionRef.current?.id !== session.id) return;
        closeDraftBrowserSessions(next);
        updateResourceDraftSession(null);
        setResourceActivity({
          id: `${Date.now()}-workbench-commit`,
          text: `${message}${preferencesSaved && payload.rejectedResources.length ? ` 已记录 ${payload.rejectedResources.length} 条“不感兴趣”偏好。` : ''}${shouldNotifyAgent ? ' Agent 正在自动继续后续处理。' : ''}`,
        });
        if (shouldNotifyAgent) {
          const changedTitles = mutation.changedProjectNotes.map((note) => note.title).join('、');
          setAgentExternalRequest({
            id: `resource-workbench-complete-${payload.commitId}`,
            observedOutcome: {
              kind: 'resource-writeback', eventId: payload.commitId,
              draftSessionId: payload.draftSessionId,
              resourceCount: payload.selectedResources.length,
              projects: mutation.changedProjectNotes.map((note) => ({ noteId: note.id, resourceUrls: (note.resources || []).map((resource) => resource.url) })),
            },
            text: `[资源工作台完成事件]\n用户已做出最终确认，系统已将 ${payload.selectedResources.length} 个资源直接写入项目资源栏${changedTitles ? `（${changedTitles}）` : ''}。${preferencesSaved ? `已记录 ${payload.rejectedResources.length} 条排除偏好。` : '偏好保存失败，不要宣称已记录偏好。'}这些资源不需要再暂存或提交，不要再要求用户确认免费性、403 或写入权限。请简洁汇总本次结果；如原资源统筹请求还有未处理任务，直接继续下一个未处理任务，不要重复搜索已收录任务。`,
            targetSkillId: 'resource-curation',
          });
          setIsAgentOpen(true);
        }
      } catch (error) {
        const message = resourcesSaved ? '资源已保存，但工作台确认回执未送达；请先核对项目资源，避免重复收录。'
          : error instanceof Error ? error.message : '资源工作台结果写回失败';
        if (!resourcesSaved) await workbench.completeCommit?.({
          sessionId: payload.sessionId,
          commitId: payload.commitId,
          ok: false,
          message,
        }).catch((ackError: unknown) => console.warn('[resource-workbench] failure acknowledgement failed:', ackError));
        if (resourceDraftSessionRef.current?.id !== session.id) return;
        setResourceActivity({
          id: `${Date.now()}-workbench-error`,
          text: message,
        });
        if (shouldNotifyAgent) setIsAgentOpen(true);
      }
    })(); });
  }, []);
  const updateWorkflowHandoff = useCallback((handoff: AgentWorkflowHandoff | null) => {
    const current = workflowHandoffRef.current;
    if (handoff && current && current.id !== handoff.id) {
      recordAgentHandoffAudit({ handoff: current, status: 'superseded' }).catch((error) => {
        console.warn('[agent-handoff] audit superseded failed:', error);
      });
    }
    if (handoff && current?.id !== handoff.id) {
      recordAgentHandoffAudit({ handoff, status: 'created' }).catch((error) => {
        console.warn('[agent-handoff] audit creation failed:', error);
      });
    }
    workflowHandoffRef.current = handoff;
    saveWorkflowHandoff(handoff);
    setWorkflowHandoff(handoff);
  }, []);
  useEffect(() => connectApplicationExit(), []);
  useEffect(() => rendererExitPreparation.register({
    name: '组合学习流程与概念补全',
    backgroundTasks: () => {
      const workflows = backgroundWorkflows.getSnapshot().filter(backgroundWorkflowActive);
      const children = new Set(workflows.flatMap(job => job.projects.flatMap(project => project.steps.flatMap(step => step.childJobId ? [step.childJobId] : []))));
      return workflows.length + conceptBatchJobs.getSnapshot().filter(job => conceptBatchActive(job) && !children.has(job.id)).length;
    },
    stop: async () => {
      await Promise.all([backgroundWorkflows.stopAll(), conceptBatchJobs.stopAll()]);
      await Promise.all([backgroundWorkflows.flush(), conceptBatchJobs.flush()]);
    },
  }), []);
  useEffect(() => rendererExitPreparation.register({
    name: '资料后台处理',
    backgroundTasks: () => documentBackgroundJobs.getSnapshot().filter(documentJobActive).length,
    stop: async () => {
      // Only native, user-confirmed application exit reaches this callback.
      if (!documentBackgroundJobs.getScopeId()) return;
      for (const job of documentBackgroundJobs.getSnapshot().filter(documentJobActive)) documentBackgroundJobs.cancel(job.id);
      await waitForExitCondition(() => !documentBackgroundJobs.getSnapshot().some(documentJobActive));
      await documentBackgroundJobs.flush();
    },
  }), []);
  useEffect(() => registerPendingFlush(async () => {
    await appSettings.flush();
    await flushLlmSettingsWrites();
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await flushLatestNoteWrites(learningWriteQueueRef, () => pendingNotesRef.current, flushSave);
    if (workflowDraftSaveTimerRef.current) {
      clearTimeout(workflowDraftSaveTimerRef.current);
      workflowDraftSaveTimerRef.current = null;
    }
    if (workflowDraftFileRef.current) await saveAgentWorkflowDraftFile(workflowDraftFileRef.current);
    await Promise.all([
      flushProfileStateWrites(),
      flushLearningEpisodeWrites(),
      flushAgentAuditWrites(),
      flushSceneInteractionAuditWrites(),
      flushSceneAssemblyAuditWrites(),
    ]);
  }), [flushSave, appSettings.flush]);

  /** Keystrokes update the authoritative draft immediately, without whole-App render/index work. */
  const handleEditNote = useCallback((noteId: string, patch: Partial<Pick<NoteItem, 'content' | 'title' | 'tags' | 'aliases'>>) => {
    const previous = notesRef.current;
    const index = previous.findIndex(note => note.id === noteId);
    if (index < 0) return; // A late editor event cannot recreate a deleted note.
    const before = previous[index];
    if (patch.aliases !== undefined && JSON.stringify(patch.aliases) !== JSON.stringify(before.aliases || [])) {
      const error = noteAliasesError(previous, noteId, patch.aliases);
      if (error) throw new Error(error);
    }
    if ((Object.keys(patch) as Array<keyof typeof patch>).every(key => patch[key] === undefined || patch[key] === before[key])) return;
    let next = previous.slice();
    next[index] = { ...before, ...patch, updatedAt: new Date().toISOString() };
    const renamed = next[index].title !== before.title;
    // The title input submits a completed draft, not each keystroke. Rewrite
    // live references in the same pending snapshot so navigation cannot follow
    // an old title and accidentally create an empty replacement note.
    if (renamed) next = applyNoteRenameReferences(previous, next, noteId);
    notesRef.current = next;
    pendingNotesRef.current = next;
    readingOnlySaveRef.current = null;
    personalOnlySaveRef.current = null;
    noteSaveRevisionRef.current += 1;
    setNoteSaveState('pending');
    if (renamed) setNotes(next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; void flushSave(notesRef.current).catch(() => {}); }, NOTE_AUTOSAVE_IDLE_MS);
    const activity = ++editingActivityRef.current;
    if (!editingIndexLeaseRef.current) {
      editingIndexLeaseRef.current = true;
      void setNoteIndexEditing(true).catch(() => {});
    }
    if (editingIdleTimerRef.current) clearTimeout(editingIdleTimerRef.current);
    editingIdleTimerRef.current = setTimeout(() => {
      void flushSave(notesRef.current).then(() => {
        if (activity !== editingActivityRef.current) return;
        editingIndexLeaseRef.current = false;
        return setNoteIndexEditing(false);
      }).catch(() => {
        if (activity === editingActivityRef.current) {
          editingIndexLeaseRef.current = false;
          void setNoteIndexEditing(false).catch(() => {});
        }
      });
    }, 30_000);
  }, [flushSave]);
  const handleFinishNoteEditing = useCallback(() => {
    // Publish before navigation/Agent reads, but keep disk/index maintenance asynchronous.
    if (publishedNotesRef.current !== notesRef.current) setNotes(notesRef.current);
    if (!pendingNotesRef.current && !editingIndexLeaseRef.current) return;
    const activity = editingActivityRef.current;
    if (editingIdleTimerRef.current) { clearTimeout(editingIdleTimerRef.current); editingIdleTimerRef.current = null; }
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    void flushSave(notesRef.current).then(async () => {
      if (activity !== editingActivityRef.current) return;
      editingIndexLeaseRef.current = false;
      await setNoteIndexEditing(false);
      await requestNoteIndexRefresh();
    }).catch(() => {
      if (activity === editingActivityRef.current) {
        editingIndexLeaseRef.current = false;
        void setNoteIndexEditing(false).catch(() => {});
      }
    });
  }, [flushSave]);
  const handleNoteEditingActivity = useCallback(() => {
    // Observe activity only; never intercept IME/keyboard events or touch the
    // editor state. Viewport-only saves keep their independent lightweight batch.
    if (!pendingNotesRef.current || readingOnlySaveRef.current?.latest === notesRef.current
      || personalOnlySaveRef.current?.latest === notesRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null; void flushSave(notesRef.current).catch(() => {});
    }, NOTE_AUTOSAVE_IDLE_MS);
    const activity = ++editingActivityRef.current;
    if (editingIdleTimerRef.current) clearTimeout(editingIdleTimerRef.current);
    editingIdleTimerRef.current = setTimeout(() => {
      void flushSave(notesRef.current).then(() => {
        if (activity !== editingActivityRef.current) return;
        editingIndexLeaseRef.current = false; return setNoteIndexEditing(false);
      }).catch(() => {
        if (activity === editingActivityRef.current) {
          editingIndexLeaseRef.current = false; void setNoteIndexEditing(false).catch(() => {});
        }
      });
    }, 30_000);
  }, [flushSave]);

  const handleUpdateNote = (u: NoteItem) => {
    if (rejectLateDeletedNoteUpdate(optimisticDeletionsRef.current, notesRef.current, u.id)) return;
    u = retainLatestTextbookReadingPosition(notesRef.current.find(note => note.id === u.id), u);
    const prev = notesRef.current;
      const i = prev.findIndex(n => n.id === u.id);
      const previous = i !== -1 ? prev[i] : undefined;
      if (JSON.stringify(previous?.aliases || []) !== JSON.stringify(u.aliases || [])) {
        const error = noteAliasesError(prev, u.id, u.aliases || []);
        if (error) throw new Error(error);
      }
      const personalOnly = Boolean(previous && isPersonalOnlyNoteChange(previous, u));
      let nn = [...prev];
      if (i !== -1) nn[i] = u;
      else nn.unshift(u);
      if (previous && previous.title !== u.title) nn = applyNoteRenameReferences(prev, nn, u.id);
      if (!personalOnly) nn = adjustPlanAfterNoteUpdate(nn, previous, nn.find(note => note.id === u.id)!).notes;
      const r = personalOnly ? nn : recalculateBacklinks(nn);
      noteSaveRevisionRef.current += 1;
      setNoteSaveState('pending');
      if (!personalOnly) indexNote(r.find(note => note.id === u.id)!).catch(() => {});
      personalOnlySaveRef.current = personalOnly ? trackPersonalOnlySave(prev, r, pendingNotesRef.current, personalOnlySaveRef.current) : null;
      notesRef.current = r;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      pendingNotesRef.current = r;
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        if (pendingNotesRef.current) {
          void flushSave(pendingNotesRef.current).catch(() => {});
        }
      }, NOTE_AUTOSAVE_IDLE_MS);
      setNotes(r);
  };
  useEffect(() => { return () => { if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); if (pendingNotesRef.current) void flushSave(pendingNotesRef.current).catch(() => {}); } }; }, [flushSave]);

  const stormCreatedNoteIdsRef = useRef(new Set<string>());
  const handleStormUpdateNote = (note: NoteItem, signal?: AbortSignal, expected?: NoteItem | null): Promise<void> => enqueueLearningWrite(learningWriteQueueRef, async () => {
    // A queued write from an abandoned research must not recreate notes after navigation.
    if (signal?.aborted) throw new DOMException('研究已停止', 'AbortError');
    if (expected === undefined) throw new Error('研究写入缺少正文基线，未覆盖笔记');
    const patch = prepareStormNoteWrite(notesRef.current, note, expected, stormCreatedNoteIdsRef.current);
    handleUpdateNote(patch);
    if (expected === null) stormCreatedNoteIdsRef.current.add(note.id);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    // Already inside the write queue: do not await flushSave, which enqueues on the same queue.
    const snapshot = notesRef.current;
    const revision = noteSaveRevisionRef.current;
    setNoteSaveState('saving');
    try {
      await saveAllNotesToStorage(snapshot);
      setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
      if (pendingNotesRef.current === snapshot) pendingNotesRef.current = null;
    } catch (error) {
      pendingNotesRef.current = notesRef.current;
      setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, false));
      throw error;
    }
  });

  const persistLearningMutation = (noteId: string, mutate: (note: NoteItem) => NoteItem | Promise<NoteItem>): Promise<void> => {
    return enqueueLearningWrite(learningWriteQueueRef, async () => {
      const latest = notesRef.current.find((note) => note.id === noteId);
      if (!latest) throw new Error('目标笔记已不存在，学习记录未写入其他项目');
      const updated = await mutate(latest);
      if (updated === latest) return;
      if (notesRef.current.find((note) => note.id === noteId) !== latest) throw new Error('校验时笔记发生修改，请重试；未覆盖最新内容');
      const previous = notesRef.current;
      const personalOnly = isPersonalOnlyNoteChange(latest, updated);
      const replaced = previous.map((note) => note.id === noteId ? updated : note);
      const next = personalOnly ? replaced : recalculateBacklinks(replaced);
      personalOnlySaveRef.current = personalOnly ? trackPersonalOnlySave(previous, next, pendingNotesRef.current, personalOnlySaveRef.current) : null;
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      pendingNotesRef.current = next;
      notesRef.current = next;
      setNotes(next);
      const revision = ++noteSaveRevisionRef.current;
      setNoteSaveState('saving');
      try {
        if (!await savePersonalStateOnly(next, personalOnlySaveRef.current)) await saveAllNotesToStorage(next);
        setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
        if (pendingNotesRef.current === next) pendingNotesRef.current = null;
        personalOnlySaveRef.current = acknowledgePersonalSave(personalOnlySaveRef.current, next);
      } catch (error) {
        pendingNotesRef.current = notesRef.current;
        setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, false));
        throw error;
      }
      if (!personalOnly) indexNote(updated).catch(() => {});
    });
  };
  const handleLearningReviewPatch = async (noteId: string, id: string, patch: LearningReviewPatch) => {
    await persistLearningMutation(noteId, (note) => patchLearningReviewRecord(note, id, patch));
    const note = notesRef.current.find(item => item.id === noteId);
    if (note && patch.editedRestatement !== undefined) await captureRestatementCognition(note, id);
  };
  const handleQuickCheckCommit = (session: QuickCheckSession, assessment: QuickCheckAssessment) => {
    let progress = quickCheckWritesRef.current.get(session.id);
    if (!progress) {
      progress = {};
      quickCheckWritesRef.current.set(session.id, progress);
      // Completed attempts need no unbounded in-memory receipt history.
      if (quickCheckWritesRef.current.size > 100) for (const [id, receipt] of quickCheckWritesRef.current) {
        if (id !== session.id && receipt.completed) { quickCheckWritesRef.current.delete(id); break; }
      }
    }
    return commitQuickCheckWrite(progress, {
      persist: capture => persistLearningMutation(session.noteId, async current => {
        if (!quickCheckStorageScope || quickCheckStorageScope !== await agentTaskScope())
          throw new Error('资料库已变化，请重新打开简测；未写入其他资料库。');
        const outcome = applyQuickCheckAssessment([current], session, assessment);
        if (outcome.reason) throw new Error(outcome.reason);
        capture(outcome.result);
        return outcome.notes[0];
      }),
      // A personal-state mutation can already be visible after an IO failure.
      // Retry its pending disk save even when the observation is now a replay.
      flush: () => flushSave(notesRef.current),
    });
  };
  const finishStoredFlowReview = (session: FlowSession | null, status: LearningReviewStatus, error?: string, analysisSummary?: string) => session
    ? persistLearningMutation(session.noteId, (note) => finishFlowReviewRecord(note, session.id, status, error, analysisSummary))
    : Promise.resolve();
  // persistLearningMutation already exposes the recoverable failure through NoteSaveRecovery.
  // Keep the workspace usable instead of stacking a blocking native alert over the themed retry banner.
  const reportLearningSaveError = (error: unknown) => console.warn('[learning-save] 学习记录尚未保存', error);
  const cancelStoredFlowReview = async (session: FlowSession | null) => {
    if (!session) return;
    // 关闭分析后，迟到的模型回调不能重新弹出本次结果或绑定到下一次学习。
    if (flowSessionRef.current?.id === session.id) {
      flowSessionRef.current = null;
      setAnalysisProgressOpen(false);
      knowledgeDiscovery.cancel();
    }
    if (flowEpisodeIdRef.current === session.id) flowEpisodeIdRef.current = null;
    await finishStoredFlowReview(session, 'text_only');
    void patchLearningEpisode(session.id, { status: 'completed' }).catch(() => {});
  };

  const handleQuickNewNote = () => handleNewNote("knowledge");
  const handleNewNote = (t: NoteType = "knowledge", pid?: string, title?: string) => {
    if (!allowWorkspaceNavigation()) return;
    requestNoteNavigation(() => {
      if (!allowWorkspaceNavigation()) return;
      const current = notesRef.current, ct = title?.trim();
      if (ct && t === 'knowledge') {
        const resolution = resolveNoteReference(ct, current);
        if (resolution.status === 'ambiguous') { setSyncStatus(status => ({ ...status, statusText: ambiguousNoteReferenceMessage(ct, resolution.matches) })); return; }
        if (resolution.status === 'unique') { setActiveNoteId(resolution.note.id); setCurrentView('editor'); return; }
      }
      const nn: NoteItem = { id: `note-${crypto.randomUUID()}`, title: availableNoteTitle(ct || `未命名学习笔记 ${current.length + 1}`, current), content: t === 'project' ? '' : '请对该知识点进行定义描述', noteType: t, parentId: pid, tags: ['学习计划'], links: [], backlinks: [], dueDates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      handleUpdateNote(nn); setActiveNoteId(nn.id); if (t === 'project') setActiveProjectContextId(nn.id); setCurrentView('editor');
    });
  };
  const handleDeleteNote = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (notesRef.current.find(note => note.id === id)?.noteType === 'knowledge') {
      window.dispatchEvent(new CustomEvent('loginote:knowledge-maintenance', { detail: { kind: 'delete', ids: [id] } })); return;
    }
    stageNoteDeletion([id]);
  };
  const collectDescendantIds = (pid: string, an: NoteItem[]): string[] => {
    const children = new Map<string, string[]>();
    for (const note of an) if (note.parentId) {
      const ids = children.get(note.parentId) || [];
      ids.push(note.id); children.set(note.parentId, ids);
    }
    const visited = new Set([pid]), pending = [pid], result: string[] = [];
    while (pending.length) for (const id of children.get(pending.pop()!) || []) {
      if (visited.has(id)) continue;
      visited.add(id); result.push(id); pending.push(id);
    }
    return result;
  };
  const stageNoteDeletion = (ids: string[]) => {
    const next = stageOptimisticNoteDeletion(optimisticDeletionsRef.current, notesRef.current, ids);
    if (next === notesRef.current) return;
    const removed = new Set(ids);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    readingOnlySaveRef.current = null; personalOnlySaveRef.current = null;
    noteSaveRevisionRef.current++;
    notesRef.current = next; pendingNotesRef.current = next;
    setNotes(next); setNoteSaveState('pending');
    setPendingDeletionCount(optimisticDeletionsRef.current.pending.size); setRestoredDeletionCount(0);
    setActiveNoteIdState(selected => selected && removed.has(selected) ? next[0]?.id || null : selected);
    setActiveProjectContextId(selected => selected && removed.has(selected) ? null : selected);
    // Reserve the shared queue NOW so normal exit/flush cannot miss this work.
    // Yield one task before parsing backlinks/serializing the vault, allowing the
    // dialog and visible list to update without waiting for disk or indexing.
    void enqueueLearningWrite(learningWriteQueueRef, async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const snapshot = notesRef.current, revision = noteSaveRevisionRef.current;
      const checkpoint = new Map(optimisticDeletionsRef.current.pending);
      setNoteSaveState('saving');
      try {
        if (pendingNotesRef.current) await saveAllNotesToStorage(snapshot);
      } catch (error) {
        const recovery = rollbackOptimisticNoteDeletions(optimisticDeletionsRef.current, notesRef.current);
        noteSaveRevisionRef.current++;
        notesRef.current = recovery.notes; pendingNotesRef.current = recovery.notes;
        readingOnlySaveRef.current = null; personalOnlySaveRef.current = null;
        setNotes(recovery.notes); setPendingDeletionCount(0);
        setRestoredDeletionCount(count => count + recovery.restoredCount);
        setNoteSaveState('error'); throw error;
      }
      if (pendingNotesRef.current === snapshot) pendingNotesRef.current = null;
      setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
      const deleted = acknowledgeOptimisticNoteDeletion(optimisticDeletionsRef.current, checkpoint, snapshot, notesRef.current);
      setPendingDeletionCount(optimisticDeletionsRef.current.pending.size);
      // Maintenance failure must not roll back an acknowledged saved deletion.
      await finishDeletedNoteIndexCleanup(deleted).catch(error => console.warn('[note-rag] 删除已保存，索引清理待重试', error));
    }).catch(reportLearningSaveError);
  };
  const handleDeleteProject = async (id: string) => {
    const current = notesRef.current;
    if (!current.some(note => note.id === id && note.noteType === 'project')) throw new Error('目标项目已不存在，请刷新后重试。');
    stageNoteDeletion([id, ...collectDescendantIds(id, current)]);
  };
  const handleToggleFavorite = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const n = notesRef.current.find(n => n.id === id); if (n) handleUpdateNote({ ...n, isFavorite: !n.isFavorite }); };
  const handleTogglePin = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const n = notesRef.current.find(n => n.id === id); if (n) handleUpdateNote({ ...n, pinned: !n.pinned }); };
  const handleOpenContextNote = (id: string, projectContextId?: string | null, heading?: string) => {
    if (!allowWorkspaceNavigation()) return;
    navigationRevisionRef.current++;
    const selected = notesRef.current.find((note) => note.id === id);
    const navigation = contextNavigation.getSnapshot();
    const currentPage = navigation.pages[navigation.cursor];
    if (currentPage?.noteId === id) setSidebarRevealRevision(revision => revision + 1);
    const inheritedContext = currentPage ? currentPage.projectContextId : activeProjectContextId;
    contextNavigation.open(id, selected?.noteType === 'project' ? id
      : projectContextId !== undefined ? projectContextId : inheritedContext, heading);
  };
  const handleSelectNote = (id: string) => {
    if (!allowWorkspaceNavigation()) return;
    if (contextNavigation.active || currentView !== 'editor') { handleOpenContextNote(id); return; }
    if (id === activeNoteId) { setSidebarRevealRevision(revision => revision + 1); return; }
    requestNoteNavigation(() => {
      if (!allowWorkspaceNavigation()) return;
      const selected = notesRef.current.find((note) => note.id === id); if (!selected) return;
      setActiveNoteId(id);
      if (selected.noteType === 'project') setActiveProjectContextId(selected.id);
      setCurrentView('editor');
    });
  };
  const handleSelectNoteByTitle = (title: string, projectContextId?: string) => {
    if (!allowWorkspaceNavigation()) return;
    const source = isPlanPreviewDemo ? planPreviewNotes : notesRef.current;
    const destination = parseWikiLink(title, notesRef.current);
    const resolution = resolveNoteReference(destination.noteTitle, source);
    if (resolution.status === 'ambiguous') {
      setSyncStatus(current => ({ ...current, statusText: ambiguousNoteReferenceMessage(destination.noteTitle, resolution.matches) }));
      return;
    }
    const target = resolution.status === 'unique' ? resolution.note
      : !destination.noteTitle && destination.heading ? getContextFocusedNote(contextNavigation.getSnapshot(), source, activeNoteId) : undefined;
    if (target) { handleOpenContextNote(target.id, projectContextId, destination.heading); return; }
    if (destination.heading !== undefined) {
      setSyncStatus(current => ({ ...current, statusText: '未找到章节引用的目标笔记，请检查笔记名称。' }));
      return;
    }
    // Preserve wiki-link creation, but never write demo fixtures to the real vault.
    if (isPlanPreviewDemo || isSceneS1Demo || isSceneS4Demo || isLearningCompletionDemo || isReviewExitDemo) return;
    const created = initializeWikiKnowledge(destination.noteTitle, `note-${crypto.randomUUID()}`);
    handleUpdateNote(created);
    handleOpenContextNote(created.id, projectContextId);
  };
  const handleSetLearningCompletion = (target: LearningCompletionTarget, completed: boolean): Promise<void> => {
    return enqueueLearningWrite(learningWriteQueueRef, async () => {
      setNoteSaveState('saving');
      try {
        await commitLearningCompletion({
          readNotes: () => notesRef.current,
          saveNotes: saveAllNotesToStorage,
          beforeSave: () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          },
          applyNotes: (updated) => {
            const previous = notesRef.current;
            noteSaveRevisionRef.current += 1;
            notesRef.current = updated;
            pendingNotesRef.current = null;
            setNotes(updated);
            setNoteSaveState('saved');
            const previousById = new Map(previous.map((note) => [note.id, note]));
            updated.forEach((note) => {
              const before = previousById.get(note.id);
              if (!before || before.title !== note.title || before.content !== note.content || before.updatedAt !== note.updatedAt) {
                void indexNote(note).catch(() => {});
              }
            });
          },
        }, target, completed);
        recordAgentWorkspaceEvent({
          id: `learning-completion:${target.binding.noteId}:${target.binding.taskId || 'project'}:${target.binding.occurrenceDate || ''}`,
          kind: 'learning-completion-changed', occurredAt: new Date().toISOString(), noteId: target.binding.noteId,
          title: target.title, status: completed ? 'completed' : 'reopened',
          summary: completed ? '用户已将该学习项标记为完成。' : '用户已将该学习项恢复为未完成。',
        });
      } catch (error) {
        // Edits remain intact; a failed write never presents a task as completed.
        pendingNotesRef.current = notesRef.current;
        setNoteSaveState('error');
        throw error;
      }
    });
  };
  const persistPlanMutation = <T extends { notes: NoteItem[] }>(prepare: (current: NoteItem[]) => T, rootId?: string, indexImmediately = true): Promise<T> =>
    enqueueLearningWrite(learningWriteQueueRef, async () => {
      setNoteSaveState('saving');
      try {
        return await commitPlanWrite({
          readNotes: () => notesRef.current,
          saveNotes: saveAllNotesToStorage,
          trySavePersonal: (before, next) => savePersonalStateOnly(next,
            trackPersonalOnlySave(before, next, pendingNotesRef.current, personalOnlySaveRef.current)),
          beforeSave: () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          },
          applyNotes: (updated) => {
            const previous = new Map(notesRef.current.map((note) => [note.id, note]));
            notesRef.current = updated;
            pendingNotesRef.current = null;
            personalOnlySaveRef.current = null;
            noteSaveRevisionRef.current += 1;
            setNotes(updated);
            setNoteSaveState('saved');
            if (indexImmediately) updated.forEach((note) => {
              const before = previous.get(note.id);
              if (!before || before.title !== note.title || before.content !== note.content || before.updatedAt !== note.updatedAt) void indexNote(note).catch(() => {});
            });
          },
        }, prepare, rootId);
      } catch (error) {
        pendingNotesRef.current = notesRef.current;
        setNoteSaveState('error');
        throw error;
      }
    });
  const handleBatchCreateProjectTree = async (tree: PlanNode[], planMeta?: Partial<PlanMeta>) => {
    assertHardDraftCapacity(tree, planMeta || {}, notesRef.current, appSettings.getSnapshot().settings);
    if (!tree || tree.length === 0) return null;
    const now = new Date().toISOString();
    let sequence = 0;
    const projectIds = new Map<string, string>();
    const taskIds = new Map<string, string>();
    const allNodes: PlanNode[] = [];
    const collect = (nodes: PlanNode[]) => nodes.forEach((node) => {
      const nodeKey = node.key || `phase-${++sequence}`;
      if (!projectIds.has(nodeKey)) projectIds.set(nodeKey, `note-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 7)}`);
      allNodes.push(node);
      (node.tasks || []).forEach((task) => {
        if (!taskIds.has(task.key)) taskIds.set(task.key, createPlanTaskId(projectIds.get(nodeKey)!, Date.now() + sequence++));
      });
      collect(node.children || []);
    });
    collect(tree);
    const signature = JSON.stringify({ tree, planMeta: { ...planMeta, updatedAt: undefined } });
    if (planCreateIdsRef.current?.signature === signature) {
      projectIds.clear(); taskIds.clear();
      planCreateIdsRef.current.projects.forEach((value, key) => projectIds.set(key, value));
      planCreateIdsRef.current.tasks.forEach((value, key) => taskIds.set(key, value));
    } else planCreateIdsRef.current = { signature, projects: new Map(projectIds), tasks: new Map(taskIds) };

    const derivedMilestones = allNodes.flatMap((node) => node.milestone ? [{
      id: node.milestone.id,
      title: node.milestone.title,
      dueDate: node.milestone.dueDate,
      criteria: node.milestone.description ? [node.milestone.description] : undefined,
      projectId: projectIds.get(node.key),
      completed: false,
    }] : []);
    const directPhases = (tree[0]?.children || []).flatMap((node) => (
      node.startDate && node.dueDate ? [{
        projectId: projectIds.get(node.key)!,
        startDate: node.startDate,
        endDate: node.dueDate,
        outcome: node.outcome,
      }] : []
    ));
    const rootNode = tree[0];
    const rootId = rootNode ? projectIds.get(rootNode.key) : undefined;
    const configuredMilestones = (planMeta?.milestones || []).map((milestone) => ({
      ...milestone,
      projectId: milestone.projectId && projectIds.has(milestone.projectId)
        ? projectIds.get(milestone.projectId)
        : milestone.projectId,
    }));
    const rootPlanMeta: PlanMeta | undefined = rootNode && rootId ? {
      resourcePreparationVersion: 1,
      schemaVersion: 2,
      status: planMeta?.status || 'active',
      shortTitle: planMeta?.shortTitle || rootNode.title.trim() || '未命名学习计划',
      summary: planMeta?.summary || rootNode.outcome || `围绕“${rootNode.title.trim() || '学习目标'}”形成可验证的阶段成果。`,
      startDate: planMeta?.startDate || rootNode.startDate || homeLocalDate(new Date(now)),
      targetDate: planMeta?.targetDate || rootNode.dueDate,
      weeklyBudgetMinutes: planMeta?.weeklyBudgetMinutes,
      dailyStudyMinutes: planMeta?.dailyStudyMinutes,
      activeWeekdays: planMeta?.activeWeekdays?.length ? planMeta.activeWeekdays : [1, 2, 3, 4, 5, 6],
      portfolioPriority: planMeta?.portfolioPriority || rootNode.priority || 'medium',
      autoAdjustPolicy: planMeta?.autoAdjustPolicy || 'ask',
      conditions: planMeta?.conditions,
      phaseWindows: planMeta?.phaseWindows?.length ? planMeta.phaseWindows : directPhases,
      milestones: [...configuredMilestones, ...derivedMilestones],
      research: planMeta?.research,
      updatedAt: now,
    } : undefined;

    const createdNotes: NoteItem[] = [];
    const buildNotes = (nodes: PlanNode[], parentId?: string) => nodes.forEach((node) => {
      const title = node.title.trim() || '未命名阶段';
      const noteId = projectIds.get(node.key)!;
      const dueDates: DueDateItem[] = [];
      if (node.dueDate) dueDates.push({
        id: `due-${noteId}-0`, noteId, noteTitle: title, taskText: title,
        startDate: node.startDate,
        dueDate: node.dueDate, completed: false, priority: node.priority || 'medium', source: 'manual',
        estimatedMinutes: node.estimatedMinutes,
      });
      const taskLines = (node.tasks || []).map((task, order) => {
        const taskId = taskIds.get(task.key) || createPlanTaskId(noteId);
        dueDates.push({
          id: taskId,
          noteId,
          noteTitle: title,
          taskText: task.text,
          kind: task.kind,
          startDate: task.startDate,
          dueDate: task.dueDate,
          estimatedMinutes: task.estimatedMinutes,
          capacityKind: task.capacityKind,
          dependencyTaskIds: (task.dependencyKeys || []).flatMap((key) => taskIds.get(key) ? [taskIds.get(key)!] : []),
          milestoneId: task.milestoneId,
          executionKind: task.executionKind,
          recurrence: task.recurrence,
          linkedProjectId: task.linkedProjectKey ? projectIds.get(task.linkedProjectKey) : undefined,
          linkedKnowledgeIds: task.linkedKnowledgeIds,
          launchMode: task.launchMode,
          reminderMinutes: task.reminderMinutes,
          order,
          completed: false,
          priority: task.priority || 'medium',
          source: task.source || 'llm',
        });
        return formatPlanTaskLine(task.text, task.dueDate, taskId);
      });
      createdNotes.push({
        id: noteId,
        title,
        content: taskLines.join('\n'),
        generatedContentBlocks: taskLines.length ? [taskLines.join('\n')] : [],
        noteType: 'project',
        parentId,
        tags: ['学习计划'],
        links: [],
        backlinks: [],
        dueDates,
        planMeta: noteId === rootId ? rootPlanMeta : undefined,
        resources: noteId === rootId ? plannedPreparationDocuments(planMeta?.preparationDocuments) : undefined,
        createdAt: now,
        updatedAt: now,
      });
      buildNotes(node.children || [], noteId);
    });
    buildNotes(tree);

    if (createdNotes.length > 0) {
      const source = isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current;
      const nextNotes = recalculateBacklinks([...source, ...createdNotes]);
      if (isPlanPreviewDemo) {
        planPreviewNotesRef.current = nextNotes;
        setPlanPreviewNotes(nextNotes);
      } else {
        await persistPlanMutation((current) => ({ notes: [...current, ...createdNotes] }));
        const endedAt = now;
        const episodeId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const planSummary = summarizePlan(tree);
        const evidence = extractPlanEvidence({ episodeId, observedAt: endedAt, tree });
        saveLearningEpisode({
          id: episodeId,
          type: 'plan',
          status: 'completed',
          title: `学习计划：${planSummary.titles[0] || '未命名计划'}`,
          startedAt: endedAt,
          endedAt,
          goal: planSummary.titles[0],
          summary: `已创建 ${planSummary.nodeCount} 个计划节点，其中 ${planSummary.scheduledCount} 个设置了日期。`,
          evidenceSnippets: evidence.evidenceSnippets,
          profileSignals: evidence.profileSignals,
          createdAt: endedAt,
          updatedAt: endedAt,
        }).catch(() => {});
      }
      setActiveNoteId(rootId || createdNotes[0].id);
      setActiveProjectContextId(rootId || createdNotes[0].id);
      setPlanWorkspaceFocusId(rootId || createdNotes[0].id);
      setCurrentView("timeline");
      planCreateIdsRef.current = null;
      return {
        rootId: rootId || createdNotes[0].id,
        rootTitle: rootNode?.title.trim() || createdNotes[0].title,
        taskCount: allNodes.reduce((total, node) => total + (node.tasks?.length || 0), 0),
        persistence: Promise.resolve(),
      };
    }
    return null;
  };
  const handleUpdatePublishedPlan = async (rootId: string, tree: PlanNode[], planMeta?: Partial<PlanMeta>, baseValue?: PublishedPlanEditorValue) => {
      const originatedFromAgent = agentPlanEditorQueue.some((draft) => draft.rootId === rootId);
      const confirmedEditorDraftId = agentPlanEditorQueue.find((draft) => draft.rootId === rootId)?.agentEditorDraftId;
      const prepare = (source: NoteItem[]) => {
        assertHardDraftCapacity(tree, planMeta || {}, source, appSettings.getSnapshot().settings, rootId);
        if (originatedFromAgent && !isPlanEditorDraftFresh(source, {
          newPlanDraft: null, editorQueue: agentPlanEditorQueue, editingPlanRootId: rootId,
          baseProjectRevisions: agentPlanEditorBaseRevisions,
        })) throw new Error('原计划已更新，Agent 草图已保留；请先重新载入最新计划');
        if (!originatedFromAgent && baseValue) {
          const current = buildPublishedPlanEditorValue(source, rootId);
          const fingerprint = (value: PublishedPlanEditorValue | null) => value && JSON.stringify({ tree: value.tree, planMeta: value.planMeta, projectCatalog: value.projectCatalog });
          if (fingerprint(current) !== fingerprint(baseValue)) throw new Error('原计划已更新，当前草图已保留；请重新载入最新计划后确认');
        }
        return replacePublishedPlanFromEditor(source, rootId, tree, planMeta || {});
      };
      const mutation = isPlanPreviewDemo ? prepare(planPreviewNotesRef.current) : await persistPlanMutation(prepare, rootId);
      const nextNotes = isPlanPreviewDemo ? recalculateBacklinks(mutation.notes) : mutation.notes;
      if (isPlanPreviewDemo) {
        planPreviewNotesRef.current = nextNotes;
        setPlanPreviewNotes(nextNotes);
      } else {
        if (!originatedFromAgent) clearManualPlanDraft(planDraftKey(rootId));
        const endedAt = new Date().toISOString();
        const episodeId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const evidence = extractPlanEvidence({ episodeId, observedAt: endedAt, tree, action: 'update' });
        saveLearningEpisode({
          id: episodeId,
          type: 'plan',
          status: 'completed',
          title: `调整学习计划：${tree[0]?.title || rootId}`,
          startedAt: endedAt,
          endedAt,
          goal: tree[0]?.title,
          summary: `用户已在计划编辑器中确认：${mutation.summary.structurePatchCount} 个结构调整、${mutation.summary.milestonePatchCount} 个里程碑调整、${mutation.summary.executionPatchCount} 个执行事项调整。`,
          evidenceSnippets: evidence.evidenceSnippets,
          profileSignals: evidence.profileSignals,
          createdAt: endedAt,
          updatedAt: endedAt,
        }).catch(() => {});
      }
      setActiveNoteId(rootId);
      setActiveProjectContextId(rootId);
      setPlanWorkspaceFocusId(rootId);
      const remainingAgentDrafts = agentPlanEditorQueue.filter((draft) => draft.rootId !== rootId);
      if (remainingAgentDrafts.length > 0) {
        setAgentPlanEditorQueue(remainingAgentDrafts);
        const remainingIds = buildPlanEditorBaseRevisions(nextNotes, remainingAgentDrafts.map((draft) => draft.rootId));
        setAgentPlanEditorBaseRevisions(Object.fromEntries(Object.entries(agentPlanEditorBaseRevisions).filter(([id]) => id in remainingIds)));
        setEditingPlanRootId(remainingAgentDrafts[0].rootId);
        setCurrentView('plan');
      } else {
        setAgentPlanEditorQueue([]);
        setAgentPlanEditorBaseRevisions({});
        setEditingPlanRootId(null);
        setCurrentView('timeline');
        if (originatedFromAgent && !isPlanPreviewDemo) {
            updateWorkflowHandoff(buildPersistedPlanHandoff({
            scopeProjectId: rootId,
            scopeProjectTitle: mutation.summary.rootProjectTitle || tree[0]?.title || rootId,
            knowledgePointTitles: [
              ...mutation.summary.linkedKnowledgeTitles,
              ...mutation.summary.createdKnowledgeTitles,
            ],
            taskCount: mutation.summary.taskCount,
            sourceSkillId: 'plan-planning',
            }));
            if (confirmedEditorDraftId) setAgentExternalRequest({ id: `plan-editor-complete-${confirmedEditorDraftId}`,
              text: '计划调整已在编辑器中确认并保存。', targetSkillId: 'plan-planning',
              observedOutcome: { kind: 'plan-writeback', eventId: confirmedEditorDraftId, editorDraftId: confirmedEditorDraftId, rootProjectId: rootId } });
        }
      }
  };
  const createAgentProjectPlan = async (root: AgentProjectPlanNode, planMeta?: Partial<PlanMeta>) => {
    if (!allowWorkspaceNavigation()) throw new Error('请先保存或取消当前编辑，再导入计划草图。');
    if (agentNewPlanDraft || agentPlanEditorQueue.length > 0) {
      throw new Error('请先在计划编辑器中确认或放弃当前 Agent 草案');
    }
    // Reuse the production validator and ID normalizer, but keep its projection
    // entirely in memory. The editor is now the only route to persistence.
    const built = buildProjectPlanNotes(getAgentPlanNotes(), root, undefined, undefined, planMeta);
    const normalizedRootMeta = built.createdNotes.find((note) => note.id === built.summary.rootNoteId)?.planMeta || {};
    const collectDraftMilestones = (nodes: PlanNode[]): NonNullable<PlanMeta['milestones']> => nodes.flatMap((node) => [
      ...(node.milestone ? [{
        id: node.milestone.id,
        title: node.milestone.title,
        dueDate: node.milestone.dueDate,
        criteria: node.milestone.description ? [node.milestone.description] : undefined,
        projectId: node.key,
        completed: false,
      }] : []),
      ...collectDraftMilestones(node.children || []),
    ]);
    const explicitMilestones = planMeta?.milestones || [];
    const nodeMilestones = collectDraftMilestones(built.tree);
    const milestoneIds = new Set(explicitMilestones.map((item) => item.id));
    const value: PlanBuilderDraftValue = {
      tree: built.tree as [PlanNode],
      planMeta: {
        ...normalizedRootMeta,
        ...planMeta,
        // buildProjectPlanNotes maps phase project keys to its temporary note
        // IDs. The final create path allocates fresh IDs, so let it derive the
        // phase windows again from the user-confirmed structure.
        phaseWindows: planMeta?.phaseWindows,
        milestones: [...explicitMilestones, ...nodeMilestones.filter((item) => !milestoneIds.has(item.id))],
      },
      sourceLabel: 'Agent 计划草图已导入，尚未写入',
    };
    const editorDraftId = `agent-plan-${Date.now()}`;
    setAgentNewPlanDraft({ id: editorDraftId, value });
    setAgentPlanEditorQueue([]);
    setAgentPlanEditorBaseRevisions({});
    setEditingPlanRootId(null);
    setIsAgentOpen(false);
    setCurrentView('plan');
    return { ...built.summary, draftImported: true, requiresUserConfirmation: true, editorDraftId };
  };
  const handleAddNewScheduleTask = async (input: PlanTaskCreateInput) => {
    const id = createPlanTaskId(input.noteId);
    await persistPlanMutation((currentNotes) => {
    const note = currentNotes.find((candidate) => candidate.id === input.noteId);
    if (!note || !isProjectWithinPlanRoot(currentNotes, input.noteId, input.scopeRootId)) throw new Error('请选择当前计划中的项目');
    const line = formatPlanTaskLine(input.taskText, input.dueDate, id);
    const content = `${note.content}${note.content.trim() ? '\n' : ''}${line}`;
    const updated: NoteItem = {
      ...note,
      content,
      dueDates: [
        ...(note.dueDates || []),
        {
          id,
          noteId: note.id,
          noteTitle: note.title,
          taskText: input.taskText,
          dueDate: input.dueDate,
          completed: false,
          priority: 'medium',
          kind: input.kind,
          startDate: input.dueDate,
          estimatedMinutes: input.estimatedMinutes,
          executionKind: input.executionKind,
          recurrence: input.recurrenceFrequency && input.recurrenceFrequency !== 'none' ? {
            frequency: input.recurrenceFrequency,
            weekdays: input.recurrenceWeekdays,
            interval: 1,
            missedPolicy: 'rollover',
          } : undefined,
          launchMode: input.executionKind === 'flow' ? 'flow' : input.executionKind === 'practice' ? 'scene' : input.executionKind === 'review' ? 'review' : 'none',
          source: 'manual',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    return { notes: currentNotes.map((item) => item.id === note.id ? updated : item) };
    }, input.scopeRootId);
  };
  const handleTriggerSync = async () => {
    // 方向 X：移除云端同步，改为「打开数据目录」作为导出/备份入口
    const openData = (window as any).electronAPI?.openDataFolder;
    if (openData) {
      try {
        await openData();
        setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "已打开数据目录：vault/ 可分享、user-state/ 可备份" }));
      } catch {
        setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "打开数据目录失败" }));
      }
    } else {
      setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "仅桌面版支持本地数据目录" }));
    }
  };
  const handleOpenLearn = () => { setCurrentView("learn"); };
  const handleEnterBubbleMode = (request?: AgentReviewLaunchRequest) => {
    if (!allowWorkspaceNavigation()) return;
    const validRequest = normalizeAgentReviewLaunchRequest(request);
    setReviewHubLaunchRequest(validRequest ? { ...validRequest, id: `review-picker-${Date.now()}` } : null);
    setCurrentView("bubble");
  };
  // 场景模拟：由 LearnHub 搭建面板产出初始请求，交给 SceneMode 全屏承载
  const handleEnterScene = (request: SceneInitialRequest) => {
    if (!allowWorkspaceNavigation()) return;
    setSceneDraftSnapshot(null);
    const task = getLearningCompletionTarget(notesRef.current, request.taskBinding);
    setSceneRequest({ ...request, taskBinding: task?.binding });
    setCurrentView("scene");
  };
  const handleExitScene = () => {
    if (!sceneGuard.exit()) return;
    setSceneReferenceNote(null);
    setSceneDraftSnapshot(null);
    setSceneRequest(null);
    setCurrentView("learn");
  };
  const handleSceneReference = (id: string) => {
    const source = isSceneS1Demo ? [...SCENE_S1_DEMO_NOTES, ...notesRef.current] : notesRef.current;
    const note = source.find((item) => item.id === id);
    if (note) setSceneReferenceNote(note);
  };
  const handleSelectionAction = useCallback((action: SelectionActionId, context: SelectionContext) => {
    if (!allowWorkspaceNavigation()) return;
    setAgentExternalRequest({
      id: `selection-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: buildSelectionAgentPrompt(action, context),
    });
    setIsAgentOpen(true);
  }, [allowWorkspaceNavigation]);
  const handleSceneRunComplete = ({ spec, run }: { spec: SceneSpec; run: SceneRunState }) => {
    const sceneCompleted = run.completionOutcome ? run.completionOutcome === 'completed' : run.status === 'success';
    const sceneOutcomeLabel = sceneCompleted ? '目标已完成' : run.completionOutcome === 'stopped' ? '用户结束会话'
      : run.completionOutcome === 'limit-reached' ? '达到回合上限，未判定目标完成' : '本局未完成';
    const endedAt = run.endedAt || new Date().toISOString();
    const durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(run.startedAt)) / 1000));
    const evidence = extractSceneEvidence({ episodeId: run.runId, observedAt: endedAt, spec, run });
    const metricSummary = run.metrics.map((metric) => {
      const definition = spec.metrics.find((item) => item.id === metric.metricId);
      return `${definition?.name || metric.metricId}=${String(metric.value)}`;
    }).join('；');
    const sampleChars = run.messages
      .filter((message) => message.speakerType === 'user')
      .reduce((sum, message) => sum + message.content.trim().length, 0)
      + (run.canvas?.nodes || []).reduce((sum, node) => sum + (node.data.latex?.trim().length || 0), 0);
    saveLearningEpisode({
      id: run.runId,
      type: 'scene',
      status: 'completed',
      title: `场景：${spec.meta.name}`,
      startedAt: run.startedAt,
      endedAt,
      durationSeconds,
      goal: spec.meta.goal,
      summary: `${sceneOutcomeLabel}：${run.endReason || '未提供结束原因'}${metricSummary ? `；${metricSummary}` : ''}`,
      score: run.finalScore,
      rating: run.completionOutcome || run.status,
      knowledgePoints: spec.meta.knowledgePoints,
      evidenceSnippets: evidence.evidenceSnippets,
      profileSignals: evidence.profileSignals,
      createdAt: endedAt,
      updatedAt: endedAt,
    }).then(() => ingestProfileSignals({
      episodeId: run.runId,
      signals: evidence.profileSignals,
      sampleChars,
    })).catch(() => {});
    const scopeProject = resolveNoteByTitleOrAlias(
      spec.meta.subject,
      notesRef.current.filter((note) => note.noteType === 'project'),
    );
    updateWorkflowHandoff(buildSceneHandoff({ spec, run, scopeProjectId: scopeProject?.id }));
    recordAgentWorkspaceEvent({
      id: `scene:${run.runId}`, kind: 'scene-completed', occurredAt: endedAt,
      noteId: scopeProject?.id, title: spec.meta.name, status: run.completionOutcome || run.status, score: run.finalScore,
      summary: `${sceneOutcomeLabel}：${run.endReason || '未提供结束原因'}${metricSummary ? `；${metricSummary}` : ''}`,
    });
  };
  const handleEnterFlowMode = (nid: string, rim: number, binding?: LearningTaskBinding) => { if (!allowWorkspaceNavigation()) return; const n = notes.find(n => n.id === nid); if (!n) return; flowTaskBindingRef.current = getLearningCompletionTarget(notesRef.current, binding || { noteId: nid })?.binding || null; setFlowCompletionPrompt(null); flowEpisodeIdRef.current = null; setFlowTargetNote(n); setFlowInitialResource(null); setFlowReviewInterval(rim); setFlowSpeakingContent(""); setIsFlowAnalysisOpen(false); setCurrentView("flow"); };
  const handleContinueHomeProject = (project: HomeFocusProject) => {
    if (!allowWorkspaceNavigation()) return;
    const action = resolveHomeContinueAction(notesRef.current, project);
    if (action.kind === 'plan') {
      setPlanWorkspaceFocusId(action.rootId);
      setCurrentView('timeline');
      return;
    }
    const note = notesRef.current.find((candidate) => candidate.id === action.noteId);
    if (!note) return;
    if (action.kind === 'flow') {
      handleEnterFlowMode(note.id, settings.flowSettings.reviewIntervalMinutes, action.binding);
    } else if (action.kind === 'review') {
      handleEnterBubbleMode({ scope: note.noteType === 'project' ? 'project' : 'knowledge', strategy: 'smart', noteTitle: note.title });
    } else {
      const knowledgePoints = note.noteType === 'project' ? collectKnowledgePoints(note.id, notesRef.current) : [note.title];
      handleEnterScene({ source: 'build', subject: note.title, knowledgePoints, extraHints: `本次计划事项：${action.text}`, taskBinding: action.binding });
    }
  };

  const handleAgentOpenResource = (resource: ResourceItem) => {
    if (!allowWorkspaceNavigation()) return;
    const taskText = String(resource.taskText || '').trim();
    const target = notesRef.current.find((note) => note.noteType === 'project' && taskText && note.content.includes(taskText))
      || notesRef.current.find((note) => note.id === resourceDraftSessionRef.current?.scopeProjectId)
      || notesRef.current.find((note) => note.noteType === 'project');
    if (!target) throw new Error('没有可承载心流学习的项目笔记');
    flowTaskBindingRef.current = getProjectCompletionTarget(notesRef.current, target.id)?.binding || null;
    setFlowCompletionPrompt(null);
    flowEpisodeIdRef.current = null;
    setFlowTargetNote(target);
    setFlowInitialResource(resource);
    setFlowReviewInterval(20);
    setFlowSpeakingContent('');
    setIsFlowAnalysisOpen(false);
    setCurrentView('flow');
    setIsAgentOpen(false);
  };

  const handleAgentDownloadResource = async (resource: ResourceItem): Promise<boolean> => {
    if (!resource.browserSessionId || !resource.candidateId) throw new Error('资源候选缺少有效的浏览器会话');
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.download) throw new Error('当前环境不支持浏览器资源下载');
    const result = await browser.download({
      sessionId: resource.browserSessionId,
      candidateId: resource.candidateId,
    });
    if (!result.ok && !result.canceled) throw new Error(result.error || '下载入库失败');
    return result.ok;
  };

  const handleAgentScanResourcePage = async (resource: ResourceItem): Promise<number> => {
    if (!resource.browserSessionId) throw new Error('资源候选缺少有效的浏览器会话');
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.scan) throw new Error('当前环境不支持扫描浏览器当前页');
    const result = await browser.scan(resource.browserSessionId) as { resources?: ResourceItem[] };
    const resources = Array.isArray(result.resources) ? result.resources : [];
    const session = resourceDraftSessionRef.current;
    if (!session) throw new Error('当前资源草案已经结束');
    const next = registerDiscoveredResources(notesRef.current, session, resources, {
      taskText: String(resource.taskText || ''),
      knowledgeTitles: resource.knowledgeTitles || [],
    });
    updateResourceDraftSession(next);
    return resources.length;
  };

  const handleAgentAuthorizeResource = async (resource: ResourceItem): Promise<boolean> => {
    if (!resource.browserSessionId || !resource.candidateId) throw new Error('资源候选缺少有效的浏览器会话');
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.authorize) throw new Error('当前环境不支持隔离登录容器');
    const result = await browser.authorize({
      sessionId: resource.browserSessionId,
      candidateId: resource.candidateId,
    }) as { canceled?: boolean; resource?: ResourceItem };
    if (result.canceled || !result.resource) return false;
    const session = resourceDraftSessionRef.current;
    if (!session) throw new Error('当前资源草案已经结束');
    const next = registerDiscoveredResources(notesRef.current, session, [result.resource], {
      taskText: String(resource.taskText || ''),
      knowledgeTitles: resource.knowledgeTitles || [],
    });
    updateResourceDraftSession(next);
    return true;
  };
  const handleAgentResourceDecision = async (
    resource: ResourceItem,
    decision: 'selected' | 'rejected',
  ): Promise<void> => {
    const session = resourceDraftSessionRef.current;
    if (!session) throw new Error('当前资源草案已经结束');
    const next = setResourceCandidateDecision(notesRef.current, session, resource, decision);
    updateResourceDraftSession(next);
    await recordResourceDiscoveryPreference(session.scopeProjectId, resource, decision);
    setResourceActivity({
      id: `${Date.now()}-${resource.candidateId || resource.url}`,
      text: decision === 'selected'
        ? `已将“${resource.title}”加入备选并记录偏好。`
        : `已记录对“${resource.title}”不感兴趣，整理时会排除它。`,
    });
  };

  type ResourceSearchInput = {
    projectTitle: string;
    taskText: string;
    knowledgeTitles: string[];
  };
  type ResourceSearchOutcome = {
    mode: 'review' | 'auto';
    status: 'workbench-opened' | 'written' | 'no-match';
    message: string;
    resources: ResourceItem[];
    markdown: string;
  };

  /** Agent Skill 与项目笔记按钮共用的唯一资源搜索执行链。 */
  const runResourceSearch = async (
    session: AgentResourceDraftSession,
    input: ResourceSearchInput,
    retainSessionAfterAutoWrite: boolean,
    signal?: AbortSignal,
  ): Promise<ResourceSearchOutcome> => {
    signal?.throwIfAborted();
    const target = validateResourceSearchTarget(notesRef.current, session, input);
    const browser = (window as any).electronAPI?.resourceBrowser;
    if (!browser?.search) throw new Error('当前环境不支持隔离浏览器资源搜索');
    const collectionMode = settingsRef.current.resourceCollectionMode;
    const resourceState = getResourceStateSnapshot();
    const resourcePlan = buildAutomaticResourcePlan(resourceState, settingsRef.current.resourceFormatPreference, notesRef.current);
    const automaticTargets = resourcePlan.targets;
    const semanticModel: ResourceSemanticModel = async (request, modelSignal) => {
      const response = await callLLM({ providerId: '', model: '', workflow: 'agent-resource-curation', userInput: request.userInput,
        systemPromptOverride: request.systemPrompt, maxTokensOverride: request.maxTokens, temperatureOverride: 0.2,
        skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled', outputSchema: { type: 'json_object' } }, { signal: modelSignal });
      return response.parsedJson || response.content;
    };
    if (collectionMode === 'auto') setResourceActivity({ id: `${Date.now()}-resource-understanding`, text: '资源 Agent 正在理解项目目标、知识点与偏好，设计检索策略…' });
    const semanticPlan = collectionMode === 'auto' ? await planResourceSearch({ projectTitle: target.project.title,
      rootProjectTitle: target.rootProjectTitle, taskText: target.taskText, knowledgeTitles: target.knowledgeTitles, targets: automaticTargets }, semanticModel, signal) : undefined;
    if (collectionMode === 'auto') setResourceActivity({ id: `${Date.now()}-resource-mix`, text: `按偏好查找：${resourcePlan.summary}；可下载资料将自动入库。` });
    const result = await browser.search({
      projectTitle: target.project.title,
      rootProjectTitle: target.rootProjectTitle,
      taskText: target.taskText,
      knowledgeTitles: target.knowledgeTitles,
      maxResults: 12,
      automaticTargets: collectionMode === 'auto' ? automaticTargets : undefined,
      trustedResourceHosts: collectionMode === 'auto' ? [...trustedResourceHosts(resourceState, notesRef.current)] : undefined,
      draftSessionId: session.id,
      interactionMode: collectionMode,
      semanticPlan,
      source: session.origin || 'agent',
    }) as { sessionId?: string; markdown?: string; resources?: ResourceItem[] };
    // Search can finish after Stop; it must not turn into an automatic write then.
    signal?.throwIfAborted();
    if (settingsRef.current.resourceCollectionMode !== collectionMode) throw new Error('资源收录模式已变化，请重新开始');
    const candidates = Array.isArray(result.resources) ? result.resources : [];
    if (semanticPlan) setResourceActivity({ id: `${Date.now()}-resource-review`, text: `已找到 ${candidates.length} 个候选，正在按学习目标审核语义相关性…` });
    const reviewed = semanticPlan ? await reviewResourceCandidates(semanticPlan, candidates, semanticModel, signal) : undefined;
    const resources = reviewed?.resources || candidates;

    if (collectionMode === 'review') {
      const nextSession = registerResourceBrowserSession(session, String(result.sessionId || ''));
      updateResourceDraftSession(nextSession);
      const message = `资源工作台已打开并识别 ${resources.length} 个候选；确认后会直接写入“${target.project.title}”。`;
      return {
        mode: 'review',
        status: 'workbench-opened',
        message,
        resources: target.project.resources || [],
        markdown: `${message} 无需在 Agent 中再次暂存或提交。`,
      };
    }

    const selection = selectResourcesForAutomaticCollection(resources, {
      taskText: target.taskText,
      projectTitle: target.project.title,
      knowledgeTitles: target.knowledgeTitles,
      existingUrls: (target.project.resources || []).flatMap(resource => [resource.url, ...(resource.sourceUrl ? [resource.sourceUrl] : [])]),
      maxResults: 2,
      state: resourceState,
      notes: notesRef.current,
      targets: automaticTargets,
    });
    if (selection.selected.length === 0) {
      if (!retainSessionAfterAutoWrite && resourceDraftSessionRef.current?.id === session.id) {
        updateResourceDraftSession(null);
      }
      const detail = summarizeAutomaticResourceSkips(selection.skipped);
      const message = `后台检索了 ${candidates.length} 个候选，语义审核保留 ${resources.length} 个，本次未写入。${detail ? `原因：${detail}。` : '没有取得适合当前目标的可收录资源。'}`;
      setResourceActivity({ id: `${Date.now()}-resource-auto-empty`, text: message });
      return {
        mode: 'auto',
        status: 'no-match',
        message,
        resources: target.project.resources || [],
        markdown: `${message} 如需人工查看候选，可在设置中切换为“筛选确认后收录”。`,
      };
    }

    const now = new Date().toISOString();
    await persistPlanMutation(current => {
      signal?.throwIfAborted();
      if (settingsRef.current.resourceCollectionMode !== 'auto') throw new Error('自动收录已关闭');
      return applyTrustedAutoResources(current, session, selection.selected, now, getResourceStateSnapshot());
    });

    const downloads = await resourceDownloadClientRef.current!.collectAutomatically({
      projectId: target.project.id, resources: selection.selected, signal,
      onProgress: text => setResourceActivity({ id: `${Date.now()}-resource-auto-downloading`, text }),
    });
    // Download binding is another acknowledged delta save. Do not refresh from the earlier URL-only snapshot.
    const finalNotes = notesRef.current;

    if (retainSessionAfterAutoWrite && resourceDraftSessionRef.current?.id === session.id) {
      const refreshedSession = createResourceDraftSession(
        finalNotes,
        {
          scopeProjectTitle: session.scopeProjectTitle,
          origin: session.origin || 'agent',
        },
        now,
        session.id,
      );
      updateResourceDraftSession(refreshedSession);
    } else if (resourceDraftSessionRef.current?.id === session.id) {
      updateResourceDraftSession(null);
    }

    const updatedProject = finalNotes.find((note) => note.id === target.project.id);
    const unknownPricingCount = selection.selected.filter(resource => resource.accessType === 'public' && resource.isFree !== true).length;
    const restrictedCount = selection.selected.filter(resource => resource.accessType === 'authenticated').length;
    const downloadMessage = `${downloads.bound ? ` 已自动入库并绑定 ${downloads.bound} 个附件（新下载 ${downloads.downloaded} 个、复用 ${downloads.reused} 个）；支持的格式在后台解析和索引。` : ''}${downloads.failed ? ` ${downloads.failed} 个附件未完成下载或绑定，原链接保留。` : ''}${downloads.stopped ? ' 自动下载已停止。' : ''}${downloads.errors.length ? ` ${[...new Set(downloads.errors)].join('；')}` : ''}`;
    const missing = Object.entries(resourcePlan.targets).flatMap(([category, count]) => {
      const actual = selection.selected.filter(resource => resource.searchCategory === category).length;
      return actual < count ? [`${RESOURCE_CATEGORY_LABELS[category as keyof typeof RESOURCE_CATEGORY_LABELS]}缺 ${count - actual}`] : [];
    });
    const downloadFallback = downloads.bound < resourcePlan.downloadTarget && !downloads.stopped
      ? ` 下载资料未达到 ${resourcePlan.downloadTarget} 项，已降级保留可用在线链接，不用无关资源补齐。` : '';
    const message = `语义审核保留 ${resources.length}/${candidates.length} 个候选；已自动收录 ${selection.selected.length} 个资源到“${target.project.title}”：${summarizeResourceMix(selection.selected)}。${missing.length ? `未找到足够合格候选：${missing.join('、')}。` : ''}${restrictedCount ? `其中 ${restrictedCount} 个来自认可站点，可能需要登录或验证，仅保留链接。` : ''}${unknownPricingCount ? `另有 ${unknownPricingCount} 个公开链接免费性未确认。` : ''}另按配额或准入规则跳过 ${selection.skipped.length} 个候选。${downloadMessage}${downloadFallback}`;
    setResourceActivity({ id: `${Date.now()}-resource-auto-written`, text: message });
    return {
      mode: 'auto',
      status: 'written',
      message,
      resources: updatedProject?.resources || [],
      markdown: `${message} 已写入资源和入库附件无需再暂存、提交、重复下载或请求确认。`,
    };
  };

  const handleProjectResourceRecommendation = async (note: NoteItem): Promise<ResourceSearchOutcome> => {
    if (note.noteType !== 'project') throw new Error('统一资源统筹入口目前仅适用于项目笔记');
    if (agentNewPlanDraft || agentPlanEditorQueue.length > 0) {
      throw new Error('请先在计划编辑器中确认或放弃当前 Agent 草案');
    }
    if (planDraftSessionRef.current) throw new Error('请先提交或放弃当前计划草案');
    if (resourceDraftSessionRef.current) throw new Error('已有资源工作台或 Agent 资源统筹正在进行，请先完成或关闭它');
    const knowledgeTitles = collectKnowledgePoints(note.id, notesRef.current).slice(0, 8);
    const topics = knowledgeTitles.length > 0 ? knowledgeTitles : [note.title];
    const taskText = `围绕“${note.title}”整理项目学习资源`;
    const session = createResourceDraftSession(notesRef.current, {
      selectedProjectId: note.id,
      origin: 'note-editor',
      directProjectTarget: { taskText, knowledgeTitles: topics },
    });
    updateResourceDraftSession(session);
    try {
      return await runResourceSearch(session, {
        projectTitle: note.title,
        taskText,
        knowledgeTitles: topics,
      }, false);
    } catch (error) {
      closeDraftBrowserSessions(session);
      if (resourceDraftSessionRef.current?.id === session.id) updateResourceDraftSession(null);
      throw error;
    }
  };
  const progressiveReviewWorkerRef=useRef<ProgressiveReviewWorker|null>(null);
  useEffect(()=>{
    if(!notesHydrated||!(window as any).electronAPI?.progressiveLearning)return;
    const worker=new ProgressiveReviewWorker({readNotes:()=>notesRef.current,
      persist:async prepare=>{await persistPlanMutation(current=>({notes:prepare(current)}),undefined,false);},
      onError:error=>console.warn('[progressive-review] 已保存本次记录，可在学习记录重试:',error)}).start();
    progressiveReviewWorkerRef.current=worker;
    const off=(window as any).electronAPI?.progressiveLearning?.onKnowledge?.((created:NoteItem[])=>{for(const note of created)if(note.parentId)worker.kick(note.parentId);});
    return ()=>{off?.();worker.stop();if(progressiveReviewWorkerRef.current===worker)progressiveReviewWorkerRef.current=null;};
  },[notesHydrated]);
  const handleExitFlowMode = async (session: FlowSession) => {
    // Cancel before joining the write queue: the reading debounce must not add
    // another full save while this exit is waiting behind accepted work.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (session.learningMode === 'progressive') {
      const course=await loadProgressiveCourse(session.noteId);
      if(!course||course.id!==session.progressiveCourseId)throw new Error('课程已变化，请重新进入后保存');
      // The controller has already durably flushed the exact draft and answer submissions.
      await progressiveReviewCommand({op:'review-exit',projectNoteId:session.noteId,environmentId:course.environmentId,
        courseId:course.id,exitId:session.id,analyze:session.analyze!==false,expectedProgressVersion:course.progress.version});
      if (session.questions !== undefined) await persistLearningMutation(session.noteId, note =>
        JSON.stringify(note.questions || []) === JSON.stringify(session.questions)
          ? note : { ...note, questions: session.questions });
      if (pendingNotesRef.current) await flushSave(pendingNotesRef.current);
      await confirmNoteNavigation(requestNoteNavigation, () => {
        if (!allowWorkspaceNavigation()) throw new Error('请先处理当前未保存的编辑，再退出心流');
        setActiveNoteId(session.noteId);setCurrentView('editor');
      });
      await progressiveReviewCommand({op:'review-activate',projectNoteId:session.noteId,environmentId:course.environmentId,courseId:course.id,exitId:session.id});
      setFlowCompletionPrompt(null);
      progressiveReviewWorkerRef.current?.kick(session.noteId);
      const minutes = Math.round((session.durationSeconds || 0) / 60);
      if (minutes > 0) recordStudyDuration(minutes).catch(() => {});
      return;
    }
    let project = notesRef.current.find((note) => note.id === session.noteId);
    const seen = new Set<string>();
    while (project?.parentId && !seen.has(project.id)) {
      seen.add(project.id);
      const parent = notesRef.current.find((note) => note.id === project!.parentId && note.noteType === 'project');
      if (!parent) break;
      project = parent;
    }
    session = { ...session, rootProjectId: project?.id || session.noteId };
    const { analysisText, needsAnalysis } = flowReviewAdmission(session);
    // 先持久化本次输入；失败留在心流页，教材及旧记录不受影响。
    await persistLearningMutation(session.noteId, (note) => saveFlowReviewRecord(note, session,
      needsAnalysis ? 'pending_analysis' : 'text_only', !needsAnalysis));
    // Empty reviews stay empty, but the final reading position must still be
    // durable. A real review already saved both together, so this is a no-op.
    if (pendingNotesRef.current) await flushSave(pendingNotesRef.current);
    const savedRestatementNote = notesRef.current.find(note => note.id === session.noteId);
    if (savedRestatementNote) await captureRestatementCognition(savedRestatementNote, session.id);
    // A buffered viewport can require another save at the leave boundary.
    // Cancellation must reject onExit so FlowMode releases its exit guard.
    // Account for the session and start analysis only after leaving commits.
    await confirmNoteNavigation(requestNoteNavigation, () => {
      if (!allowWorkspaceNavigation()) throw new Error('请先处理当前未保存的编辑，再退出心流');
      setActiveNoteId(session.noteId);
      setCurrentView('editor');
    });
    const completionTask = getLearningCompletionTarget(notesRef.current, flowTaskBindingRef.current || undefined);
    setFlowCompletionPrompt(completionTask ? { sessionId: session.id, binding: completionTask.binding } : null);
    flowSessionRef.current = session;
    setFlowReviewSession(session);
    // 记录学习时长（心流模式）：把 durationSeconds 转分钟写入周报（内部按 ≥20 分钟判定活跃天数）
    const flowMinutes = Math.round((session.durationSeconds || 0) / 60);
    if (flowMinutes > 0) recordStudyDuration(flowMinutes).catch(() => {});
    const exited = notesRef.current.find(n => n.id === session.noteId);
    setFlowSummaryText(session.summary || exited?.flowSummary || "");
    setFlowQuestions(exited?.questions || []);
    // 明确的本次会话文本，不再通过教材正文前缀猜测增量。
    flowEpisodeIdRef.current = needsAnalysis ? session.id : null;
    saveLearningEpisode({
      id: session.id,
      type: 'flow',
      status: needsAnalysis ? 'pending_analysis' : 'completed',
      title: `心流学习：${session.noteTitle}`,
      noteId: session.noteId,
      rootProjectId: session.rootProjectId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds: session.durationSeconds,
      summary: session.summary,
      unresolvedQuestions: (exited?.questions || []).filter((q) => !q.answer).map((q) => q.question),
      createdAt: session.endedAt,
      updatedAt: session.endedAt,
    }).catch(() => {});
    recordAgentWorkspaceEvent({
      id: `flow:${session.id}`, kind: 'flow-exited', occurredAt: session.endedAt,
      noteId: session.noteId, title: session.noteTitle,
      status: needsAnalysis ? 'pending_analysis' : 'completed',
      summary: session.summary || `心流学习已结束，本次持续 ${Math.max(0, Math.round(session.durationSeconds / 60))} 分钟。`,
    });
    // 分析开关关闭：只保存文本，不进入知识点识别与 AI 分析
    if (!needsAnalysis) {
      return;
    }
    if (analysisText) {
      setFlowSpeakingContent(analysisText);
      setIsSelectionOpen(true);
      // 阶段一：识别知识点，完成后由用户在选择窗口确认
      void knowledgeDiscovery.start(analysisText, session.id);
    }
  };
  const handleConfirmKnowledgePoints = async (selected: KnowledgePointCandidate[]) => {
    const reviewSession = flowSessionRef.current;
    if (!reviewSession) return;
    const isCurrentSession = () => flowSessionRef.current?.id === reviewSession.id;
    const finishEpisode = (status: 'completed' | 'failed', error?: string) => {
      void patchLearningEpisode(reviewSession.id, { status, error }).catch(() => {});
      if (flowEpisodeIdRef.current === reviewSession.id) flowEpisodeIdRef.current = null;
    };
    setIsSelectionOpen(false);
    if (selected.length === 0) {
      await finishStoredFlowReview(reviewSession, 'text_only').catch(reportLearningSaveError);
      finishEpisode('completed');
      if (isCurrentSession()) setIsFlowAnalysisOpen(false);
      return;
    }
    // 打开全屏等待弹窗：阶段② 掌握度评分进行中
    setAnalysisOffline(false);
    setAnalysisError('');
    setAnalysisPhase('mastery');
    setAnalysisProgressOpen(true);
    try {
      const stored = notesRef.current.find(note => note.id === reviewSession.noteId)
        ?.learningReviewRecords?.find(record => record.sessionId === reviewSession.id)?.masteryAssessment;
      const batch = stored || await evaluateFlowKnowledgeMastery({
        sessionId: reviewSession.id, projectNoteId: reviewSession.noteId,
        rawText: reviewSession.incrementalText || reviewSession.restateText || '',
        observedAt: reviewSession.endedAt, candidates: selected, notes: notesRef.current,
      }, { isCurrent: isCurrentSession });
      if (!isCurrentSession()) return;
      // The receipt and all independent layer states are persisted together against the latest snapshot.
      // Reopening/retrying this session reuses its receipt, never adds a second mastery sample.
      const outcome = await persistPlanMutation(current => {
        if (!isCurrentSession()) throw new Error('本次复盘已停止');
        return prepareFlowMasteryOutcome(current, batch);
      });
      if (!isCurrentSession()) return;
      setKnowledgeResults(outcome.results);
      // 掌握度评分完成，进入五路画像证据分析阶段（弹窗持续展示）
      setAnalysisPhase('evidence');
      setIsFlowAnalysisOpen(true);
    } catch (e) {
      if (!isCurrentSession()) return;
      await finishStoredFlowReview(reviewSession, 'analysis_failed', e instanceof Error ? e.message : '知识点评分失败').catch(reportLearningSaveError);
      finishEpisode('failed', e instanceof Error ? e.message : '知识点评分失败');
      if (!isCurrentSession()) return;
      console.warn('[KP] 并行评分失败:', e);
      setIsFlowAnalysisOpen(false);
      setAnalysisError(`知识点分析或保存未完成：${e instanceof Error ? e.message : '请稍后重试'}。复盘原文已保留。`);
    }
  };
  const handleEnterReview = (nid: string, nt: string, q: string, ctx: string) => { if (!allowWorkspaceNavigation()) return; reviewActivationRef.current++; reviewNoteIdRef.current = nid; setReviewReturnView("bubble"); setReviewNoteId(nid); setReviewNoteTitle(nt); setReviewQuestion(q); setReviewContext(ctx); setCurrentView("review"); };
  const handleEnterReviewFromBubble = handleEnterReview;
  const handleEnterReviewFromGraph = (note: NoteItem) => {
    if (!allowWorkspaceNavigation()) return;
    reviewActivationRef.current++;
    reviewNoteIdRef.current = note.id;
    setReviewReturnView("graph");
    setReviewNoteId(note.id);
    setReviewNoteTitle(note.title);
    setReviewQuestion(buildReviewOpeningQuestion(note.title, note.noteType === 'project'));
    setReviewContext(note.noteType === 'project'
      ? buildProjectReviewKnowledgeContext(note, notes)
      : `知识点：${note.title}\n${note.content}`);
    setCurrentView("review");
  };
  const handleExitReview = async (analysis: ReviewAnalysis | null, segmentMastery?: KnowledgePointMasteryResult[], episode?: ReviewEpisodeCapture) => {
    if (currentViewRef.current !== 'review' || reviewActivationRef.current !== reviewActivation) {
      throw new Error('该复习会话已离开，请在当前会话中保存。');
    }
    const noteId = reviewNoteId;
    const noteTitle = reviewNoteTitle;
    const sessionKey = episode?.id || `legacy-review-${noteId}`;
    if (!reviewExitGuard.updateStatus('saving', sessionKey)) throw new Error('另一个复习会话正在保存，请勿重复退出。');
    let progress = reviewExitProgressRef.current.get(sessionKey);
    if (!progress) {
      progress = {};
      reviewExitProgressRef.current.set(sessionKey, progress);
    }
    const outcome = await commitReviewExitWrite(progress, {
      persistNotes: () => persistPlanMutation((current) => prepareReviewExitOutcome(current, {
        noteId, noteTitle, analysis, segmentMastery, episode,
      })),
      persistEpisode: async (savedOutcome) => {
        if (!episode) return;
        const evidence = extractReviewEvidence({
          episodeId: episode.id, observedAt: episode.endedAt, messages: episode.messages,
          analysis, knowledgePoints: savedOutcome.knowledgePoints, masteryEvaluations: savedOutcome.masteryEvaluations,
        });
        const score = analysis
          ? (analysis.accuracyScore + analysis.completenessScore + analysis.logicScore + analysis.relevanceScore) / 4
          : undefined;
        await saveLearningEpisode({
          id: episode.id, type: 'review', status: 'completed', title: `复习：${noteTitle}`, noteId,
          startedAt: episode.startedAt, endedAt: episode.endedAt,
          durationSeconds: Math.max(0, Math.round((Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) / 1000)),
          goal: episode.questionText, summary: episode.reviewFeedback?.feedback || analysis?.feedback,
          recommendation: episode.reviewFeedback?.suggestion || analysis?.suggestion,
          score, rating: analysis?.overallRating, knowledgePoints: savedOutcome.knowledgePoints,
          unresolvedQuestions: analysis?.missingKnowledge || [],
          evidenceSnippets: evidence.evidenceSnippets, profileSignals: evidence.profileSignals,
          learningChanges: savedOutcome.learningChanges,
          ...(episode.draftAnswer ? { draftAnswer: episode.draftAnswer } : {}),
          ...(episode.comparisonSummary ? { comparisonSummary: episode.comparisonSummary } : {}),
          createdAt: episode.endedAt, updatedAt: episode.endedAt,
        });
        await clearReviewDraftsForNote(noteId, episode.consumedDraftIds || []);
      },
    }).catch((error) => { reviewExitGuard.updateStatus('failed', sessionKey); throw error; });
    // A late callback can never close a different page or a newer review activation.
    if (currentViewRef.current !== 'review' || reviewActivationRef.current !== reviewActivation) {
      reviewExitGuard.updateStatus('idle', sessionKey);
      reviewExitProgressRef.current.delete(sessionKey);
      return;
    }
    // A record-write retry must not repeat mastery increments or completion side effects.
    if (!progress.notified) {
    progress.notified = true;
    if (outcome.masteredCount) void recordNewMastered(outcome.masteredCount).catch(() => {});
    if (episode) {
      const evidence = extractReviewEvidence({
        episodeId: episode.id, observedAt: episode.endedAt, messages: episode.messages,
        analysis, knowledgePoints: outcome.knowledgePoints, masteryEvaluations: outcome.masteryEvaluations,
      });
      void ingestProfileSignals({
        episodeId: episode.id, signals: evidence.profileSignals,
        sampleChars: episode.messages.filter((message) => message.role === 'user')
          .reduce((sum, message) => sum + message.content.length, 0),
      }).catch((error) => console.warn('[review] profile evidence save failed:', error));
    }
    if (analysis || episode?.reviewFeedback?.status === 'available') updateWorkflowHandoff(buildReviewHandoff({
      noteId, noteTitle, episodeId: episode?.id, knowledgePointTitles: outcome.knowledgePoints, analysis, feedback: episode?.reviewFeedback,
    }));
    recordAgentWorkspaceEvent({
      id: `review:${sessionKey}`, kind: 'review-completed', occurredAt: episode?.endedAt || new Date().toISOString(),
      noteId, title: noteTitle, status: analysis || episode?.reviewFeedback?.status === 'available' ? 'completed' : 'completed_without_analysis',
      ...(analysis ? { score: (analysis.accuracyScore + analysis.completenessScore + analysis.logicScore + analysis.relevanceScore) / 4 } : {}),
      summary: episode?.reviewFeedback?.feedback || analysis?.feedback || (outcome.knowledgePoints.length
        ? `复习已结束，本次涉及：${outcome.knowledgePoints.join('、')}。`
        : '复习已结束，本次没有可用分析结果。'),
    });
    }
    if (!reviewExitGuard.updateStatus('idle', sessionKey)) return;
    setCurrentView(reviewReturnView);
    reviewExitProgressRef.current.delete(sessionKey);
  };

  // ===== 论证编辑闭环（独立窗口调度） =====
  // 打开论证编辑器独立窗口
  const openArgumentEditor = (doc: ArgDoc, noteId: string | null, entryMode: 'new' | 'edit') => {
    (window as any).electronAPI?.argument?.open({ doc, noteId, entryMode });
  };

  // 入口一（全新分析）：真实 provider 返回后，把原始复述评分与论证结构合并到统一结果页。
  const handleArgumentReady = (doc: ArgDoc | undefined, report: FlowAnalysisReport, reviewSession: FlowSession | null) => {
    if (!doc) return;
    if (!reviewSession || flowSessionRef.current?.id !== reviewSession.id) return;
    const sourceNoteId = reviewSession.noteId;
    const sourceNote = notesRef.current.find((note) => note.id === sourceNoteId);
    // Save the existing analysis graph as a draft, then sync the same private cognition record.
    // Publication, formal scoring and the user's current navigation are not changed.
    void saveArgumentDoc(doc, sourceNoteId, 'new', reviewSession.id, false, 'draft',
      flowReviewAdmission(reviewSession).restatement).catch(reportLearningSaveError);
    setFlowResult({
      doc,
      report,
      noteId: sourceNoteId,
      noteTitle: sourceNote?.title || doc.title || '本次复盘',
      speakingContent: reviewSession.incrementalText || reviewSession.restateText || '',
      createdAt: new Date().toISOString(),
      entryMode: 'new',
      reviewSessionId: reviewSession.id,
    });
    setIsFlowAnalysisOpen(false);
    setAnalysisProgressOpen(false);
  };

  const handleFlowAnalysisDone = (result: { report?: FlowAnalysisReport; profileInsight?: ProfileInsight;
    analysisV2?: FlowReviewAnalysisResultV2; serviceError?: string; error?: string }, reviewSession: FlowSession | null) => {
    const episodeId = reviewSession?.id;
    if (!episodeId) return;
    if (flowSessionRef.current?.id !== episodeId) return;
    const report = result.report;
    if (!report) {
      setAnalysisError('复盘分析未完成。学习内容已保存，可以返回笔记查看。');
      setIsFlowAnalysisOpen(false);
    } else {
      setAnalysisProgressOpen(false);
    }
    if (!report || result.error || result.serviceError) {
      void finishStoredFlowReview(reviewSession, 'analysis_failed', result.error || result.serviceError || '复盘分析失败').catch(reportLearningSaveError);
    } else {
      // 复盘块只保留简短摘要；画像依据下方的独立证据门直接更新，不依赖该块存在。
      void finishStoredFlowReview(reviewSession, 'analyzed', undefined,
        result.analysisV2?.reviewBlockSummary || report.summary).catch(reportLearningSaveError);
    }
    const statistics = report && result.analysisV2 && !result.error && !result.serviceError
      ? buildFlowStatisticsSubmission(result.analysisV2, episodeId, reviewSession?.incrementalText || reviewSession?.restateText || '') : undefined;
    const evidence = report ? extractFlowEvidence({
      episodeId,
      observedAt: result.analysisV2?.observedAt || new Date().toISOString(),
      report,
      profileInsight: result.profileInsight,
      analysisV2: result.analysisV2,
    }) : undefined;
    patchLearningEpisode(episodeId, {
      status: report ? 'completed' : 'failed',
      summary: report?.summary || reviewSession?.summary,
      recommendation: report?.recommendation,
      score: report?.clarityScore,
      knowledgePoints: knowledgeResults.map((item) => item.name),
      unresolvedQuestions: flowQuestions.filter((q) => !q.answer).map((q) => q.question),
      evidenceSnippets: evidence?.evidenceSnippets,
      profileSignals: evidence?.profileSignals,
      flowStatistics: statistics,
      error: result.error || result.serviceError,
    }).then(async () => {
      if (evidence) await ingestProfileSignals({ episodeId, signals: evidence.profileSignals,
        sampleChars: (reviewSession?.incrementalText || reviewSession?.restateText || '').length });
      if (statistics) await saveFlowStatistics(statistics);
    }).catch(error => console.warn('[flow] 复盘证据或统计写入未完成；已保存统计字段可在启动时恢复', error));
    if (flowEpisodeIdRef.current === episodeId) flowEpisodeIdRef.current = null;
  };

  // 论证图块数据解析器（供正文内嵌只读结构图）
  const getArgumentDoc = (docId: string) => {
    for (const n of notes) {
      const found = (n.argumentDocs || []).find((d) => d.doc_id === docId);
      if (found) return found;
    }
    return undefined;
  };

  // 入口二（编辑旧图）：正文 <ArgumentBlock id="X"/> 点击
  const handleArgumentBlockEdit = (docId: string) => {
    const target = notesRef.current.find((n) => n.argumentDocs?.some((d) => d.doc_id === docId));
    const doc = target?.argumentDocs?.find((d) => d.doc_id === docId);
    if (!doc || !target) return;
    openArgumentEditor(doc, target.id, 'edit');
  };

  // 删除一张结构图（不含 confirm，供编辑器窗口回传复用）
  const performArgumentBlockDelete = async (docId: string) => {
    const target = notesRef.current.find((n) => n.argumentDocs?.some((d) => d.doc_id === docId));
    if (!target) return;
    await persistLearningMutation(target.id, latest => {
      const escapedId = docId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const content = latest.content.replace(new RegExp(`<ArgumentBlock\\s+id="${escapedId}"\\s*/>`, 'g'), '')
        .replace(/\n{3,}/g, '\n\n').trim();
      return detachReviewArgument({ ...latest, argumentDocs: (latest.argumentDocs || []).filter(doc => doc.doc_id !== docId),
        content, updatedAt: new Date().toISOString() }, docId);
    });
    const savedReviewNote = notesRef.current.find(note => note.id === target.id);
    if (savedReviewNote?.learningReviewRecords?.length) await captureRestatementCognition(savedReviewNote);
  };

  const requestArgumentAction = (kind: ArgumentActionRequest['kind'], docId: string) => {
    const target = notesRef.current.find((note) => note.argumentDocs?.some((doc) => doc.doc_id === docId));
    const graph = target?.argumentDocs?.find((doc) => doc.doc_id === docId);
    if (!target || !graph || (kind === 'withdraw' && !graph.rag?.publishedSnapshot)) return;
    setArgumentAction({ kind, docId, graphTitle: graph.title || '未命名论证结构', noteTitle: target.title || '未命名笔记' });
  };

  // 正文卡片 × 删除：先在页内冻结目标与影响范围，不使用系统弹窗。
  const handleArgumentBlockDelete = (docId: string) => {
    requestArgumentAction('delete', docId);
  };

  // 只撤回生产 RAG 快照，保留草稿、质量报告和结构图本身，便于修正后重新发布。
  const performArgumentRagWithdraw = (docId: string) => {
    const target = notesRef.current.find((note) => note.argumentDocs?.some((doc) => doc.doc_id === docId));
    const current = target?.argumentDocs?.find((doc) => doc.doc_id === docId);
    if (!target || !current?.rag?.publishedSnapshot) return;
    const withdrawnAt = new Date().toISOString();
    const argumentDocs = (target.argumentDocs || []).map((doc) => {
      if (doc.doc_id !== docId || !doc.rag?.publishedSnapshot) return doc;
      const snapshot = doc.rag.publishedSnapshot;
      return {
        ...doc,
        rag: {
          ...doc.rag,
          qualityAudit: appendArgumentQualityAudit(doc.rag.qualityAudit, {
            id: `withdrawn-${Date.now()}`,
            event: 'withdrawn',
            revisionHash: snapshot.revisionHash,
            at: withdrawnAt,
            deterministicScore: snapshot.assessment.score,
            semanticScore: snapshot.semanticAssessment?.score,
            effectiveAdmission: snapshot.effectiveAdmission || snapshot.assessment.admission,
            evidenceGrade: snapshot.evidenceAssessment?.grade || snapshot.assessment.evidenceGrade,
            model: snapshot.semanticAssessment?.model,
          }),
          publishedSnapshot: undefined,
        },
        updated_at: withdrawnAt,
      };
    });
    handleUpdateNote({ ...target, argumentDocs, updatedAt: new Date().toISOString() });
  };
  const handleArgumentRagWithdraw = (docId: string) => requestArgumentAction('withdraw', docId);
  const confirmArgumentAction = (request: ArgumentActionRequest) => {
    setArgumentAction(null);
    if (request.kind === 'delete') void performArgumentBlockDelete(request.docId).catch(reportLearningSaveError);
    else performArgumentRagWithdraw(request.docId);
  };

  // 保存（编辑器窗口回传）：入口一追加图 + 插入 block；入口二覆盖同 doc_id 的图
  const saveArgumentDoc = async (doc: ArgDoc, noteId: string | null, entryMode: 'new' | 'edit', reviewSessionId?: string,
    navigateAfterSave = true, publication: ArgumentPublicationChoice = 'draft', sourceRestatement?: string) => {
    if (!doc || !noteId) return false;
    const target = notesRef.current.find((n) => n.id === noteId);
    if (!target) return false;
    if (entryMode === 'edit' && !target.argumentDocs?.some((item) => item.doc_id === doc.doc_id)) return false;
    const existingReviewGraphId = reviewSessionId
      ? target.learningReviewRecords?.find((item) => item.sessionId === reviewSessionId)?.argumentDocIds[0] : undefined;
    if (existingReviewGraphId && existingReviewGraphId !== doc.doc_id) doc = { ...doc, doc_id: existingReviewGraphId };
    const prepared = prepareArgumentPublication(doc);
    const { assessment, revisionHash, semanticAssessment, semanticFresh, evidenceAssessment, effective, now } = prepared;
    if (publication === 'publish' && !prepared.canPublish) throw new Error('发布条件已变化，当前版本未写入。请重新检查质量报告后再选择保存方式。');
    const publish = publication === 'publish';
    const previousSnapshot = doc.rag?.publishedSnapshot;
    const qualityAudit = publish
      ? appendArgumentQualityAudit(doc.rag?.qualityAudit, {
          id: `published-${Date.now()}`,
          event: 'published',
          revisionHash,
          at: now,
          deterministicScore: assessment.score,
          semanticScore: semanticAssessment?.score,
          effectiveAdmission: effective.admission,
          evidenceGrade: evidenceAssessment.grade,
          model: semanticAssessment?.model,
        })
      : doc.rag?.qualityAudit;
    const rag = {
      sourceKind: 'user_graph' as const,
      draftAssessment: assessment,
      semanticAssessment,
      evidenceAssessment,
      issueDecisions: doc.rag?.issueDecisions,
      qualityAudit,
      publishedSnapshot: publish
        ? createPublishedSnapshot(doc, assessment, now, {
            semanticAssessment,
            evidenceAssessment,
            effectiveAdmission: effective.admission,
          })
        : previousSnapshot,
    };
    const stamped = { ...doc, rag, updated_at: now };
    // 原质量审核/确认保持不变；图与本次复述框在同一可恢复快照中写入。
    await persistLearningMutation(noteId, (latest) => saveReviewArgument(latest, stamped, reviewSessionId, sourceRestatement));
    const savedReviewNote = notesRef.current.find(note => note.id === noteId);
    if (savedReviewNote?.learningReviewRecords?.some(review => review.argumentDocIds.includes(stamped.doc_id))) {
      await captureRestatementCognition(savedReviewNote);
    }
    if (navigateAfterSave) {
      setActiveNoteId(noteId);
      setCurrentView('editor');
    }
    return true;
  };

  const runFlowResultOperation = (operation: FlowResultOperation, publication: ArgumentPublicationChoice = 'draft', reviewMode: 'changes' | 'full' = 'changes') => {
    const entryView = currentViewRef.current;
    return flowResultWriteRef.current.run(operation, {
    current: () => {
      if (currentViewRef.current !== entryView || entryView === 'review') return null;
      const current = flowResultRef.current;
      const canvasDoc = useCanvasStore.getState().doc;
      // Include edits already in the store, even before the canvas's React effect emits them.
      return current && canvasDoc.doc_id === current.doc.doc_id ? { ...current, doc: canvasDoc } : current;
    },
    phase: setFlowResultOperation,
    notice: setFlowResultNotice,
    save: (snapshot) => snapshot.isMock ? Promise.resolve(true)
      : saveArgumentDoc(snapshot.doc, snapshot.noteId, snapshot.entryMode, snapshot.reviewSessionId, false, publication),
    reassess: (doc) => flowResultRef.current?.isMock
      ? Promise.resolve({ ...doc, iteration: (doc.iteration || 0) + 1, updated_at: new Date().toISOString() })
      : reassessArgumentStructure(doc, undefined, reviewMode),
    apply: (result) => {
      if (result.doc.structureReview) {
        if (!useCanvasStore.getState().applyStructureReviewPatch(result.doc)) return;
      } else useCanvasStore.getState().initDoc(result.doc);
      setFlowResult({ ...result, doc: useCanvasStore.getState().doc });
    },
    saved: (snapshot) => {
      if (snapshot.noteId) setActiveNoteId(snapshot.noteId);
      setFlowResult(null);
      setCurrentView('editor');
    },
    });
  };
  const handleFlowResultResubmit = (mode: 'changes' | 'full' = 'changes') => runFlowResultOperation('reassess', 'draft', mode);
  const handleFlowResultSave = (publication: ArgumentPublicationChoice) => runFlowResultOperation('save', publication);

  // 订阅编辑器窗口回传：保存 / 删除
  useEffect(() => {
    const api = (window as any).electronAPI?.argument;
    if (!api) return;
    const applyWrite = async (payload: any, remove: boolean) => {
      let result: { ok: boolean; error?: string };
      try {
        if (!notesReadyRef.current) throw new Error('笔记库尚未读取成功，请在主窗口重新读取后再保存');
        if (remove) {
          if (!payload?.noteId || !payload?.docId) throw new Error('删除目标已失效');
          await persistLearningMutation(payload.noteId, (latest) => {
            const escapedId = String(payload.docId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const content = latest.content.replace(new RegExp('<ArgumentBlock\\s+id="' + escapedId + '"\\s*/>', 'g'), '')
              .replace(/\n{3,}/g, '\n\n').trim();
            return detachReviewArgument({ ...latest,
              argumentDocs: (latest.argumentDocs || []).filter((item) => item.doc_id !== payload.docId),
              content, updatedAt: new Date().toISOString(),
            }, payload.docId);
          });
          const savedReviewNote = notesRef.current.find(note => note.id === payload.noteId);
          if (savedReviewNote?.learningReviewRecords?.length) await captureRestatementCognition(savedReviewNote);
        } else {
          // Closing an independent editor must not replace a live scene or another workspace draft.
          const publication: ArgumentPublicationChoice = payload?.publication === 'publish' ? 'publish' : 'draft';
          const saved = await saveArgumentDoc(payload?.doc, payload?.noteId ?? null, payload?.entryMode ?? 'new', undefined, false, publication);
          if (!saved) throw new Error('保存目标已失效，未写入其他笔记');
        }
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : '写入失败，请重试。' };
      }
      try { await api.writeApplied?.({ requestId: payload?.requestId, ...result }); }
      catch (error) { console.warn('[argument] 保存回执未送达', error); }
    };
    const offSaved = api.onSaved?.((payload: any) => { void applyWrite(payload, false); });
    const offDeleted = api.onDeleted?.((payload: any) => { void applyWrite(payload, true); });
    const offOpenNote = api.onOpenNote?.((payload: any) => {
      if (!allowWorkspaceNavigation()) return;
      const noteId = typeof payload?.noteId === 'string' ? payload.noteId : '';
      if (!noteId || !notesRef.current.some((note) => note.id === noteId)) return;
      const note = notesRef.current.find((item) => item.id === noteId);
      contextNavigation.open(noteId, note?.noteType === 'project' ? noteId : null);
    });
    return () => { offSaved?.(); offDeleted?.(); offOpenNote?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeNote = resolveEditorNote(notesRef.current, activeNoteId);
  const getAgentPlanNotes = () => isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current;
  const hasPendingAgentPlanEditorDraft = () => Boolean(agentNewPlanDraft || agentPlanEditorQueue.length > 0);
  const assertNoPendingAgentPlanEditorDraft = () => {
    if (hasPendingAgentPlanEditorDraft()) {
      throw new Error('请先在计划编辑器中确认或放弃当前 Agent 草案');
    }
  };
  const getAgentFocusedNote = () => {
    const navigation = contextNavigation.getSnapshot();
    const referencePage = navigation.pages[navigation.cursor];
    if (referencePage) return getContextFocusedNote(navigation,
      isPlanPreviewDemo ? planPreviewNotesRef.current : notesRef.current);
    if (currentViewRef.current === 'review') return notesRef.current.find((note) => note.id === reviewNoteIdRef.current) || null;
    const planFocusedId = currentView === 'plan' || currentView === 'timeline'
      ? planWorkspaceFocusId || activeProjectContextId
      : null;
    const focusedId = planFocusedId || activeNoteId;
    const source = planFocusedId ? getAgentPlanNotes() : notesRef.current;
    return getContextFocusedNote(navigation, source, focusedId);
  };
  const agentFocusedNote = getAgentFocusedNote();
  const commitAgentNoteChange = (change: WorkspaceNoteChange, undoRecordId?: string, expectedStorageScope?: string, preflight?: () => Promise<void>) => change.knowledgeOnly
    ? commitSelectedKnowledgeChange(change, undoRecordId, expectedStorageScope, preflight)
    : enqueueLearningWrite(learningWriteQueueRef, async () => {
    const checkStorageScope = async () => {
      if (expectedStorageScope && expectedStorageScope !== await agentTaskScope()) throw new Error('资料库已变化，未将旧操作写入新库');
    };
    await checkStorageScope();
    await preflight?.();
    if (['move', 'remove', 'restore'].includes(change.kind) || [...change.before, ...change.after].some(note => note.noteType === 'project')) assertNoPendingAgentPlanEditorDraft();
    return commitAgentWorkspaceChange(change, {
      readNotes: () => notesRef.current, undoRecordId,
      saveAndApply: async (prepared) => {
        await checkStorageScope();
        await preflight?.();
        if (['move', 'remove', 'restore'].includes(prepared.kind) || [...prepared.before, ...prepared.after].some(note => note.noteType === 'project')) assertNoPendingAgentPlanEditorDraft();
        const previous = notesRef.current;
        const projected = applyWorkspaceNoteChange(previous, prepared);
        const personalOnly = personalNotePatches(previous, projected) !== null;
        const next = personalOnly ? projected : recalculateBacklinks(projected);
        personalOnlySaveRef.current = personalOnly ? trackPersonalOnlySave(previous, next, pendingNotesRef.current, personalOnlySaveRef.current) : null;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        // Apply before disk I/O; later editor changes keep their own pending save.
        notesRef.current = next; pendingNotesRef.current = next; setNotes(next);
        const revision = ++noteSaveRevisionRef.current;
        setNoteSaveState('saving');
        try {
          if (!await savePersonalStateOnly(next, personalOnlySaveRef.current)) await saveAllNotesToStorage(next);
          setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, true));
          if (pendingNotesRef.current === next) pendingNotesRef.current = null;
          personalOnlySaveRef.current = acknowledgePersonalSave(personalOnlySaveRef.current, next);
        } catch (error) {
          pendingNotesRef.current = notesRef.current;
          setNoteSaveState(acknowledgedSaveState(noteSaveRevisionRef.current, revision, false));
          throw error;
        }
        const retained = new Set(prepared.after.map(note => note.id));
        const removed = new Set(prepared.before.filter(note => !retained.has(note.id)).map(note => note.id));
        await finishDeletedNoteIndexCleanup([...removed]);
        if (!personalOnly) prepared.after.forEach(note => { const latest = notesRef.current.find(item => item.id === note.id); if (latest) void indexNote(latest).catch(() => {}); });
        setActiveNoteIdState(current => current && removed.has(current) ? notesRef.current[0]?.id || null : current);
        setActiveProjectContextId(current => current && removed.has(current) ? null : current);
      },
    });
  });
  async function commitSelectedKnowledgeChange(change: WorkspaceNoteChange, undoRecordId?: string, scopeId?: string, preflight?: () => Promise<void>) {
    await capturePendingChanges(); await flushPendingChanges();
    return enqueueLearningWrite(learningWriteQueueRef, async () => {
      if ([...change.before, ...change.after].some(note => note.noteType !== 'knowledge')) throw Error('知识点整理不能修改项目对象');
      if (scopeId && scopeId !== await agentTaskScope()) throw Error('资料库已变化，请重新选择知识点');
      await preflight?.();
      const after = await prepareSelectedNoteMetadata(change.after);
      const prepared = { ...change, after };
      return commitAgentWorkspaceChange(prepared, { readNotes: () => notesRef.current, undoRecordId,
        saveAndApply: async selected => {
          if (scopeId && scopeId !== await agentTaskScope()) throw Error('资料库已变化');
          await preflight?.();
          const previous = notesRef.current, next = applyWorkspaceNoteChange(previous, selected);
          const before = new Map(selected.before.map(note => [note.id, note])), retained = new Set(selected.after.map(note => note.id));
          const delta = { upserts: selected.after.map(note => ({ note, before: before.get(note.id) || null })),
            removed: selected.before.filter(note => !retained.has(note.id)).map(note => ({ id: note.id, before: note })),
            ...(selected.knowledgeMerges?.length ? { knowledgeMerges: selected.knowledgeMerges } : {}) };
          // Only immutable note identities are projected. No full-vault body
          // parse, backlink rewrite, all-notes save or all-notes index request.
          notesRef.current = next; pendingNotesRef.current = next; setNotes(next); setNoteSaveState('saving');
          const branch = contextNavigation.getSnapshot(), visiblePage = branch.pages[branch.cursor];
          if (visiblePage && delta.removed.some(row => row.id === visiblePage.noteId)) contextNavigation.reset();
          setActiveNoteIdState(id => id && delta.removed.some(row => row.id === id) ? selected.after[0]?.id || null : id);
          try {
            await saveSelectedKnowledgeDelta(delta);
            if (pendingNotesRef.current === next) pendingNotesRef.current = null;
            setNoteSaveState(pendingNotesRef.current ? 'pending' : 'saved');
          } catch (error) {
            // Compensate only unchanged optimistic objects. A newly typed draft
            // on the surviving target is retained instead of overwritten.
            const afterById = new Map(selected.after.map(note => [note.id, note]));
            const rolled = notesRef.current.filter(note => !(afterById.get(note.id) === note && !before.has(note.id)))
              .map(note => afterById.get(note.id) === note && before.has(note.id) ? before.get(note.id)! : note);
            for (const note of selected.before) if (!rolled.some(row => row.id === note.id)) rolled.push(note);
            notesRef.current = rolled; pendingNotesRef.current = rolled; setNotes(rolled); setNoteSaveState('error');
            throw error;
          }
          void finishDeletedNoteIndexCleanup(delta.removed.map(row => row.id)).catch(reportLearningSaveError);
          if (!window.electronAPI?.vault) selected.after.forEach(note => { void indexNote(note).catch(reportLearningSaveError); });
        } });
    });
  }
  const resourceDownloadClientRef = useRef<ReturnType<typeof createResourceDownloadClient> | null>(null);
  const resourceDownloadFocusRef = useRef(getAgentFocusedNote);
  resourceDownloadFocusRef.current = getAgentFocusedNote;
  resourceDownloadClientRef.current ||= createResourceDownloadClient({
    notes: () => notesRef.current, active: () => {
      const focused = resourceDownloadFocusRef.current();
      return notesRef.current.find(n => n.id === focused?.id) || null;
    },
    api: () => (window as any).electronAPI?.resourceDownloads,
    automaticAllowed: () => settingsRef.current.resourceCollectionMode === 'auto',
    save: (plan, batch, assertAllowed) => persistPlanMutation(current => {
      assertAllowed?.();
      return bindDownloadedProjectResources(current, plan, batch);
    }),
  });
  const agentCtx: AgentRuntimeContext = {
    resourceDownloads: resourceDownloadClientRef.current,
    documentBindings: createDocumentBindingPort({
      assertReady: () => {
        if (typeof (window as any).electronAPI?.ragDocs?.list !== 'function') throw new Error('当前环境没有本地资料列表接口，请重启更新后的桌面应用');
        if (!notesHydrated || isPlanPreviewDemo || isSceneS1Demo || isSceneS4Demo || isLearningCompletionDemo || isReviewExitDemo || rendererExitPreparation.isStopping()) {
          throw new Error('资料库尚未就绪、处于演示模式或正在退出，暂不能查询或修改资料绑定');
        }
      },
      scope: agentTaskScope,
      list: listDocuments,
      notes: () => notesRef.current,
      commit: (change, scopeId, preflight) => commitAgentNoteChange(change, undefined, scopeId, preflight),
      flush: async scopeId => {
        if (scopeId !== await agentTaskScope()) throw new Error('资料库已切换，未保存旧绑定');
        if (pendingNotesRef.current) await flushSave(pendingNotesRef.current);
        if (scopeId !== await agentTaskScope()) throw new Error('资料库已切换，请重新核对绑定状态');
      },
    }),
    applyConceptBatchChange: (change, scopeId) => {
      if (!notesHydrated || isPlanPreviewDemo || isSceneS1Demo || isSceneS4Demo || isLearningCompletionDemo || isReviewExitDemo) {
        throw new Error('当前窗口尚未就绪或处于演示模式，未写入真实概念笔记');
      }
      return commitAgentNoteChange(change, undefined, scopeId);
    },
    applyWorkspaceNoteChange: commitAgentNoteChange,
    undoWorkspaceOperation: async operationId => {
      const record = await agentOperationStore.get(operationId);
      return commitAgentNoteChange(prepareOperationUndo(notesRef.current, record), operationId);
    },
    getNotes: () => notesRef.current,
    getLearningCapacitySettings: () => {
      const live = appSettings.getSnapshot();
      if (live.loadState !== 'ready' || live.saveState === 'error') throw new Error('个人设置尚未就绪或保存失败，请先在设置页读取/重试保存');
      return { learningWeeklyBudgetMinutes: live.settings.learningWeeklyBudgetMinutes };
    },
    applyLearningCapacityPatch: async patch => {
      assertNoPendingAgentPlanEditorDraft();
      if (appSettings.loadState !== 'ready' || !notesHydrated || isPlanPreviewDemo) throw new Error('设置/笔记未就绪或处于演示模式，未修改学习容量');
      const mutation = prepareLearningCapacityPatch(notesRef.current, patch);
      const originalBudget = appSettings.getSnapshot().settings.learningWeeklyBudgetMinutes;
      let operation: unknown;
      if (mutation.before.length) operation = await commitAgentNoteChange({ kind: 'edit', label: '调整计划学习强度与计时关系', before: mutation.before, after: mutation.after });
      try {
        if (patch.weeklyBudgetMinutes !== undefined) {
          if (appSettings.getSnapshot().settings.learningWeeklyBudgetMinutes !== originalBudget) throw new Error('个人周预算在保存期间已变化');
          appSettings.update({ learningWeeklyBudgetMinutes: patch.weeklyBudgetMinutes });
          await appSettings.flush();
          if (appSettings.getSnapshot().settings.learningWeeklyBudgetMinutes !== patch.weeklyBudgetMinutes) {
            return { saved: false, partial: mutation.before.length > 0, superseded: true, operation,
              message: '保存期间用户再次调整了个人周预算，保留较新的设置；本次不能宣称预算仍为请求值。未重排日期。',
              capacity: learningCapacitySummary(buildLearningCapacity(notesRef.current, weekStartDate(), appSettings.getSnapshot().settings)) };
          }
        }
      } catch {
        return { saved: false, partial: mutation.before.length > 0, operation,
          message: `${mutation.before.length ? '计划时长修改已保存；' : ''}个人周预算尚未确认保存或期间已变化，请核对设置并重试保存。未重排日期。`,
          capacity: learningCapacitySummary(buildLearningCapacity(notesRef.current, weekStartDate(), appSettings.getSnapshot().settings)) };
      }
      return { saved: true, operation, rescheduled: false,
        capacity: learningCapacitySummary(buildLearningCapacity(notesRef.current, weekStartDate(), appSettings.getSnapshot().settings)) };
    },
    getAgentPersona: () => normalizeAgentPersona(appSettings.settings.agentPersona),
    getAgentExecutionMode: () => settingsRef.current.agentExecutionMode,
    getAgentToolCallLimit: () => settingsRef.current.agentToolCallLimit,
    updateAgentPersona: async (persona) => {
      if (appSettings.loadState !== 'ready') throw new Error('应用设置尚未读取完成，暂时不能修改助手人格');
      const next = normalizeAgentPersona(persona);
      appSettings.update({ agentPersona: next });
      await appSettings.flush();
      return next;
    },
    getPlanNotes: getAgentPlanNotes,
    hasPendingPlanEditorDraft: hasPendingAgentPlanEditorDraft,
    getActiveNote: getAgentFocusedNote,
    getWorkspaceSnapshot: () => {
      const focused = getAgentFocusedNote();
      return {
        revision: navigationRevisionRef.current,
        view: currentViewRef.current,
        ...(focused ? {
          focusedNoteId: focused.id,
          focusedNoteTitle: focused.title,
          focusedNoteType: focused.noteType,
        } : {}),
        recentEvents: agentRecentEvents,
      };
    },
    recordWorkspaceEvent: recordAgentWorkspaceEvent,
    publishTextbook: async (input) => {
      try {
        return await publishTextbookAfterSave(learningWriteQueueRef, {
          readNotes: () => notesRef.current,
          saveNotes: saveAllNotesToStorage,
          preflightMarkdown: async (markdown) => {
            const { assertMdxNoteImportable } = await import('./components/mdxNotePreflight');
            assertMdxNoteImportable(markdown);
          },
          beforeSave: () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            setNoteSaveState('saving');
          },
          applyNotes: (saved) => {
            noteSaveRevisionRef.current += 1;
            notesRef.current = saved;
            pendingNotesRef.current = null;
            setNotes(saved);
            setNoteSaveState('saved');
            // Persistence already queues the changed textbook for idle indexing.
            // Do not immediately start all indexing channels during first paint.
          },
        }, input);
      } catch (error) {
        pendingNotesRef.current = notesRef.current;
        setNoteSaveState('error');
        throw error;
      }
    },
    openTextbookProject: (projectNoteId) => {
      if (!allowWorkspaceNavigation() || !notesRef.current.find((note) => note.id === projectNoteId)?.textbook) return false;
      handleOpenContextNote(projectNoteId); return true;
    },
    navigate: (view) => {
      if (!reviewExitGuard.allowNavigation()) throw new Error('复习尚未完整保存，请先在当前页面完成保存或重试。');
      if (!sceneGuard.allowNavigation()) throw new Error('场景流程已锁定，请先完成场景并点击退出');
      if (!allowCognitionLeave()) throw new Error('个人理解尚未保存或正在保存，请先保存或取消编辑，再切换页面。');
      setCurrentView(view);
    },
    openNoteByTitle: (title) => {
      if (!allowWorkspaceNavigation()) return false;
      const note = resolveNoteByTitleOrAlias(title, notesRef.current);
      if (!note) return false;
      handleOpenContextNote(note.id);
      return true;
    },
    enterLearningMode: ({ mode, noteTitle, question, sceneRequest, reviewRequest, taskBinding, quickCheckRequest }) => {
      if (!allowWorkspaceNavigation()) return false;
      if (mode === 'quick_check') {
        const target = quickCheckRequest?.noteId
          ? notesRef.current.find(note => note.id === quickCheckRequest.noteId && note.noteType === 'knowledge')
          : noteTitle ? resolveNoteByTitleOrAlias(noteTitle, notesRef.current.filter(note => note.noteType === 'knowledge'))
            : getAgentFocusedNote();
        if (!target || target.noteType !== 'knowledge') return false;
        return quickCheckControllerRef.current?.open({ noteId: target.id,
          criterionIds: quickCheckRequest?.criterionIds, regenerate: quickCheckRequest?.regenerate, source: 'agent' }) || false;
      }
      if (mode === 'bubble') { handleEnterBubbleMode(reviewRequest); return true; }
      const note = noteTitle
        ? resolveNoteByTitleOrAlias(noteTitle, notesRef.current)
        : getAgentFocusedNote();
      if (mode === 'flow') {
        if (!note) return false;
        if (taskBinding && !getLearningCompletionTarget(notesRef.current, taskBinding)) return false;
        handleEnterFlowMode(note.id, settings.flowSettings.reviewIntervalMinutes, taskBinding);
        return true;
      }
      if (mode === 'review') {
        if (!note && reviewRequest) { handleEnterBubbleMode(reviewRequest); return true; }
        if (!note) return false;
        const openingQuestion = question || buildReviewOpeningQuestion(note.title, note.noteType === 'project');
        const context = note.noteType === 'project'
          ? buildProjectReviewKnowledgeContext(note, notesRef.current)
          : note.content;
        setIsAgentOpen(false);
        handleEnterReview(note.id, note.title, openingQuestion, context);
        return true;
      }
      if (!sceneRequest && !note) return false;
      const requestedNote = sceneRequest
        ? resolveNoteByTitleOrAlias(noteTitle || sceneRequest.subject, notesRef.current)
        : note;
      const derivedKnowledge = requestedNote?.noteType === 'project'
        ? collectKnowledgePoints(requestedNote.id, notesRef.current)
        : requestedNote?.noteType === 'knowledge' ? [requestedNote.title] : [];
      const knownKnowledge = sceneRequest?.knowledgePoints
        .map((title) => resolveNoteByTitleOrAlias(title, notesRef.current.filter((candidate) => candidate.noteType === 'knowledge'))?.title)
        .filter((title): title is string => Boolean(title)) || [];
      const knowledgePoints = [...new Set([...derivedKnowledge, ...knownKnowledge])].slice(0, 20);
      // Only a caller-provided binding or explicitly selected project authorizes completion.
      const explicitBinding = sceneRequest?.taskBinding || taskBinding;
      if (explicitBinding && !getLearningCompletionTarget(notesRef.current, explicitBinding)) return false;
      const selectedBinding = explicitBinding || ((!sceneRequest || noteTitle) && requestedNote?.noteType === 'project'
        ? { noteId: requestedNote.id } : undefined);
      setIsAgentOpen(false);
      handleEnterScene(sceneRequest ? {
        ...sceneRequest,
        knowledgePoints,
        taskBinding: selectedBinding,
      } : {
        source: 'auto',
        subject: note!.title,
        knowledgePoints: knowledgePoints.length ? knowledgePoints : [note!.title],
        taskBinding: selectedBinding,
      });
      return true;
    },
    createKnowledgeNote: async (input) => {
      const tags = input.tags?.length ? input.tags : ['Agent 草案'];
      const created = await agentCtx.createNote!({ ...input, tags, noteType: 'knowledge' });
      return { ...created, tags };
    },
    createNote: async (request) => {
      const { input, parent } = prepareAgentNoteCreation({ ...request }, notesRef.current);
      const { title, content } = input;
      const now = new Date().toISOString();
      const note: NoteItem = {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title, content, noteType: input.noteType,
        ...(input.projectRole ? { projectRole: input.projectRole } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        tags: input.tags?.length ? input.tags : input.noteType === 'project' ? [input.projectRole === 'reference' ? '项目资料' : '学习项目'] : ['Agent 创建'],
        links: [], backlinks: [], dueDates: [], createdAt: now, updatedAt: now,
      };
      const navigationRevision = navigationRevisionRef.current;
      const operation = await commitAgentNoteChange({ kind: 'create', label: `创建笔记《${title}》`, before: [], after: [note], dependencies: parent ? [parent] : [] });
      if (navigationRevisionRef.current === navigationRevision && allowWorkspaceNavigation()) {
        setActiveNoteId(note.id);
        if (note.noteType === 'project') setActiveProjectContextId(note.id);
        setCurrentView('editor');
      }
      return { noteId: note.id, title: note.title, noteType: note.noteType, projectRole: note.projectRole, parentId: note.parentId, ...operation };
    },
    deleteNotes: async ({ noteIds, includeProjectDescendants }) => {
      assertNoPendingAgentPlanEditorDraft();
      const current = notesRef.current;
      if (noteIds.length && noteIds.every(id => current.find(note => note.id === id)?.noteType === 'knowledge')) {
        const selected = prepareKnowledgeDeletion(current, noteIds);
        const operation = await commitAgentNoteChange(selected);
        return { deletedCount: selected.before.length, deletedTitles: selected.before.map(note => note.title), recoverable: true, ...operation };
      }
      const ids = new Set(noteIds);
      if (!ids.size) throw new Error('没有指定待删除笔记');
      if ([...ids].some((id) => !current.some((note) => note.id === id))) throw new Error('部分待删除笔记已不存在，请重新确认');
      for (const project of current.filter((note) => ids.has(note.id) && note.noteType === 'project')) {
        const descendants = collectDescendantIds(project.id, current);
        if (descendants.some((id) => !ids.has(id)) && !includeProjectDescendants) {
          throw new Error(`项目“${project.title}”仍包含未选中的下级内容，已拒绝删除`);
        }
        if (includeProjectDescendants) descendants.forEach((id) => ids.add(id));
      }
      const removed = current.filter((note) => ids.has(note.id));
      const operation = await commitAgentNoteChange({ kind: 'remove', label: `移除 ${removed.length} 篇笔记（可恢复）`, before: removed, after: [] });
      return { deletedCount: removed.length, deletedTitles: removed.map((note) => note.title), recoverable: true, ...operation };
    },
    renameProject: async ({ projectId, title }) => {
      assertNoPendingAgentPlanEditorDraft();
      const current = notesRef.current;
      const project = current.find((note) => note.id === projectId && note.noteType === 'project');
      if (!project) throw new Error('目标项目已不存在，请重新确认');
      const nextTitle = title.trim();
      if (!nextTitle) throw new Error('项目名称不能为空');
      if (findNotesByTitleOrAlias(nextTitle, current.filter(note => note.id !== project.id)).length) throw new Error(`新名称已被其他笔记使用：${nextTitle}`);
      const operation = await commitAgentNoteChange(prepareNoteEdit(current, { noteId: project.id, title: nextTitle }));
      return { projectId, previousTitle: project.title, title: nextTitle, ...operation };
    },
    getAppearance: () => ({ theme: appSettings.settings.theme, accentColor: appSettings.settings.accentColor || 'emerald' }),
    updateAppearance: async (patch) => {
      if (appSettings.loadState !== 'ready') throw new Error('应用设置尚未读取完成，暂时不能修改外观');
      const next = {
        theme: patch.theme || appSettings.settings.theme,
        accentColor: patch.accentColor || appSettings.settings.accentColor || 'emerald',
      };
      appSettings.update(next);
      await appSettings.flush();
      return next;
    },
    applyPlanTaskChange: async (change) => {
      assertNoPendingAgentPlanEditorDraft();
      const source = getAgentPlanNotes();
      const mutation = applyPlanTaskChange(source, change);
      const nextNotes = recalculateBacklinks(mutation.notes);
      const changedProject = nextNotes.find((note) => note.id === mutation.changedNote.id && note.noteType === 'project');
      if (changedProject) {
        if (!allowWorkspaceNavigation()) throw new Error('请先保存或取消当前编辑，再导入任务调整草图。');
        const projectById = new Map(nextNotes.filter((note) => note.noteType === 'project').map((note) => [note.id, note]));
        let root = changedProject;
        const visited = new Set<string>();
        while (root.parentId && !visited.has(root.id)) {
          visited.add(root.id);
          const parent = projectById.get(root.parentId);
          if (!parent) break;
          root = parent;
        }
        const editorDraft = buildPublishedPlanEditorValue(nextNotes, root.id);
        if (!editorDraft) throw new Error('任务调整已生成，但无法映射到计划编辑器');
        setAgentNewPlanDraft(null);
        setAgentPlanEditorQueue([editorDraft]);
        setAgentPlanEditorBaseRevisions(buildPlanEditorBaseRevisions(source, [root.id]));
        setEditingPlanRootId(root.id);
        setPlanWorkspaceFocusId(root.id);
        setIsAgentOpen(false);
        setCurrentView('plan');
        return { ...mutation.summary, draftImported: true, requiresUserConfirmation: true };
      }
      const committed = await persistPlanMutation(current => applyPlanTaskChange(current, change));
      return committed.summary;
    },
    createProjectPlan: createAgentProjectPlan,
    appendProjectStudyTasks: async (input) => {
      assertNoPendingAgentPlanEditorDraft();
      const mutation = await persistPlanMutation(current => appendProjectStudyTasks(current, input));
      setActiveNoteId(mutation.changedNote.id);
      setCurrentView('editor');
      return mutation.summary;
    },
    appendProjectStudyTaskBatch: async (input) => {
      assertNoPendingAgentPlanEditorDraft();
      const mutation = await persistPlanMutation(current => appendProjectStudyTaskBatch(current, input));
      const firstProject = mutation.changedProjectNotes[0];
      if (firstProject) {
        setActiveNoteId(firstProject.id);
        setCurrentView('editor');
      }
      return mutation.summary;
    },
    getPlanDraftSession: () => planDraftSessionRef.current,
    startPlanDraftSession: (input) => {
      assertNoPendingAgentPlanEditorDraft();
      if (resourceDraftSessionRef.current) throw new Error('请先提交或放弃当前资源草案');
      if (planDraftSessionRef.current) throw new Error('请先提交或放弃当前计划草案');
      const planNotes = getAgentPlanNotes();
      const session = input.scopeKind === 'portfolio'
        ? createPortfolioPlanDraftSession(planNotes, undefined, undefined, input.rootProjectIds)
        : createPlanDraftSession(planNotes, {
          ...input,
          selectedProjectId: getAgentFocusedNote()?.id,
        });
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePlanDraftBatch: (input) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个计划草案会话');
      const session = stagePlanDraftBatch(getAgentPlanNotes(), current, input);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePlanStructurePatches: (patches) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个计划草案会话');
      const session = stagePlanStructurePatches(getAgentPlanNotes(), current, patches);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePlanMetaPatch: (patch) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个计划草案会话');
      const session = stagePlanMetaPatch(getAgentPlanNotes(), current, patch);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePlanMilestonePatches: (patches) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个计划草案会话');
      const session = stagePlanMilestonePatches(getAgentPlanNotes(), current, patches);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePlanExecutionPatches: (patches) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个计划草案会话');
      const session = stagePlanExecutionPatches(getAgentPlanNotes(), current, patches);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    stagePortfolioPlanPatches: (input) => {
      const current = planDraftSessionRef.current;
      if (!current) throw new Error('请先开始一个综合计划草案会话');
      const session = stagePortfolioPlanPatches(getAgentPlanNotes(), current, input);
      updatePlanDraftSession(session);
      return summarizePlanDraft(session);
    },
    discardPlanDraftSession: () => {
      const scopeProjectTitle = planDraftSessionRef.current?.scopeProjectTitle;
      updatePlanDraftSession(null);
      return { discarded: Boolean(scopeProjectTitle), scopeProjectTitle };
    },
    commitPlanDraftSession: async () => {
      const session = planDraftSessionRef.current;
      if (!session) throw new Error('当前没有可提交的计划草案');
      const sourceNotes = getAgentPlanNotes();
      let mutation = buildPlanDraftMutation(sourceNotes, session);
      let nextNotes = recalculateBacklinks(mutation.notes);
      const committedSummary = {
        scopeProjectTitle: mutation.summary.rootProjectTitle,
        projectCount: mutation.summary.projectCount,
        taskCount: mutation.summary.taskCount,
        createdKnowledgeTitles: mutation.summary.createdKnowledgeTitles,
        linkedKnowledgeTitles: mutation.summary.linkedKnowledgeTitles,
        structurePatchCount: mutation.summary.structurePatchCount,
        planMetaPatchCount: mutation.summary.planMetaPatchCount,
        milestonePatchCount: mutation.summary.milestonePatchCount,
        executionPatchCount: mutation.summary.executionPatchCount,
        rootCount: mutation.summary.rootCount,
        rootProjectTitles: mutation.summary.rootProjectTitles,
        rootSummaries: mutation.summary.rootSummaries,
      };
      if (session.purpose !== 'study-tasks') {
        if (!allowWorkspaceNavigation()) throw new Error('请先保存或取消当前编辑，再导入计划调整草图。');
        const scopeIds = mutation.summary.rootSummaries?.map((item) => item.rootProjectId)
          || [session.scopeProjectId];
        const editorDrafts = scopeIds.flatMap((rootId) => {
          const value = buildPublishedPlanEditorValue(nextNotes, rootId);
          return value ? [{ ...value, agentEditorDraftId: session.id }] : [];
        });
        if (editorDrafts.length === 0) throw new Error('草案已生成，但无法映射到计划编辑器');
        setAgentNewPlanDraft(null);
        setAgentPlanEditorQueue(editorDrafts);
        setAgentPlanEditorBaseRevisions(buildPlanEditorBaseRevisions(sourceNotes, editorDrafts.map((draft) => draft.rootId)));
        setEditingPlanRootId(editorDrafts[0].rootId);
        setPlanWorkspaceFocusId(editorDrafts[0].rootId);
        updatePlanDraftSession(null);
        setIsAgentOpen(false);
        setCurrentView('plan');
        return { ...committedSummary, draftImported: true, requiresUserConfirmation: true,
          ...(editorDrafts.length === 1 ? { editorDraftId: session.id } : {}) };
      }
      if (isPlanPreviewDemo) {
        planPreviewNotesRef.current = nextNotes;
        setPlanPreviewNotes(nextNotes);
        updatePlanDraftSession(null);
        return committedSummary;
      }
      mutation = await persistPlanMutation(current => buildPlanDraftMutation(current, session));
      nextNotes = mutation.notes;
      void finishDeletedNoteIndexCleanup(mutation.deletedProjectIds).catch(reportLearningSaveError);
      updatePlanDraftSession(null);
      const projectNotes = nextNotes.filter((note) => note.noteType === 'project');
      const projectById = new Map(projectNotes.map((note) => [note.id, note]));
      const committedScopeIds = mutation.summary.rootSummaries?.map((item) => item.rootProjectId)
        || [session.scopeProjectId];
      const evidenceRoots = committedScopeIds.flatMap((scopeId) => {
        const committedScope = projectById.get(scopeId);
        if (!committedScope) return [];
        let evidenceRoot = committedScope;
        const visitedParents = new Set<string>();
        while (evidenceRoot.parentId && !visitedParents.has(evidenceRoot.parentId)) {
          visitedParents.add(evidenceRoot.parentId);
          const parent = projectById.get(evidenceRoot.parentId);
          if (!parent) break;
          evidenceRoot = parent;
        }
        return [evidenceRoot];
      }).filter((root, index, roots) => roots.findIndex((candidate) => candidate.id === root.id) === index);
      if (evidenceRoots.length > 0) {
        const buildEvidenceNode = (note: NoteItem, visited = new Set<string>()): PlanNode => {
          if (visited.has(note.id)) return { key: note.id, title: note.title, children: [] };
          const nextVisited = new Set(visited).add(note.id);
          const deadline = note.dueDates.find((item) => item.taskText.trim() === note.title.trim());
          return {
            key: note.id,
            title: note.title,
            startDate: deadline?.startDate,
            dueDate: deadline?.dueDate,
            priority: deadline?.priority,
            children: projectNotes.filter((item) => item.parentId === note.id).map((child) => buildEvidenceNode(child, nextVisited)),
          };
        };
        const endedAt = new Date().toISOString();
        const episodeId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const evidence = extractPlanEvidence({ episodeId, observedAt: endedAt, tree: evidenceRoots.map((root) => buildEvidenceNode(root)), action: 'update' });
        const rootTitles = evidenceRoots.map((root) => root.title);
        await saveLearningEpisode({
          id: episodeId,
          type: 'plan',
          status: 'completed',
          title: session.scopeKind === 'portfolio' ? `统筹调整 ${rootTitles.length} 个学习计划` : `调整学习计划：${rootTitles[0]}`,
          startedAt: session.createdAt,
          endedAt,
          goal: rootTitles.join('、'),
          summary: `${session.scopeKind === 'portfolio' ? `已原子提交 ${rootTitles.length} 个根计划的组合草案；` : '已提交'}${mutation.summary.structurePatchCount} 个结构补丁、${mutation.summary.milestonePatchCount} 个里程碑补丁、${mutation.summary.executionPatchCount} 个执行事项补丁${mutation.summary.planMetaPatchCount ? '，并更新计划条件' : ''}。`,
          evidenceSnippets: evidence.evidenceSnippets,
          profileSignals: evidence.profileSignals,
          createdAt: endedAt,
          updatedAt: endedAt,
        }).catch(() => {});
      }
      const firstProject = mutation.changedProjectNotes[0]
        || mutation.createdProjectNotes[0]
        || nextNotes.find((note) => note.id === session.scopeProjectId);
      if (firstProject) {
        setActiveNoteId(firstProject.id);
        setCurrentView('editor');
      }
      return committedSummary;
    },
    getResourceDraftSession: () => resourceDraftSessionRef.current,
    getResourceCollectionMode: () => settingsRef.current.resourceCollectionMode,
    startResourceDraftSession: (input) => {
      assertNoPendingAgentPlanEditorDraft();
      if (planDraftSessionRef.current) throw new Error('请先提交或放弃当前计划草案');
      const session = createResourceDraftSession(notesRef.current, {
        ...input,
        selectedProjectId: getAgentFocusedNote()?.id,
      });
      updateResourceDraftSession(session);
      return summarizeResourceDraft(session);
    },
    searchOnlineLearningResources: async (input, execution) => {
      const session = resourceDraftSessionRef.current;
      if (!session) throw new Error('请先开始一个资源草案会话');
      const outcome = await runResourceSearch(session, input, true, execution?.signal);
      return { markdown: outcome.markdown, resources: outcome.status === 'written' ? outcome.resources : [],
        status: outcome.status, requiresUserConfirmation: outcome.status === 'workbench-opened' };
    },
    stageResourceDraftBatch: (projects) => {
      const session = resourceDraftSessionRef.current;
      if (!session) throw new Error('请先开始一个资源草案会话');
      const nextSession = stageResourceDraftBatch(notesRef.current, session, projects);
      updateResourceDraftSession(nextSession);
      return summarizeResourceDraft(nextSession);
    },
    discardResourceDraftSession: () => {
      const scopeProjectTitle = resourceDraftSessionRef.current?.scopeProjectTitle;
      closeDraftBrowserSessions(resourceDraftSessionRef.current);
      updateResourceDraftSession(null);
      return { discarded: Boolean(scopeProjectTitle), scopeProjectTitle };
    },
    commitResourceDraftSession: async () => {
      const session = resourceDraftSessionRef.current;
      if (!session) throw new Error('当前没有可提交的资源草案');
      const mutation = await persistPlanMutation(current => buildResourceDraftMutation(current, session));
      closeDraftBrowserSessions(session);
      updateResourceDraftSession(null);
      const firstProject = mutation.changedProjectNotes[0];
      if (firstProject) {
        setActiveNoteId(firstProject.id);
        setCurrentView('editor');
      }
      return mutation.summary;
    },
    ensureDataFresh,
  };

  const shellPolicy = APP_VIEW_SHELL_POLICY[currentView];
  const communityFocus = shellPolicy.shell==='focus' && !(flowResult && currentView!=='review' && !reviewExitGuard.locked);
  useEffect(()=>{void window.electronAPI?.community?.setFocus?.(communityFocus).catch(()=>{});},[communityFocus]);
  const focusShellTitle = currentView === 'flow'
    ? '心流学习'
    : currentView === 'review'
      ? '苏格拉底式复习'
      : isSceneS4Demo || sceneRequest?.sceneSkill === 'S4'
        ? 'S4 数理推导'
        : sceneRequest?.sceneSkill === 'S2'
          ? 'S2 通用画布试验'
        : 'S1 场景模拟';
  const focusShellContext = currentView === 'flow'
    ? flowTargetNote?.title
    : currentView === 'review'
      ? reviewNoteTitle
      : isSceneS4Demo
        ? '严格凸函数·推导画布'
        : sceneRequest?.subject;

  const flowCompletionTarget = getLearningCompletionTarget(notes, flowCompletionPrompt?.binding);
  const flowCompletionContent = flowCompletionTarget ? React.createElement(LearningCompletionCard, {
    key: flowCompletionPrompt?.sessionId,
    target: flowCompletionTarget,
    onSetCompleted: handleSetLearningCompletion,
    context: 'flow', variant: 'result',
    onDismiss: () => setFlowCompletionPrompt(null),
  }) : null;
  const hasFlowCloseout = Boolean(flowCompletionContent && flowReviewSession?.noteId === activeNoteId);
  const showFlowCloseoutBanner = hasFlowCloseout && !isFlowAnalysisOpen && !isSelectionOpen && !analysisProgressOpen;
  const sceneCompletionTarget = getLearningCompletionTarget(notes, sceneRequest?.taskBinding);
  const sceneCompletionContent = sceneCompletionTarget ? React.createElement(LearningCompletionCard, {
    target: sceneCompletionTarget, onSetCompleted: handleSetLearningCompletion,
    context: 'scene', variant: 'result',
  }) : null;

  const withQuickCheck = (children: React.ReactNode) => React.createElement(QuickCheckProvider, {
    notes,
    getNotes: getQuickCheckNotes,
    controllerRef: quickCheckControllerRef,
    storageScope: quickCheckStorageScope,
    canOpen: () => Boolean(quickCheckStorageScope) && !flowResult?.isMock
      && !flowResultWriteRef.current.busy && allowWorkspaceNavigation(),
    onCommit: handleQuickCheckCommit,
    children,
  });

  if (!notesHydrated) return React.createElement(VaultStartupView, {
    status: vaultStartup.status, error: vaultStartup.error, onRetry: () => { void vaultStartup.retry(); },
  });
  if (isLearningCompletionDemo) return React.createElement(LearningCompletionDemoPage, { settings });
  if (isReviewExitDemo) return React.createElement(ReviewExitDemoPage);

  if (flowResult && currentView !== 'review' && !reviewExitGuard.locked) {
    return withQuickCheck(React.createElement(FlowResultView, {
      data: flowResult,
      operation: flowResultOperation,
      notice: flowResultNotice,
      onChange: (doc: ArgDoc) => {
        if (flowResultWriteRef.current.busy) return;
        setFlowResult((current) => current && current.doc.doc_id === doc.doc_id ? { ...current, doc } : current);
      },
      onBack: () => {
        if (flowResultWriteRef.current.busy) return;
        if (flowResult.reviewSessionId === flowReviewSession?.id) void cancelStoredFlowReview(flowReviewSession).catch(reportLearningSaveError);
        setFlowResult(null);
        setIsFlowAnalysisOpen(false);
        setCurrentView('editor');
      },
      onSave: handleFlowResultSave,
      onResubmit: handleFlowResultResubmit,
      renderQuickCheckEntry: (title: string) => {
        // Flow mastery is saved before the argument-result page is assembled.
        // Do not treat an unsaved/mock/older report as a current mastery receipt.
        const masterySaved = flowResult.reviewSessionId && notes.some(note => note.learningReviewRecords?.some(record =>
          record.sessionId === flowResult.reviewSessionId && record.masteryAssessment));
        if (!masterySaved) return null;
        const matches = notes.filter(note => note.noteType === 'knowledge'
          && (note.title === title || note.aliases?.includes(title)));
        return matches.length === 1 ? React.createElement(QuickCheckButton, {
          noteId: matches[0].id, source: 'flow_result', children: '定向简测',
        }) : null;
      },
      completionContent: !flowResult.isMock && flowResult.reviewSessionId === flowCompletionPrompt?.sessionId ? flowCompletionContent : null,
      recoveryContent: React.createElement(NoteSaveRecovery, { state: noteSaveState, onRetry: retryNoteSave,
        error: noteSaveError, notice: noteRecoveryNotice, onDismissNotice: () => setNoteRecoveryNotice(''),
        pendingDeletionCount, restoredDeletionCount, onDismissDeletionNotice: () => setRestoredDeletionCount(0) }),
      settingsRecoveryContent: React.createElement(React.Fragment, null,
        React.createElement(AppSettingsFeedback, { state: appSettings, banner: true,
          onRetryLoad: () => { void appSettings.retryLoad(); }, onRetrySave: () => { void appSettings.retrySave(); } }),
        React.createElement(ModelSettingsFeedback, { state: llmSaveState, onRetry: () => { void retryLlmSettingsSave().catch(() => {}); } })),
    }));
  }

  return withQuickCheck(React.createElement('div', { className: 'app-frame loginote-app-shell min-h-screen flex text-slate-900 dark:text-slate-100 font-sans transition-colors selection:bg-indigo-100 selection:text-indigo-900', 'data-shell': shellPolicy.shell,
    onKeyDownCapture: handleNoteEditingActivity, onPointerDownCapture: handleNoteEditingActivity, onScrollCapture: handleNoteEditingActivity },
    shellPolicy.showGlobalHeader && React.createElement(WorkspaceNavigation, {
      currentView,
      onSelectView: setCurrentView,
      onOpenLearn: handleOpenLearn,
      onOpenReview: () => handleEnterBubbleMode(),
      onOpenPrivacy: () => setIsPrivacyOpen(true),
    }),
    React.createElement('div', { className: 'workspace-stage' },
      shellPolicy.showGlobalHeader
        ? React.createElement(WorkspaceTopbar, { onOpenCommandPalette: () => { if (allowWorkspaceNavigation()) setIsCommandPaletteOpen(true); }, syncStatus, onTriggerSync: handleTriggerSync })
        : shellPolicy.shell === 'focus' && currentView !== 'flow' && currentView !== 'review'
          ? React.createElement(FocusShellHeader, { title: focusShellTitle, context: focusShellContext })
          : null,
      React.createElement(NoteSaveRecovery, { state: noteSaveState, onRetry: retryNoteSave,
        error: noteSaveError, recovering: recoveringNoteDrafts, notice: noteRecoveryNotice, onDismissNotice: () => setNoteRecoveryNotice(''),
        onRecoverDrafts: currentView === 'editor' && !flowResult && /(其他位置|其他窗口|基线|已变化|已存在|重新载入|冲突)/u.test(noteSaveError) ? recoverNoteDrafts : undefined,
        pendingDeletionCount, restoredDeletionCount, onDismissDeletionNotice: () => setRestoredDeletionCount(0) }),
      currentView !== 'settings' && React.createElement(AppSettingsFeedback, { state: appSettings, banner: true,
        onRetryLoad: () => { void appSettings.retryLoad(); }, onRetrySave: () => { void appSettings.retrySave(); } }),
      currentView !== 'settings' && React.createElement(ModelSettingsFeedback, { state: llmSaveState,
        onRetry: () => { void retryLlmSettingsSave().catch(() => {}); } }),
      React.createElement('div', { className: 'workspace-content' },
        shellPolicy.showGlobalSidebar && React.createElement(Sidebar, { notes, getNotes: getQuickCheckNotes, activeNoteId: contextNavigation.active ? contextNavigation.pages[contextNavigation.cursor].noteId : activeNoteId, onSelectNote: handleSelectNote, onNewNote: handleNewNote, onDeleteNote: handleDeleteNote, onToggleFavorite: handleToggleFavorite, onTogglePin: handleTogglePin, onDeleteProject: handleDeleteProject, settings, treeStateRef: sidebarTreeStateRef, revealRevision: sidebarRevealRevision }),
        React.createElement('main', { className: 'flex-1 min-h-0 min-w-0 flex overflow-hidden relative' },
        React.createElement('div', { className: 'flex-1 min-h-0 min-w-0 flex overflow-hidden relative',
          'data-context-source': currentView, inert: contextNavigation.active, 'aria-hidden': contextNavigation.active,
          style: { visibility: contextNavigation.active ? 'hidden' : 'visible' } },
        React.createElement(ContextSourceForward, { navigation: contextNavigation, onMove: contextNavigation.move }),
        currentView === "home" && React.createElement(HomeView, {
          capacitySettings: settings,
          notes,
          onContinueProject: handleContinueHomeProject,
          onOpenPlan: () => setCurrentView('timeline'),
          onOpenReview: () => handleEnterBubbleMode(),
          onOpenProfile: () => setCurrentView('profile'),
        }),
        currentView === "profile" && React.createElement(ProfileOverviewView, {
          notes,
          onBack: () => setCurrentView('home'),
          onOpenEvidence: () => setCurrentView('profile-evidence'),
        }),
        currentView === "profile-evidence" && React.createElement(ProfileEvidenceView, { notes,
          onBack: () => setCurrentView('profile'), onOpenNote: handleSelectNote }),
        currentView === "editor" && React.createElement('div', { className: 'flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden' },
          showFlowCloseoutBanner && React.createElement('div', { className: 'learning-closeout-banner' }, React.createElement(LearningCompletionCard, {
            key: flowCompletionPrompt?.sessionId, target: flowCompletionTarget, onSetCompleted: handleSetLearningCompletion,
            context: 'flow', variant: 'inline', onDismiss: () => setFlowCompletionPrompt(null),
          })),
          React.createElement('div', { className: 'flex-1 min-h-0 min-w-0 flex overflow-hidden' },
            React.createElement(NoteEditor, { note: activeNote, isActive: !contextNavigation.active && !isAgentOpen && !isCommandPaletteOpen, isVisible: !contextNavigation.active, allNotes: notesRef.current, onUpdateNote: handleUpdateNote, onEditNote: handleEditNote, onFinishEditing: handleFinishNoteEditing, saveState: noteSaveState, onRetrySave: retryNoteSave, onTextbookReadingPosition: handleTextbookReadingPosition, getTextbookReadingPosition,
              onSetLearningCompletion: handleSetLearningCompletion, hideLearningCompletionControl: hasFlowCloseout && flowCompletionTarget?.kind === 'project',
              onSelectNoteByTitle: handleSelectNoteByTitle, onOpenNote: handleOpenContextNote, projectContextId: activeProjectContextId, onOpenConceptFill: (n) => setConceptFillNote(n),
              onContinueProgressive: (noteId) => handleEnterFlowMode(noteId, settings.flowSettings.reviewIntervalMinutes),
              onArgumentBlockEdit: handleArgumentBlockEdit, onArgumentBlockDelete: handleArgumentBlockDelete, onArgumentRagWithdraw: handleArgumentRagWithdraw,
              getArgumentDoc, onLearningReviewPatch: handleLearningReviewPatch, settings, onRecommendProjectResources: handleProjectResourceRecommendation, contentVersion: editorRefreshVersion, publication: notes }),
            isFlowAnalysisOpen && flowSpeakingContent && React.createElement(FlowAnalysisPanel, { speakingContent: flowSpeakingContent, key: flowReviewSession?.id,
              completionContent: flowCompletionContent,
              noteTitle: flowReviewSession?.noteTitle || "", noteId: flowReviewSession?.noteId || null,
              analysisRunId: flowReviewSession?.id, allNotes: notes, summaryText: flowSummaryText, questions: flowQuestions,
              onClose: () => { setIsFlowAnalysisOpen(false); void cancelStoredFlowReview(flowReviewSession).catch(reportLearningSaveError); },
              onSelectNoteByTitle: handleSelectNoteByTitle, onUpdateNote: handleUpdateNote,
              onArgumentReady: (doc: ArgDoc | undefined, report: FlowAnalysisReport) => handleArgumentReady(doc, report, flowReviewSession), masteryResults: knowledgeResults,
              onProgress: (stage) => setAnalysisPhase(stage), onDone: (result) => handleFlowAnalysisDone(result, flowReviewSession) }))),
        currentView === "graph" && React.createElement(GraphView, { notes: graphNotes, onSelectNoteByTitle: handleSelectNoteByTitle, onOpenNote: handleOpenContextNote, onStartReview: handleEnterReviewFromGraph }),
        currentView === "learn" && React.createElement(LearnHub, { notes, flowSettings: settings.flowSettings, onEnterFlow: handleEnterFlowMode, onUpdateNote: handleStormUpdateNote, onOpenNote: handleSelectNote, onEnterScene: handleEnterScene }),
        currentView === "scene" && isSceneS1Demo && React.createElement('div', { className: 'flex-1 min-h-0 h-full overflow-hidden' }, React.createElement(SceneS1DemoPage, { onOpenNote: handleSceneReference, onExit: handleExitScene, onSessionStatusChange: sceneGuard.updateStatus })),
        currentView === "scene" && isSceneS4Demo && React.createElement('div', { className: 'flex-1 min-h-0 h-full overflow-hidden' }, React.createElement(SceneS4DemoPage, { onExit: handleExitScene, onSessionStatusChange: sceneGuard.updateStatus })),
        // S2 owns cancellation/resource cleanup when leaving; its activity never locks workspace navigation.
        currentView === "scene" && !isSceneS1Demo && !isSceneS4Demo && sceneRequest?.sceneSkill === 'S2' && React.createElement('div', { className: 'flex-1 min-h-0 h-full overflow-y-auto' }, React.createElement(SceneS2CanvasTrial, { initialRequest: sceneRequest, initialDraft: sceneDraftSnapshot, projectNoteSource: s2ProjectNoteAccess.source, projectNoteSourceError: s2ProjectNoteAccess.error, onDraftChange: setSceneDraftSnapshot, onExit: handleExitScene })),
        currentView === "scene" && !isSceneS1Demo && !isSceneS4Demo && sceneRequest && sceneRequest.sceneSkill !== 'S2' && React.createElement('div', { className: 'flex-1 min-h-0 h-full overflow-y-auto' }, React.createElement(SceneMode, { allNotes: notes, initialRequest: sceneRequest, initialDraft: sceneDraftSnapshot, onDraftChange: setSceneDraftSnapshot, onExit: handleExitScene, onRunComplete: handleSceneRunComplete, onOpenNote: handleSceneReference, onSessionStatusChange: sceneGuard.updateStatus, completionContent: sceneCompletionContent })),
        currentView === "review" && reviewNoteId && React.createElement('div', { className: 'flex-1 min-h-0 h-full overflow-hidden' }, React.createElement(ReviewChat, {
          key: reviewActivation,
          noteId: reviewNoteId,
          noteTitle: reviewNoteTitle,
          questionText: reviewQuestion,
          knowledgeContext: reviewContext,
          allNotes: isReviewSessionDemo ? reviewPickerNotes : notes,
          onReviewComplete: isReviewSessionDemo ? (_analysis, _segments, episode) => {
            if (episode && reviewExitGuard.updateStatus('idle', episode.id)) setCurrentView('bubble');
          } : handleExitReview,
          onExitSaveStateChange: handleReviewExitSaveStateChange,
          onQuickCheckAfterSave: isReviewSessionDemo ? undefined : (noteId: string) => {
            quickCheckControllerRef.current?.open({ noteId, source: 'review_result' });
          },
          previewMessages: isReviewSessionDemo ? REVIEW_SESSION_DEMO_MESSAGES : undefined,
          previewEvidence: isReviewSessionDemo ? REVIEW_SESSION_DEMO_EVIDENCE : undefined,
          previewElapsedSeconds: isReviewSessionDemo ? 384 : undefined,
        })),
        currentView === "documents" && React.createElement(DocumentsView, { notes, getBindingScope: agentTaskScope,
          onSaveDocumentBindings: async (document, projectIds, expectedIds, scopeId) => {
            if (!notesHydrated || isPlanPreviewDemo || rendererExitPreparation.isStopping()) throw new Error('资料库尚未就绪或正在退出，暂不能修改绑定');
            if (scopeId !== await agentTaskScope()) throw new Error('资料库已切换，请重新打开绑定面板');
            const stored = (await listDocuments()).find(item => item.id === document.id);
            if (!stored) throw new Error('该资料已不存在，请刷新列表');
            const change = prepareDocumentProjectBindings(notesRef.current, stored, projectIds, expectedIds);
            if (change) await commitAgentNoteChange(change, undefined, scopeId);
            else if (pendingNotesRef.current) await flushSave(pendingNotesRef.current);
          } }),
        currentView === "flow" && flowTargetNote && React.createElement(FlowMode, { key: flowTargetNote.id, note: notes.find((item) => item.id === flowTargetNote.id) || flowTargetNote, isActive: !contextNavigation.active && !isAgentOpen && !isCommandPaletteOpen, isVisible: !contextNavigation.active, allNotes: notes, reviewIntervalMinutes: flowReviewInterval, flowSettings: settings.flowSettings, initialResource: flowInitialResource || undefined, onExit: handleExitFlowMode, onUpdateNote: handleUpdateNote,
          onTextbookReadingPosition: handleTextbookReadingPosition, getTextbookReadingPosition, onOpenKnowledge: handleOpenContextNote }),
        currentView === "bubble" && React.createElement(ReviewHub, { allNotes: reviewPickerNotes, onEnterReview: handleEnterReviewFromBubble, launchRequest: reviewHubLaunchRequest }),
        currentView === "timeline" && React.createElement(PlanWorkspace, {
          capacitySettings: settings, onOpenLearningSettings: () => openPlanLearningSettings('timeline'),
          notes: planWorkspaceNotes,
          initialPlanId: planWorkspaceFocusId,
          onToggleTaskCompleted: handleTogglePlanWorkspaceTask,
          onToggleProjectCompleted: handleTogglePlanWorkspaceProject,
          onToggleMilestoneCompleted: handleTogglePlanWorkspaceMilestone,
          onSelectNoteByTitle: handleSelectPlanWorkspaceNote,
          onAddTask: handleAddPlanWorkspaceTask,
          onAddStructureItem: handleAddPlanWorkspaceStructureItem,
          onOpenPlanBuilder: () => {
            setAgentNewPlanDraft(null);
            setAgentPlanEditorQueue([]);
            setAgentPlanEditorBaseRevisions({});
            setEditingPlanRootId(null);
            setCurrentView("plan");
          },
          onOpenPlanEditor: (rootId: string) => {
            setAgentNewPlanDraft(null);
            setAgentPlanEditorQueue([]);
            setAgentPlanEditorBaseRevisions({});
            setPlanWorkspaceFocusId(rootId);
            setEditingPlanRootId(rootId);
            setCurrentView("plan");
          },
          onRequestPlanAdjustment: (scope: PlanAdjustmentScope) => {
            if (scope.kind === 'portfolio') {
              const scopedRoots = planWorkspaceNotes.filter((note) => scope.rootIds.includes(note.id));
              const rootSummary = scopedRoots.map((note) => `${note.title}（${note.id}）`).join('、');
              const stableRootIds = JSON.stringify(scope.rootIds);
              setAgentExternalRequest({
                id: `plan-adjust-portfolio-${Date.now()}`,
                text: `请统筹调整综合总览中的 ${scope.rootIds.length} 个根计划：${rootSummary}。精确作用域 rootProjectIds=${stableRootIds}。先调用 query_plan_portfolio 并传入这些 rootProjectIds 读取真实数据，检查跨计划的日期冲突、里程碑和周负荷；再调用 start_plan_portfolio_draft 锁定同一组 rootProjectIds，通过组合草案统一预览。可以调整各根内部既有项目的日期与优先级，但不得新增、删除或跨根移动项目，也不得逐根直接提交；若条件冲突，先说明影响并等待我确认。`,
                targetSkillId: 'plan-planning',
              });
            } else {
              const meta = scope.meta;
              const conditionSummary = meta ? `必须保留的计划条件：本计划每日投入 ${meta.dailyStudyMinutes ?? '待确认'} 分钟；个人共享周预算 ${settingsRef.current.learningWeeklyBudgetMinutes ?? '待确认'} 分钟，先查询 query_learning_capacity 核对其他计划占用；学习日 ${meta.activeWeekdays?.join(',') || '1,2,3,4,5,6'}；自动调整策略 ${meta.autoAdjustPolicy || 'ask'}；条件 ${JSON.stringify(meta.conditions || {})}。` : '';
              setAgentExternalRequest({
                id: `plan-adjust-${Date.now()}`,
                text: `请调整学习计划“${scope.title}”（根项目 ID：${scope.id}）。先用 query_plan_workspace 按 rootProjectId 读取真实计划任务，分析里程碑、依赖和周负荷。${conditionSummary}若条件互相冲突，先说明影响并生成草案，不要直接覆盖原计划。`,
                targetSkillId: 'plan-planning',
              });
            }
            setIsAgentOpen(true);
          },
        }),
        currentView === "plan" && React.createElement(PlanBuilder, {
          capacitySettings: settings, allPlanNotes: notes, onOpenLearningSettings: () => openPlanLearningSettings('plan'),
          isActive: !contextNavigation.active,
          draftStorageKey: agentNewPlanDraft || agentPlanEditorQueue.length ? undefined : planDraftKey(`${isPlanPreviewDemo ? 'demo:' : ''}${editingPlanRootId || 'new'}`),
          key: agentNewPlanDraft?.id || agentPlanEditorQueue[0]?.rootId || editingPlanRootId || 'new-plan',
          onBatchCreate: async (tree: PlanNode[], planMeta?: Partial<PlanMeta>) => {
            const originatedFromAgent = Boolean(agentNewPlanDraft);
            const confirmedEditorDraftId = agentNewPlanDraft?.id;
            const persisted = await handleBatchCreateProjectTree(tree, planMeta);
            if (!persisted) throw new Error('草图中没有可以写入的项目');
            if (!originatedFromAgent) clearManualPlanDraft(planDraftKey(`${isPlanPreviewDemo ? 'demo:' : ''}new`));
            setAgentNewPlanDraft(null);
            setAgentPlanEditorBaseRevisions({});
            if (originatedFromAgent && persisted && !isPlanPreviewDemo) {
                updateWorkflowHandoff(buildPersistedPlanHandoff({
                  scopeProjectId: persisted.rootId,
                  scopeProjectTitle: persisted.rootTitle,
                  taskCount: persisted.taskCount,
                  sourceSkillId: 'plan-planning',
                }));
                if (confirmedEditorDraftId) {
                  setAgentExternalRequest({
                    id: `plan-editor-complete-${confirmedEditorDraftId}`,
                    text: '计划已在编辑器中确认并保存。请简洁汇总本次结果，不重复创建计划。',
                    targetSkillId: 'plan-planning',
                    observedOutcome: { kind: 'plan-writeback', eventId: confirmedEditorDraftId,
                      editorDraftId: confirmedEditorDraftId, rootProjectId: persisted.rootId },
                  });
                }
            }
          },
          initialValue: editingPlanInitialValue,
          draftValue: agentNewPlanDraft?.value || (agentPlanEditorQueue[0] ? {
            tree: agentPlanEditorQueue[0].tree,
            planMeta: agentPlanEditorQueue[0].planMeta,
            sourceLabel: agentPlanEditorQueue.length > 1
              ? `Agent 综合计划草图：当前第 1 / ${agentPlanEditorQueue.length} 个根计划，尚未写入`
              : 'Agent 计划调整草图已导入，尚未写入',
          } : null),
          onDraftChange: (value: PlanBuilderDraftValue) => {
            setAgentNewPlanDraft((current) => current ? { ...current, value } : current);
            setAgentPlanEditorQueue((current) => current.length > 0 ? [{
              ...current[0],
              tree: value.tree,
              planMeta: value.planMeta,
            }, ...current.slice(1)] : current);
          },
          onBatchUpdate: handleUpdatePublishedPlan,
          onCancel: () => {
            if (!agentNewPlanDraft && !agentPlanEditorQueue.length) clearManualPlanDraft(planDraftKey(`${isPlanPreviewDemo ? 'demo:' : ''}${editingPlanRootId || 'new'}`));
            if (editingPlanRootId) setPlanWorkspaceFocusId(editingPlanRootId);
            setAgentNewPlanDraft(null);
            setAgentPlanEditorQueue([]);
            setAgentPlanEditorBaseRevisions({});
            setEditingPlanRootId(null);
            setCurrentView('timeline');
          },
        }),
        currentView === "settings" && React.createElement(SettingsModal, {
          initialSection: learningSettingsOrigin ? 'learning' : undefined,
          onBack: learningSettingsOrigin ? () => setCurrentView(learningSettingsOrigin) : undefined,
          backLabel: learningSettingsOrigin === 'plan' ? '返回计划草稿' : '返回学习计划',
          settings, onUpdateSettings: appSettings.update, appSettingsState: appSettings,
          onRetryAppSettingsLoad: () => { void appSettings.retryLoad(); }, onRetryAppSettingsSave: () => { void appSettings.retrySave(); },
          syncStatus, onTriggerSync: handleTriggerSync, notes,
        })
        ),
        React.createElement(ContextNotePages, {
          navigation: contextNavigation,
          sourceLabel: getContextSourceLabel(currentView, activeNote?.title),
          getNote: (id: string) => (isPlanPreviewDemo ? planPreviewNotes : isSceneS1Demo ? [...SCENE_S1_DEMO_NOTES, ...notesRef.current] : notesRef.current)
            .find((note) => note.id === id) || null,
          onMove: contextNavigation.move,
          renderNote: (note, page, isActive) => isPlanPreviewDemo || isSceneS1Demo || isSceneS4Demo
            ? React.createElement('article', { className: 'context-note-readonly' },
              React.createElement('p', { className: 'mb-3 text-xs text-[var(--ln-text-muted)]' }, '演示笔记 · 只读详情'),
              React.createElement('h1', null, note.title),
              React.createElement(SceneRichMessage, { content: note.content.replace(/^#\s+[^\n]*\n*/, '') || '暂无内容' }))
            : React.createElement(NoteEditor, { note, isActive: isActive && !isAgentOpen && !isCommandPaletteOpen, isVisible: isActive, allNotes: notesRef.current, onUpdateNote: handleUpdateNote, onEditNote: handleEditNote, onFinishEditing: handleFinishNoteEditing, saveState: noteSaveState, onRetrySave: retryNoteSave, onSetLearningCompletion: handleSetLearningCompletion, onTextbookReadingPosition: handleTextbookReadingPosition, getTextbookReadingPosition,
              onSelectNoteByTitle: handleSelectNoteByTitle, onOpenNote: handleOpenContextNote, projectContextId: page.projectContextId,
              onContinueProgressive: (noteId) => handleEnterFlowMode(noteId, settings.flowSettings.reviewIntervalMinutes),
              headingRequest: page.heading ? { heading: page.heading, key: page.key } : undefined,
              onOpenConceptFill: setConceptFillNote, onArgumentBlockEdit: handleArgumentBlockEdit,
              onArgumentBlockDelete: handleArgumentBlockDelete, onArgumentRagWithdraw: handleArgumentRagWithdraw,
              getArgumentDoc, onLearningReviewPatch: handleLearningReviewPatch, settings, onRecommendProjectResources: handleProjectResourceRecommendation,
              contentVersion: editorRefreshVersion, publication: notes }),
        })
        )
      )
    ),
    React.createElement(CommandPalette, { isOpen: isCommandPaletteOpen && !reviewExitGuard.locked && !sceneGuard.locked, onClose: () => setIsCommandPaletteOpen(false), notes: isCommandPaletteOpen ? notesRef.current : notes, onSelectNote: handleSelectNote, onNewNote: handleNewNote, onSelectView: setCurrentView }),
    React.createElement(AgentPanel, {
      open: isAgentOpen && !sceneGuard.locked && !reviewExitGuard.locked,
      workflowDraftReady,
      role: agentRole,
      ctx: agentCtx,
      selectedProjectTitle: agentFocusedNote?.noteType === 'project' ? agentFocusedNote.title : undefined,
      planDraftSession,
      onDiscardPlanDraft: () => updatePlanDraftSession(null),
      resourceDraftSession,
      onDiscardResourceDraft: () => {
        closeDraftBrowserSessions(resourceDraftSessionRef.current);
        updateResourceDraftSession(null);
      },
      onOpenResource: handleAgentOpenResource,
      onDownloadResource: handleAgentDownloadResource,
      onScanResourcePage: handleAgentScanResourcePage,
      onAuthorizeResource: handleAgentAuthorizeResource,
      onSetResourceCandidateDecision: handleAgentResourceDecision,
      resourceActivity,
      workflowHandoff,
      onWorkflowHandoffChange: updateWorkflowHandoff,
      onContinueLearning: (rootId: string) => {
        if (!allowWorkspaceNavigation()) return false;
        const entry = buildLearningProjectQueue(notesRef.current, homeLocalDate()).find(entry => entry.note.id === rootId || entry.parentChain.some(parent => parent.id === rootId));
        if (!entry) return false;
        handleEnterFlowMode(entry.note.id, settings.flowSettings.reviewIntervalMinutes); setIsAgentOpen(false); return true;
      },
      onClose: () => setIsAgentOpen(false),
      onBusyChange: setIsAgentBusy,
      externalRequest: agentExternalRequest,
      onOpen: () => { if (allowWorkspaceNavigation()) setIsAgentOpen(true); },
    }),
    !sceneGuard.locked && !reviewExitGuard.locked && React.createElement(AgentOrb, { open: isAgentOpen, busy: isAgentBusy, hasRecommendation: Boolean(workflowHandoff), onToggle: () => { if (allowWorkspaceNavigation()) setIsAgentOpen(p => !p); } }),
    sceneReferenceNote && React.createElement(SceneReferenceDialog, { note: sceneReferenceNote, onClose: () => setSceneReferenceNote(null) }),
    sceneGuard.notice && React.createElement('div', { className: 'scene-lock-notice', role: 'status' }, sceneGuard.notice),
    reviewExitGuard.notice && React.createElement('div', { className: 'scene-lock-notice', role: 'status' }, reviewExitGuard.notice),
    React.createElement(SelectionActionHub, { onAction: handleSelectionAction }),
    React.createElement(KnowledgeMaintenanceHub, { notes, onPrepare: async () => { await capturePendingChanges(); await flushPendingChanges(); },
      getNotes: () => notesRef.current, onCommit: (change: WorkspaceNoteChange) => commitAgentNoteChange(change),
      onUndo: async (operationId: string) => { const record = await agentOperationStore.get(operationId); return commitAgentNoteChange(prepareOperationUndo(notesRef.current, record), operationId); } }),
    React.createElement(PrivacyPolicyModal, { isOpen: isPrivacyOpen, onClose: () => setIsPrivacyOpen(false) }),
    React.createElement(ArgumentActionDialog, { request: argumentAction, onCancel: () => setArgumentAction(null), onConfirm: confirmArgumentAction }),
    isSelectionOpen && React.createElement(KnowledgePointSelectionModal, { candidates: knowledgeDiscovery.candidates, knowledgeNotes: notes.filter(n => n.noteType === "knowledge"), loading: knowledgeDiscovery.loading, error: knowledgeDiscovery.error, onRetry: () => { void knowledgeDiscovery.retry(); }, onClose: () => { setIsSelectionOpen(false); void cancelStoredFlowReview(flowReviewSession).catch(reportLearningSaveError); }, onConfirm: handleConfirmKnowledgePoints }),
    analysisProgressOpen && React.createElement(AnalysisProgressModal, { phase: analysisPhase, offline: analysisOffline, error: analysisError, onClose: () => { setAnalysisProgressOpen(false); setAnalysisOffline(false); setAnalysisError(''); } }),
    conceptFillNote && React.createElement(ConceptFillModal, { key: conceptFillNote.id, note: conceptFillNote, onClose: () => setConceptFillNote(null), onConfirm: async (content, references) => {
      const expected = conceptFillNote;
      await persistLearningMutation(expected.id, current => prepareConceptNoteWrite(current, expected, content, references));
    } })
  ));
}
