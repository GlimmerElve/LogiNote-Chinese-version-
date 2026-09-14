import type { LearningAbility } from './services/learningAbility/types';
import type { ArgDoc } from './services/argumentDoc/types';

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
  /** 论证结构文档数组（心流复盘分析产出，一笔记可含多张图，随笔记作为可分享内容持久化） */
  argumentDocs?: ArgDoc[];
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

export type ViewMode = 'editor' | 'graph' | 'timeline' | 'plan' | 'ai_segment' | 'settings' | 'learn' | 'flow' | 'review' | 'bubble' | 'documents' | 'home' | 'argument';

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

export type LlmWorkflowId = 'plan-generation' | 'text-segmentation' | 'auto-link' | 'flow-analysis' | 'review-questioning' | 'review-tutor' | 'review-scoring' | 'review-bubble' | 'question-answer' | 'study-task-generation' | 'knowledge-discovery' | 'knowledge-mastery-scoring' | 'profile-evidence-layered' | 'profile-style-cognitive' | 'profile-concept-aliases' | 'logic-check' | 'flow-preprocess' | 'storm-multi-perspective' | 'storm-contradiction' | 'storm-brief' | 'storm-peer-review' | 'storm-abstract';

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
  /** 是否绝对化断言（一定/必然/所有） */
  absolutistClaims?: boolean;
  /** 是否不留余地、不容质疑 */
  leavesNoRoom?: boolean;
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

