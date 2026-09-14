import {
  ArgumentFunctionType,
  QualityIndicators,
  Vulnerability,
  LayeredScoreResult,
} from '../../types';

/**
 * 步骤②整段论证质量 → 三层分数折算（严格参照 deepseek_python_20260910_ba2bfd.md）。
 * counts：9 类论证类型计数（来自步骤① sentences 现算）。
 * quality：LLM 输出的 4 个质量指标（各自 0-4 分）。
 * vulnerabilities：LLM 输出的漏洞表（含严重程度 + 影响层面）。
 */

/** 严重程度 → 扣分映射 */
const PENALTY_TABLE: Record<number, number> = {
  1: 2,
  2: 5,
  3: 10,
  4: 15,
  5: 20,
};

/** 占比分数：value/threshold 封顶 1，再 ×100 */
function ratioScore(value: number, threshold: number): number {
  if (threshold <= 0) return 0;
  return Math.min(value / threshold, 1) * 100;
}

/** 质量指标 0-4 → 0-100 */
function qualityScore(score: number): number {
  return (score / 4) * 100;
}

/** 等级判定 */
function grade(score: number): string {
  if (score >= 85) return '优秀';
  if (score >= 70) return '良好';
  if (score >= 60) return '及格';
  if (score >= 40) return '偏弱';
  return '严重不足';
}

/** 三层原始分 + 漏洞扣分 → 最终分数与等级 */
export function computeLayeredScore(
  counts: Record<ArgumentFunctionType, number>,
  quality: QualityIndicators,
  vulnerabilities: Vulnerability[],
): LayeredScoreResult {
  const total =
    (counts['定义'] || 0) +
    (counts['对比'] || 0) +
    (counts['假设'] || 0) +
    (counts['举例'] || 0) +
    (counts['推理'] || 0) +
    (counts['反例削弱'] || 0) +
    (counts['建议对策'] || 0) +
    (counts['命名'] || 0) +
    (counts['事实陈述'] || 0);

  // 结构密度指标
  const conceptSum = (counts['定义'] || 0) + (counts['命名'] || 0) + (counts['对比'] || 0);
  const conceptDensity = ratioScore(total > 0 ? conceptSum / total : 0, 0.30);
  const conceptDistinction = ratioScore(
    conceptSum > 0 ? (counts['对比'] || 0) / conceptSum : 0,
    0.50,
  );
  const judgmentDensity = ratioScore(
    total > 0 ? ((counts['假设'] || 0) + (counts['举例'] || 0) + (counts['事实陈述'] || 0)) / total : 0,
    0.50,
  );
  const reasoningDensity = ratioScore(
    total > 0 ? ((counts['推理'] || 0) + (counts['反例削弱'] || 0) + (counts['建议对策'] || 0)) / total : 0,
    0.40,
  );
  const reasoningSum = (counts['推理'] || 0) + (counts['反例削弱'] || 0);
  const counterRatio = ratioScore(reasoningSum > 0 ? (counts['反例削弱'] || 0) / reasoningSum : 0, 0.30);

  // 质量指标映射
  const conceptClarity = qualityScore(quality.conceptClarity?.score ?? 0);
  const exampleQuality = qualityScore(quality.exampleQuality?.score ?? 0);
  const factSpeculation = qualityScore(quality.factSpeculation?.score ?? 0);
  const reasoningChain = qualityScore(quality.reasoningChain?.score ?? 0);

  // 三层原始分
  const conceptRaw = conceptDensity * 0.3 + conceptDistinction * 0.3 + conceptClarity * 0.4;
  const judgmentRaw = judgmentDensity * 0.3 + exampleQuality * 0.4 + factSpeculation * 0.3;
  const logicRaw = reasoningDensity * 0.3 + counterRatio * 0.2 + reasoningChain * 0.5;

  // 漏洞扣分
  let conceptPenalty = 0;
  let judgmentPenalty = 0;
  let logicPenalty = 0;
  for (const v of vulnerabilities || []) {
    // 语音识别误差不扣分；无法判断跳过
    if (v.type === '语音转文字识别误差' || v.layer === '无法判断') continue;
    const penalty = PENALTY_TABLE[v.severity] ?? 0;
    if (v.layer === '多层') {
      conceptPenalty += penalty / 3;
      judgmentPenalty += penalty / 3;
      logicPenalty += penalty / 3;
    } else if (v.layer === '概念层') {
      conceptPenalty += penalty;
    } else if (v.layer === '判断层') {
      judgmentPenalty += penalty;
    } else if (v.layer === '逻辑层') {
      logicPenalty += penalty;
    }
  }

  const conceptFinal = Math.max(0, conceptRaw - conceptPenalty);
  const judgmentFinal = Math.max(0, judgmentRaw - judgmentPenalty);
  const logicFinal = Math.max(0, logicRaw - logicPenalty);

  const round1 = (x: number) => Math.round(x * 10) / 10;

  return {
    raw: { concept: round1(conceptRaw), judgment: round1(judgmentRaw), logic: round1(logicRaw) },
    penalty: {
      concept: round1(conceptPenalty),
      judgment: round1(judgmentPenalty),
      logic: round1(logicPenalty),
    },
    final: {
      concept: round1(conceptFinal),
      judgment: round1(judgmentFinal),
      logic: round1(logicFinal),
    },
    grade: {
      concept: grade(conceptFinal),
      judgment: grade(judgmentFinal),
      logic: grade(logicFinal),
    },
  };
}