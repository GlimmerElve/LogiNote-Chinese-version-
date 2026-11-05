import type {
  LlmConversationMessage,
  LlmTool,
  LlmToolCall,
  LlmWorkflowId,
  NoteItem,
  AgentPersonaSettings,
  PlanMeta,
  PlanConditions,
  PlanExecutionKind,
  PlanRecurrenceRule,
  PlanTaskKind,
  PlanTaskBlueprint,
  ResourceItem,
  SceneCapabilityId,
  ScenePromptModuleId,
  SceneRecipeId,
  ViewMode,
  VaultSettings,
} from '../../types';
import type { AgentSequenceExecution } from './skillSequence';
import type { LearningTaskBinding } from '../learningCompletion';
import type { MasteryShadowCriterionId } from '../masteryShadow/rubric';

export type AgentToolLocation = 'main' | 'renderer';
export type AgentToolPermission = 'readonly' | 'navigation' | 'write';

export interface AgentPlanTaskChange {
  operation: 'add' | 'reschedule' | 'reprioritize';
  noteTitle: string;
  taskText: string;
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
}

export interface AgentProjectPlanNode {
  estimatedMinutes?: number;
  /** 草案内稳定键，用于解析任务、里程碑和项目的交叉引用。 */
  key?: string;
  title: string;
  startDate?: string;
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
  outcome?: string;
  milestone?: {
    id: string;
    title: string;
    dueDate: string;
    description?: string;
  };
  /** 执行层事项；不会创建新的项目笔记。 */
  tasks?: PlanTaskBlueprint[];
  children?: AgentProjectPlanNode[];
}

export interface AgentProjectPlanInput {
  root: AgentProjectPlanNode;
  planMeta?: Partial<PlanMeta>;
}

export interface AgentKnowledgeNoteInput {
  title: string;
  content: string;
  tags?: string[];
}

export interface AgentCreateNoteInput extends AgentKnowledgeNoteInput {
  noteType: 'knowledge' | 'project';
  projectRole?: 'learning' | 'reference';
  parentProjectId?: string;
  parentProjectTitle?: string;
}

export interface AgentDeleteNotesInput {
  noteIds: string[];
  includeProjectDescendants: boolean;
}

export interface AgentSceneLaunchRequest {
  source: 'build' | 'auto';
  subject: string;
  knowledgePoints: string[];
  customTitle?: string;
  roleHints?: string;
  extraHints?: string;
  recipeId?: SceneRecipeId;
  requestedCapabilities?: SceneCapabilityId[];
  requestedPromptModules?: ScenePromptModuleId[];
  sceneSkill: 'S1' | 'S4';
  /** Exact plan identity; scene titles and knowledge references do not imply completion. */
  taskBinding?: LearningTaskBinding;
}

export interface AgentReviewLaunchRequest {
  scope: 'knowledge' | 'project';
  strategy: 'smart' | 'weak' | 'random';
  /** Optional existing note/project title used only to focus the picker. */
  noteTitle?: string;
}

/** Navigation only: the card owns reference retrieval, answers and mastery updates. */
export interface AgentQuickCheckLaunchRequest {
  /** An explicit stable knowledge-note ID never falls back to a title/current note. */
  noteId?: string;
  /** Optional focus; the local card rechecks current gaps before generating questions. */
  criterionIds?: MasteryShadowCriterionId[];
  /** Only on explicit user request. Unfinished answers require card confirmation. */
  regenerate?: boolean;
}

export interface AgentProjectStudyTasksInput {
  projectTitle: string;
  tasks: string[];
}

export interface AgentProjectStudyTaskBatchInput {
  rootProjectTitle: string;
  projects: AgentProjectStudyTasksInput[];
  createKnowledgeNotes: string[];
}

export type AgentPlanDraftMode = 'full-task-generation' | 'revise-subtree';
export type AgentPlanDraftPurpose = 'structure' | 'study-tasks' | 'plan-layout';

export interface AgentProjectStructurePatch {
  operation: 'update' | 'add_child' | 'move' | 'delete_subtree';
  projectTitle?: string;
  parentProjectTitle?: string;
  newParentProjectTitle?: string;
  title?: string;
  startDate?: string;
  dueDate?: string;
  clearStartDate?: boolean;
  clearDueDate?: boolean;
  priority?: 'high' | 'medium' | 'low';
}

