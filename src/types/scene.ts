/**
 * 应用板块 — 一对一对话场景类型系统
 *
 * 设计要点：
 * 1. 固定骨架（七要素 + engineConfig + events）由类型强约束；
 *    骨架之外的可变字段走 `SceneSpec.extras`（自由扩展层）。
 * 2. MVP 只支持一对一（用户 ↔ 单个 NPC），多角色仅保留 `DialogueParadigm` 枚举占位。
 * 3. 角色属性为模块化字段（`RoleAttribute[]`），用户可增删与开关。
 * 4. 指标全部由 LLM 依语义驱动，前端不做规则引擎。
 * 5. 结束信号 `[结束:原因]` 与动作描写 `*...*` 由文本标记解析，零额外 LLM 调用。
 */

import type { ComputeSpec, HelpSpec, DerivationCanvasState, DerivationEvent } from './sceneS4';
import type { LearningTaskBinding } from '../services/learningCompletion';

/* ==========================================================================
 * 一、场景 Skill 类型
 * ========================================================================== */

/**
 * 场景 Skill 编号。
 * MVP 仅实现 S1（对话博弈），其余为类型占位，便于后续扩展而无需改结构。
 */
export type SceneSkillType =
  | 'S1'  // 对话博弈
  | 'S2'  // 通用画布试验入口（版本化独立协议，不迁移历史占位数据）
  | 'S3'  // 数据建模与分析
  | 'S4'  // 公式推演与计算
  | 'S5'  // 参数实验与仿真
  | 'S6'  // 构建与合成
  | 'S7'  // 代码与算法沙盒
  | 'S8'  // 训练与评估竞技场
  | 'S9'  // 证明与推导工作台
  | 'S10' // 诊断与调试
  | 'S11' // 设计与决策
  | 'S12' // 实验设计与复现
  | 'S0'; // 基础练习

/**
 * 对话交互范式。
 * 前两项为多角色扩展位（本期不实现），MVP 恒为 `single-role-dialogue`。
 */
export type DialogueParadigm =
  | 'multi-role-independent-memory'  // 多角色独立记忆 · 用户交互对话
  | 'multi-role-event-response'      // 多角色 · 用户指定事件查看角色应对
  | 'single-role-dialogue';          // 单角色对话（MVP）

/** 通用 S1 回合允许使用的富内容格式声明。渲染支持将在后续阶段接入。 */
export type SceneOutputFormat = 'markdown' | 'latex' | 'code' | 'table' | 'image';

/**
 * 通用 S1 可声明的用户交互类型。
 *
 * 注意：类型进入协议并不等于当前客户端已经实现对应控件。生成阶段必须再与
 * 运行时公布的 capability 列表取交集，不能让 LLM 臆造客户端无法执行的操作。
 */
export type SceneInteractionType =
  | 'text'
  | 'single-choice'
  | 'multiple-choice'
  | 'ordering'
  | 'fill-blanks'
  | 'question-set';

/** 场景搭建 Skill 可选择的稳定配方；用于 Agent 间移交，不包含具体题目内容。 */
export type SceneRecipeId =
  | 'agent-designed'
  | 'free-dialogue'
  | 'question-answer'
  | 'role-dialogue'
  | 'guided-practice'
  | 'batch-assessment'
  | 'socratic-dialogue'
  | 'case-analysis'
  | 'decision-simulation'
  | 'process-training'
  | 'guided-derivation';

/** 场景装配器可解析的稳定能力标识；同时用于 Agent 移交、预检和本地审计。 */
export type SceneCapabilityId =
  | 'text'
  | 'single-choice'
  | 'multiple-choice'
  | 'ordering'
  | 'fill-blanks'
  | 'true-false'
  | 'question-set'
  | 'markdown-content'
  | 'given-node'
  | 'assumption-node'
  | 'formula-node'
  | 'conclusion-node'
  | 'derivation-edge'
  | 'mathlive-editor'
  | 'step-submit'
  | 'premise-validation'
  | 'compute-help';

/**
 * 由场景 Agent 按用户意图选择的提示词模块。
 *
 * 这些 id 不是给 LLM 的建议标签，而是运行时装配契约：
 * 未启用的模块不得被放入生成、回合或评分上下文。
 */
export type ScenePromptModuleId =
  | 'model-experiment'
  | 'input-form'
  | 'role-context'
  | 'scenario-framing'
  | 'resource-grounding'
  | 'personal-cognition-grounding'
  | 'structured-interaction'
  | 'deterministic-assessment'
  | 'adaptive-progression'
  | 'turn-agent-planning'
  | 'metric-state'
  | 'event-system'
  | 'profile-personalization';

/** 场景级交互能力白名单。旧场景缺省时等价于仅支持 text。 */
export interface SceneInteractionProtocol {
  version: '1.0';
  /** 本场景允许各回合选用的交互类型。 */
  allowedTypes: SceneInteractionType[];
  /** LLM 没有为某回合指定交互时采用的类型，必须属于 allowedTypes。 */
  defaultType: SceneInteractionType;
  /** 结构化控件失效或旧客户端读取时是否允许退回文本回答。 */
  allowTextFallback: boolean;
}

/** 单选、多选回合中展示给用户的选项；不携带正确答案，避免泄露判据。 */
export interface SceneInteractionOption {
  id: string;
  label: string;
  description?: string;
}

/** 排序回合中可移动的项目。 */
export interface SceneOrderingItem {
  id: string;
  content: string;
}

