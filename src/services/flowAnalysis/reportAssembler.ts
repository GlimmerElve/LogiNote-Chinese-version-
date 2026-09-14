import { KnowledgePointMasteryResult, LayeredScoreResult, Vulnerability } from '../../types';
import {
  FlowAnalysisReport,
  FlowAnalysisSection,
  FlowSummaryResult,
  LayeredEvidenceBundle,
} from './types';

/**
 * 结果组装（纯函数）：把「总结器结果 + 整段论证质量评估 + 三层分数 + 认知解读 + 关联知识 + 掌握度」组装成统一分类报告。
 * 步骤②新链路下，「关键结论」「关键问题」被「三层分数 + 漏洞表」取代。
 */

function section(
  kind: FlowAnalysisSection['kind'],
  title: string,
  items: unknown[],
): FlowAnalysisSection | null {
  if (!items || items.length === 0) return null;
  return { kind, title, items, total: items.length };
}

/** 步骤②参数质量评估 + 三层分数的展示条目 */
export interface ArgumentQualitySectionItem {
  layeredScores?: LayeredScoreResult;
  vulnerabilities: Vulnerability[];
  summary: string;
}

export function assembleReport(
  summary: FlowSummaryResult,
  layered: LayeredEvidenceBundle,
  layeredScores: LayeredScoreResult | undefined,
  cognitiveInterpretation: string | undefined,
  relatedKnowledge: Array<{ term: string; relation: string; suggestedWikiLink?: string }>,
  masteryResults: KnowledgePointMasteryResult[],
): FlowAnalysisReport {
  const sections: FlowAnalysisSection[] = [];

  // 论证质量（三层分数 + 漏洞表）
  if (layered.qualityResult) {
    const item: ArgumentQualitySectionItem = {
      layeredScores,
      vulnerabilities: layered.qualityResult.vulnerabilities,
      summary: layered.qualityResult.summary,
    };
    const qualitySec = section('argumentQuality', '论证质量', [item]);
    if (qualitySec) sections.push(qualitySec);
  }

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