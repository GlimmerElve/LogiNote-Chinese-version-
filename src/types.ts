import type { LearningAbility } from './services/learningAbility/types';
import type { ArgDoc, ArgumentPublishedSnapshot, ArgumentSourceRef } from './services/argumentDoc/types';
import type { TextbookManifest, LearningReviewRecord, LearningContentMigration, TextbookReadingState } from './services/textbook/types';

export type NoteType = 'project' | 'knowledge';

export type GraphMode = 'knowledge' | 'overview' | 'path';

export type PlanTaskKind = 'learn' | 'practice' | 'review' | 'assessment';
export type PlanExecutionKind = 'todo' | 'flow' | 'practice' | 'review';
export type PlanRecurrenceFrequency = 'none' | 'daily' | 'weekdays' | 'weekly' | 'custom';
export type PlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type PlanStartingLevel = 'new' | 'basic' | 'intermediate' | 'advanced';
export type PlanPace = 'relaxed' | 'balanced' | 'intensive';

export interface PlanConditions {
  /** 用户用什么可观察结果判断计划达成。 */
  goalEvidence?: string;
  startingLevel?: PlanStartingLevel;
  pace?: PlanPace;
  preferredSessionMinutes?: number;
  preferredTimeOfDay?: 'morning' | 'afternoon' | 'evening' | 'flexible';
  deadlineMode?: 'hard' | 'flexible';
  reviewCadence?: 'light' | 'standard' | 'intensive';
  constraintNotes?: string;
}

export interface PlanMilestone {
  id: string;
  title: string;
  dueDate: string;
  criteria?: string[];
  projectId?: string;
  completed?: boolean;
  completedAt?: string;
}

export interface PlanPhaseWindow {
  projectId: string;
  startDate: string;
  endDate: string;
  outcome?: string;
  order?: number;
}

export interface PlanRecurrenceRule {
  frequency: PlanRecurrenceFrequency;
  interval?: number;
  /** 0–6 表示周日到周六；仅 custom / weekly 使用。 */
  weekdays?: number[];
  timeOfDay?: string;
  endDate?: string;
  missedPolicy?: 'skip' | 'rollover' | 'keep';
}

/** 只挂在学习计划根项目上；项目树本身仍由 NoteItem.parentId 表达。 */
export interface PlanMeta {
  /** Only explicitly confirmed plans opt into resumable root resource preparation. */
  resourcePreparationVersion?: 1;
  /** Local planning draft attachment choices; source bytes are never included. */
  preparationDocuments?: Array<{ id: string; title: string; indexable: boolean }>;
  schemaVersion: 2;
  status: PlanStatus;
  shortTitle?: string;
  summary?: string;
  startDate?: string;
  targetDate?: string;
  weeklyBudgetMinutes?: number;
  /** 本计划每日学习强度；叶子项目默认继承。weeklyBudgetMinutes 仅保留兼容旧数据。 */
  dailyStudyMinutes?: number;
  activeWeekdays?: number[];
  portfolioPriority?: 'high' | 'medium' | 'low';
  autoAdjustPolicy?: 'ask' | 'automatic' | 'off';
  conditions?: PlanConditions;
  phaseWindows?: PlanPhaseWindow[];
  milestones?: PlanMilestone[];
  /** Actual public web excerpts used for this plan draft, never model-invented sources. */
  research?: import('./services/planResearch').PlanResearchBundle;
  updatedAt?: string;
}

export interface DueDateItem {
  id: string;
  noteId: string;
  noteTitle: string;
  taskText: string;
  dueDate: string;
  completed: boolean;
  /** 最近一次被勾选为完成的时间；用于聚合按时率，不记录逐次点击历史。 */
  completedAt?: string;
  priority: 'high' | 'medium' | 'low';
  /** 首次自动调整前的日期，便于解释与后续恢复。 */
  originalDueDate?: string;
  /** 最近一次由本地动态调度器调整的时间。 */
  autoAdjustedAt?: string;
  /** 面向用户的简短调整原因。 */
  autoAdjustmentReason?: string;
  /** 防止同一任务取消完成后再次勾选时重复顺延计划。 */
  completionAdjustmentAppliedAt?: string;
  /** 计划工作台中的任务轨道；旧任务由标题在展示时保守推断。 */
  kind?: PlanTaskKind;
  /** 时间线跨度起点；缺省时与 dueDate 相同。 */
  startDate?: string;
  /** 用于周容量与多计划冲突检测。 */
  estimatedMinutes?: number;
  /** 执行事项是否额外占用容量；included 表示已包含在关联叶子项目内。 */
  capacityKind?: 'additional' | 'included';
  dependencyTaskIds?: string[];
  milestoneId?: string;
  order?: number;
  source?: 'llm' | 'manual' | 'scheduler' | 'dsr' | 'legacy';
  /** 执行层任务不会创建新的项目笔记。 */
  executionKind?: PlanExecutionKind;
  recurrence?: PlanRecurrenceRule;
  linkedProjectId?: string;
  linkedKnowledgeIds?: string[];
  launchMode?: 'none' | 'flow' | 'scene' | 'review';
  reminderMinutes?: number;
  /** 周期任务已完成的 occurrence 日期；completed 仅表示当前 occurrence。 */
  completedOccurrenceDates?: string[];
}

export type ResourceKind = 'online' | 'local';

export type LocalFileType =
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video'
  | 'text'
  | 'html'
  | 'office'
  | 'other';

export type ResourceContentKind =
  | 'webpage'
  | 'article'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'presentation'
  | 'document'
  | 'image'
  | 'archive'
  | 'other';

export interface ResourceItem {
  title: string;
  url: string;
  platform?: string;
  /** 资源工作台候选绑定的项目；仅用于将人工确认结果精确归档。 */
  projectTitle?: string;
  /** 该候选由哪一类检索意图发现；用于分类配额与显式偏好，不限制用户手动选择数量。 */
  searchCategory?: ResourceSearchCategory;
  /** Model-reviewed evidence from this search batch, never a claimed URL supplied by a model. */
  semanticReview?: { version: 1; score: number; reason: string; topics?: string[] };
  /** Public query which produced this candidate; used to balance semantic evidence across planned searches. */
  searchQuery?: string;
  /** 区分在线/本地资源，缺省按 online 处理 */
  kind?: ResourceKind;
  /** 收录来源；自动推荐不能把自身结果当作用户站点认可。旧资源可缺失。 */
  collectionOrigin?: 'user' | 'agent';
  /** 本地文件类型，用于 webview 内嵌/兜底判断 */
  fileType?: LocalFileType;
  /** 下载后在本地资料库中的稳定 ID，避免在笔记中持久化绝对路径。 */
  documentId?: string;
  /** 本地资料的原始在线来源。 */
  sourceUrl?: string;
  /** Agent 统筹资源时绑定的项目正文任务；旧资源可不填写。 */
  taskText?: string;
  /** 该资源服务的知识点标题，必须来自任务中的显式 wiki 链接。 */
  knowledgeTitles?: string[];
  /** 为什么该资源适合当前任务。 */
  reason?: string;
  level?: 'beginner' | 'intermediate' | 'advanced';
  language?: string;
  /** true=推定免费，false=明确不免费；undefined=未知，不等于收费。 */
  isFree?: boolean;
  /** 在线搜索或人工核验时间。 */
  verifiedAt?: string;
  /** 本次浏览器搜索生成的只读候选 ID；提交项目资源时不会持久化。 */
  candidateId?: string;
  /** 候选资源出现在哪个搜索结果页；仅用于本地溯源。 */
  sourcePageUrl?: string;
  /** 浏览器探测到的内容类型。 */
  contentType?: string;
  /** 服务器声明的资源字节数；未知时不填写。 */
  contentLength?: number;
  /** 下载时优先使用的服务器文件名。 */
  suggestedFileName?: string;
  /** 识别出的实际文件扩展名（不含点）。 */
  fileExtension?: string;
  /** 浏览器结构化识别出的资源形态。 */
  resourceType?: ResourceContentKind;
  /** 资源由当前页面、普通链接、媒体元素或页面元数据中的哪一类入口发现。 */
  detectedFrom?: 'page' | 'link' | 'media' | 'metadata';
  /** 页面公开元数据中的简短描述；登录资源不会传入 LLM。 */
  description?: string;
  /** 是否是文件或媒体附件；并不等于当前资料库能够建立索引。 */
  isAttachment?: boolean;
  /** 当前是否支持经用户确认后直接下载到本地资料库。 */
  downloadable?: boolean;
  /** 下载入库后是否能够继续解析并建立 RAG 索引。 */
  indexable?: boolean;
  /** 访问条件；authenticated 也可能是验证/反爬，不表示已登录或已读正文。 */
  accessType?: 'public' | 'authenticated' | 'unknown';
  /** 本次链接检查的 HTTP 状态，区分 403 访问限制与 404/410 失效。 */
  accessHttpStatus?: number;
  /** 隔离浏览器会话 ID；只在运行期使用，不随项目资源持久化。 */
  browserSessionId?: string;
  /** Electron Session 分区；只在运行期用于让心流 WebView 复用同一登录态。 */
  browserPartition?: string;
  /** 登录容器 ID；只在运行期和本地容器元数据中使用。 */
  authContainerId?: string;
}