/** 填空回合中的单个空位。 */
export interface SceneBlankItem {
  id: string;
  label?: string;
  placeholder?: string;
}

export interface SceneInteractionOrderPolicy {
  mode: 'shuffle' | 'preserve';
  reason?: 'true-false' | 'strategy-choice' | 'position-dependent' | 'ordered-scale' | 'ordered-instruction';
}

interface SceneInteractionDirectiveBase {
  /** 回合内稳定 id，用户响应必须原样引用。 */
  id: string;
  type: SceneInteractionType;
  /** 控件附近的简短操作说明；主要题干仍放在 SceneMessage.content。 */
  instruction?: string;
  required: boolean;
}

export interface SceneTextInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'text';
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}

export interface SceneSingleChoiceInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'single-choice';
  orderPolicy?: SceneInteractionOrderPolicy;
  /** Explicit per-task grading; omitted only for legacy stored directives. */
  assessment?: 'objective' | 'none';
  options: SceneInteractionOption[];
  allowExplanation?: boolean;
}

export interface SceneMultipleChoiceInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'multiple-choice';
  orderPolicy?: SceneInteractionOrderPolicy;
  /** Strategy choices may deliberately have no single correct answer. */
  assessment?: 'objective' | 'none';
  options: SceneInteractionOption[];
  minSelections?: number;
  maxSelections?: number;
  allowExplanation?: boolean;
}

export interface SceneOrderingInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'ordering';
  orderPolicy?: SceneInteractionOrderPolicy;
  assessment?: 'objective' | 'none';
  items: SceneOrderingItem[];
  allowExplanation?: boolean;
}

export interface SceneFillBlanksInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'fill-blanks';
  blanks: SceneBlankItem[];
  allowExplanation?: boolean;
}

export interface SceneQuestionSetChoiceItem {
  orderPolicy?: SceneInteractionOrderPolicy;
  id: string;
  type: 'single-choice' | 'multiple-choice';
  content: string;
  required: boolean;
  options: SceneInteractionOption[];
  minSelections?: number;
  maxSelections?: number;
}

export interface SceneQuestionSetTrueFalseItem {
  id: string;
  type: 'true-false';
  content: string;
  required: boolean;
  trueLabel?: string;
  falseLabel?: string;
}

/** 第一阶段题组支持选择与判断；后续原子组件可按注册表逐步加入。 */
export type SceneQuestionSetItem = SceneQuestionSetChoiceItem | SceneQuestionSetTrueFalseItem;

export interface SceneQuestionSetInteractionDirective extends SceneInteractionDirectiveBase {
  type: 'question-set';
  title?: string;
  description?: string;
  submissionMode: 'batch';
  feedbackMode: 'after-submit';
  items: SceneQuestionSetItem[];
}

/** AI 回合附带的可执行交互指令。 */
export type SceneInteractionDirective =
  | SceneTextInteractionDirective
  | SceneSingleChoiceInteractionDirective
  | SceneMultipleChoiceInteractionDirective
  | SceneOrderingInteractionDirective
  | SceneFillBlanksInteractionDirective
  | SceneQuestionSetInteractionDirective;

interface SceneInteractionResponseBase {
  /** 对应 SceneInteractionDirective.id。 */
  interactionId: string;
  type: SceneInteractionType;
  submittedAt: string;
}

export interface SceneTextInteractionResponse extends SceneInteractionResponseBase {
  type: 'text';
  value: string;
}

export interface SceneSingleChoiceInteractionResponse extends SceneInteractionResponseBase {
  type: 'single-choice';
  selectedId: string;
  explanation?: string;
}

export interface SceneMultipleChoiceInteractionResponse extends SceneInteractionResponseBase {
  type: 'multiple-choice';
  selectedIds: string[];
  explanation?: string;
}

export interface SceneOrderingInteractionResponse extends SceneInteractionResponseBase {
  type: 'ordering';
  orderedIds: string[];
  explanation?: string;
}

export interface SceneFillBlanksInteractionResponse extends SceneInteractionResponseBase {
  type: 'fill-blanks';
  values: Record<string, string>;
  explanation?: string;
}

export type SceneQuestionSetAnswer =
  | { itemId: string; type: 'single-choice'; selectedId: string }
  | { itemId: string; type: 'multiple-choice'; selectedIds: string[] }
  | { itemId: string; type: 'true-false'; value: boolean };

export interface SceneQuestionSetInteractionResponse extends SceneInteractionResponseBase {
  type: 'question-set';
  answers: SceneQuestionSetAnswer[];
}

export type SceneQuestionSetEvaluationItem =
  | { itemId: string; type: 'single-choice'; correctId: string; explanation?: string }
  | { itemId: string; type: 'multiple-choice'; correctIds: string[]; explanation?: string }
  | { itemId: string; type: 'true-false'; correctValue: boolean; explanation?: string };

/** 仅保存在运行态、不会传给交互组件的题组评分依据。 */
export interface SceneQuestionSetEvaluation {
  interactionId: string;
  type: 'question-set';
  items: SceneQuestionSetEvaluationItem[];
}

/** 用户针对结构化回合提交的原始答案；content 只保存其可读摘要。 */
export type SceneInteractionResponse =
  | SceneTextInteractionResponse
  | SceneSingleChoiceInteractionResponse
  | SceneMultipleChoiceInteractionResponse
  | SceneOrderingInteractionResponse
  | SceneFillBlanksInteractionResponse
  | SceneQuestionSetInteractionResponse;

