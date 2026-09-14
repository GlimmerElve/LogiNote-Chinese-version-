import {
  ProfileInsight,
  KnowledgePointMasteryResult,
  PreprocessResult,
  LayeredScoreResult,
} from '../../types';
import { callLLM, LlmHttpError } from '../llmService';
import { FlowAnalysisInput, FlowAnalysisReport, FlowSummaryResult, LayeredEvidenceBundle } from './types';
import type { ArgDoc } from '../argumentDoc/types';
import { convertFlowPreprocessToArgDoc } from '../argumentDoc/convert';
import {
  preprocessText,
  fetchLayeredEvidence,
  fetchCognitiveStyle,
  fetchConceptAliases,
} from './evidenceTasks';
import { computeLayeredScore } from './evidenceQuality';
import { assembleReport } from './reportAssembler';
import { fuseProfileInsight } from '../profile/profileFusion';
import { recordReasoning } from '../learningAbility/timelineStore';
import { refreshLearningAbility } from '../learningAbility/refresh';
import { computeTypeCounts } from '../profile/styleScoring';
import { appendRawRecord, recalcAndSaveSnapshot, updateTrend, upsertWeekWordCloud } from '../profile/styleStore';
import { computeWordCloud } from '../profile/wordCloud';

/**
 * 心流分析编排（三步式）。
 * 步骤① 预处理：逐句拆分论证结构 + 9 类论证类型标注 + 结构图 + 结论节点（flow-preprocess）
 * 步骤② 论证质量评估：对整段论证结构做「4 质量指标 + 漏洞表 + 总结」（profile-evidence-layered）
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
): Promise<{ report: FlowAnalysisReport; profileInsight: ProfileInsight; serviceError?: string; argumentDoc?: ArgDoc }> {
  const text = input.speakingContent;
  const existingTitles = input.allNotes.map((n) => n.title).join(', ');

  let serviceError: string | undefined;
  const reportError = (e: unknown) => {
    if (e instanceof LlmHttpError) serviceError = serviceError || httpErrorText(e);
  };

  // ===== 步骤① 预处理：逐句拆分论证结构 + 类型标注 + 结构图 =====
  let preprocess: PreprocessResult = { sentences: [], edges: [] };
  try {
    preprocess = await preprocessText(text);
  } catch (e) {
    reportError(e);
  }

  // 前端统计 9 类论证类型计数（风格 raw 用 + 步骤②三层分数用）
  const counts = computeTypeCounts(preprocess.sentences);

  // 表达风格 raw 追加 + 快照/趋势重算；词云按周更新（异步，不阻塞）
  if (preprocess.sentences.length > 0) {
    appendRawRecord(counts)
      .then(async () => {
        const snapshot = await recalcAndSaveSnapshot();
        await updateTrend(snapshot.display);
      })
      .catch(() => {});
    upsertWeekWordCloud(computeWordCloud(text)).catch(() => {});
  }

  // ===== 步骤②：整段论证质量评估 + 认知风格 + 概念归并（并行） =====
  const [layeredSettled, cognitiveSettled, aliasesSettled] = await Promise.allSettled([
    fetchLayeredEvidence(preprocess, text),
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

  // 前端计算三层分数（结构密度 + 质量指标 + 漏洞扣分）
  let layeredScores: LayeredScoreResult | undefined;
  if (layeredBundle.qualityResult) {
    layeredScores = computeLayeredScore(
      counts,
      layeredBundle.qualityResult.quality,
      layeredBundle.qualityResult.vulnerabilities,
    );
  }

  // 汇总 ProfileInsight（表达风格偏好型由论证类型折算落 style-snapshot，三层能力由步骤② final 分数填充）
  const profileInsight: ProfileInsight = {
    cognitiveStyle: cognitiveBundle.cognitiveStyle,
    concepts: aliasesBundle.concepts || [],
    layeredScores,
  };

  // 画像融合 + 周报记录 + 学习能力刷新（异步，不阻塞）
  fuseProfileInsight(profileInsight, text.length).catch(() => {});

  if (layeredBundle.qualityResult) {
    recordReasoning(layeredScores, layeredBundle.qualityResult.vulnerabilities)
      .then(() => refreshLearningAbility(input.allNotes))
      .catch(() => {});
  }

  // ===== 步骤③：总结器（归纳 + 清晰度 + 建议） =====
  const vulnSummary = (layeredBundle.qualityResult?.vulnerabilities || []).map((v) => `[${v.layer}]${v.type}`).join('、');
  const diagnosisSummary = [
    `【论证质量总结】${layeredBundle.qualityResult?.summary || '无'}`,
    `【隐含漏洞】${vulnSummary || '无'}`,
    `【认知解读】${cognitiveBundle.cognitiveInterpretation || '无'}`,
    `【关联知识】${JSON.stringify(aliasesBundle.relatedKnowledge || [])}`,
  ].join('\n');

  const mainUserInput = `笔记标题：${input.noteTitle}\n\n学习者口语复盘原文：\n${text}\n\n以下是论证质量与问题诊断结果：\n${diagnosisSummary}\n\n请归纳总结、评估表达清晰度。`;

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
    layeredScores,
    cognitiveBundle.cognitiveInterpretation,
    aliasesBundle.relatedKnowledge || [],
    masteryResults,
  );

  // 构建论证结构文档（步骤①骨架 + 步骤②漏洞回填，并内置三层布局）
  let argumentDoc: ArgDoc | undefined;
  if (preprocess.sentences.length > 0) {
    argumentDoc = convertFlowPreprocessToArgDoc(
      preprocess,
      layeredBundle.qualityResult?.vulnerabilities ?? [],
      { title: input.noteTitle },
    );
  }

  return { report, profileInsight, serviceError, argumentDoc };
}