export type ResourceSearchCategory = 'encyclopedia' | 'video' | 'materials' | 'practice' | 'paper';
export type ResourceFormatPreference = 'adaptive' | 'video' | 'reading' | 'practice' | 'paper';
export interface ResourceSemanticSearchPlan {
  goal: string;
  topics: string[];
  lanes: Array<{ category: ResourceSearchCategory; queries: string[]; reason: string }>;
}

export interface ResourceSearchTab {
  id: ResourceSearchCategory;
  label: string;
  description: string;
  query: string;
  searchPageUrl: string;
  currentUrl?: string;
  candidateCount: number;
  loaded?: boolean;
  activeVariantId?: string;
  variants?: Array<{ id: string; label: string; query: string; searchPageUrl: string }>;
  /** Agent 自动发布的目标数量；人工筛选不受此限制。 */
  automaticTarget: number;
}

export interface ResourceAuthContainer {
  id: string;
  name: string;
  origin: string;
  partition: string;
  createdAt: string;
  lastUsedAt: string;
}

/** Renderer 打开在线资源时取得的本地登录会话路由；不会进入笔记、Agent 或分享数据。 */
export interface ResourceAuthSessionResolution {
  authContainerId: string;
  origin: string;
  partition: string;
}

export interface ResourceBrowserSearchRequest {
  projectTitle: string;
  /** 项目树根节点的领域标题，用于构造第二个短核心词。 */
  rootProjectTitle?: string;
  taskText: string;
  knowledgeTitles: string[];
  maxResults?: number;
  /** 用户长期偏好调整后的 Agent 自动目标；只影响后台候选补搜，不限制人工选择。 */
  automaticTargets?: Partial<Record<ResourceSearchCategory, number>>;
  /** A model understands the task first; the browser only executes this bounded plan. */
  semanticPlan?: ResourceSemanticSearchPlan;
  /** 本地根据用户主动选择/正向反馈推导；仅放宽推荐链接，不授权读取或登录。 */
  trustedResourceHosts?: string[];
  /** 同一资源草案内复用一个可见浏览器窗口，避免按任务连续弹窗。 */
  draftSessionId?: string;
  /** review=可见工作台；auto=后台搜索后由本地安全门控自动收录。 */
  interactionMode?: 'review' | 'auto';
  source?: 'agent' | 'note-editor' | 'concept-fill';
  /** 仅供受控内部研究流程覆盖查询；普通资源统筹仍由任务与知识点生成查询。 */
  queryOverride?: string;
}

export interface ResourceBrowserSearchResult {
  sessionId: string;
  query: string;
  searchPageUrl: string;
  resources: ResourceItem[];
  markdown: string;
}

export interface ResourceBrowserDownloadResult {
  ok: boolean;
  canceled?: boolean;
  document?: UploadedDocument;
  error?: string;
}

export interface ResourceBrowserScanResult {
  sessionId: string;
  pageUrl: string;
  resources: ResourceItem[];
}

export type ResourceCandidateDecision = 'selected' | 'rejected';

export interface ResourceBrowserCandidateDecisionEvent {
  sessionId: string;
  draftSessionId?: string;
  decision: ResourceCandidateDecision;
  resource: ResourceItem;
}

export interface ResourceBrowserClosedEvent {
  sessionId: string;
  draftSessionId?: string;
  interactionMode: 'review' | 'auto';
}

export interface ResourceWorkbenchState {
  sessionId: string;
  draftSessionId?: string;
  projectTitle: string;
  taskText: string;
  knowledgeTitles: string[];
  query: string;
  searchTabs?: ResourceSearchTab[];
  activeSearchTabId?: ResourceSearchCategory;
  currentUrl: string;
  canGoBack: boolean;
  canGoForward: boolean;
  resources: ResourceItem[];
  decisions: Record<string, ResourceCandidateDecision>;
  downloadCandidateIds: string[];
  notice?: string;
  busy?: boolean;
}

export interface ResourceWorkbenchCommitEvent {
  commitId: string;
  sessionId: string;
  draftSessionId?: string;
  selectedResources: ResourceItem[];
  rejectedResources: ResourceItem[];
  downloadedCandidateIds: string[];
  downloadedResources: Array<{ candidateId: string; document: UploadedDocument }>;
  downloadErrors: Array<{ candidateId: string; message: string }>;
}

export interface NoteItem {
  /** Private origin receipt; never exported as community content or treated as learning evidence. */
  communityImport?: import('./services/community/resourceImport').CommunityProvenance;

