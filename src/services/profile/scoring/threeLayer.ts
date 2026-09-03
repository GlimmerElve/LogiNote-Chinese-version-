import {
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
  KnowledgePointDsr,
  MasteryLevel,
} from '../../../types';
import { clamp, ema } from './ability';

/**
 * 知识点「分层掌握度」折算（0 基准净得分 + 递进联动 + 恒定权重 + 方案 Y 直接增量）。
 * 与画像三层能力（ability.ts 的 50 基准）是两套独立体系，互不换算。
 */

/** 掌握度单次更新步长（方案 Y 直接增量）；由 0.8 调至 0.5，避免有错误时仍快速爬升 */
export const MASTERY_DELTA_ALPHA = 0.5;

/** 掌握判定线：conceptMastery ≥ 55 视为「已掌握」，供学习能力维度/UI 使用 */
export const MASTERY_LINE = 55;

/** 三层直接合成权重：推理最能体现掌握，判断次之，概念因被联动传导、直接权重最小 */
export const MASTERY_W_CONCEPT = 0.18;
export const MASTERY_W_JUDGMENT = 0.32;
export const MASTERY_W_REASONING = 0.50;

/** 递进联动系数（净得分按比例传导，正负都传导） */
export const LINK_JUDGMENT_TO_CONCEPT = 0.6;
export const LINK_REASONING_TO_CONCEPT = 0.5;
export const LINK_REASONING_TO_JUDGMENT = 0.5;

/** 掌握度平滑系数（旧 computeConceptMastery 的 EMA 用，保留兼容） */
export const MASTERY_ALPHA = 0.3;

/**
 * 概念层净得分（0 基准，可正可负；证据为空返回 null 表示「未触及」）。
 */
export function scoreConceptEvidence(ev?: ConceptEvidence): number | null {
  if (!ev) return null;
  let delta = 0;
  if (ev.redefinesInOwnWords) delta += 20;
  if (ev.distinguishesSimilarConcepts) delta += 20;
  if (ev.givesCounterExamples) delta += 15;
  delta -= 8 * Math.min(ev.vagueTerms?.length || 0, 4);
  delta -= 30 * (ev.conceptErrors?.length || 0);
  return delta;
}

/**
 * 判断层净得分（0 基准，可正可负；证据为空返回 null 表示「未触及」）。
 */
export function scoreJudgmentEvidence(ev?: JudgmentEvidence): number | null {
  if (!ev) return null;
  let delta = 0;
  if (ev.considersConditions) delta += 20;
  if (ev.distinguishesFactOpinion) delta += 15;
  if (ev.usesQualifiers) delta += 20;
  delta -= 15 * Math.min(ev.absolutistCount || 0, 3);
  delta -= 35 * (ev.judgmentErrors?.length || 0);
  return delta;
}

/**
 * 推理层净得分（0 基准，可正可负；证据为空返回 null 表示「未触及」）。
 */
export function scoreReasoningEvidence(ev?: ReasoningEvidence): number | null {
  if (!ev) return null;
  let delta = 0;
  if (ev.providesPremises) delta += 25;
  if (ev.completeChain) delta += 25;
  if (ev.identifiesAssumptions) delta += 20;
  delta -= 30 * (ev.fallacyTypes?.length || 0);
  return delta;
}

/**
 * 判定触及的最高认知层级（有推理证据→reasoning；有判断证据→judgment；否则 concept）。
 */
export function determineMasteryLevel(
  reasoningDelta: number | null,
  judgmentDelta: number | null,
): MasteryLevel {
  if (reasoningDelta !== null) return 'reasoning';
  if (judgmentDelta !== null) return 'judgment';
  return 'concept';
}

/** 分层掌握度合成的返回结构 */
export interface LayeredMasteryResult {
  /** 更新后的掌握度（0-100） */
  mastery: number;
  /** 触及的最高层级 */
  level: MasteryLevel;
  /** 加权后的总增量（可为负，供调试/UI 展示） */
  deltaTotal: number;
  /** 递进联动后的概念层最终分 */
  conceptFinal: number;
  /** 递进联动后的判断层最终分 */
  judgmentFinal: number;
  /** 递进联动后的推理层最终分 */
  reasoningFinal: number;
}

/**
 * 分层掌握度合成（方案 Y 直接增量）。
 * 输入三层净得分（null 表示未触及，按 0 参与计算），结合递进联动 + 恒定权重，输出新的掌握度。
 * @param oldMastery 默认 0（新用户初始 0，非 50）
 */
export function computeLayeredMastery(
  conceptDelta: number | null,
  judgmentDelta: number | null,
  reasoningDelta: number | null,
  oldMastery: number = 0,
): LayeredMasteryResult {
  const c = conceptDelta ?? 0;
  const j = judgmentDelta ?? 0;
  const r = reasoningDelta ?? 0;

  // 1. 递进联动（单向：判断→概念，推理→概念+判断）
  const conceptFinal = c + LINK_JUDGMENT_TO_CONCEPT * j + LINK_REASONING_TO_CONCEPT * r;
  const judgmentFinal = j + LINK_REASONING_TO_JUDGMENT * r;
  const reasoningFinal = r;

  // 2. 恒定权重：推理最能体现掌握，判断次之，概念直接权重最小
  const deltaTotal =
    MASTERY_W_CONCEPT * conceptFinal +
    MASTERY_W_JUDGMENT * judgmentFinal +
    MASTERY_W_REASONING * reasoningFinal;

  const mastery = clamp(oldMastery + MASTERY_DELTA_ALPHA * deltaTotal, 0, 100);

  return {
    mastery,
    level: determineMasteryLevel(reasoningDelta, judgmentDelta),
    deltaTotal,
    conceptFinal,
    judgmentFinal,
    reasoningFinal,
  };
}

/**
 * 内联计算某知识点的 conceptMastery 更新（纯函数，无 IO；旧兼容入口，保留 MASTERY_ALPHA EMA 语义）。
 * 保留原 DSR 其它字段，仅返回掌握度相关的三个字段，供调用方合并进完整 DSR。
 */
export function computeConceptMastery(
  cur: KnowledgePointDsr,
  signal: number,
): Pick<KnowledgePointDsr, 'conceptMastery' | 'conceptMasterySamples' | 'conceptMasteryUpdatedAt'> {
  const s = clamp(signal, 0, 100);
  const samples = (cur.conceptMasterySamples || 0) + 1;
  const mastery = clamp(ema(cur.conceptMastery, s, MASTERY_ALPHA), 0, 100);
  return {
    conceptMastery: mastery,
    conceptMasterySamples: samples,
    conceptMasteryUpdatedAt: new Date().toISOString(),
  };
}