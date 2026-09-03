import {
  ProfileInsight,
  KnowledgePointMasteryResult,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { analyzeReasoningStyle } from '../reasoningStyle/analyzer';
import { FlowAnalysisInput, FlowAnalysisReport, FlowSummaryResult } from './types';
import {
  fetchConceptEvidence,
  fetchJudgmentEvidence,
  fetchReasoningEvidence,
  fetchCognitiveStyle,
  fetchConceptAliases,
} from './evidenceTasks';
import { assembleReport } from './reportAssembler';
import { fuseProfileInsight } from '../profile/profileFusion';
import { recordReasoning } from '../learningAbility/timelineStore';
import { refreshLearningAbility } from '../learningAbility/refresh';

/**
 * 心流分析编排（P8：锚点+诊断双输出 + 总结器）。
 * 阶段1：5 个证据请求并行 → 锚点（画像/周报）+ 诊断（面板）
 * 阶段2：主请求（总结器）依赖阶段1诊断 → summary + clarityScore + 建议
 */
export type FlowAnalysisProgressStage = 'evidence' | 'summary';

/** 把 HTTP 错误转成可读提示（阶段 B 展示在结果面板顶部） */
function httpErrorText(e: LlmHttpError): string {
  switch (e.status) {
    case 402: return 'AI 服务余额不足，请充值后重试';
    case 403: return 'AI 服务鉴权失败或配置异常，请检查 API Key';
    case 429: return 'AI 服务请求过于频繁，请稍后再试';
    default: return `AI 服务不可用（HTTP ${e.status}）`;
  }
}

export async function runFlowAnalysis(
  input: FlowAnalysisInput,
  masteryResults: KnowledgePointMasteryResult[] = [],
  onProgress?: (stage: FlowAnalysisProgressStage) => void,
): Promise<{ report: FlowAnalysisReport; profileInsight: ProfileInsight; serviceError?: string }> {
  const text = input.speakingContent;
  const existingTitles = input.allNotes.map((n) => n.title).join(', ');

  // ===== 阶段1：5 证据请求并行（settled 收集 HTTP 服务错误，不中断整体） =====
  const [conceptSettled, judgmentSettled, reasoningSettled, cognitiveSettled, aliasesSettled] =
    await Promise.allSettled([
      fetchConceptEvidence(text),
      fetchJudgmentEvidence(text),
      fetchReasoningEvidence(text),
      fetchCognitiveStyle(text),
      fetchConceptAliases(text, existingTitles),
    ]);

  let serviceError: string | undefined;

  const conceptBundle = conceptSettled.status === 'fulfilled' ? conceptSettled.value : {};
  const judgmentBundle = judgmentSettled.status === 'fulfilled' ? judgmentSettled.value : {};
  const reasoningBundle = reasoningSettled.status === 'fulfilled' ? reasoningSettled.value : {};
  const cognitiveBundle = cognitiveSettled.status === 'fulfilled' ? cognitiveSettled.value : {};
  const aliasesBundle = aliasesSettled.status === 'fulfilled' ? aliasesSettled.value : {};

  for (const s of [conceptSettled, judgmentSettled, reasoningSettled, cognitiveSettled, aliasesSettled]) {
    if (s.status === 'rejected' && s.reason instanceof LlmHttpError) {
      serviceError = serviceError || httpErrorText(s.reason);
    }
  }

  // 5 路证据已全部完成，进入总结阶段
  onProgress?.('summary');

  // 正则统计（同步）
  const stats = analyzeReasoningStyle(text);

  // 汇总 ProfileInsight（锚点）
  const profileInsight: ProfileInsight = {
    conceptEvidence: conceptBundle.conceptEvidence,
    judgmentEvidence: judgmentBundle.judgmentEvidence,
    reasoningEvidence: reasoningBundle.reasoningEvidence,
    cognitiveStyle: cognitiveBundle.cognitiveStyle,
    expressionStyle: {
      prefersExample: Math.min(stats.exampleMarkerDensity / 5, 1),
      prefersAnalogy: Math.min(stats.analogyMarkerDensity / 5, 1),
      prefersDefinition: Math.min(stats.definitionMarkerDensity / 5, 1),
      prefersDerivation: Math.min(stats.causalConnectorDensity / 5, 1),
      conclusionFirst: stats.conclusionFirstRatio,
      terminologyAccuracy: conceptBundle.terminologyAccuracy,
      selfCorrection: reasoningBundle.selfCorrection,
    },
    concepts: aliasesBundle.concepts || [],
  };

  // 画像融合 + 周报记录 + 学习能力刷新（异步，不阻塞）
  fuseProfileInsight(profileInsight, text.length).catch(() => {});

  const reasoningEv = reasoningBundle.reasoningEvidence;
  const fallacyTotal =
    (conceptBundle.conceptEvidence?.conceptErrors?.length || 0) +
    (judgmentBundle.judgmentEvidence?.judgmentErrors?.length || 0) +
    (reasoningEv?.fallacyTypes?.length || 0);
  recordReasoning(
    {
      premises: reasoningEv?.providesPremises,
      completeChain: reasoningEv?.completeChain,
      assumption: reasoningEv?.identifiesAssumptions,
      deductiveInductive: reasoningEv?.distinguishesDeductiveInductive,
      counterfactual: reasoningEv?.considersCounterfactuals,
    },
    fallacyTotal,
  )
    .then(() => refreshLearningAbility(input.allNotes))
    .catch(() => {});

  // ===== 阶段2：主请求（总结器）依赖阶段1诊断 =====
  const diagnosisSummary = [
    `【概念诊断】${JSON.stringify(conceptBundle.conceptDiagnosis || [])}`,
    `【判断诊断】${JSON.stringify(judgmentBundle.judgmentDiagnosis || [])}`,
    `【逻辑诊断】${JSON.stringify(reasoningBundle.logicDiagnosis || [])}`,
    `【认知解读】${cognitiveBundle.cognitiveInterpretation || '无'}`,
    `【关联知识】${JSON.stringify(aliasesBundle.relatedKnowledge || [])}`,
  ].join('\n');

  const expressionPrefs = {
    prefersExample: Math.min(stats.exampleMarkerDensity / 5, 1),
    prefersAnalogy: Math.min(stats.analogyMarkerDensity / 5, 1),
    prefersDefinition: Math.min(stats.definitionMarkerDensity / 5, 1),
    prefersDerivation: Math.min(stats.causalConnectorDensity / 5, 1),
    conclusionFirst: stats.conclusionFirstRatio,
  };

  const mainUserInput = `笔记标题：${input.noteTitle}\n\n学习者口语复盘原文：\n${text}\n\n以下是五个分析模块的诊断结果：\n${diagnosisSummary}\n\n表达风格偏好数据（正则统计，0-1，偏好举例/偏好类比/偏好定义/偏好推导/先结论）：\n${JSON.stringify(expressionPrefs)}\n\n请归纳总结、评估表达清晰度，并根据表达风格偏好数据归纳学习者的表达习惯。`;

  let summaryResult: FlowSummaryResult = {};
  try {
    const mainResp = await callLLM({ providerId: '', model: '', workflow: 'flow-analysis', userInput: mainUserInput });
    const j = mainResp.parsedJson || {};
    summaryResult = {
      clarityScore: typeof j.clarityScore === 'number' ? j.clarityScore : undefined,
      clarityComment: typeof j.clarityComment === 'string' ? j.clarityComment : undefined,
      summary: typeof j.summary === 'string' ? j.summary : undefined,
      recommendation: typeof j.recommendation === 'string' ? j.recommendation : undefined,
      expressionStyleComment: typeof j.expressionStyleComment === 'string' ? j.expressionStyleComment : undefined,
    };
  } catch (e) {
    // 总结器失败不影响诊断展示，但 HTTP 服务错误要透传
    if (e instanceof LlmHttpError) {
      serviceError = serviceError || httpErrorText(e);
    }
  }

  // ===== 组装报告 =====
  const report = assembleReport(
    summaryResult,
    conceptBundle.conceptDiagnosis || [],
    judgmentBundle.judgmentDiagnosis || [],
    reasoningBundle.logicDiagnosis || [],
    cognitiveBundle.cognitiveInterpretation,
    aliasesBundle.relatedKnowledge || [],
    masteryResults,
  );

  return { report, profileInsight, serviceError };
}
