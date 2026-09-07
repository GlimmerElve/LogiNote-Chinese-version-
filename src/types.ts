import type { LearningAbility } from './services/learningAbility/types';

export type NoteType = 'project' | 'knowledge';

export type GraphMode = 'knowledge' | 'overview';

export interface DueDateItem {
  id: string;
  noteId: string;
  noteTitle: string;
  taskText: string;
  dueDate: string;
  completed: boolean;
  priority: 'high' | 'medium' | 'low';
}

export interface LogicSegment {
  id: string;
  type: 'concept' | 'definition' | 'schedule' | 'logic_flow' | 'summary' | 'key_term';
  title: string;
  content: string;
  confidence: number;
  suggestedWikiLink?: string;
  extractedDate?: string;
  status?: 'accepted' | 'suggested' | 'rejected';
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

export interface ResourceItem {
  title: string;
  url: string;
  platform?: string;
  /** 区分在线/本地资源，缺省按 online 处理 */
  kind?: ResourceKind;
  /** 本地文件类型，用于 webview 内嵌/兜底判断 */
  fileType?: LocalFileType;
}

export interface NoteItem {
  id: string;
  title: string;
  content: string;
  noteType: NoteType;
  parentId?: string;
  tags: string[];
  /** 知识点别名（用于「自动关联」时匹配同义/异名概念，如 "LLM"、"Large Language Model"） */
  aliases?: string[];
  links: string[];
  backlinks: string[];
  dueDates: DueDateItem[];
  logicSegments?: LogicSegment[];
  pinned?: boolean;
  isFavorite?: boolean;
  color?: string;
  resources?: ResourceItem[];
  createdAt: string;
  updatedAt: string;
  aiAnalyzedAt?: string;
  questions?: StudyQuestionCard[];
  flowSummary?: string;
  dsrState?: KnowledgePointDsr;
  lastReferencedAt?: string;
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export interface KnowledgePointDsr {
  difficulty: number;
  stability: number;
  lastReviewedAt: string | null;
  reviewCount: number;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  /** 概念掌握度（0-100，理解 + 表达质量，区别于记忆巩固的 stability） */
  conceptMastery?: number;
  /** 掌握的累计有效样本数（≥2 才可信） */
  conceptMasterySamples?: number;
  /** conceptMastery 最后更新时间（ISO） */
  conceptMasteryUpdatedAt?: string;
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

export type ViewMode = 'editor' | 'graph' | 'timeline' | 'plan' | 'ai_segment' | 'settings' | 'learn' | 'flow' | 'review' | 'bubble' | 'documents' | 'home';

export interface PlanNode {
  key: string;
  title: string;
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
  children: PlanNode[];
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
  enabled: boolean;
  createdAt: string;
}

export type LlmWorkflowId = 'plan-generation' | 'text-segmentation' | 'auto-link' | 'flow-analysis' | 'review-questioning' | 'review-tutor' | 'review-scoring' | 'review-bubble' | 'question-answer' | 'study-task-generation' | 'knowledge-discovery' | 'knowledge-mastery-scoring' | 'profile-evidence-layered' | 'profile-style-cognitive' | 'profile-concept-aliases' | 'logic-check' | 'storm-multi-perspective' | 'storm-contradiction' | 'storm-brief' | 'storm-peer-review' | 'storm-abstract';

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
  providerId: string;
  model: string;
  workflow: LlmWorkflowId;
  userInput: string;
  context?: Record<string, string>;
  stream?: boolean;
  tools?: LlmTool[];
  messages?: ChatMessage[];
}

export interface LlmCallResponse {
  content: string;
  parsedJson?: any;
  usage?: { promptTokens: number; completionTokens: number; };
}

export interface LlmSettings {
  providers: LlmProvider[];
  defaultProviderId?: string;
  /** 工作流 → 提供商 id 的绑定映射（可部分绑定，未绑定的走 defaultProviderId） */
  workflowBinding: Partial<Record<LlmWorkflowId, string>>;
}

export interface VaultSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: 'indigo' | 'purple' | 'emerald' | 'coral' | 'rose' | 'amber' | 'teal' | 'slate';
  localOnly: boolean;
  enableEncryption: boolean;
  encryptionPassword?: string;
  cloudSyncEnabled: boolean;
  autoAiSegment: boolean;
  dueNotification: boolean;
  /** 编辑器正文字号（像素，精细调节，默认 16） */
  fontSize: number;
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

export interface AiSegmentRequest {
  text: string;
  noteTitle?: string;
  existingNotes?: string[];
}

export interface AiSegmentResponse {
  summary: string;
  segments: LogicSegment[];
  suggestedWikiLinks: Array<{ originalTerm: string; linkedTitle: string; reason: string }>;
  extractedStudyPlans: Array<{ taskText: string; dueDate: string; priority: 'high' | 'medium' | 'low' }>;
  overallStructure: string;
  polishedText?: string;
  extensions?: Array<{ type: string; title: string; content: string; reason?: string }>;
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
  title: string;
  snippet: string;
  embedding: number[];
  updatedAt: string;
}

export interface NoteSearchResult {
  noteId: string;
  title: string;
  score: number;
  snippet: string;
}

export interface PlanChatResponse {
  isComplete: boolean;
  question?: string;
  planTree?: any[];
  reasoning?: string;
}

export type LearnMode = 'flow' | 'review' | 'storm';

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
  reviewCount: number;
  speakingNotes: FlowSpeakingNote[];
  reviewIntervalMinutes: number;
  summary?: string;
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

/** 表达风格（0-1 或 0-100） */
export interface ExpressionStyle {
  /** 0-1 偏好举例 */
  prefersExample: number;
  /** 0-1 偏好类比 */
  prefersAnalogy: number;
  /** 0-1 偏好定义 */
  prefersDefinition: number;
  /** 0-1 偏好逻辑推导 */
  prefersDerivation: number;
  /** 0-1 先结论后展开（越小越倾向先铺垫） */
  conclusionFirst: number;
  /** 0-100 术语准确性 */
  terminologyAccuracy: number;
  /** 0-100 自我修正能力 */
  selfCorrection: number;
}

/** 用户长期画像（v2：user-state 单份持久化 + A1 内存缓存） */
export interface UserProfile {
  version: 2;
  updatedAt: string;
  analysisCount: number;
  ability: LayeredAbility;
  cognitiveStyle: CognitiveStyle;
  expressionStyle: ExpressionStyle;
  /** 学习能力（六维，跨时间纵向能力） */
  learningAbility: LearningAbility;
}

/** 单条知识点观察（flow-analysis 输出，含归并与候选标记） */
export interface ConceptObservation {
  /** 归一并归一化后的中文名 */
  canonicalName: string;
  /** 用户实际使用的词（含英文），用于归并 */
  aliases: string[];
  /** 0-100 本次观察到的掌握信号（旧字段，逐步被三层分数字段取代，保留兼容） */
  masterySignal?: number;
  /** true=已提及（活跃）；false=需补充（默认不掌握） */
  mentioned: boolean;
  /** 若能匹配到已有笔记，给出其标题（用于定位） */
  existingNoteTitle?: string;
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
  expressionStyle?: Partial<ExpressionStyle>;
  /** 知识点掌握度观察（来源一口语复盘核心） */
  concepts: ConceptObservation[];
}

/* ===== 知识点分层掌握度评分（两阶段 + 并行） ===== */

/** 知识点触及的最高认知层级（触及层而非达标层） */
export type MasteryLevel = 'concept' | 'judgment' | 'reasoning';

/** 阶段一识别出的三类知识点 */
export type KnowledgePointCategory = 'known' | 'potential';

/** 阶段一发现结果（供选择窗口展示） */
export interface KnowledgePointCandidate {
  id: string;
  name: string;
  category: KnowledgePointCategory;
  existingNoteTitle?: string;
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
}

/* ===== 存储重构：可分享内容 vs 个人数据分离 ===== */

/** 单篇笔记的个人状态（从 NoteItem 抽离、随 user-state 持久化的字段） */
export interface UserNoteState {
  /** 复习记忆 + 概念掌握度（已含 conceptMastery） */
  dsrState?: KnowledgePointDsr;
  flowSummary?: string;
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

/** 补全来源 */
export type ConceptSource = 'web' | 'rag';

/** 文档向量化状态机 */
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** 待确认的概念草稿（预览态，不直接落盘） */
export interface ConceptDraft {
  noteId: string;
  title: string;
  content: string;
  source: ConceptSource;
  references?: Array<{ title: string; url?: string }>;
  createdAt: string;
}

/** 资料文档元数据（后端索引库，全局共享） */
export interface UploadedDocument {
  id: string;                      // `doc-${ts}`
  fileName: string;
  fileType: 'txt' | 'md' | 'pdf';
  size: number;                    // 原始字节数
  status: DocumentStatus;          // 向量化状态
  chunkCount: number;              // 已完成向量化的分块数（processing 阶段持续增长）
  totalChars: number;              // 抽取文本总字符数
  error?: string;                  // failed 时的原因
  uploadAt: string;
}

/** 文档分块 + 向量（后端存储，384 维） */
export interface DocumentChunk {
  id: string;                      // `${docId}#${idx}`
  docId: string;
  fileName: string;
  index: number;
  sectionPath: string;             // 层级上下文前缀（如「# 机器学习 > ## 监督学习」）
  content: string;
  embedding: number[];
}

/** 文档检索命中结果 */
export interface DocumentSearchResult {
  docId: string;
  fileName: string;
  chunkId: string;
  sectionPath: string;
  score: number;
  snippet: string;
}

/** 后端联网生成响应 */
export interface ConceptGenerateResponse {
  content: string;
  references?: Array<{ title: string; url?: string }>;
}

