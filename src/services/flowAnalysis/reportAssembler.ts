import { KnowledgePointMasteryResult, LayerIssue } from '../../types';
import {
  FlowAnalysisReport,
  FlowAnalysisSection,
  FlowSummaryResult,
  LayeredEvidenceBundle,
} from './types';

/**
 * 结果组装（纯函数）：把「总结器结果 + 结论粒度论证分析 + 统一关键问题 + 认知解读 + 关联知识 + 掌握度」组装成统一分类报告。
 * 结论粒度链路下，概念/判断/逻辑三个旧诊断 section 被「关键结论」+「关键问题」取代。
 */

function section(
  kind: FlowAnalysisSection['kind'],
  title: string,
  items: unknown[],
): FlowAnalysisSection | null {
  if (!items || items.length === 0) return null;
  return { kind, title, items, total: items.length };
}

export function assembleReport(
  summary: FlowSummaryResult,
  layered: LayeredEvidenceBundle,
  keyIssues: LayerIssue[],
  cognitiveInterpretation: string | undefined,
  relatedKnowledge: Array<{ term: string; relation: string; suggestedWikiLink?: string }>,
  masteryResults: KnowledgePointMasteryResult[],
): FlowAnalysisReport {
  const sections: FlowAnalysisSection[] = [];

  // 关键结论（每条结论的论证链）
  const argumentsSec = section(
    'reasoningArguments',
    '关键结论',
    layered.argumentAnalyses || [],
  );
  if (argumentsSec) sections.push(argumentsSec);

  // 关键问题（统一，不再分概念/判断/逻辑三个 section）
  const issuesSec = section('keyIssues', '关键问题', keyIssues);
  if (issuesSec) sections.push(issuesSec);

  if (cognitiveInterpretation) {
    sections.push({
      kind: 'cognitiveInterpretation',
      title: '认知风格解读',
      items: [cognitiveInterpretation],
      total: 1,
    });
  }

  if (summary.expressionStyleComment) {
    sections.push({
      kind: 'expressionStyle',
      title: '表达风格',
      items: [summary.expressionStyleComment],
      total: 1,
    });
  }

  const related = section('relatedKnowledge', '关联知识', relatedKnowledge);
  if (related) sections.push(related);

  const mastery = section('mastery', '知识点掌握度', masteryResults);
  if (mastery) sections.push(mastery);

  return {
    clarityScore: summary.clarityScore,
    clarityComment: summary.clarityComment,
    summary: summary.summary,
    recommendation: summary.recommendation,
    thinkingStyleBrief: layered?.thinkingStyleBrief,
    conceptSummary: layered?.conceptSummary,
    judgmentSummary: layered?.judgmentSummary,
    reasoningSummary: layered?.reasoningSummary,
    overallComment: layered?.overallComment,
    sections,
  };
}