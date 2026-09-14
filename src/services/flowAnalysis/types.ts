import {
  NoteItem,
  StudyQuestionCard,
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
  ArgumentQualityResult,
} from '../../types';

/**
 * flow-analysis 编排层内部类型。
 * FlowAnalysisInput = runFlowAnalysis 的入参打包（编排层的输入集合，非直接发给 LLM 的请求体）。
 */

/** 一次完整心流分析的输入参数集合 */
export interface FlowAnalysisInput {
  /** 复述文本（核心分析对象，正则统计 + 各证据请求共用） */
  speakingContent: string;
  /** 所属笔记标题 */
  noteTitle: string;
  /** 全部笔记（概念归并请求用它匹配已有笔记标题） */
  allNotes: NoteItem[];
  /** 学习总结文本（可选，并入主请求） */
  summaryText?: string;
  /** 待解答问题（可选，并入主请求） */
  questions?: StudyQuestionCard[];
}

/** 三层合一的证据 bundle（profile-evidence-layered 一次请求产出） */
export interface LayeredEvidenceBundle {
  // —— 映射回旧锚点（供画像融合 / 知识点掌握度复用） ——
  conceptEvidence?: ConceptEvidence;
  judgmentEvidence?: JudgmentEvidence;
  reasoningEvidence?: ReasoningEvidence;
  // —— 新增文字总结（供报告展示） ——
  thinkingStyleBrief?: string;
  conceptSummary?: string;
  judgmentSummary?: string;
  reasoningSummary?: string;
  overallComment?: string;
  // —— 整段论证质量评估（步骤②新链路产出） ——
  qualityResult?: ArgumentQualityResult;
}

/** 结果面板分类渲染的统一载体（每类一个 section） */
export type FlowAnalysisSectionKind =
  | 'score'
  | 'argumentQuality'
  | 'cognitiveInterpretation'
  | 'expressionStyle'
  | 'relatedKnowledge'
  | 'mastery';

export interface FlowAnalysisSection {
  kind: FlowAnalysisSectionKind;
  title: string;
  items: unknown[];
  total?: number;
}

/** 结果面板展示用的统一报告结构（FlowAnalysisPanel 按 sections 分类渲染） */
export interface FlowAnalysisReport {
  /** 表达清晰度分（0-100，P8 新语义：停顿/重复/结构） */
  clarityScore?: number;
  /** 清晰度简短评论 */
  clarityComment?: string;
  /** 综合归纳（结合笔记标题） */
  summary?: string;
  /** 综合学习建议 */
  recommendation?: string;
  /** 表达风格一句话描述（AI 根据正则偏好归纳） */
  expressionStyleComment?: string;
  /** 思维表达特点一句话（profile-evidence-layered 输出） */
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

/** 主请求（总结器）返回的结构 */
export interface FlowSummaryResult {
  clarityScore?: number;
  clarityComment?: string;
  summary?: string;
  recommendation?: string;
  /** 表达风格一句话描述 */
  expressionStyleComment?: string;
}