export type SceneInteractionDiagnosticReason =
  | 'accepted'
  | 'conversation'
  | 'invalid-json'
  | 'empty-response'
  | 'missing-interaction'
  | 'invalid-interaction-shape'
  | 'missing-id'
  | 'unsupported-type'
  | 'disallowed-type'
  | 'invalid-fields'
  | 'scene-ended';

/**
 * 通用回合的交互协议诊断。只描述协议形态，不保存题干、答案或模型原文。
 */
export interface SceneInteractionDiagnostic {
  requestedType?: string;
  resolvedType: SceneInteractionType | 'none';
  outcome: 'accepted' | 'text-fallback' | 'none';
  reason: SceneInteractionDiagnosticReason;
}

/** 通用行为场景的一次结构化 AI 回合。 */
export interface SceneGeneralTurnResult {
  experiments?: SceneExperimentRecord[];
  taskUpdate?: SceneTaskUpdate;
  userRequestedEnd?: boolean;
  /** 面向用户展示的正文，不包含机器控制标记。 */
  content: string;
  /** 本轮需要用户完成的操作；无操作时省略。 */
  interaction?: SceneInteractionDirective;
  /** 与题组指令分离的私有评分依据；前端不渲染。 */
  interactionEvaluation?: SceneQuestionSetEvaluation;
  objectiveEvaluation?: SceneObjectiveEvaluation;
  interactionPreparation?: import('../services/scene/sceneTaskPreparation').SceneInteractionPreparation;
  /** 仅供本地质量审计使用，不进入模型上下文。 */
  interactionDiagnostic: SceneInteractionDiagnostic;
  /** 场景自然结束时给出原因，替代正文中的 [结束:...] 标记。 */
  endReason?: string;
  workingMemory?: SceneWorkingMemory;
  teachingState?: SceneTeachingState;
  discussionInteractionId?: string;
  agentTrace?: SceneAgentTurnTrace;
}

export type SceneObjectiveEvaluation =
  | { interactionId: string; type: 'single-choice'; correctId: string; explanation: string }
  | { interactionId: string; type: 'multiple-choice'; correctIds: string[]; explanation: string }
  | { interactionId: string; type: 'ordering'; correctOrderIds: string[]; explanation: string };
export interface SceneObjectiveAssessment {
  interactionId: string;
  correct: boolean;
  explanation: string;
}

export type SceneFeedbackTiming = 'immediate' | 'on-request' | 'at-end';
export interface SceneAnswerFeedbackPolicy {
  correctness: SceneFeedbackTiming;
  explanation: SceneFeedbackTiming;
}
export interface SceneTeachingConditionalRule {
  when: 'any' | 'correct' | 'incorrect' | 'on-request';
  correctness?: SceneFeedbackTiming;
  explanation?: SceneFeedbackTiming;
  responseStyle?: 'brief-confirmation' | 'explanation' | 'agent-decides';
}
export interface SceneTeachingInstructionUpdate {
  id: string;
  action: 'set' | 'revoke';
  scope: 'session' | 'task' | 'review';
  interactionId?: string;
  target?: 'all' | 'incorrect';
  instruction?: string;
  rules?: SceneTeachingConditionalRule[];
  source: { sourceMessageId: string; quote: string };
}
export interface SceneTeachingInstruction {
  id: string;
  acceptedOrder?: number;
  scope: 'session' | 'task' | 'review';
  interactionIds?: string[];
  instruction: string;
  rules: SceneTeachingConditionalRule[];
  source: { sourceMessageId: string; quote: string };
}
/** Semantic choices, not a prescribed teaching workflow or new tool authorization. */
export interface SceneTeachingDirective {
  /** Current semantic request only; does not persist as a global policy. */
  explanationRequested?: boolean;
  policyUpdates?: SceneTeachingInstructionUpdate[];
  focus?: { action: 'focus' | 'release'; interactionId?: string };
  progression?: 'pause' | 'resume';
  feedback?: { scope: 'task' | 'review' | 'session'; target?: 'all' | 'incorrect'; interactionId?: string; correctness?: SceneFeedbackTiming; explanation?: SceneFeedbackTiming };
}
export interface SceneLearningNote {
  id: string;
  interactionId?: string;
  kind: 'question' | 'misconception' | 'self-explanation' | 'hint-dependence' | 'uncertain';
  status: 'open' | 'resolved';
  summary: string;
  originalSummary?: string;
  evidence: Array<{ sourceMessageId: string; quote: string }>;
}
export interface SceneTeachingState {
  /** Session rules survive optional-history pruning; review instructions expire on the next user input. */
  activeInstructions?: SceneTeachingInstruction[];
  policyOrder?: number;
  instructionChanges?: Array<{ acceptedOrder?: number; id: string; action: 'set' | 'revoke'; scope: 'session' | 'task' | 'review'; source: { sourceMessageId: string; quote: string } }>;
  lastAnswerMessageId?: string;
  discussion?: { interactionId: string; answerMessageId: string };
  pause?: { sourceMessageId: string; quote: string };
  feedbackPolicy?: SceneAnswerFeedbackPolicy;
  feedbackSource?: { sourceMessageId: string; quote: string; acceptedOrder?: number };
  taskFeedback?: Array<{ acceptedOrder?: number; interactionId: string; correctness?: SceneFeedbackTiming; explanation?: SceneFeedbackTiming; sourceMessageId?: string; quote?: string }>;
  helpRequests?: Array<{ interactionId: string; sourceMessageId: string }>;
  notes: SceneLearningNote[];
}

