import { KnowledgePointMasteryResult } from '../../types';
import {
  FlowAnalysisReport,
  FlowAnalysisSection,
  FlowSummaryResult,
  DiagnosisItem,
  LayeredEvidenceBundle,
} from './types';

/**
 * 结果组装（纯函数）：把「总结器结果 + 三层诊断 + 知识点掌握度 + 文字总结」组装成统一分类报告。
 * P8：诊断来自各自的证据请求，总结器只给 summary/clarityScore/建议。
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
  conceptDiagnosis: DiagnosisItem[],
  judgmentDiagnosis: DiagnosisItem[],
  logicDiagnosis: DiagnosisItem[],
  cognitiveInterpretation: string | undefined,
  relatedKnowledge: Array<{ term: string; relation: string; suggestedWikiLink?: string }>,
  masteryResults: KnowledgePointMasteryResult[],
  layered?: LayeredEvidenceBundle,
): FlowAnalysisReport {
  const sections: FlowAnalysisSection[] = [];

  // 各诊断 section
  const concept = section('conceptDiagnosis', '概念诊断', conceptDiagnosis);
  if (concept) sections.push(concept);

  const judgment = section('judgmentDiagnosis', '判断诊断', judgmentDiagnosis);
  if (judgment) sections.push(judgment);

  const logic = section('logicDiagnosis', '逻辑诊断', logicDiagnosis);
  if (logic) sections.push(logic);

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