/** 根计划设置补丁；只修改显式提供的字段。 */
export interface AgentPlanMetaPatch {
  dailyStudyMinutes?: number;
  status?: PlanMeta['status'];
  shortTitle?: string;
  summary?: string;
  startDate?: string;
  targetDate?: string;
  weeklyBudgetMinutes?: number;
  activeWeekdays?: number[];
  portfolioPriority?: PlanMeta['portfolioPriority'];
  autoAdjustPolicy?: PlanMeta['autoAdjustPolicy'];
  conditions?: PlanConditions;
}

/** 里程碑的完成状态属于用户验收记录，Agent 补丁故意不暴露 completed。 */
export interface AgentPlanMilestonePatch {
  operation: 'add' | 'update' | 'delete';
  milestoneId: string;
  title?: string;
  dueDate?: string;
  criteria?: string[];
  projectTitle?: string;
  clearCriteria?: boolean;
  clearProject?: boolean;
}

export interface AgentPlanExecutionPatch {
  operation: 'add' | 'update' | 'delete';
  /** add 时由 Agent 提供草案内唯一键，提交后直接作为稳定任务 ID。 */
  taskId: string;
  noteTitle?: string;
  taskText?: string;
  kind?: PlanTaskKind;
  executionKind?: PlanExecutionKind;
  startDate?: string;
  dueDate?: string;
  estimatedMinutes?: number;
  priority?: 'high' | 'medium' | 'low';
  recurrence?: PlanRecurrenceRule;
  milestoneId?: string;
  linkedProjectTitle?: string;
  linkedKnowledgeTitles?: string[];
  launchMode?: 'none' | 'flow' | 'scene' | 'review';
  reminderMinutes?: number;
  clearRecurrence?: boolean;
  clearMilestone?: boolean;
  clearLinkedProject?: boolean;
  clearLinkedKnowledge?: boolean;
}

/**
 * A root-scoped portion of a portfolio draft. Portfolio coordination may
 * change timing, priority, capacity, milestones and execution items in
 * several roots. Structure patches are restricted to date/priority updates;
 * projects never move across roots as a side effect of portfolio balancing.
 */
export interface AgentPortfolioPlanRootDraft {
  rootProjectId: string;
  rootProjectTitle: string;
  baseProjectRevisions: Record<string, string>;
  /** Date/priority-only updates inside this root; hierarchy changes stay forbidden. */
  structurePatches: AgentProjectStructurePatch[];
  planMetaPatch?: AgentPlanMetaPatch;
  milestonePatches: AgentPlanMilestonePatch[];
  executionPatches: AgentPlanExecutionPatch[];
}

export interface AgentPortfolioPlanRootPatchInput {
  /** Stable root id returned by query_plan_portfolio. Titles are not accepted. */
  rootProjectId: string;
  structurePatches?: AgentProjectStructurePatch[];
  planMetaPatch?: AgentPlanMetaPatch;
  milestonePatches?: AgentPlanMilestonePatch[];
  executionPatches?: AgentPlanExecutionPatch[];
}