  id: string;
  title: string;
  content: string;
  /** 系统生成的业务正文片段：用于索引排除，不改变正文或 wiki 关联。 */
  generatedContentBlocks?: string[];
  noteType: NoteType;
  /** 未标记的旧项目保持学习用途；资料型仅组织正文，不参与学习计划。 */
  projectRole?: 'learning' | 'reference';
  textbook?: TextbookManifest;
  learningReviewRecords?: LearningReviewRecord[];
  learningContentMigration?: LearningContentMigration;
  textbookReadingState?: TextbookReadingState;
  parentId?: string;
  tags: string[];
  /** 知识点别名（用于「自动关联」时匹配同义/异名概念，如 "LLM"、"Large Language Model"） */
  aliases?: string[];
  links: string[];
  backlinks: string[];
  dueDates: DueDateItem[];
  pinned?: boolean;
  isFavorite?: boolean;
  color?: string;
  resources?: ResourceItem[];
  /** 概念补全时实际引用的来源；仅为参考溯源，不表示权威事实或个人认同。 */
  referenceSources?: NoteReferenceSource[];
  /** 仅计划根项目设置；若缺失则按旧项目树派生兼容视图。 */
  planMeta?: PlanMeta;
  /** Plan project's observable acceptance outcome; separate from editable study content. */
  planOutcome?: string;
  createdAt: string;
  updatedAt: string;
  aiAnalyzedAt?: string;
  questions?: StudyQuestionCard[];
  flowSummary?: string;
  dsrState?: KnowledgePointDsr;
  lastReferencedAt?: string;
  /** 论证结构文档数组（心流复盘分析产出，一笔记可含多张图，随笔记作为可分享内容持久化） */
  argumentDocs?: ArgDoc[];
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export interface KnowledgePointDsr {
  difficulty: number;
  stability: number;
  lastReviewedAt: string | null;
  /** Actual practice, including aided/unverified answers; not a memory-success signal. */
  lastPracticedAt?: string;
  /** Bounded quick-check activity receipts, separate from mastery observations. */
  practiceSessionIds?: string[];
  reviewCount: number;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  /** 概念掌握度（0-100，理解 + 表达质量，区别于记忆巩固的 stability） */
  conceptMastery?: number;
  /** 掌握的累计有效样本数（≥2 才可信） */
  conceptMasterySamples?: number;
  /** conceptMastery 最后更新时间（ISO） */
  conceptMasteryUpdatedAt?: string;
  /** 新量规的独立分层状态；旧百分比不能自动换算成该状态。 */
  masteryShadow?: import('./services/masteryShadow/types').MasteryShadowState;
  /** Recent review receipts prevent replay from incrementing memory scheduling twice. */
  reviewSessionIds?: string[];
}

export interface ReviewBubbleCard {
  noteId: string;
  noteTitle: string;
  questionText: string;
  knowledgeContext?: string;
  forgetScore: number;
  retrievability: number;
  difficulty: number;
  stability: number;
  /** 概念掌握度（0-100，来自 note.dsrState.conceptMastery，未评定时为 undefined） */
  conceptMastery?: number;
  /** Unified read-only state; optional for older review cards. */
  mastery?: import('./services/masteryReadModel').KnowledgeMasteryView;
}

export interface ReviewAnalysis {
  accuracyScore: number;
  completenessScore: number;
  logicScore: number;
  relevanceScore: number;
  overallRating: ReviewRating;
  feedback: string;
  suggestion: string;
  missingKnowledge: string[];
  /** 四维分数对应的学生原话证据；用于审计，不改变现有结果页布局。 */
  scoreEvidence?: {
    accuracy: string;
    completeness: string;
    logic: string;
    relevance: string;
  };
  /** 当前对话对评分的支持程度，不是掌握度。 */
  confidence?: number;
  /** 知识点三层掌握度证据（与心流模式同一套评分标准；可选，用于分层掌握度更新） */
  masteryEvidence?: {
    conceptEvidence?: ConceptEvidence;
    judgmentEvidence?: JudgmentEvidence;
    reasoningEvidence?: ReasoningEvidence;
  };
}

export interface ReviewQuestionResponse {
  question: string;
  knowledgeContext: string;
}

export interface ReviewRecord {
  id: string;
  noteId: string;
  noteTitle: string;
  rating: ReviewRating;
  difficultyBefore: number;
  difficultyAfter: number;
  stabilityBefore: number;
  stabilityAfter: number;
  analysis: ReviewAnalysis;
  reviewedAt: string;
}

export interface FolderItem {
  id: string;
  name: string;
  parentId?: string | null;
  color?: string;
  icon?: string;
}

export interface GraphNode {
  id: string;
  title: string;
  val: number;
  noteType: NoteType;
  parentId?: string;
  tags: string[];
  group: string;
  color?: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  dueDateCount?: number;
  isFavorite?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'wiki' | 'tag' | 'due_date' | 'parent_child';
  weight?: number;
}

export type ViewMode = 'editor' | 'graph' | 'timeline' | 'plan' | 'settings' | 'learn' | 'flow' | 'review' | 'bubble' | 'documents' | 'home' | 'profile' | 'profile-evidence' | 'argument' | 'scene';

export interface PlanNode {
  /** 叶子项目的独立时长；不设置则继承根计划每日投入。 */
  estimatedMinutes?: number;
  key: string;
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
  tasks?: PlanTaskBlueprint[];
  children: PlanNode[];
}

/** Existing project note that can be scheduled without creating a duplicate note. */
export interface PlanProjectCandidate {
  key: string;
  title: string;
  parentKey: string;
  path: string;
  depth: number;
  startDate?: string;
  dueDate?: string;
  priority: 'high' | 'medium' | 'low';
  childCount: number;
}

export interface PlanTaskBlueprint {
  capacityKind?: 'additional' | 'included';
  key: string;
  text: string;
  kind: PlanTaskKind;
  startDate?: string;
  dueDate: string;
  estimatedMinutes: number;
  priority?: 'high' | 'medium' | 'low';
  dependencyKeys?: string[];
  milestoneId?: string;
  source?: 'llm' | 'manual' | 'scheduler' | 'dsr' | 'legacy';
  executionKind?: PlanExecutionKind;
  recurrence?: PlanRecurrenceRule;
  linkedProjectKey?: string;
  linkedKnowledgeIds?: string[];
  launchMode?: 'none' | 'flow' | 'scene' | 'review';
  reminderMinutes?: number;
  displayRow?: number;
}

export interface PlanTemplate {
  id: string;
  name: string;
  planTree: PlanNode[];
  createdAt: string;
}

export type PlanStepperStep = number;

export interface AiPlanRequest {
  userInput: string;
  expectation?: string;
  dailyMinutes?: number;
  noteTitle?: string;
  existingNotes?: string[];
}

export interface AiPlanResponse {
  planTree: PlanNode[];
  reasoning: string;
}

export type LlmApiType = 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

export interface LlmProvider {
  id: string;
  name: string;
  apiType: LlmApiType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel?: string;
  /** Explicit opt-in for exact model names; never infer vision from a provider name. */
  visionModels?: string[];
  /** User-verified scene-model capacity; never inferred from a model name. */
  contextWindowTokens?: number;
  enabled: boolean;
  createdAt: string;
}

export type LlmWorkflowId = 'plan-generation' | 'flow-analysis' | 'review-tutor' | 'review-scoring' | 'question-answer' | 'study-task-generation' | 'knowledge-discovery' | 'knowledge-mastery-scoring' | 'profile-evidence-layered' | 'profile-style-cognitive' | 'profile-concept-aliases' | 'logic-check' | 'flow-preprocess' | 'storm-multi-perspective' | 'storm-contradiction' | 'storm-brief' | 'storm-peer-review' | 'storm-abstract'
  | 'concept-generation'
  | 'document-knowledge-extract'
  | 'argument-quality-review'
  | 'textbook-blueprint' | 'textbook-chapter' | 'textbook-quality'
  | 'agent-chat'
  | 'agent-intent-routing'
  | 'agent-resource-curation'
  | 'agent-study-task-generation'
  | 'agent-personalized-qa'
  | 'agent-scene-setup'
  // ===== 应用板块（一对一对话场景 MVP）=====
  | 'scene-decide'         // 决策：新建 or 复用已有场景（输出 SceneDecideResult JSON）
  | 'scene-generate'       // 生成全新场景（输出 SceneSpec JSON）
  | 'scene-adapt'          // 基于已有场景调整（输出 SceneAdaptResult JSON，可自推翻）
  | 'scene-role-reply'     // 角色发言（流式，末尾可带 [结束:原因] 与 *动作*）
  | 'scene-turn-plan'      // 运行期互动 Agent：按当前回答规划本轮动作、上下文与交互组件
  | 'scene-general-turn'   // 通用 S1 回合发言（答题/诊断/教学/辩论等）
  | 'scene-model-experiment'
  | 'scene-experiment-evaluate'
  | 'scene-metric-update'  // 指标更新 + 成败判定 + 突发事件条件判定
  // ===== S4 数理场景 =====
  | 'scene-compute-generate'   // 生成 S4 数理场景预览外壳
  | 'scene-compute-config'     // 用户开始后生成 compute/help
  | 'scene-compute-adapt'      // 基于已有 S4 骨架改编
  | 'scene-formula-parse'      // LaTeX/MathJSON → SymPy 表达式
  | 'scene-compute-analyze'    // 基于 SymPy 结果的步骤评价
  | 'scene-help';              // 求助响应（下一步解法 + 原因）
  // 轮次 N 删除 'scene-equiv-adjudicate'（参考链等价性判定已整体移除）

export interface LlmWorkflowTemplate {
  id: LlmWorkflowId;
  name: string;
  description: string;
  systemPrompt: string;
  defaultParams: { temperature: number; maxTokens: number; };
  outputSchema?: object;
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A verified local source attached to an Agent answer. */
export interface AgentCitation {
  sourceId: string;
  type: 'note' | 'document';
  entityId: string;
  title: string;
  sectionPath?: string;
  snippet: string;
  score?: number;
  /** Stable RAG chunk identity used to reopen a document at the cited passage. */
  chunkId?: string;
  /** Format-aware source position retained across the Agent evidence gate. */
  sourceLocation?: SourceLocator;
  matchKinds?: Array<'note' | 'passage' | 'entity' | 'argument'>;
  relationSummary?: string;
  evidenceOrigin?: 'passage' | 'imported-document-extraction' | 'note-passage' | 'user-argument-doc';
  admission?: 'admitted' | 'limited';
  evidenceGrade?: 'A' | 'B' | 'C' | 'ungraded';
  argumentHits?: UserArgumentNodeHit[];
}

/** Agent 专用消息；不扩展既有 ChatMessage，避免影响复习与场景链路。 */
export interface LlmConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Verified citations used by this answer; provider serializers ignore this field. */
  citations?: AgentCitation[];
  /** Private UI pointers; never factual citations or automatic cognition updates. */
  cognitionReferences?: import('./services/cognition/retrieval').CognitionReference[];
  /** Read-only inquiry continuation: query and snapshot cursor only, no private source text. */
  cognitionInquiry?: import('./services/cognition/inquiry').InquiryCursor;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReviewMessage {
  id: string;
  role: 'user' | 'tutor';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export interface LlmCallRequest {
  /** Locally declared removable historical blocks; never model-provided authority. */
  sceneOptionalContext?: Array<{ id: string; text: string; sourceIds?: string[] }>;
  sceneOptionalJsonFields?: string[];
  /** Local repair only: if a raised output budget cannot fit, reuse the original limit. Never applies to paid trials. */
  sceneRepairBaseOutputTokens?: number;
  /** Scoped local raster attachments, separate from the textual prompt. */
  images?: LlmImageInput[];
  /** Per-call structured output declaration; does not change the workflow's default. */
  outputSchema?: object;
  providerId: string;
  model: string;
  workflow: LlmWorkflowId;
  userInput: string;
  context?: Record<string, string>;
  stream?: boolean;
  tools?: LlmTool[];
  agentMessages?: LlmConversationMessage[];
  systemPromptOverride?: string;
  /** Per-call output budget override for large Agent tool arguments. */
  maxTokensOverride?: number;
  /** Frozen extraction experiments can pin sampling without changing other workflows. */
  temperatureOverride?: number;
  /** Long document extraction only; host caps this at fifteen minutes. */
  timeoutMsOverride?: number;
  /** 调用方已经装配好 Agent 上下文时，避免服务层再次注入。 */
  skipMemoryInjection?: boolean;
  messages?: ChatMessage[];
  /**
   * 跳过服务层的画像自动注入（默认 false）。
   * 供调用方自行精确控制画像注入时机时使用，例如应用板块按场景开关决定是否注入，
   * 避免与 SCENE_ROLE_REPLY 的扮演指令重复叠加。
   */
  skipProfileInjection?: boolean;
  /** 仅在服务商明确支持时转发；证据整理等低推理任务可关闭思考，避免耗尽输出额度。 */
  thinkingMode?: 'enabled' | 'disabled';
}

export interface LlmImageInput { assetId: string; dataUrl: string }

export interface LlmResponseDiagnostics {
  sceneContextBudget?: import('./services/scene/sceneContextBudget').SceneContextBudgetDiagnostics;
  finishReason?: string;
  reasoningTokens?: number;
  hadReasoningContent?: boolean;
  responseModel?: string;
}

export interface LlmCallResponse {
  content: string;
  parsedJson?: any;
  usage?: { promptTokens: number; completionTokens: number; };
  toolCalls?: LlmToolCall[];
  diagnostics?: LlmResponseDiagnostics;
}

export interface LlmSettings {
  providers: LlmProvider[];
  defaultProviderId?: string;
  /** 工作流 → 提供商 id 的绑定映射（可部分绑定，未绑定的走 defaultProviderId） */
  workflowBinding: Partial<Record<LlmWorkflowId, string>>;
}

export type AgentCommunicationMode = 'balanced' | 'coach' | 'socratic' | 'companion' | 'expert';
export type AgentAnswerTone = 'neutral' | 'warm' | 'direct' | 'encouraging' | 'academic' | 'playful';
export type AgentAnswerDetail = 'concise' | 'balanced' | 'detailed';
export type AgentExecutionMode = 'economy' | 'standard' | 'deep';

/** Explicit assistant behavior chosen by the user; separate from inferred learner profile. */
export interface AgentPersonaSettings {
  displayName: string;
  communicationMode: AgentCommunicationMode;
  tone: AgentAnswerTone;
  answerDetail: AgentAnswerDetail;
  /** User-confirmed open-ended style rules; each item is independently editable. */
  styleDirectives: string[];
  /** @deprecated Older settings are migrated into styleDirectives when loaded. */
  customInstructions?: string;
}

export interface VaultSettings {
  /** 个人全部计划共用的周预算；未设置时须明确确认，不从旧计划求和迁移。 */
  learningWeeklyBudgetMinutes?: number;
  theme: 'light' | 'dark' | 'system';
  /** 全局强调色；未设置时使用产品默认的黛绿主题。 */
  accentColor?: 'indigo' | 'purple' | 'emerald' | 'coral' | 'rose' | 'amber' | 'teal' | 'slate' | `#${string}`;
  localOnly: boolean;
  enableEncryption: boolean;
  encryptionPassword?: string;
  cloudSyncEnabled: boolean;
  autoAiSegment: boolean;
  dueNotification: boolean;
  /** 编辑器正文字号（像素，精细调节，默认 16） */
  fontSize: number;
  /** Agent 统筹资源时的收录方式：review=用户工作台筛选，auto=依偏好与安全门控自动收录。 */
  resourceCollectionMode: 'review' | 'auto';
  /** 明确偏好优先；adaptive 只根据主动选择与使用反馈调整资源比例。 */
  resourceFormatPreference?: ResourceFormatPreference;
  /** Per-run Agent reasoning/tool budget. Complex skills may raise the effective minimum. */
  agentExecutionMode?: AgentExecutionMode;
  /** Optional per-new-request tool budget; absent means the selected preset. */
  agentToolCallLimit?: number;
  agentPersona: AgentPersonaSettings;
  graphPhysics: { repulsion: number; linkDistance: number; showTagsInGraph: boolean; };
  flowSettings: FlowSettings;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  isSyncing: boolean;
  syncedNotesCount: number;
  cloudStorageUsed: string;
  statusText: string;
  error?: string;
}

export interface NoteChunk {
  id: string;           // `${noteId}#${chunkIndex}`
  noteId: string;
  title: string;
  content: string;      // 分块后的文本
  embedding: number[];  // 384 维向量
  updatedAt: string;
}

export interface NoteEmbedding {
  noteId: string;
  noteType?: NoteType;
  title: string;
  snippet: string;
  embedding: number[];
  updatedAt: string;
  /** Browser fallback source version, distinct from the index creation time. */
  sourceUpdatedAt?: string;
}

/** Renderer → Electron 主进程的笔记/用户论证索引同步载荷。 */
export interface NoteRagIndexInput {
  id: string;
  title: string;
  /** 缺少类型的旧载荷不能进入资料检索。 */
  noteType?: NoteType;
  generatedContentBlocks?: string[];
  textbook?: TextbookManifest;
  learningReviewRecords?: LearningReviewRecord[];
  /** 仅笔记正文；已发布论证图通过 publishedArguments 独立索引，避免整图文本重复计权。 */
  content: string;
  updatedAt?: string;
  referenceSources?: NoteReferenceSource[];
  publishedArguments?: Array<{
    argumentDocId: string;
    snapshot: ArgumentPublishedSnapshot;
  }>;
}

export interface UserArgumentNodeHit {
  argumentId: string;
  argumentDocId: string;
  revisionHash: string;
  nodeId: string;
  mainType: ArgumentFunctionType;
  layer: 'concept' | 'judgment' | 'logic';
  text: string;
  match: 'direct' | 'expanded';
  relationDirection?: 'supports' | 'supported_by' | 'opposes' | 'opposed_by';
  /** 用户显式绑定的底层来源，供 Agent 区分个人论证与可核验根据。 */
  sources?: ArgumentSourceRef[];
}

export interface NoteSearchResult {
  /** Optional host-issued structural entry point, not a completeness or truth claim. */
  argumentContext?: import('./electron/rag/argumentSearchBridge').ArgumentSearchContextAttachment;
  noteId: string;
  noteType?: NoteType;
  title: string;
  score: number;
  snippet: string;
  /** note=正文通道，argument=已发布用户论证图通道。 */
  matchKinds?: Array<'note' | 'argument'>;
  argumentHits?: UserArgumentNodeHit[];
  relationSummary?: string;
  evidenceOrigin?: 'note-passage' | 'user-argument-doc';
  admission?: 'admitted' | 'limited';
  evidenceGrade?: 'A' | 'B' | 'C' | 'ungraded';
  /** v2参考正文块坐标；必须回读当前原文，不能只凭向量结果作评分依据。 */
  passage?: NoteReferencePassageRef;
}

export type NoteReferenceSource = NonNullable<ConceptDraft['references']>[number];
export type NoteReferenceSectionKind = 'definition' | 'condition' | 'fact' | 'example' | 'reasoning' | 'sources' | 'general';
export interface NoteReferencePassageRef {
  schemaVersion: 2;
  chunkId: string;
  sourceHash: string;
  sourceUpdatedAt?: string;
  textStart: number;
  textEnd: number;
  sectionPath: string;
  /** 仅标题提示，不是模型已验证的论证节点类型。 */
  sectionKind: NoteReferenceSectionKind;
  forcedSplit: boolean;
}
export interface NoteReferenceIndexStatus {
  noteId: string;
  status: 'missing' | 'queued' | 'processing' | 'ready' | 'failed' | 'empty' | 'legacy' | 'unavailable';
  sourceHash?: string;
  sourceUpdatedAt?: string;
  indexedAt?: string;
  chunkCount: number;
  errorCode?: 'embedding_unavailable' | 'storage_unavailable' | 'index_budget_exceeded' | 'interrupted' | 'index_unavailable';
}

/** 项目教材派生索引状态。普通项目保存不是重建信号。 */
export interface TextbookReferenceIndexStatus {
  noteId: string;
  textbookId?: string;
  revisionId?: string;
  status: 'missing' | 'queued' | 'processing' | 'ready' | 'failed' | 'empty' | 'invalid' | 'unavailable';
  sourceHash?: string;
  indexedAt?: string;
  chunkCount: number;
  errorCode?: 'embedding_unavailable' | 'storage_unavailable' | 'index_budget_exceeded' | 'interrupted' | 'invalid_textbook';
}

/** 教材检索结果仅是可回读的参考正文块，不代表论证或个人立场。 */
export interface TextbookReferenceSearchResult {
  noteId: string;
  textbookId: string;
  revisionId: string;
  title: string;
  score: number;
  snippet: string;
  chunkId: string;
  sourceHash: string;
  textStart: number;
  textEnd: number;
  sectionPath: string;
  sectionKind: NoteReferenceSectionKind;
  forcedSplit: boolean;
}

export interface PlanChatResponse {
  isComplete: boolean;
  question?: string;
  planTree?: any[];
  reasoning?: string;
}

export type LearnMode = 'flow' | 'review' | 'storm' | 'scene';

export interface FlowSettings {
  reviewIntervalMinutes: number;
  whiteNoiseType: WhiteNoiseType;
  whiteNoiseVolume: number;
  autoStartReview: boolean;
}

export type WhiteNoiseType = 'rain' | 'campfire' | 'wind' | 'wave' | 'none';

export interface FlowSpeakingNote {
  id: string;
  noteId: string;
  text: string;
  createdAt: string;
  roundIndex: number;
}

export interface StudyQuestionCard {
  id: string;
  question: string;
  answer?: string;
  noteId: string;
  createdAt: string;
  answeredAt?: string;
}

export interface FlowSession {
  id: string;
  noteId: string;
  noteTitle: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  reviewIntervalMinutes: number;
  summary?: string;
  rootProjectId?: string;
  textbookRevisionId?: string;
  /** Progressive sessions own page/private-state storage; never enter the legacy textbook preparation chain. */
  learningMode?: 'progressive';
  progressiveCourseId?: string;
  questions?: StudyQuestionCard[];
  /** 退出时复述区的最终全文（语音流式 + 就地编辑的结果） */
  restateText?: string;
  /** 本次学习新增的复述文本（已剥离进入心流前的原文，供口语复盘分析） */
  incrementalText?: string;
  /** 退出心流时是否触发 AI 分析（由心流页「分析」开关决定） */
  analyze?: boolean;
}

export interface AnalysisResult {
  summary?: string;
  originalStatement?: string;
  logicGaps?: Array<{ description: string; severity: 'critical' | 'major' | 'minor'; suggestion: string }>;
  logicalFallacies?: Array<{ type: string; explanation: string; correction?: string }>;
  narrativeErrors?: Array<{ error: string; context: string; fix: string }>;
  relatedKnowledge?: Array<{ term: string; relation: string; suggestedWikiLink?: string }>;
  missingFactors?: string[];
  supplementaryKnowledge?: string[];
  suggestedCorrection?: string;
  clarityScore?: number;
}

export type FlowAnalysisResult = AnalysisResult;
export type LogicalAnalysisResult = AnalysisResult;

/* ===== 用户个人画像（三层递进能力 + 双极认知风格 + 表达风格） ===== */

/** 概念层证据锚点（LLM 提取，前端折算为 score） */
export interface ConceptEvidence {
  /** 是否用自己的话重述概念 */
  redefinesInOwnWords?: boolean;
  /** 是否区分相近概念 */
  distinguishesSimilarConcepts?: boolean;
  /** 是否举正反例 */
  givesCounterExamples?: boolean;
  /** 出现的模糊词（"那个""差不多""某种程度"等） */
  vagueTerms?: string[];
  /** 概念理解错误（把概念说错、张冠李戴等） */
  conceptErrors?: string[];
}

/** 判断层证据锚点 */
export interface JudgmentEvidence {
  /** 是否考虑条件/范围/反例 */
  considersConditions?: boolean;
  /** 是否区分事实与观点 */
  distinguishesFactOpinion?: boolean;
  /** 是否恰当使用量词（有些/多数） */
  usesQualifiers?: boolean;
  /** 绝对化表达次数（肯定/所有/不可能） */
  absolutistCount?: number;
  /** 判断错误（对条件/适用范围/真假的错误判断） */
  judgmentErrors?: string[];
}

/** 单条质量指标（0-4 分 + 原文依据） */
export interface QualityIndicator {
  /** 0-4 整数分 */
  score: number;
  /** 引用原文中的具体内容 */
  evidence: string;
}

/** 四个质量指标（步骤② LLM 输出） */
export interface QualityIndicators {
  conceptClarity: QualityIndicator;
  exampleQuality: QualityIndicator;
  factSpeculation: QualityIndicator;
  reasoningChain: QualityIndicator;
}

/** 隐含漏洞条目（步骤② LLM 输出） */
export interface Vulnerability {
  /** 定位到的句子 id（对应 SentenceAnnotation.id；一对一，用于画布节点标红） */
  nodeId?: string;
  /** 问题类型（如"循环论证""过度概括""语音转文字识别误差"） */
  type: string;
  /** 严重程度 1-5（语音识别误差 1-3） */
  severity: number;
  /** 影响层面 */
  layer: '概念层' | '判断层' | '逻辑层' | '多层' | '无法判断';
  /** 原文依据 */
  evidence: string;
  /** 强化建议 */
  suggestion: string;
}

/** 步骤②整段论证质量评估结果（LLM 输出纯 JSON） */
export interface ArgumentQualityResult {
  argumentType: 'formal' | 'empirical' | 'normative';
  quality: QualityIndicators;
  vulnerabilities: Vulnerability[];
  summary: string;
}

/** 三层分数结果（前端根据质量指标 + 结构密度 + 漏洞扣分计算） */
export interface LayeredScoreResult {
  raw: { concept: number; judgment: number; logic: number };
  penalty: { concept: number; judgment: number; logic: number };
  final: { concept: number; judgment: number; logic: number };
  grade: { concept: string; judgment: string; logic: string };
}

/** 推理层证据锚点 */
export interface ReasoningEvidence {
  /** 是否给出推理前提 */
  providesPremises?: boolean;
  /** 推理链是否完整（无跳跃） */
  completeChain?: boolean;
  /** 是否识别隐含假设 */
  identifiesAssumptions?: boolean;
  /** 是否区分演绎/归纳（高阶推理意识，画像三层能力用） */
  distinguishesDeductiveInductive?: boolean;
  /** 是否考虑反事实/替代解释（高阶批判思维，画像三层能力用） */
  considersCounterfactuals?: boolean;
  /** 出现的谬误类型 */
  fallacyTypes?: string[];
}

/** 三层递进能力分数（0-100，附可信门槛计数） */
export interface LayeredAbility {
  /** 概念层：概念清晰度 */
  conceptClarity: number;
  /** 判断层：判断合理性 */
  judgmentReasonableness: number;
  /** 推理层：推理有效性 */
  reasoningValidity: number;
  /** 有效证据样本数（可信门槛之一） */
  evidenceCount: number;
  /** 累计文本字符数（可信门槛之一） */
  evidenceChars: number;
}

/** 认知风格（双极标签，不进主评分轴；-100 ~ +100） */
export interface CognitiveStyle {
  /** -100 具象 ~ +100 抽象 */
  abstractVsConcrete: number;
  /** -100 零散 ~ +100 系统 */
  systematicVsScattered: number;
  /** -100 收敛 ~ +100 发散 */
  divergentVsConvergent: number;
  /** -100 武断 ~ +100 谨慎 */
  cautiousVsDogmatic: number;
  /** -100 表面应付 ~ +100 深度理解（v2 新增，学习方式理论 deep/surface approach） */
  deepVsSurface: number;
}

/** 认知风格证据锚点（LLM 提取的文本可观察布尔证据，前端归一化折算为 -100~+100；仅本次折算用，不落盘） */
export interface CognitiveStyleEvidence {
  // 抽象 vs 具象（正=抽象，负=具象）
  /** 是否使用上位概括概念（心理机制/认知偏差/启发式等） */
  usesAbstractTerms?: boolean;
  /** 是否把具体现象提炼为一般规律 */
  generalizesDomain?: boolean;
  /** 是否大量使用具体场景实例 */
  usesConcreteExamples?: boolean;
  /** 是否停留在事例/操作层面不上升概括 */
  staysOperational?: boolean;
  // 系统 vs 零散（正=系统，负=零散）
  /** 是否有层次框架（前提→机制→结论、首先/然后/最后） */
  structuresHierarchically?: boolean;
  /** 点与点之间是否有过渡衔接 */
  connectsPoints?: boolean;
  /** 是否跳跃无过渡 */
  jumpsDisconnected?: boolean;
  /** 是否并列罗列无主次 */
  listsWithoutOrder?: boolean;
  // 发散 vs 收敛（正=发散，负=收敛）
  /** 是否给出多个角度/假设/可能性 */
  multipleAngles?: boolean;
  /** 是否提到替代解释/例外/反例 */
  considersAlternatives?: boolean;
  /** 是否只给唯一答案 */
  singleAnswerOnly?: boolean;
  /** 是否明确排除其他可能 */
  excludesAlternatives?: boolean;
  // 谨慎 vs 武断（正=谨慎，负=武断）
  /** 是否使用限定词（可能/通常/某些） */
  qualifiesStatements?: boolean;
  /** 是否标注不确定性/待验证 */
  marksUncertainty?: boolean;
  /** 是否描述当时犹豫/反复想/事后才反思（反应轴·沉思） */
  delayedReflection?: boolean;
  /** 是否绝对化断言（一定/必然/所有） */
  absolutistClaims?: boolean;
  /** 是否不留余地、不容质疑 */
  leavesNoRoom?: boolean;
  /** 是否描述快速反应/脱口而出/先做再说（反应轴·冲动） */
  quickReaction?: boolean;
  // 深度 vs 表面（正=深度，负=表面）
  /** 是否关联更大概念框架/上位理论 */
  linksBroaderFramework?: boolean;
  /** 是否追问底层机制/原因 */
  probesMechanism?: boolean;
  /** 是否反思自身假设 */
  reflectsOnAssumptions?: boolean;
  /** 是否只复述表面定义/事实 */
  repeatsSurfaceInfo?: boolean;
  /** 是否不追问为什么 */
  noWhyProbing?: boolean;
  // 参照轴（不参与折算，仅进入认知解读文字）
  /** 是否以“我判断/我认为/我决定”为依据（内部参照） */
  internalReference?: boolean;
  /** 是否以“大家/领导/别人/环境/权威”为依据（外部参照） */
  externalReference?: boolean;
  /** 是否归因于自身可控因素 */
  selfAttribution?: boolean;
  /** 是否归因于外部不可控因素 */
  externalAttribution?: boolean;
  // 修饰轴（不折算、不存储，仅进入认知解读文字）
  /** 注意力是否只盯一个点深入（注意修饰·聚焦） */
  focusesSinglePoint?: boolean;
  /** 注意力是否广泛扫描、多方向联想（注意修饰·扫描） */
  scansMultipleDirections?: boolean;
  /** 是否敏锐区分细节差异（记忆修饰·尖锐） */
  sharpDetails?: boolean;
  /** 是否倾向概括、模糊相似（记忆修饰·齐平） */
  blurredGeneralization?: boolean;
}

/** 论证功能类型（preprocess 逐句标注的主类型，9 类） */
export type ArgumentFunctionType =
  | '定义'
  | '对比'
  | '假设'
  | '举例'
  | '推理'
  | '反例削弱'
  | '建议对策'
  | '命名'
  | '事实陈述';

/** 五种表达风格（英文 key，展示层映射中文） */
export type ExpressionStyleKind =
  | 'academic'
  | 'critical'
  | 'practical'
  | 'divergent'
  | 'objective';

/** 论证节点之间的连线关系 */
export type ArgumentRelation = 'support' | 'oppose';

/** 论证结构边（flow-preprocess 输出的结构化连线，供画布构图与步骤②定位） */
export interface ArgumentEdge {
  /** 源句子 id（对应 SentenceAnnotation.id） */
  source: string;
  /** 目标句子 id（对应 SentenceAnnotation.id） */
  target: string;
  /** support=支持/推出/导向；oppose=削弱/反例/限制 */
  relation: ArgumentRelation;
}

/** preprocess 输出的逐句标注 */
export interface SentenceAnnotation {
  /** 稳定句子 id（形如 s1、s2），供 edges 引用与节点定位 */
  id: string;
  /** 编号（1 起） */
  index: number;
  /** 去口语化后的句子（已清除停顿滞留词、保留有语义连接词与 [[双链]]） */
  text: string;
  /** 论证功能主类型 */
  mainType: ArgumentFunctionType;
  /** 副类型 / 说明（含疑似语音识别误差标注） */
  subTypes?: string;
  /** 疑似语音转文字识别误差说明 */
  asrNote?: string;
}

/** preprocess（flow-preprocess）输出：9 类论证功能 + 结构化连线关系 */
export interface PreprocessResult {
  /** 逐句拆分与类型标注 */
  sentences: SentenceAnnotation[];
  /** 句子之间的连接关系（取代旧的 mermaid 结构图） */
  edges: ArgumentEdge[];
}

/** 单条原始分析记录（style-raw-analysis.json） */
export interface RawAnalysisRecord {
  /** 分析日期 YYYY-MM-DD */
  analysisDate: string;
  /** 9 类论证功能计数 */
  counts: Record<ArgumentFunctionType, number>;
  /** 创建时间 ISO */
  createdAt: string;
}

/** 原始分析文件顶层 */
export interface RawAnalysisFile {
  records: RawAnalysisRecord[];
}

/** 风格聚合快照（style-snapshot.json，每次重算覆盖） */
export interface StyleSnapshotFile {
  calculatedAt: string;
  /** 9 类加权占比 */
  typeRatios: Record<ArgumentFunctionType, number>;
  /** 5 风格原始得分 */
  styleScores: Record<ExpressionStyleKind, number>;
  /** 5 风格百分比归一化（未平滑） */
  stylePercent: Record<ExpressionStyleKind, number>;
  /** 指数平滑后的显示值（雷达图） */
  display: Record<ExpressionStyleKind, number>;
  /** 判定结论文本 */
  conclusion: string;
}

/** 风格趋势快照（style-trend.json，追加/当天覆盖） */
export interface StyleTrendFile {
  snapshots: Array<{
    date: string;
    display: Record<ExpressionStyleKind, number>;
    topStyle: string;
    /** Absent only on legacy nine-type snapshots. */
    rubricVersion?: string;
    observedAt?: string;
  }>;
}

/** 词云文件（style-wordcloud.json，按周） */
export interface WordCloudFile {
  weeks: Array<{
    weekStart: string;
    words: Array<{ word: string; count: number }>;
  }>;
}

/** 用户长期画像（v2：user-state 单份持久化 + A1 内存缓存） */
export interface UserProfile {
  version: 2;
  updatedAt: string;
  analysisCount: number;
  ability: LayeredAbility;
  cognitiveStyle: CognitiveStyle;
  /** 学习能力（六维，跨时间纵向能力） */
  learningAbility: LearningAbility;
  /** 画像证据门控状态：用于幂等、分指标累计与可信晋升，不直接注入 LLM。 */
  evidenceGate?: ProfileEvidenceGateState;
}

export interface ProfileEvidenceSample {
  episodeId: string;
  value: number;
  weight: number;
  observedAt: string;
  evidenceSnippetIds?: string[];
  matchedCriteria?: string[];
  rubricVersion?: string;
}

export interface ProfileEvidenceAggregate {
  dimension: 'ability' | 'cognitive_style' | 'expression_style';
  indicator: string;
  /** 新复盘量规独立聚合；旧版本数值不作为新量规的初始化样本。 */
  rubricVersion?: string;
  status: 'holding' | 'trusted';
  mean: number;
  /** 普通历史均值，仅供回顾；mean 是近期加权的当前值。 */
  historicalMean?: number;
  /** 更慢的时间基线，用于识别近期进步或回落。 */
  baselineMean?: number;
  trendDelta?: number;
  confidence: number;
  samples: ProfileEvidenceSample[];
  updatedAt: string;
}

export interface ProfileEvidenceGateState {
  version: 1;
  processedEpisodeIds: string[];
  aggregates: Record<string, ProfileEvidenceAggregate>;
}

/** 单条知识点观察（flow-analysis 输出，含归并与候选标记） */
export interface ConceptObservation {
  /** 归一并归一化后的中文名 */
  canonicalName: string;
  /** 用户实际使用的词（含英文），用于归并 */
  aliases: string[];
  /** true=已提及（活跃）；false=需补充（默认不掌握） */
  mentioned: boolean;
  /** 若能匹配到已有笔记，给出其标题（用于定位） */
  existingNoteTitle?: string;
  /** 原文中的最短证据片段；用于别名登记审计。 */
  evidence?: string;
  /** 触及的最高认知层级 */
  level?: MasteryLevel;
  /** 概念层净得分（可正可负） */
  conceptScore?: number | null;
  /** 判断层净得分（可正可负） */
  judgmentScore?: number | null;
  /** 推理层净得分（可正可负） */
  reasoningScore?: number | null;
}

/** flow-analysis 额外输出的画像增量证据 */
export interface ProfileInsight {
  conceptEvidence?: ConceptEvidence;
  judgmentEvidence?: JudgmentEvidence;
  reasoningEvidence?: ReasoningEvidence;
  cognitiveStyle?: Partial<CognitiveStyle>;
  /** 知识点掌握度观察（来源一口语复盘核心） */
  concepts: ConceptObservation[];
  /** 步骤②整体论证质量 → 三层分数（替代旧 arguments 布尔链路） */
  layeredScores?: LayeredScoreResult;
}

/* ===== 知识点分层掌握度评分（两阶段 + 并行） ===== */

/** 知识点触及的最高认知层级（触及层而非达标层） */
export type MasteryLevel = 'none' | 'concept' | 'judgment' | 'reasoning';

/** 阶段一识别出的三类知识点 */
export type KnowledgePointCategory = 'known' | 'potential';

/** 阶段一发现结果（供选择窗口展示） */
export interface KnowledgePointCandidate {
  id: string;
  name: string;
  category: KnowledgePointCategory;
  existingNoteTitle?: string;
  discoverySource?: 'explicit' | 'inferred';
  evidence?: string;
  confidence?: number;
}

/** 阶段二单知识点评分结果（净得分，可正可负） */
export interface KnowledgePointMasteryResult {
  name: string;
  level: MasteryLevel;
  conceptDelta: number;
  judgmentDelta: number;
  reasoningDelta: number;
  /** 递进联动后的概念层最终分 */
  conceptFinal?: number;
  /** 递进联动后的判断层最终分 */
  judgmentFinal?: number;
  /** 递进联动后的推理层最终分 */
  reasoningFinal?: number;
  /** 简洁评价（≤30字） */
  comment: string;
  existingNoteTitle?: string;
  /** 新心流知识点评价显示状态而非旧净增分。 */
  shadow?: import('./services/masteryShadow/types').MasteryShadowPresentation;
}

/* ===== 存储重构：可分享内容 vs 个人数据分离 ===== */

/** 单篇笔记的个人状态（从 NoteItem 抽离、随 user-state 持久化的字段） */
export interface UserNoteState {
  communityImport?: import('./services/community/resourceImport').CommunityProvenance;
  /** Original Flow extraction is private; runtime ArgDoc fields are restored only after loading personal state. */
  argumentFlowStructures?: Record<string, import('./services/argumentDoc/types').FlowArgumentStructure>;
  /** 复习记忆 + 概念掌握度（已含 conceptMastery） */
  dsrState?: KnowledgePointDsr;
  flowSummary?: string;
  learningReviewRecords?: LearningReviewRecord[];
  learningContentMigration?: LearningContentMigration;
  textbookReadingState?: TextbookReadingState;
  questions?: StudyQuestionCard[];
  lastReferencedAt?: string;
  aiAnalyzedAt?: string;
  pinned?: boolean;
  isFavorite?: boolean;
  color?: string;
}

/** user-state/user-state.json 顶层结构 */
export interface UserStateFile {
  version: 1;
  noteStates: Record<string, UserNoteState>; // key = noteId
}

/** user-state/profile.json 顶层结构（全局画像 + 概念映射） */
export interface ProfileStateFile {
  version: 1;
  profile: UserProfile;
  conceptAliasMap: Record<string, string>;
}

/** user-state/settings.json 顶层结构（应用设置 + 心流设置） */
export interface SettingsStateFile {
  version: 1;
  appSettings: VaultSettings;
}

/** user-state/llm.json 顶层结构（LLM 配置） */
export interface LlmStateFile {
  version: 1;
  settings: LlmSettings;
}

/* ===== 资料文档 RAG（知识点概念补全用，后端向量化） ===== */

export type SourceBlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'caption' | 'notes';

/** 指向原始资料的格式专属位置；索引只保存定位信息，不保存本机绝对路径。 */
export type SourceLocator =
  | { kind: 'text'; charStart: number; charEnd: number }
  | { kind: 'pdf'; page: number; bbox?: [number, number, number, number]; blockIndex?: number; tableIndex?: number }
  | { kind: 'docx'; paragraphIndex: number; runStart?: number; runEnd?: number }
  | { kind: 'pptx'; slideIndex: number; shapeIndex?: number; notes?: boolean };

/** 阅读投影中的一块可能来自多个不连续的 PDF 原始块；原文和坐标始终不可变。 */
export interface SourceBlockFragment {
  locator: SourceLocator;
  rawText: string;
  formulaEvidence?: FormulaEvidence;
  /** Layout provenance only, never a semantic correctness judgement. */
  layoutRole?: 'print_furniture' | 'chapter_label' | 'credit' | 'contents' | 'drop_cap';
}

/** Extraction evidence, never a mathematical correctness certificate. */
export interface FormulaEvidence {
  origin: 'native_latex' | 'pdf_layout';
  status: 'structured_unverified' | 'needs_visual_check';
  reasons: string[];
  /** Original page coordinates; conservative region, not guaranteed formula-only. */
  region?: [number, number, number, number];
}

export interface DocumentPreprocessingIssue {
  code: 'suspicious_character' | 'table_interruption' | 'table_extraction_unavailable'
    | 'anchor_normalized' | 'visual_line_merge' | 'column_reading_order' | 'drop_cap_join' | 'layout_auxiliary';
  severity: 'info' | 'warning';
  blockIds: string[];
  message: string;
}

export interface DocumentPreprocessingMetadata {
  version: 1;
  engine: string;
  rawBlockCount: number;
  projectedBlockCount: number;
  sourceCoverage: number;
  issues: DocumentPreprocessingIssue[];
}

export interface SourceBlock {
  id: string;
  textStart: number;
  textEnd: number;
  kind: SourceBlockKind;
  sectionPath: string;
  locator: SourceLocator;
  /** 可逆来源台账；未提供时 locator 仍是唯一来源。 */
  sourceFragments?: SourceBlockFragment[];
}

export interface StructuredDocument {
  schemaVersion: 1;
  docId: string;
  normalizedText: string;
  blocks: SourceBlock[];
  /** 本地 PDF 预处理审计信息；旧资料没有该字段时保持兼容。 */
  preprocessing?: DocumentPreprocessingMetadata;
  /** 教材深读的原文件快照；旧索引没有此字段时需显式准备，不能伪造版本。 */
  sourceHash?: string;
  materialParserVersion?: number;
}

export interface SentenceSpan {
  id: string;
  textStart: number;
  textEnd: number;
}

export type KnowledgeIndexStatus = 'disabled' | 'pending' | 'processing' | 'ready' | 'partial' | 'failed';
export type KnowledgeProcessingMode = 'local-only' | 'allow-cloud';

export interface RagKnowledgeSettings {
  enabled: boolean;
  processingMode: KnowledgeProcessingMode;
}

export interface RagKnowledgeDocumentStatus {
  docId: string;
  status: KnowledgeIndexStatus;
  generationId?: string;
  indexedChunks: number;
  failedChunks: number;
  totalChunks: number;
  entityCount?: number;
  argumentCount?: number;
  extractorVersion?: number;
  knowledgePromptVersion?: number;
  error?: string;
  updatedAt?: string;
}

export interface RagKnowledgePendingChunk {
  docId: string;
  generationId: string;
  chunkId: string;
  sectionPath: string;
  sentences: Array<{ id: string; text: string }>;
}

export type KnowledgeEntityType =
  | 'concept'
  | 'person'
  | 'organization'
  | 'method'
  | 'theory'
  | 'technology'
  | 'event'
  | 'place'
  | 'metric'
  | 'material'
  | 'other';

/** 模型只提交候选标注；正文、偏移、docId 和 chunkId 一律由主进程回填。 */
export interface KnowledgeEntityMentionCandidate {
  localId: string;
  surfaceText: string;
  entityType: KnowledgeEntityType;
  sentenceIds: string[];
  aliases?: string[];
  confidence: number;
}

/** Describes how the source speaks, never whether a relation is objectively true. */
export type KnowledgeStatementStatus = 'asserted' | 'research_question' | 'hypothesis' | 'unspecified';

export interface KnowledgeEntityRelationCandidate {
  localId: string;
  subjectMentionId: string;
  predicate: string;
  objectMentionId: string;
  evidenceSentenceIds: string[];
  qualifiers?: string[];
  statementStatus?: KnowledgeStatementStatus;
  confidence: number;
}

export interface KnowledgeArgumentUnitCandidate {
  localId: string;
  mainType: ArgumentFunctionType;
  sentenceIds: string[];
  mentionedEntityMentionIds?: string[];
  confidence: number;
}

export interface KnowledgeArgumentEdgeCandidate {
  localId: string;
  sourceArgumentId: string;
  targetArgumentId: string;
  relation: ArgumentRelation;
  evidenceSentenceIds?: string[];
  confidence: number;
}

export interface RagKnowledgeChunkExtraction {
  chunkId: string;
  entityMentions: KnowledgeEntityMentionCandidate[];
  entityRelations: KnowledgeEntityRelationCandidate[];
  argumentUnits: KnowledgeArgumentUnitCandidate[];
  argumentEdges: KnowledgeArgumentEdgeCandidate[];
}

export type KnowledgeAdmission = 'admitted' | 'low_confidence' | 'audit_only';

export interface KnowledgeEntityMention {
  id: string;
  docId: string;
  chunkId: string;
  sentenceIds: string[];
  surfaceText: string;
  normalizedKey: string;
  entityType: KnowledgeEntityType;
  canonicalEntityId: string;
  textStart: number;
  textEnd: number;
  aliases: string[];
  confidence: number;
  admission: Extract<KnowledgeAdmission, 'admitted' | 'low_confidence'>;
}

export interface KnowledgeEntityRelation {
  id: string;
  docId: string;
  chunkId: string;
  subjectEntityId: string;
  objectEntityId: string;
  predicate: string;
  qualifiers: string[];
  /** Absent on legacy shards; retrieval must not treat absence as a proven assertion. */
  statementStatus?: KnowledgeStatementStatus;
  evidenceSentenceIds: string[];
  confidence: number;
  admission: Extract<KnowledgeAdmission, 'admitted' | 'audit_only'>;
  embedding?: number[];
}

export interface KnowledgeArgumentUnit {
  id: string;
  docId: string;
  chunkId: string;
  sentenceIds: string[];
  mainType: ArgumentFunctionType;
  layer: 'concept' | 'judgment' | 'logic';
  textStart: number;
  textEnd: number;
  text: string;
  mentionedEntityIds: string[];
  confidence: number;
  origin: 'imported-document-extraction';
  admission: Extract<KnowledgeAdmission, 'admitted' | 'low_confidence'>;
  embedding?: number[];
}

export interface KnowledgeArgumentEdge {
  id: string;
  docId: string;
  chunkId: string;
  sourceArgumentId: string;
  targetArgumentId: string;
  relation: ArgumentRelation;
  evidenceSentenceIds: string[];
  confidence: number;
  admission: Extract<KnowledgeAdmission, 'admitted' | 'audit_only'>;
}

export interface CanonicalKnowledgeEntity {
  id: string;
  /** 由同类型显式别名合并的 provisional entity id，供关系索引回解。 */
  memberEntityIds: string[];
  canonicalName: string;
  normalizedKey: string;
  entityType: KnowledgeEntityType;
  aliases: string[];
  mentionIds: string[];
  docIds: string[];
  embedding: number[];
}

export interface KnowledgeEntityCatalog {
  schemaVersion: 1;
  generatedAt: string;
  entities: CanonicalKnowledgeEntity[];
}

export interface RagKnowledgeBatchCommit {
  docId: string;
  generationId: string;
  items: RagKnowledgeChunkExtraction[];
}

/** 补全来源 */
export type ConceptSource = 'browser' | 'rag' | 'hybrid';

export interface ConceptSourceEvidence {
  /** Page-declared date only; not independent verification of publication. */
  publishedAt?: string;
  sourceId: string;
  type: 'web' | 'document' | 'note';
  title: string;
  snippet: string;
  url?: string;
  entityId?: string;
  sectionPath?: string;
  score?: number;
}

/** 文档向量化状态机 */
export type DocumentStatus = 'stored' | 'pending' | 'processing' | 'ready' | 'failed';

export type UploadedDocumentFileType =
  | 'txt'
  | 'md'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'doc'
  | 'ppt'
  | 'xlsx'
  | 'xls'
  | 'epub'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'other';

/** 待确认的概念草稿（预览态，不直接落盘） */
export interface ConceptDraft {
  noteId: string;
  title: string;
  content: string;
  source: ConceptSource;
  references?: Array<{
    sourceId?: string;
    type?: ConceptSourceEvidence['type'];
    title: string;
    url?: string;
    entityId?: string;
    sectionPath?: string;
    snippet?: string;
  }>;
  createdAt: string;
}

/** 资料文档元数据（后端索引库，全局共享） */
export interface UploadedDocument {
  /** Private provenance for the exact downloaded community version. */
  communitySource?: {accountId:string;entryId:string;versionId:string;role:string;kind?:'snapshot'|'file'};
  sourceReadOnly?: boolean;
  /** Community imports build a body index; advanced AI extraction requires a separate user action. */
  processingPolicy?: 'body_only';
  /** Runtime-only background progress; never another stored index. */
  bodyIndexProgress?: {completed:number;total:number};
  id: string;                      // `doc-${ts}`
  fileName: string;
  /** 用户整理资料库时使用的单层分类；为空表示“未分类”，不参与检索或来源身份判断。 */
  category?: string;
  fileType: UploadedDocumentFileType;
  /** 实际存储扩展名（含点），删除和打开时不再根据 fileType 猜测。 */
  extension: string;
  /** 当前是否有解析器，只有 true 的资料才进入向量化队列。 */
  indexable: boolean;
  size: number;                    // 原始字节数
  status: DocumentStatus;          // 向量化状态
  chunkCount: number;              // 已完成向量化的分块数（processing 阶段持续增长）
  totalChars: number;              // 抽取文本总字符数
  error?: string;                  // failed 时的原因
  sourceUrl?: string;              // 经浏览器下载时记录公开来源；不包含登录参数
  /** 解析与向量索引独立：向量失败不意味着已解析原文不可读。 */
  parseStatus?: 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported';
  parseError?: string;
  parsedAt?: string;
  /** L0/L1 索引结构版本；旧 manifest 缺省视为 0。 */
  indexSchemaVersion?: number;
  /** 旧索引仍可检索，定位或文本切分版本过旧时提示用户手动重建。 */
  needsReindex?: boolean;
  knowledgeStatus?: KnowledgeIndexStatus;
  knowledgeGenerationId?: string;
  knowledgeIndexedChunks?: number;
  knowledgeTotalChunks?: number;
  knowledgeEntityCount?: number;
  knowledgeArgumentCount?: number;
  knowledgeExtractorVersion?: number;
  knowledgePromptVersion?: number;
  knowledgeError?: string;
  documentGraphProgress?: {version?:'v5.0';completedWindows:number;totalWindows:number;nodes:number;entities:number;unresolved:number;bridgePending?:boolean;bridgeReviewRequired?:boolean;stale?:boolean;rebuilding?:boolean;published?:boolean;publicationPending?:boolean};
  uploadAt: string;
}

/** 文档分块 + 向量（后端存储，384 维） */
export interface DocumentChunk {
  id: string;                      // `${docId}#${idx}`
  docId: string;
  /** Host-only coordinate adapter for original paragraphs; has no passage embedding. */
  sourceBasis?: 'structured-document-v1';
  fileName: string;
  index: number;
  sectionPath: string;             // 层级上下文前缀（如「# 机器学习 > ## 监督学习」）
  content: string;
  /** 在换行归一化后的源文本中的半开区间；旧索引可缺省。 */
  textStart?: number;
  textEnd?: number;
  paragraphCount?: number;
  /** 单句超出预算被硬切；其中论证单元仅保留审计，不进入生产图。 */
  forcedSplit?: boolean;
  sentenceSpans?: SentenceSpan[];
  sourceBlockIds?: string[];
  sourceLocators?: SourceLocator[];
  contentHash?: string;
  schemaVersion?: number;
  embeddingModelVersion?: string;
  /** Number of sentence-aligned local-model views pooled into this complete semantic chunk. */
  embeddingViewCount?: number;
  embedding: number[];
}

export interface DocumentPreviewChunk {
  id: string;
  index: number;
  sectionPath: string;
  content: string;
  /** Full original chunk length/hash, even when the preview text is bounded. */
  contentLength?: number;
  contentHash?: string;
  sourceLocators?: SourceLocator[];
}

export interface DocumentPreview {
  document: UploadedDocument;
  chunks: DocumentPreviewChunk[];
  totalChunkCount: number;
  truncated: boolean;
  /** Present when the preview window was opened around a cited RAG chunk. */
  focusedChunkId?: string;
}

/** 文档检索命中结果 */
export interface DocumentSearchResult {
  /** Version-bound native graph entries; separate from legacy argument/scoring units. */
  documentGraphAnchors?: Array<{docId: string; nodeId: string}>;
  /** Retrieval-only node entries, independent of which passage survives fusion. */
  documentGraphEntryCandidates?: Array<{docId: string; nodeId: string; score: number;
    channels: Array<'argument' | 'dense' | 'sparse' | 'facet'>;
    denseRank?: number; sparseRank?: number; facetRanks?: Array<number | undefined>}>;
  argumentContext?: import('./electron/rag/argumentSearchBridge').ArgumentSearchContextAttachment;
  docId: string;
  fileName: string;
  chunkId: string;
  sectionPath: string;
  score: number;
  snippet: string;
  /** 命中词在完整 chunk 中的位置，供审计界面高亮；无字面命中时可能为 0。 */
  hitStart?: number;
  /** 可选的原文件定位；旧 Agent/前端忽略该字段仍保持兼容。 */
  sourceLocators?: SourceLocator[];
  matchKinds?: Array<'passage' | 'entity' | 'argument'>;
  entities?: KnowledgeEntityHit[];
  entityRelations?: KnowledgeEntityRelationHit[];
  arguments?: KnowledgeArgumentHit[];
  argumentEdges?: KnowledgeArgumentEdgeHit[];
  relationSummary?: string;
  retrievalVersion?: number;
}

export type DocumentQueryIntent =
  | 'definition' | 'fact' | 'entity_relation' | 'reason' | 'support'
  | 'opposition' | 'comparison' | 'application' | 'general';

export interface DocumentSearchOptions {
  /** Explicit host lease only. Missing keeps old search behaviour and creates no lease. */
  argumentEnvironmentId?: string;
  mode?: 'auto' | 'passage' | 'entity' | 'argument';
  expandGraph?: boolean;
  /** 仅显式传入才限制范围；undefined 保持原检索行为，[] 不检索任何资料。 */
  allowedDocIds?: string[];
}

export interface KnowledgeEntityHit {
  entityId: string;
  canonicalName: string;
  entityType: KnowledgeEntityType;
  match: 'direct' | 'expanded';
  score: number;
}

export interface KnowledgeEntityRelationHit {
  relationId: string;
  subjectEntityId: string;
  subjectName: string;
  predicate: string;
  objectEntityId: string;
  objectName: string;
  confidence: number;
  qualifiers?: string[];
  statementStatus?: KnowledgeStatementStatus;
  evidenceQuotes?: string[];
  evidenceSentenceIds: string[];
  direction: 'outgoing' | 'incoming' | 'direct';
}

export interface KnowledgeArgumentHit {
  argumentId: string;
  mainType: ArgumentFunctionType;
  text: string;
  confidence: number;
  origin: 'imported-document-extraction';
  admission: 'admitted';
  match: 'direct' | 'expanded';
}

export interface KnowledgeArgumentEdgeHit {
  edgeId: string;
  sourceArgumentId: string;
  targetArgumentId: string;
  relation: ArgumentRelation;
  confidence: number;
  direction: 'supports' | 'supported_by' | 'opposes' | 'opposed_by';
}

/** 后端联网生成响应 */
export interface ConceptGenerateResponse {
  content: string;
  references?: Array<{ title: string; url?: string }>;
}

/* ===== 应用板块（一对一对话场景）类型 re-export ===== */
export * from './types/scene';

/* ===== S4 数理场景类型 re-export ===== */
export * from './types/sceneS4';