export type SceneRuntimeMode = 'dialogue' | 'qa' | 'coaching' | 'simulation' | 'assessment' | 'derivation';
export type SceneRuntimeToolId = 'knowledge-notes' | 'documents' | 'document-arguments' | 'argument-chain' | 'learner-profile' | 'model-experiment';

export interface SceneCapabilityPlan {
  needs: Array<{ id: string; goal: string; capabilityIds: string[] }>;
  missing: Array<{ goal: string; reason: string }>;
}
export interface SceneExperimentPolicy {
  criteria: string[];
  maxExperiments: number;
  maxOutputTokens: number;
  temperature: number;
}
export interface SceneExperimentInput {
  promptSourceMessageId: string;
  promptQuote?: string;
  promptFieldId?: string;
  inputSourceMessageId?: string;
  inputQuote?: string;
  inputFieldId?: string;
  outputFormat: 'text' | 'json-object';
}
export interface SceneInputForm {
  id: string;
  title: string;
  description?: string;
  fields: Array<{ id: string; label: string; kind: 'text' | 'textarea' | 'select'; required: boolean;
    purpose?: 'prompt' | 'test-input' | 'output-format' | 'context'; placeholder?: string; maxLength: number;
    options?: Array<{ value: string; label: string }> }>;
}
export interface SceneFormSubmission { formId: string; values: Record<string, string> }
export interface SceneExperimentRecord {
  id: string;
  sourceUserMessageId: string;
  prompt: string;
  input: string;
  outputFormat: 'text' | 'json-object';
  criteria: string[];
  model: string;
  temperature: number;
  maxOutputTokens: number;
  output: string;
  status: 'complete' | 'failed';
  formatValid?: boolean;
  evaluation: Array<{ criterion: string; verdict: 'met' | 'unmet' | 'uncertain'; evidence: string; suggestion: string }>;
  error?: string;
}
export type SceneRuntimeAction = 'respond' | 'clarify' | 'challenge' | 'evaluate' | 'advance' | 'summarize' | 'finish';

/** A task lifecycle change must be grounded in the latest conversational user turn. */
export interface SceneTaskUpdate {
  operation: 'replace' | 'cancel';
  interactionId: string;
  sourceUserMessageId: string;
  reason: string;
}

/** 搭建阶段生成，运行时逐次校验；模型不能扩大此契约的权限。 */
export interface SceneRuntimeContract {
  version: '1.0';
  mode: SceneRuntimeMode;
  initiator: 'user' | 'agent' | 'either';
  allowedTools: SceneRuntimeToolId[];
  allowedActions: SceneRuntimeAction[];
  allowedInteractionTypes: SceneInteractionType[];
  /** An independent child whitelist prevents question-set from bypassing answer-kind restrictions. */
  allowedQuestionItemTypes?: Array<SceneQuestionSetItem['type']>;
  allowTextFallback: boolean;
  /** Conversation is independent of raw-text answers; defaults to true. */
  allowConversation?: boolean;
  /** undefined 表示该来源全局；空数组表示没有授权任何资源。 */
  scope: { noteIds?: string[]; documentIds?: string[]; cognitionRecordIds?: string[] };
  evaluation: 'none' | 'on-request' | 'each-answer';
  /** Local answer checking is always independent of when results are revealed. */
  answerFeedback?: SceneAnswerFeedbackPolicy;
  completion: 'user-controlled' | 'objective';
  maxToolCallsPerTurn: number;
  maxPlanningSteps: number;
  maxUserTasksPerTurn: number;
  flowGuidance: string;
  /** 可选里程碑；普通对话用单一会话阶段，无需预设逐轮脚本。 */
  stages?: Array<{ id: string; goal: string; allowedNext: string[] }>;
  initialStageId?: string;
}

export interface SceneWorkingMemory {
  stageId?: string;
  /** 仅作本局导航；不能作为已验证事实或长期画像。 */
  focus: string;
  pendingQuestions: string[];
  resolvedQuestions: string[];
  observations: Array<{ text: string; sourceMessageIds: string[] }>;
  /** 用户原话，必须可以回溯到本局用户消息。 */
  userStatements: Array<{ quote: string; sourceMessageId: string }>;
  lastStrategy: string;
  updatedAtTurn: number;
}

/** 不保存工具原文、画像或检索内容。 */
export interface SceneAgentTurnTrace {
  understandingSteps?: number;
  planningSteps: number;
  tools: Array<{ id: SceneRuntimeToolId; status: 'ready' | 'empty' | 'unavailable' }>;
  fallbackUsed: boolean;
  budgetExhausted: boolean;
}

/**
 * 通用 S1 的交互行为契约。字段存在时不再按传统 NPC 角色扮演发言。
 * 自然语言字段让 LLM 能描述答题、诊断、教学、辩论等不同回合范式。
 */
export interface SceneBehaviorSpec {
  /** 由场景搭建 Skill 选择的配方；后续多 Agent 只需传递该稳定 id。 */
  recipeId?: SceneRecipeId;
  kind: string;
  aiBehavior: string;
  userAction: string;
  evaluationRule: string;
  progressionRule: string;
  outputFormats?: SceneOutputFormat[];
  /** 场景级交互白名单；历史数据缺省时按仅文本协议处理。 */
  interaction?: SceneInteractionProtocol;
}

