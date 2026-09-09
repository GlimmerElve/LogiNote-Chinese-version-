import {
  ProfileInsight,
  KnowledgePointMasteryResult,
  LayerIssue,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { analyzeReasoningStyle } from '../reasoningStyle/analyzer';
import { FlowAnalysisInput, FlowAnalysisReport, FlowSummaryResult, LayeredEvidenceBundle } from './types';
import {
  preprocessText,
  fetchLayeredEvidence,
  fetchCognitiveStyle,
  fetchConceptAliases,
} from './evidenceTasks';
import { assembleReport } from './reportAssembler';
import { fuseProfileInsight } from '../profile/profileFusion';
import { recordReasoning } from '../learningAbility/timelineStore';
import { refreshLearningAbility } from '../learningAbility/refresh';

/**
 * 心流分析编排（结论粒度三段式）。
 * 步骤① 预处理：清洗口语 + 抽取关键结论（flow-preprocess，不落盘）
 * 步骤② 论证链分析：对每条结论做 concept/judgment/reasoning 证据 + issues（profile-evidence-layered）
 * 步骤③ 总结器：归纳总结 + 清晰度评估 + 建议（flow-analysis）
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

  let serviceError: string | undefined;
  const reportError = (e: unknown) => {
    if (e instanceof LlmHttpError) serviceError = serviceError || httpErrorText(e);
  };

  // ===== 步骤① 预处理：清洗口语 + 抽取关键结论（不落盘） =====
  let keyConclusions: { claim: string; evidence: string }[] = [];
  try {
    keyConclusions = await preprocessText(text);
  } catch (e) {
    reportError(e);
  }
  // 预处理失败或未抽到结论时回退：把整段文本当作单条结论
  if (keyConclusions.length === 0) {
    keyConclusions = [{ claim: input.noteTitle || '复盘要点', evidence: text }];
  }

  // ===== 步骤②：论证链分析 + 认知风格 + 概念归并（并行） =====
  const [layeredSettled, cognitiveSettled, aliasesSettled] = await Promise.allSettled([
    fetchLayeredEvidence(keyConclusions),
    fetchCognitiveStyle(text),
    fetchConceptAliases(text, existingTitles),
  ]);

  const layeredBundle: LayeredEvidenceBundle = layeredSettled.status === 'fulfilled' ? layeredSettled.value : {};
  const cognitiveBundle = cognitiveSettled.status === 'fulfilled' ? cognitiveSettled.value : {};
  const aliasesBundle = aliasesSettled.status === 'fulfilled' ? aliasesSettled.value : {};

  for (const s of [layeredSettled, cognitiveSettled, aliasesSettled]) {
    if (s.status === 'rejected') reportError(s.reason);
  }

  // 进入总结阶段
  onProgress?.('summary');

  // 正则统计（同步）
  const stats = analyzeReasoningStyle(text);

  // 统一关键问题（扁平化，供面板展示 + 供总结器）
  const keyIssues: LayerIssue[] =
    (layeredBundle.argumentAnalyses || []).flatMap((a) => a.issues || []);

  // 汇总 ProfileInsight
  const profileInsight: ProfileInsight = {
    reasoningEvidence: layeredBundle.reasoningEvidence,
    cognitiveStyle: cognitiveBundle.cognitiveStyle,
    expressionStyle: {
      prefersExample: Math.min(stats.exampleMarkerDensity / 5, 1),
      prefersAnalogy: Math.min(stats.analogyMarkerDensity / 5, 1),
      prefersDefinition: Math.min(stats.definitionMarkerDensity / 5, 1),
      prefersDerivation: Math.min(stats.causalConnectorDensity / 5, 1),
      conclusionFirst: stats.conclusionFirstRatio,
      terminologyAccuracy: layeredBundle.terminologyAccuracy,
      selfCorrection: layeredBundle.selfCorrection,
    },
    concepts: aliasesBundle.concepts || [],
    arguments: layeredBundle.argumentAnalyses || [],
  };

  // 画像融合 + 周报记录 + 学习能力刷新（异步，不阻塞）
  fuseProfileInsight(profileInsight, text.length).catch(() => {});

  const argumentAnalyses = layeredBundle.argumentAnalyses || [];
  recordReasoning(argumentAnalyses)
    .then(() => refreshLearningAbility(input.allNotes))
    .catch(() => {});

  // ===== 步骤③：总结器（归纳 + 清晰度 + 建议） =====
  const diagnosisSummary = [
    `【关键结论】${JSON.stringify((layeredBundle.argumentAnalyses || []).map((a) => a.claim))}`,
    `【关键问题】${JSON.stringify(keyIssues)}`,
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

  const mainUserInput = `笔记标题：${input.noteTitle}\n\n学习者口语复盘原文：\n${text}\n\n以下是关键结论与问题诊断结果：\n${diagnosisSummary}\n\n表达风格偏好数据（正则统计，0-1，偏好举例/偏好类比/偏好定义/偏好推导/先结论）：\n${JSON.stringify(expressionPrefs)}\n\n请归纳总结、评估表达清晰度，并根据表达风格偏好数据归纳学习者的表达习惯。`;

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
    reportError(e);
  }

  // ===== 组装报告 =====
  const report = assembleReport(
    summaryResult,
    layeredBundle,
    keyIssues,
    cognitiveBundle.cognitiveInterpretation,
    aliasesBundle.relatedKnowledge || [],
    masteryResults,
  );

  return { report, profileInsight, serviceError };
}