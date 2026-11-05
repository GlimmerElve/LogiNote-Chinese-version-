import type { ReviewQuestionIntent } from '../reviewIntent';
import type { ReviewComparisonSummary } from '../reviewComparison/types';
import { readReviewComparisonSummary } from '../reviewComparison/summary.ts';
import { readFlowStatisticsSubmission, type FlowStatisticsSubmission } from '../profile/flowStatisticsSchema.ts';

/** 长期保存的学习事件类型。首期只接入心流与复习。 */
export type LearningEpisodeType = 'flow' | 'review' | 'scene' | 'qa' | 'plan';

export type LearningEpisodeStatus = 'pending_analysis' | 'completed' | 'failed';

export interface EpisodeMessage {
  /** Stable turn identity for exact user-answer provenance; absent in legacy captures. */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Unsent user text retained for recovery only; never an answer or scored evidence. */
export interface ReviewDraftAnswer {
  id: string;
  content: string;
  timestamp: string;
  /** Absent on older drafts, which can be viewed but cannot be assigned to a new question. */
  context?: {
    version: 1;
    questionText: string;
    /** A later hint/rephrase is not a replacement for the original question. */
    tutorPrompt?: string;
    questionIntent: ReviewQuestionIntent;
    hintLevel: 0 | 1 | 2 | 3 | 4;
    consultedMaterialIds: string[];
  };
}

export type EvidenceSnippetType = 'mistake' | 'correction' | 'success' | 'preference' | 'observation';

/** 长期保留的最小证据片段；原始会话仍只属于工作记忆。 */
export interface EvidenceSnippet {
  /** 事件内稳定引用 id，供画像聚合记录回溯证据。旧数据可缺省。 */
  id?: string;
  type: EvidenceSnippetType;
  text: string;
  importance: number;
  source: 'user_statement' | 'scored_analysis' | 'behavior';
}

export type ProfileSignalDimension =
  | 'ability'
  | 'cognitive_style'
  | 'expression_style'
  | 'knowledge_mastery'
  | 'learning_habit';

/** 与现有用户画像维度对齐的单条结构化证据，不直接作为画像最终值。 */
export interface ProfileSignal {
  sourceEpisodeId: string;
  dimension: ProfileSignalDimension;
  indicator: string;
  value: number | string;
  confidence: number;
  evidenceType: 'explicit' | 'observed' | 'scored';
  observedAt: string;
  /** 指向同一 LearningEpisode 内的压缩证据，不保存完整对话。 */
  evidenceSnippetIds?: string[];
  /** 本次命中的可解释判据名称。 */
  matchedCriteria?: string[];
  /** 生成该信号的量规版本，便于以后重算与迁移。 */
  rubricVersion?: string;
}

export interface LearningChange {
  noteId: string;
  noteTitle: string;
  field: 'mastery' | 'difficulty' | 'stability' | 'task';
  before?: number | string;
  after?: number | string;
}

/**
 * 情景记忆只保存压缩事实、结果和关键证据，不保存完整对话或模型隐藏推理过程。
 * type-specific 数据保持扁平，便于后续检索和迁移。
 */
export interface LearningEpisode {
  id: string;
  type: LearningEpisodeType;
  status: LearningEpisodeStatus;
  title: string;
  noteId?: string;
  rootProjectId?: string;
  startedAt: string;
  endedAt: string;
  durationSeconds?: number;
  goal?: string;
  summary?: string;
  recommendation?: string;
  score?: number;
  rating?: string;
  knowledgePoints?: string[];
  unresolvedQuestions?: string[];
  evidenceSnippets?: EvidenceSnippet[];
  profileSignals?: ProfileSignal[];
  /** Compact recoverable local statistics; no transcript or model reasoning. */
  flowStatistics?: FlowStatisticsSubmission;
  learningChanges?: LearningChange[];
  /** Local dual-corpus preparation audit; never used as a mastery/profile signal. */
  comparisonSummary?: ReviewComparisonSummary;
  /** Recoverable review draft, excluded from semantic memory and profile evidence. */
  draftAnswer?: ReviewDraftAnswer;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningEpisodeFile {
  version: 2;
  episodes: LearningEpisode[];
}

export interface ReviewEpisodeCapture {
  id: string;
  startedAt: string;
  endedAt: string;
  questionText: string;
  knowledgeContext: string;
  messages: EpisodeMessage[];
  answerEvidence?: ReviewAnswerEvidence[];
  masteryEligible?: boolean;
  /** Evaluated against frozen questions and reference snapshots; old score deltas carry no write authority. */
  masteryAssessment?: import('../masteryShadow/review').ReviewMasteryBatch;
  /** Qualitative session feedback only; never permission to update mastery/profile/scheduling. */
  reviewFeedback?: import('../masteryShadow/reviewFeedback').ReviewSessionFeedback;
  /** Local preparation audit only. It is not an evaluated grade or permission to apply mastery. */
  comparisonSummary?: ReviewComparisonSummary;
  /** Unsent raw answer kept separately from submitted messages and evidence. */
  draftAnswer?: ReviewDraftAnswer;
  /** Exact recovered draft identities to clear after the replacement/session has saved. */
  consumedDraftIds?: string[];
}

export interface ReviewAnswerEvidence {
  messageId?: string;
  answer: string;
  hintLevel: 0 | 1 | 2 | 3 | 4;
  targetKnowledgeNames: string[];
  /** 本轮作答前主动查阅过的笔记或资源；评分时按强辅助证据处理。 */
  consultedMaterialIds?: string[];
  /** 生成本轮问题时已冻结的知识点／认知坐标；意图不等于回答已完成该关系。 */
  questionIntent?: ReviewQuestionIntent;
  /** Optional shadow source/structure recheck, NOT mastery evidence or permission to write. */
  referenceStructureVerification?: import('../argumentContext/questionReceipt').ArgumentQuestionReceiptVerification;
}

const MAX_EPISODES = 1000;

export function emptyLearningEpisodeFile(): LearningEpisodeFile {
  return { version: 2, episodes: [] };
}

function isEpisode(value: unknown): value is LearningEpisode {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LearningEpisode>;
  return typeof item.id === 'string'
    && ['flow', 'review', 'scene', 'qa', 'plan'].includes(item.type || '')
    && ['pending_analysis', 'completed', 'failed'].includes(item.status || '')
    && typeof item.title === 'string'
    && typeof item.startedAt === 'string'
    && typeof item.endedAt === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function sanitizeEpisode(episode: LearningEpisode): LearningEpisode {
  // 早期试验版曾保存 transcript/evidenceText；主动剥离，避免其进入长期记忆。
  const { transcript: _transcript, evidenceText: _evidenceText, ...kept } = episode as LearningEpisode & {
    transcript?: unknown;
    evidenceText?: unknown;
  };
  const evidenceSnippets = Array.isArray(kept.evidenceSnippets)
    ? kept.evidenceSnippets
        .filter((item) => item && typeof item.text === 'string' && typeof item.importance === 'number')
        .slice(0, 5)
        .map((item) => ({ ...item, text: item.text.replace(/\s+/g, ' ').trim().slice(0, 501) }))
    : undefined;
  const profileSignals = Array.isArray(kept.profileSignals)
    ? kept.profileSignals
        .filter((item) => item && typeof item.indicator === 'string' && typeof item.confidence === 'number')
        .slice(0, 20)
    : undefined;
  return {
    ...kept,
    evidenceSnippets,
    profileSignals,
    flowStatistics: kept.flowStatistics === undefined ? undefined : readFlowStatisticsSubmission(kept.flowStatistics),
    comparisonSummary: readReviewComparisonSummary(kept.comparisonSummary),
  };
}

/** Electron IPC 与 localStorage 共用的信任边界校验。 */
export function normalizeLearningEpisodeFile(value: unknown, strict = false): LearningEpisodeFile {
  if (strict && value !== null && (!value || typeof value !== 'object'
    || !Array.isArray((value as Partial<LearningEpisodeFile>).episodes)
    || !(value as LearningEpisodeFile).episodes.every(isEpisode))) {
    throw new Error('学习事件文件格式无效');
  }
  if (!value || typeof value !== 'object') return emptyLearningEpisodeFile();
  const parsed = value as Partial<LearningEpisodeFile>;
  return {
    version: 2,
    episodes: Array.isArray(parsed.episodes)
      ? parsed.episodes.filter(isEpisode).map(sanitizeEpisode)
      : [],
  };
}

/** 纯函数：同 id 覆盖、不同 id 追加，并限制首期 JSON 文件的体积。 */
export function upsertEpisodeInFile(file: LearningEpisodeFile, episode: LearningEpisode): LearningEpisodeFile {
  const withoutCurrent = file.episodes.filter((item) => item.id !== episode.id);
  return { version: 2, episodes: [...withoutCurrent, sanitizeEpisode(episode)].slice(-MAX_EPISODES) };
}