/* ==========================================================================
 * 二、角色（模块化字段）
 * ========================================================================== */

/** 角色属性字段（模块化，用户可增删；`enabled=false` 时不参与 prompt 拼装） */
export interface RoleAttribute {
  id: string;
  /** 字段名，如「身份」「性格特点」「说话风格」「初始立场」「隐藏目标」 */
  key: string;
  /** 字段内容 */
  value: string;
  /** 是否启用（关闭则不参与 prompt 拼装） */
  enabled: boolean;
}

/** 角色定义（MVP：场景中有且仅有 1 个 NPC 角色） */
export interface RoleSpec {
  id: string;
  /** 角色名/称谓 */
  name: string;
  /** 模块化属性字段列表 */
  attributes: RoleAttribute[];
}

/** 角色字段预设模板（用于「添加字段」下拉的候选） */
export const ROLE_ATTRIBUTE_PRESETS: string[] = [
  '身份',
  '性格特点',
  '说话风格',
  '初始立场',
  '隐藏目标',
  '背景故事',
  '知识水平',
  '情绪状态',
  '目的',
  '表达风格',
];

/* ==========================================================================
 * 三、指标
 * ========================================================================== */

/** 指标类型（六种） */
export type MetricType =
  | 'continuous'   // 连续型：0-1 或任意范围
  | 'discrete'     // 离散型：有限状态枚举
  | 'boolean'      // 布尔型
  | 'count'        // 计数型
  | 'set'          // 集合型
  | 'time';        // 时间型

/** 单个指标定义（名称/初值/阈值/语义说明全部由 LLM 生成，用户可改初值与阈值） */
export interface MetricSpec {
  id: string;
  /** 指标名，如「信任度」「愿意倾听」 */
  name: string;
  type: MetricType;
  /** 初始值 */
  initial: number | string | boolean;
  /** 目标阈值（由 LLM 依语义判定是否达标） */
  target: number | string | boolean;
  /** 失败阈值（可选） */
  failureThreshold?: number | string | boolean;
  /** 取值范围说明（连续型），如 [0, 1] */
  range?: [number, number];
  /** 离散型的枚举选项 */
  options?: string[];
  /** 单位（时间型/计数型），如「回合」「分钟」 */
  unit?: string;
  /**
   * 指标数据来源（S4 新增，可选）：
   * - 'engine'：由系统计算引擎（SymPy）直接写入
   * - 'llm'   ：由 LLM 语义判定更新（S1 全部指标、S4 的定性指标）
   * - 'rule'  ：由系统规则计算（如 independence_score）
   * 缺省（undefined）等价于 'llm'，保证 S1 行为不变。
   */
  source?: MetricSource;
  /** S4 本地数据绑定；id/name 不参与新指标路由。历史测量绑定仅保留识别，缺少实际数据源时预检拒绝。S1 不使用。 */
  s4Binding?: 'formula-correctness' | 'numerical-error' | 'dimension-check' | 'boundary-count' | 'independence-score' | 'help-used';
  /** 语义说明：告诉 LLM 这个指标代表什么、何时该升何时该降 */
  description: string;
}

/** 指标数据来源（S4 新增） */
export type MetricSource = 'engine' | 'llm' | 'rule';

/** 指标当前值（运行态） */
export interface MetricValue {
  metricId: string;
  value: number | string | boolean;
  /** 最近一次变化量（用于即时反馈展示） */
  lastDelta?: number | string;
  /** 最近一次变化原因（LLM 给出） */
  lastReason?: string;
}

/** 指标变化条目（挂到消息上用于即时反馈） */
export interface MetricDelta {
  metricId: string;
  metricName: string;
  delta: number | string;
  reason: string;
}

/** 指标更新的 LLM 返回结构 */
export interface MetricUpdateResult {
  metrics: MetricValue[];
  deltas: MetricDelta[];
  completionStatus: 'ongoing' | 'success' | 'failure';
  reason?: string;
  /** 本轮被判定为已满足条件的突发事件 id 列表（复用本次调用，不额外增加开销） */
  triggeredEvents: string[];
}

/* ==========================================================================
 * 四、突发事件
 * ========================================================================== */

/**
 * 突发事件（双触发：按回合 / 按自然语言条件）。
 * 来源二为运行中用户手动注入（不写入 SceneSpec，仅进入本局对话流）。
 */
export interface SceneEvent {
  id: string;
  /** 事件内容，触发后作为 speakerType='event' 的消息插入对话流 */
  description: string;
  trigger: {
    type: 'turn' | 'condition';
    /** type='turn' 时生效：第 N 轮触发 */
    turn?: number;
    /** type='condition' 时生效：自然语言条件，由每轮指标更新调用顺带判定 */
    condition?: string;
  };
  /** 运行态：是否已触发 */
  fired: boolean;
}

/* ==========================================================================
 * 五、引擎配置（承载「架构核心」，供 manifest 摘要与 LLM 判断可复用性）
 * ========================================================================== */

/** 引擎配置：体现场景的搭建架构核心 */
export interface EngineConfig {
  /** 交互范式（MVP 恒为 'single-role-dialogue'） */
  paradigm: DialogueParadigm;
  /** 是否启用角色记忆（MVP 为 true：完整对话记录即角色记忆，无需独立记忆库） */
  roleMemory: boolean;
  /** 用到的技术/组件标识，如 ['LLM流式对话', '指标引擎', '突发事件注入'] */
  technologies: string[];
  /** 用到的引擎适配器标识，如 ['SceneDirector', 'MetricEngine'] */
  engines: string[];
}

