import {
  NoteItem,
  StudyQuestionCard,
  LayeredScoreResult,
  Vulnerability,
} from '../../types';
import type { ShadowInput, ShadowLayer } from '../flowShadow/types';

/**
 * flow-analysis 编排层内部类型。
 * FlowAnalysisInput = runFlowAnalysis 的入参打包（编排层的输入集合，非直接发给 LLM 的请求体）。
 */

/** 一次完整心流分析的输入参数集合 */
export interface FlowAnalysisInput {
  /** 复述文本（新版论证解构与语义评价的原始证据） */
  speakingContent: string;
  /** 所属笔记标题 */
  noteTitle: string;
  /** 当前项目笔记，用于在本地组装高优先级参考资料。 */
  noteId?: string;
  /** 与复盘情景共用的幂等 ID。 */
  analysisRunId?: string;
  /** Explicit task requirements only; never infer required abilities from the note title/question list. */
  reviewTask?: ShadowInput['task'];
  /** 全部笔记（用于检索项目教材及关联知识点参考资料） */
  allNotes: NoteItem[];
  /** 学习总结文本（可选，并入主请求） */
  summaryText?: string;
  /** 待解答问题（可选，并入主请求） */
  questions?: StudyQuestionCard[];
}

/** 结果面板分类渲染的统一载体（每类一个 section） */
export type FlowAnalysisSectionKind =
  | 'score'
  | 'argumentQuality'
  | 'cognitiveInterpretation'
  | 'expressionStyle'
  | 'relatedKnowledge'
  | 'mastery';

export interface FlowStyleObservation {
  evidenceIds: string[];
  quotes: string[];
  reason: string;
}

export interface FlowStylePresentation {
  expression: Array<{ key: string; label: string; share: number | null; observations: FlowStyleObservation[] }>;
  cognitive: Array<{ key: string; label: string; negative: string; positive: string;
    value: number | null; directionLabel: string; observations: FlowStyleObservation[] }>;
}

export interface FlowAnalysisSection {
  kind: FlowAnalysisSectionKind;
  title: string;
  items: unknown[];
  total?: number;
}

/** 新版与历史报告共用的三层评价展示契约，不包含评分执行逻辑。 */
export interface ArgumentQualitySectionItem {
  layeredScores?: LayeredScoreResult;
  vulnerabilities: Vulnerability[];
  summary: string;
}

/** 结果面板展示用的统一报告结构（FlowAnalysisPanel 按 sections 分类渲染） */
export interface FlowAnalysisReport {
  /** 文本表达清晰度（0-100）：指代、连贯、承接；无音频不评语速或停顿。 */
  clarityScore?: number;
  /** Compatibility scores may contain numeric placeholders; these layers must render as unknown, not zero. */
  unscoredLayers?: ShadowLayer[];
  /** Local arithmetic inconsistencies awaiting model context/impact review; not fixed deductions or zeroes. */
  verificationPendingLayers?: ShadowLayer[];
  verificationNotes?: string[];
  /** 本次认知与表达观察，独立于长期画像。 */
  stylePresentation?: FlowStylePresentation;
  /** 清晰度简短评论 */
  clarityComment?: string;
  /** 综合归纳（结合笔记标题） */
  summary?: string;
  /** 综合学习建议 */
  recommendation?: string;
  /** 表达行为的兼容摘要；新版依据原话观察，不按九类计数折算 */
  expressionStyleComment?: string;
  /** 本次认知观察的兼容摘要 */
  thinkingStyleBrief?: string;
  /** 概念层综合评价（≤60字） */
  conceptSummary?: string;
  /** 判断层综合评价（≤60字） */
  judgmentSummary?: string;
  /** 推理层综合评价（≤60字） */
  reasoningSummary?: string;
  /** 三层综合 + 主要突破口（≤80字） */
  overallComment?: string;
  sections: FlowAnalysisSection[];
}

/** 生产 V2 的完整可追溯结果；旧 UI 仍可消费上方 report。 */
export type { FlowReviewAnalysisResultV2 } from './productionV2';