export interface AgentPlanDraftSession {
  id: string;
  /** Missing on legacy sessions and therefore treated as a single-root draft. */
  scopeKind?: 'root' | 'portfolio';
  mode: AgentPlanDraftMode;
  purpose: AgentPlanDraftPurpose;
  scopeProjectId: string;
  scopeProjectTitle: string;
  baseProjectRevisions: Record<string, string>;
  projects: AgentProjectStudyTasksInput[];
  createKnowledgeNotes: string[];
  structurePatches: AgentProjectStructurePatch[];
  planMetaPatch?: AgentPlanMetaPatch;
  milestonePatches: AgentPlanMilestonePatch[];
  executionPatches: AgentPlanExecutionPatch[];
  /** Root-id keyed, revision-locked state for an atomic portfolio draft. */
  portfolioRoots?: Record<string, AgentPortfolioPlanRootDraft>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPlanDraftSummary {
  sessionId: string;
  mode: AgentPlanDraftMode;
  scopeProjectId: string;
  scopeProjectTitle: string;
  projectCount: number;
  taskCount: number;
  createKnowledgeNotes: string[];
  structurePatchCount: number;
  planMetaPatchCount: number;
  milestonePatchCount: number;
  executionPatchCount: number;
  scopeKind?: 'root' | 'portfolio';
  rootCount?: number;
  rootProjectTitles?: string[];
}

export interface AgentLearningResourceInput extends ResourceItem {
  taskText: string;
  knowledgeTitles: string[];
  reason: string;
  isFree: boolean;
}

export interface AgentProjectResourceDraftItem {
  projectTitle: string;
  resources: AgentLearningResourceInput[];
  /** 只允许填写该项目当前已经存在的资源 URL；与 resources 同时出现即表示替换。 */
  removeResourceUrls?: string[];
}

export interface AgentResourceDraftSession {
  id: string;
  scopeProjectId: string;
  scopeProjectTitle: string;
  /**
   * agent：由资源统筹 Skill 创建，必须绑定末级项目中的真实学习任务与知识点。
   * note-editor：由用户在项目笔记页主动发起，只允许写回被锁定的当前项目。
   */
  origin?: 'agent' | 'note-editor';
  directProjectTarget?: {
    projectId: string;
    taskText: string;
    knowledgeTitles: string[];
  };
  baseProjectRevisions: Record<string, string>;
  projects: AgentProjectResourceDraftItem[];
  discoveredResources: ResourceItem[];
  /** 仅由用户显式操作产生；普通打开、停留和点击不会被推断成偏好。 */
  selectedResourceUrls: string[];
  rejectedResourceUrls: string[];
  /** 仅供渲染进程关闭/复用窗口；不会传入 LLM。 */
  browserSessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentResourceDraftSummary {
  sessionId: string;
  scopeProjectId: string;
  scopeProjectTitle: string;
  projectCount: number;
  resourceCount: number;
  removalCount: number;
  discoveredResourceCount: number;
  selectedResourceCount: number;
  rejectedResourceCount: number;
}

export interface AgentToolConfirmation {
  title: string;
  description: string;
  impacts?: string[];
}

export interface AgentWorkspaceSnapshot {
  /** Monotonic UI navigation revision. It changes even when the view name stays the same. */
  revision: number;
  view: ViewMode;
  focusedNoteId?: string;
  focusedNoteTitle?: string;
  focusedNoteType?: NoteItem['noteType'];
  recentEvents?: AgentWorkspaceEvent[];
}

export interface AgentWorkspaceEvent {
  id: string;
  kind: 'review-completed' | 'flow-exited' | 'scene-completed' | 'learning-completion-changed' | 'background-task-completed';
  occurredAt: string;
  title: string;
  summary: string;
  noteId?: string;
  status?: string;
  score?: number;
}

export interface AgentRuntimeContext {
  getCognitionAssistantWork?: () => import('./cognitionAssistantState').CognitionAssistantWork;
  getCognitionAssistantCompletions?: () => import('./cognitionAssistantState').CognitionCompletionReceipt[];
  /** Ephemeral controller identity, not the durable chat ID or a write permission. */
  getCognitionProposalOwner?: () => string;
  prepareCognitionRead?: (args: Record<string, unknown>) => Record<string, unknown>;
  observeCognitionRead?: (args: Record<string, unknown>, result: unknown) => void;
  /** Trusted UI session identity; not an LLM-selected role or an authorization. */
  getConversationId?: () => string;
  /** Existing local documents: metadata-only reads and confirmed association changes. */
  documentBindings?: import('./documentBindings').DocumentBindingPort;
  resourceDownloads?: import('../resourceDownloads').ResourceDownloadPort;
  getLearningCapacitySettings?: () => Pick<VaultSettings, 'learningWeeklyBudgetMinutes'>;
  applyLearningCapacityPatch?: (patch: import('../learningCapacity').LearningCapacityPatch) => Promise<unknown>;
  /** Only the approved concept batch may use this storage-scope-bound, non-navigating save port. */
  applyConceptBatchChange?: (change: import('./workspaceOperations').WorkspaceNoteChange, scopeId: string) => Promise<unknown>;
  applyWorkspaceNoteChange?: (change: import('./workspaceOperations').WorkspaceNoteChange) => Promise<{ operationId: string; saved: boolean; changedNoteIds: string[] }>;
  undoWorkspaceOperation?: (operationId: string) => Promise<{ operationId: string; saved: boolean; changedNoteIds: string[] }>;
  getNotes: () => NoteItem[];
  getAgentPersona?: () => AgentPersonaSettings;
  getAgentExecutionMode?: () => import('../../types').AgentExecutionMode | undefined;
  getAgentToolCallLimit?: () => number | undefined;
  updateAgentPersona?: (persona: AgentPersonaSettings) => Promise<AgentPersonaSettings>;
  /** Optional plan-specific source used by isolated plan previews and tests. */
  getPlanNotes?: () => NoteItem[];
  getActiveNote?: () => NoteItem | null;
  /** Live page focus. This is trusted application state and outranks conversational history. */
  getWorkspaceSnapshot?: () => AgentWorkspaceSnapshot;
  recordWorkspaceEvent?: (event: AgentWorkspaceEvent) => void;
  publishTextbook?: import('../textbook/generationTypes').TextbookPublisher;
  openTextbookProject?: (projectNoteId: string) => boolean;
  navigate: (view: ViewMode) => void;
  openNoteByTitle: (title: string) => boolean;
  enterLearningMode: (input: {
    mode: 'flow' | 'review' | 'bubble' | 'scene' | 'quick_check';
    noteTitle?: string;
    question?: string;
    sceneRequest?: AgentSceneLaunchRequest;
    taskBinding?: LearningTaskBinding;
    reviewRequest?: AgentReviewLaunchRequest;
    quickCheckRequest?: AgentQuickCheckLaunchRequest;
  }) => boolean;
  createKnowledgeNote: (input: AgentKnowledgeNoteInput) => Promise<{
    noteId: string;
    title: string;
    tags: string[];
  }>;
  createNote?: (input: AgentCreateNoteInput) => Promise<{
    noteId: string;
    title: string;
    noteType: 'knowledge' | 'project';
    parentId?: string;
  }>;
  deleteNotes?: (input: AgentDeleteNotesInput) => Promise<{
    deletedCount: number;
    deletedTitles: string[];
  }>;
  renameProject?: (input: { projectId: string; title: string }) => Promise<{
    projectId: string;
    previousTitle: string;
    title: string;
  }>;
  getAppearance?: () => Pick<VaultSettings, 'theme' | 'accentColor'>;
  updateAppearance?: (patch: Partial<Pick<VaultSettings, 'theme' | 'accentColor'>>) => Promise<Pick<VaultSettings, 'theme' | 'accentColor'>>;
  applyPlanTaskChange: (change: AgentPlanTaskChange) => Promise<{
    operation: AgentPlanTaskChange['operation'];
    noteId: string;
    noteTitle: string;
    taskText: string;
    dueDate: string;
    priority: 'high' | 'medium' | 'low';
    draftImported?: boolean;
    requiresUserConfirmation?: boolean;
  }>;
  createProjectPlan: (root: AgentProjectPlanNode, planMeta?: Partial<PlanMeta>) => Promise<{
    rootNoteId: string;
    rootTitle: string;
    nodeCount: number;
    scheduledCount: number;
    milestoneCount?: number;
    executionTaskCount?: number;
    draftImported?: boolean;
    requiresUserConfirmation?: boolean;
    editorDraftId?: string;
  }>;
  appendProjectStudyTasks: (input: AgentProjectStudyTasksInput) => Promise<{
    projectNoteId: string;
    projectTitle: string;
    taskCount: number;
    linkedKnowledgeTitles: string[];
  }>;
  appendProjectStudyTaskBatch: (input: AgentProjectStudyTaskBatchInput) => Promise<{
    rootProjectTitle: string;
    projectCount: number;
    taskCount: number;
    createdKnowledgeTitles: string[];
    linkedKnowledgeTitles: string[];
  }>;
  getPlanDraftSession: () => AgentPlanDraftSession | null;
  /** A plan draft already imported into the visual editor but not committed. */
  hasPendingPlanEditorDraft?: () => boolean;
  startPlanDraftSession: (input: {
    scopeProjectTitle?: string;
    scopeKind?: 'root' | 'portfolio';
    rootProjectIds?: string[];
    mode: AgentPlanDraftMode;
    purpose: AgentPlanDraftPurpose;
  }) => AgentPlanDraftSummary;
  stagePlanDraftBatch: (input: {
    projects: AgentProjectStudyTasksInput[];
    createKnowledgeNotes: string[];
  }) => AgentPlanDraftSummary;
  stagePlanStructurePatches: (patches: AgentProjectStructurePatch[]) => AgentPlanDraftSummary;
  stagePlanMetaPatch: (patch: AgentPlanMetaPatch) => AgentPlanDraftSummary;
  stagePlanMilestonePatches: (patches: AgentPlanMilestonePatch[]) => AgentPlanDraftSummary;
  stagePlanExecutionPatches: (patches: AgentPlanExecutionPatch[]) => AgentPlanDraftSummary;
  stagePortfolioPlanPatches: (input: {
    roots: AgentPortfolioPlanRootPatchInput[];
  }) => AgentPlanDraftSummary;
  discardPlanDraftSession: () => { discarded: boolean; scopeProjectTitle?: string };
  commitPlanDraftSession: () => Promise<{
    scopeProjectTitle: string;
    projectCount: number;
    taskCount: number;
    createdKnowledgeTitles: string[];
    linkedKnowledgeTitles: string[];
    structurePatchCount: number;
    planMetaPatchCount: number;
    milestonePatchCount: number;
    executionPatchCount: number;
    rootCount?: number;
    rootProjectTitles?: string[];
    rootSummaries?: Array<{
      rootProjectId: string;
      rootProjectTitle: string;
      structurePatchCount: number;
      planMetaPatchCount: number;
      milestonePatchCount: number;
      executionPatchCount: number;
    }>;
    draftImported?: boolean;
    requiresUserConfirmation?: boolean;
  }>;
  getResourceDraftSession: () => AgentResourceDraftSession | null;
  getResourceCollectionMode?: () => 'review' | 'auto';
  startResourceDraftSession: (input: { scopeProjectTitle?: string }) => AgentResourceDraftSummary;
  searchOnlineLearningResources: (input: {
    projectTitle: string;
    taskText: string;
    knowledgeTitles: string[];
  }, execution?: { signal?: AbortSignal }) => Promise<{ resources: ResourceItem[]; markdown: string; status?: string; requiresUserConfirmation?: boolean }>;
  stageResourceDraftBatch: (projects: AgentProjectResourceDraftItem[]) => AgentResourceDraftSummary;
  discardResourceDraftSession: () => { discarded: boolean; scopeProjectTitle?: string };
  commitResourceDraftSession: () => Promise<{
    scopeProjectTitle: string;
    projectCount: number;
    resourceCount: number;
    addedResourceCount: number;
    updatedResourceCount: number;
    removedResourceCount: number;
  }>;
  ensureDataFresh: () => Promise<void>;
}

export interface AgentToolDefinition extends LlmTool {
  location: AgentToolLocation;
  permission: AgentToolPermission;
  /** 只读工具若会打开窗口、联网或触发其他敏感副作用，也必须先征得用户同意。 */
  requiresConfirmation?: boolean;
  /** Never inherited from automatic mode, workflow authorization or model-supplied fields. */
  requiresExplicitApproval?: boolean;
  requiresCognitionContext?: boolean;
  /** 用户在设置中给出的持续授权；只能由本地确定性状态判定，不得由 LLM 参数解锁。 */
  isPreauthorized?: (args: Record<string, unknown>, ctx: AgentRuntimeContext) => boolean;
  /** Approval binds to this exact draft, not whichever draft is current later. */
  bindsDraft?: 'plan' | 'resource';
  /** Optional immutable scope/state snapshot for long-running approved operations. */
  approvalSnapshot?: (args: Record<string, unknown>, ctx: AgentRuntimeContext) => Promise<unknown> | unknown;
  confirmation?: (args: Record<string, unknown>, ctx?: AgentRuntimeContext) => AgentToolConfirmation;
  execute: (args: Record<string, unknown>, ctx: AgentRuntimeContext, execution?: { signal?: AbortSignal; userApproved?: boolean; cognitionContext?: boolean }) => Promise<unknown> | unknown;
  /** Opt-in all-or-nothing execution of same-tool, individually bound approval items. */
  executeApprovedBatch?: (args: Record<string, unknown>[], ctx: AgentRuntimeContext, execution: { signal?: AbortSignal; userApproved: true; cognitionContext?: boolean }) => Promise<unknown[]>;
}

export interface AgentRole {
  id: string;
  name: string;
  systemPrompt: string;
  memoryWorkflow: LlmWorkflowId;
  allowedTools: string[];
  /** Skill 可使用的最高权限集合；缺省时与 allowedTools 相同。 */
  skillToolCeiling?: string[];
  /** Trusted application domain lock. It is never inferred from model output. */
  toolScope?: 'cognition';
}

/**
 * Stable specialist identifiers. New specialist roles must be registered before
 * they can participate in a coordinated run.
 */
export type AgentSpecialistId =
  | 'scene-architect'
  | 'scene-interaction-planner'
  | 'scene-reviewer'
  | 'plan-architect'
  | 'plan-policy-reviewer'
  | 'task-designer'
  | 'task-policy-reviewer'
  | 'resource-strategist'
  | 'resource-policy-reviewer'
  | 'qa-evidence-reviewer'
  | 'resource-evidence-reviewer'
  | 'project-scope-reviewer'
  | 'qa-answer-reviewer'
  | 'qa-answer-repairer';

export type AgentArtifactKind =
  | 'scene-architecture'
  | 'scene-interaction-plan'
  | 'scene-review'
  | 'plan-strategy'
  | 'plan-policy-review'
  | 'task-strategy'
  | 'task-policy-review'
  | 'resource-strategy'
  | 'resource-policy-review'
  | 'qa-evidence-review'
  | 'resource-evidence-review'
  | 'project-scope-review'
  | 'qa-answer-review'
  | 'qa-answer-repair';

export type AgentCoordinationWorkflowId =
  | 'scene-design-v1'
  | 'learning-plan-v1'
  | 'study-task-v1'
  | 'resource-curation-v1'
  | 'qa-evidence-review-v1'
  | 'resource-evidence-review-v1'
  | 'project-scope-review-v1'
  | 'qa-answer-gate-v1';

export interface AgentTaskBudget {
  maxLlmCalls: number;
  maxToolCalls: number;
  maxOutputChars: number;
}

/** A serializable, bounded hand-off contract between specialist agents. */
export interface AgentTaskEnvelope {
  version: 1;
  id: string;
  runId: string;
  parentTaskId?: string;
  specialistId: AgentSpecialistId;
  objective: string;
  inputArtifactIds: string[];
  allowedTools: string[];
  budget: AgentTaskBudget;
  createdAt: string;
}

export interface AgentArtifact<T = unknown> {
  version: 1;
  id: string;
  taskId: string;
  kind: AgentArtifactKind;
  producer: AgentSpecialistId;
  payload: T;
  provenance: {
    sourceArtifactIds: string[];
    generatedAt: string;
  };
  validation: {
    status: 'valid' | 'invalid';
    diagnostics: string[];
  };
}

export type AgentCoordinationStepStatus = 'completed' | 'failed' | 'skipped';

export interface AgentCoordinationStep {
  taskId: string;
  specialistId: AgentSpecialistId;
  status: AgentCoordinationStepStatus;
  llmCalls: number;
  toolCalls: number;
  outputChars: number;
  artifactKinds: AgentArtifactKind[];
  diagnosticCodes: string[];
}

export interface AgentCoordinationBudget {
  maxTasks: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxOutputChars: number;
}

/** Ephemeral runtime state. Only AgentCoordinationSummary is persisted. */
export interface AgentRunContext {
  runId: string;
  workflowId: AgentCoordinationWorkflowId;
  userRequest: string;
  artifacts: AgentArtifact[];
  remainingBudget: AgentCoordinationBudget;
}

/**
 * Safe coordination summary returned to UI/audit. Artifact payloads and model
 * reasoning are deliberately excluded.
 */
export interface AgentCoordinationSummary {
  version: 1;
  runId: string;
  workflowId: AgentCoordinationWorkflowId;
  status: 'completed' | 'degraded' | 'failed';
  steps: AgentCoordinationStep[];
  totals: {
    llmCalls: number;
    toolCalls: number;
    outputChars: number;
  };
  fallbackApplied: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  memoryWorkflow: LlmWorkflowId;
  allowedTools: string[];
  matches: (userText: string) => boolean;
}

export interface AgentToolStep {
  call: LlmToolCall;
  ok: boolean;
  result?: unknown;
  error?: string;
  effectKey?: string;
  reused?: boolean;
}

/** Trusted UI completion event, never inferred from user/model message text. */
export type AgentObservedOutcome = {
  kind: 'resource-writeback';
  eventId: string;
  resourceCount: number;
  projects: Array<{ noteId: string; resourceUrls: string[] }>;
  draftSessionId?: string;
} | {
  kind: 'plan-writeback';
  eventId: string;
  editorDraftId: string;
  rootProjectId: string;
} | {
  kind: 'plan-writeback-failed';
  eventId: string;
  editorDraftId: string;
};

export type AgentRunNodeId =
  | 'route'
  | 'memory'
  | 'coordinate'
  | 'tool-loop'
  | 'approval'
  | 'final-answer'
  | 'audit';

export type AgentRunStatus = 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled';

export interface AgentActiveSkillRef {
  id: string;
  name: string;
}

/** Versioned, data-only resume point. Tool permissions are intentionally excluded. */
export interface AgentRunCheckpoint {
  version: 1;
  runId: string;
  createdAt: string;
  userText: string;
  baseRoleId: string;
  activeSkill?: AgentActiveSkillRef;
  hasActiveDraft: boolean;
  systemPrompt: string;
  dataVersionBefore?: number;
  completedNodes: AgentRunNodeId[];
  sequenceExecution?: AgentSequenceExecution;
}

export type AgentActivityPhase =
  | 'syncing'
  | 'routing'
  | 'memory'
  | 'coordinating'
  | 'reasoning'
  | 'tool'
  | 'reviewing'
  | 'approval'
  | 'stopping'
  | 'finalizing';

/** Renderer-facing progress only; never used as model context or audit evidence. */
export interface AgentActivityUpdate {
  phase: AgentActivityPhase;
  toolName?: string;
  /** Emitted immediately after routing so the panel can show the selected Skill while work continues. */
  skillId?: string;
  skillName?: string;
}

export interface AgentApprovalItem extends AgentToolConfirmation {
  call: LlmToolCall;
  binding?: AgentApprovalBinding;
}

export interface AgentApprovalBinding {
  version: 1;
  argumentsFingerprint: string;
  stateFingerprint?: string;
  draft?: { kind: 'plan' | 'resource'; id: string; fingerprint: string };
}

export interface AgentPendingApproval {
  id: string;
  items: AgentApprovalItem[];
  continuation: {
    userText: string;
    systemPrompt: string;
    roundsUsed: number;
    skillId?: string;
    auditRunId?: string;
    postToolReviewEnabled?: boolean;
    executionMode?: import('../../types').AgentExecutionMode;
    toolCallLimit?: number;
    runtimeMetrics?: AgentRuntimeMetrics;
    checkpoint?: AgentRunCheckpoint;
  };
}

/** 主 Agent 循环的可审计预算；专职 Agent 调用量另见 coordination。 */
export interface AgentRuntimeMetrics {
  llmCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AgentTurnResult {
  reply: string;
  updatedHistory: LlmConversationMessage[];
  toolTrace: AgentToolStep[];
  truncated: boolean;
  activeSkill?: { id: string; name: string };
  pendingApproval?: AgentPendingApproval;
  /** 对应 agent-audit.json 中的运行记录，用于关联 Skill 移交是否到达目标。 */
  auditRunId?: string;
  /** Multi-agent execution metadata only; specialist prompts and payloads stay ephemeral. */
  coordination?: AgentCoordinationSummary;
  /** Includes pre-execution and post-tool specialist runs in chronological order. */
  coordinationRuns?: AgentCoordinationSummary[];
  runtimeMetrics?: AgentRuntimeMetrics;
}

export type AgentWorkflowStage = 'plan' | 'scene' | 'review';

/**
 * Skill 间只传递可定位的引用与下一步意图，不携带完整对话、笔记正文或模型推理。
 * 这是当前单 Agent 阶段的短期移交协议，也是以后拆分 LangGraph 节点时的输入契约候选。
 */
export interface AgentWorkflowAction {
  destination?: 'learning';
  id: string;
  targetSkillId: 'study-task-generation' | 'resource-curation' | 'scene-setup' | 'socratic-review' | 'plan-planning';
  label: string;
  description: string;
  prompt: string;
}

export interface AgentWorkflowHandoff {
  version: 1;
  id: string;
  sourceStage: AgentWorkflowStage;
  sourceSkillId?: string;
  sourceArtifactId?: string;
  scopeProjectId?: string;
  scopeProjectTitle?: string;
  knowledgePointTitles: string[];
  outcome: string;
  actions: AgentWorkflowAction[];
  createdAt: string;
}