/* ==========================================================================
 * 六、场景定义
 * ========================================================================== */

/** 场景元信息 */
export interface SceneMeta {
  /** 场景名称（用户自定义命名） */
  name: string;
  /** 学科 */
  subject: string;
  /** 场景 Skill 类型 */
  sceneSkill: SceneSkillType;
  /** 关联知识点 */
  knowledgePoints: string[];
  /** 学习目标 */
  goal: string;
}

/** 完成条件 */
export interface SceneCompletion {
  /**
   * 完成判定模式：
   * - metric：指标达标判定（需 metrics 非空）
   * - signal：仅由 LLM 结束信号（`[结束:原因]`）判定
   */
  mode: 'metric' | 'signal';
  /** 成功条件（自然语言，由 LLM 判定） */
  successExpression: string;
  /** 失败条件（可选） */
  failureExpression?: string;
  /** S1 最大对话回合数；S4 最大节点验证提交次数（不含编辑、求助或讲解）。 */
  maxTurns: number;
}

/** 七要素 + 引擎配置 的完整场景定义（固定骨架 + extras 自由扩展） */
export interface SceneSpec {
  /** Optional exact interaction-mode dependency. Older scenes remain readable without migration. */
  interactionPack?: import('./sceneInteractionPack').SceneInteractionPackRef | null;
  /** S2 only. S4 continues using compute/help and its own proof canvas. */
  canvasWorkspace?: import('./sceneS2').S2CanvasDefinition;
  sceneId: string;
  version: string;
  meta: SceneMeta;
  /** 跨运行面的统一配方标识；S1 兼容 behavior.recipeId，S4 使用画布配方。 */
  capabilityRecipeId?: SceneRecipeId;
  /** 经装配器解析后，本场景实际启用的能力；旧场景可在加载/预检时重建。 */
  capabilityIds?: SceneCapabilityId[];
  /** Agent 实际选中的提示词/运行模块；缺省时按旧场景兼容处理。 */
  promptModuleIds?: ScenePromptModuleId[];
  runtimeContract?: SceneRuntimeContract;
  capabilityPlan?: SceneCapabilityPlan;
  experimentPolicy?: SceneExperimentPolicy;
  inputForm?: SceneInputForm;
  /** Scene-specific instructions written by the builder; never grant runtime authority. */
  agentInstructions?: { understanding: string; planning: string; response: string };
  /** Set by local project selection, never copied from model JSON. */
  referenceScope?: { projectId: string; noteIds: string[]; documentIds: string[] };

  /** ① 情境锚定 */
  situation: string;
  /** ② 任务驱动 */
  task: string;
  /** ③ 角色设定：MVP 仅 1 个 NPC 角色 */
  role: RoleSpec;
  /** 用户在场景中扮演的身份（如「刚入职的实习生」） */
  userRole: string;
  /** 开场叙述：进入场景时的旁白，作为首条 system 消息 */
  openingNarrative: string;
  /** ④ 资源嵌入 */
  resources: string[];
  /** ⑤ 规则约束 */
  rules: string[];
  /** ⑥ 完成指标（mode='signal' 时可为空数组） */
  metrics: MetricSpec[];
  /** 完成条件 */
  completion: SceneCompletion;
  /** ⑦ 反馈评估维度（MVP 仅记录，不自动评估） */
  evaluationDimensions: string[];

  /** 引擎配置（架构核心） */
  engineConfig: EngineConfig;
  /** 突发事件预设（LLM 生成 + 用户可增删） */
  events: SceneEvent[];
  /** 是否允许用户运行中手动注入事件 */
  eventInjection: boolean;
  /** 是否向角色发言注入学习画像 */
  injectProfile: boolean;
  /** 自由扩展层：骨架之外的场景字段（如「天气」「时间压力」「隐藏线索」） */
  extras?: Record<string, string>;

  /** 通用 S1 回合行为契约；缺省时保持传统角色扮演。 */
  behavior?: SceneBehaviorSpec;

  /** S4 专属：计算配置。S1 场景为 undefined。 */
  compute?: ComputeSpec;
  /** S4 专属：求助配置。S1 场景为 undefined。 */
  help?: HelpSpec;

  /** 来源：new = 全新生成；adapted = 基于已有场景调整 */
  origin: 'new' | 'adapted';
  /** 若为 adapted，记录源场景 id（仅血缘记录，产出永远是新 sceneId） */
  sourceSceneId?: string;
  createdAt: string;
  updatedAt: string;
}

/* ==========================================================================
 * 七、运行态（一局）
 * ========================================================================== */

/**
 * 单条对话消息。
 * - user   用户本体
 * - role   NPC 角色
 * - system 系统提示（开场旁白、指标反馈）
 * - event  突发事件
 * - action 动作描写（由正文中 *...* 解析拆分而来，斜体灰字渲染）
 */
export type SceneSpeakerType = 'user' | 'role' | 'system' | 'event' | 'action';

/** 场景回复实际使用的笔记检索来源。 */
export interface SceneCitation {
  index: number;
  noteId: string;
  title: string;
  snippet: string;
  score: number;
  sourceType?: 'note' | 'document';
  documentId?: string;
  chunkId?: string;
}

/** 单条对话消息 */
export interface SceneMessage {
  id: string;
  /** 发言者类型 */
  speakerType: SceneSpeakerType;
  /** 发言者显示名 */
  speakerName: string;
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  /** 本条消息触发的指标变化（用于即时反馈展示） */
  metricDeltas?: MetricDelta[];
  /** 仅记录本轮实际注入模型上下文的笔记来源。 */
  citations?: SceneCitation[];
  /** AI 消息要求用户完成的结构化交互。 */
  interaction?: SceneInteractionDirective;
  /** 题组私有评分依据；只用于下一轮确定性评分和模型反馈。 */
  interactionEvaluation?: SceneQuestionSetEvaluation;
  objectiveEvaluation?: SceneObjectiveEvaluation;
  interactionPreparation?: import('../services/scene/sceneTaskPreparation').SceneInteractionPreparation;
  objectiveAssessment?: SceneObjectiveAssessment;
  /** 用户消息对应的结构化原始响应；content 为供展示和 LLM 使用的文本摘要。 */
  interactionResponse?: SceneInteractionResponse;
  /** Conversation never implicitly answers or retires a structured task. */
  inputKind?: 'response' | 'conversation';
  /** Local end-button intent; never accepted from model output. */
  endRequested?: boolean;
  /** Local attribution of a completed assistant explanation, never taken from model metadata. */
  discussionInteractionId?: string;
  formSubmission?: SceneFormSubmission;
  agentTrace?: SceneAgentTurnTrace;
  /** Actual executor receipts, not fields generated by the conversational model. */
  experiments?: SceneExperimentRecord[];
}

/** 反事实重跑的参数覆盖 */
export interface SceneRunOverrides {
  /** 覆盖后的角色定义（一对一：仅 1 个角色） */
  role?: RoleSpec;
  /** 覆盖后的指标初值/阈值（按 metricId 索引） */
  metrics?: Record<string, { initial?: number | string | boolean; target?: number | string | boolean }>;
}

/** 一局运行状态 */
export interface SceneRunState {
  runId: string;
  sceneId: string;
  sceneName: string;
  /** 当前指标值 */
  metrics: MetricValue[];
  /** 完整对话记录（同时充当角色记忆） */
  messages: SceneMessage[];
  /** S1 已用对话回合数；S4 已接收的节点验证提交次数（与 node_submit 事件兼容同步）。 */
  turnCount: number;
  /** 突发事件运行态（含 fired 标记） */
  events: SceneEvent[];
  /** 运行状态 */
  status: 'running' | 'success' | 'failure';
  /** 结束原因 */
  endReason?: string;
  startedAt: string;
  endedAt?: string;
  /** success/failure 保留旧界面兼容；此字段区分完成、主动收场及回合耗尽。 */
  completionOutcome?: 'completed' | 'stopped' | 'limit-reached' | 'failed';
  workingMemory?: SceneWorkingMemory;
  teachingState?: SceneTeachingState;
  experimentRecords?: SceneExperimentRecord[];
  experimentApproved?: boolean;
  /** Retired task IDs are local lifecycle state, not model-authored memory. */
  retiredInteractionIds?: string[];
  /** 本局的参数覆盖（反事实重跑时记录） */
  overrides?: SceneRunOverrides;

  /** S4 专属：推导画布运行态。S1 场景为 undefined。 */
  canvas?: DerivationCanvasState;
  /** S4 专属：推导事件流（用于案例沉淀与回放）。S1 场景为 undefined。 */
  derivationEvents?: DerivationEvent[];
  /**
   * S4 专属：最终得分（第八章 6.7 口径）。
   * 由 derivationRuntime.computeFinalScore 在结束时刻写入，
   * **不参与成败判定**（成败由 checkS4Completion 决定），仅供评估展示。
   */
  finalScore?: number;
  /**
   * S4 专属：本局是否由**用户主动结束**（点「结束」按钮）。
   *
   * 为什么需要与 `status` 分开（用户明确口径）：
   *   参考答案的解锁条件被定为「**用户提交整个场景**」，即只认用户点「结束」，
   *   不认系统自动判定完成 —— 自动完成往往发生在用户还在继续推导时，
   *   若此时就放出答案，会打断尚未结束的思考。
   *   `status !== 'running'` 无法区分这两种来源，故单列本字段。
   *
   * 由 `applyS4Completion({ userIntentEnd: true })` 写入，缺省 false。
   */
  endedByUser?: boolean;
  /** S4: explicit post-completion reference consent; does not rewrite how or when the run ended. */
  s4ReferenceUnlocked?: boolean;
}

/** 上一局 vs 本局的指标差异对比条目 */
export interface MetricDiffItem {
  metricId: string;
  metricName: string;
  previousValue: number | string | boolean;
  currentValue: number | string | boolean;
  target: number | string | boolean;
  /** 连续型才有：本次减上次的差值 */
  delta?: number;
  /** 上局是否达标 / 本局是否达标 */
  previousMet: boolean;
  currentMet: boolean;
}

/* ==========================================================================
 * 八、Skill 包清单与生成结果类型
 * ========================================================================== */

/** manifest 中的单条场景索引（必须体现架构核心，供 LLM 判断可复用性） */
export interface SceneManifestEntry {
  sceneId: string;
  name: string;
  subject: string;
  sceneSkill: SceneSkillType;
  knowledgePoints: string[];
  goal: string;
  /** 架构核心摘要 */
  architecture: {
    /** 交互范式的人话描述，如「单角色对话 · 用户与 NPC 流式交互」 */
    paradigmLabel: string;
    /** 通用 S1 的范式短标签；传统 S1/S4 缺省。 */
    behaviorKind?: string;
    /** 稳定场景配方；供复用决策和 Agent 移交判断执行模式。 */
    recipeId?: SceneRecipeId;
    /** 场景声明的交互能力，旧场景缺省为 text。 */
    interactionTypes?: SceneInteractionType[];
    /** 跨运行面的完整能力集合，供复用决策和 Agent 稳定移交。 */
    capabilityIds?: SceneCapabilityId[];
    /** 生成和运行时实际启用的提示词模块。 */
    promptModuleIds?: ScenePromptModuleId[];
    /** 用到的技术，如 ['LLM流式对话', '指标引擎', '突发事件注入'] */
    technologies: string[];
    /** 用到的引擎，如 ['SceneDirector', 'MetricEngine'] */
    engines: string[];
    /** 是否预设突发事件 */
    hasEvents: boolean;
    /** 是否允许手动注入事件 */
    eventInjection: boolean;
    /** 是否注入学习画像 */
    injectProfile: boolean;
  };
  createdAt: string;
  /** 被复用次数（越高越优先推荐） */
  reuseCount: number;
}

/** 场景 Skill 包清单 */
export interface SceneSkillManifest {
  version: string;
  updatedAt: string;
  scenes: SceneManifestEntry[];
}

/** scene-decide 的决策结果 */
export interface SceneDecideResult {
  decision: 'new' | 'adapt';
  /** decision='adapt' 时给出，必须存在于 manifest，否则降级为 new */
  targetSceneId?: string;
  reason: string;
}

/** scene-adapt 的返回结构（LLM 可自推翻：`adaptedFromExisting=false` 表示改用全新生成） */
export interface SceneAdaptResult {
  /** LLM 在真正生成时若判定源骨架不适配，可置 false 表达自我推翻 */
  adaptedFromExisting: boolean;
  scene: SceneSpec;
}

/* ==========================================================================
 * 九、角色模板库（全局共享，落盘 vault/scene-skills/roles.json）
 * ========================================================================== */

/** 可复用的角色模板（整体替换当前角色用） */
export interface RoleTemplate {
  id: string;
  /** 角色名/称谓 */
  name: string;
  /** 模块化属性字段（与 RoleSpec.attributes 同构） */
  attributes: RoleAttribute[];
  createdAt: string;
  /** 被使用次数（越高越靠前） */
  useCount: number;
}

/** 角色模板库文件结构 */
export interface RoleTemplateFile {
  version: string;
  updatedAt: string;
  roles: RoleTemplate[];
}

/* ==========================================================================
 * 十、应用板块入口请求（LearnHub → App → SceneMode 的载荷契约）
 * ========================================================================== */

/**
 * 场景搭建面板产出的「初始请求」。
 *
 * 四种来源对应不同的生成路径：
 * - `existing`：复用已有场景 → 直接读该场景进预览（跳过全部 LLM 调用）
 * - `build`  ：搭建新场景 → decideScene（可复用则 adapt，否则 generate）
 * - `auto`   ：交给 AI 判断 → 跳过 decideScene，直接 generateScene
 * - `custom` ：自定义场景 → 载入空白骨架进预览（跳过全部 LLM 调用）
 */
export interface SceneInitialRequest {
  /** Exact S2 interaction package; null explicitly requests the plain canvas. */
  interactionPack?: import('./sceneInteractionPack').SceneInteractionPackRef | null;
  source: 'existing' | 'build' | 'auto' | 'custom';
  /** 学习主题（由所选项目标题推导，或用户自定义标题覆盖） */
  subject: string;
  /** 关联知识点（由所选项目下的知识类子笔记标题推导） */
  knowledgePoints: string[];
  /** 自定义标题：非空时覆盖项目标题作为场景名 */
  customTitle?: string;
  /** 本次训练明确关联的任务对象；仅跟随请求，不写入可复用的场景定义。 */
  taskBinding?: LearningTaskBinding;
  /** source='existing' 时：要复用的场景 id */
  sceneId?: string;
  /** 期望角色描述（可选，随生成请求一并交给 LLM） */
  roleHints?: string;
  /** 其它要求（可选，随生成请求一并交给 LLM） */
  extraHints?: string;
  /** Agent 或用户选定的场景配方；缺省时由场景生成器自行选择。 */
  recipeId?: SceneRecipeId;
  /** 可选能力诉求；配方必需能力由装配器自动补齐。 */
  requestedCapabilities?: SceneCapabilityId[];
  /** Agent 选中的提示词模块；显式空数组表示只使用核心执行提示。 */
  requestedPromptModules?: ScenePromptModuleId[];
  /**
   * 场景类型（S4 新增，可选）：
   * - 缺省 / 'S1'：一对一对话场景（原有行为）
   * - 'S4'：数理推导场景（画布式推导编辑器）
   * - 'S2'：通用画布试验入口（独立搭建、预览与运行，不走 S1/S4）
   */
  sceneSkill?: SceneSkillType;
}

/* ==========================================================================
 * 十一、常量
 * ========================================================================== */

/** manifest 清单塞进 prompt 的条目上限（防 prompt 膨胀） */
export const SCENE_MANIFEST_PROMPT_LIMIT = 30;

/** 场景包在 vault 下的子目录名 */
export const SCENE_SKILLS_DIR_NAME = 'scene-skills';
