import { ConceptEvidence, JudgmentEvidence, ReasoningEvidence } from '../../../types';

/**
 * 画像「三层能力」折算（与知识点掌握度是两套独立体系，保持 50 基准 + EMA 0.4）。
 * 本文件同时承载通用工具函数 clamp / ema / judgeTrend，供 threeLayer / styleScoring 复用。
 */

export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * 指数移动平均：old 为 null/undefined 时直接采用首次信号。
 * alpha 越大，越偏向新信号。
 */
export function ema(old: number | null | undefined, signal: number, alpha: number): number {
  if (old === null || old === undefined) return signal;
  return alpha * signal + (1 - alpha) * old;
}

/** 趋势判定：变化超过阈值 3 分才算上升/下降，否则视为稳定 */
export function judgeTrend(prev: number, curr: number): 'up' | 'stable' | 'down' {
  const delta = curr - prev;
  if (delta > 3) return 'up';
  if (delta < -3) return 'down';
  return 'stable';
}

/** 概念层 → 概念清晰度分数（50 基准加减） */
export function scoreConcept(ev: ConceptEvidence): number {
  let score = 50;
  if (ev.redefinesInOwnWords) score += 15;
  if (ev.distinguishesSimilarConcepts) score += 15;
  if (ev.givesCounterExamples) score += 10;
  if (ev.vagueTerms && ev.vagueTerms.length > 0) score -= ev.vagueTerms.length * 5;
  return clamp(score, 0, 100);
}

/** 判断层 → 判断合理性分数（50 基准加减） */
export function scoreJudgment(ev: JudgmentEvidence): number {
  let score = 50;
  if (ev.considersConditions) score += 20;
  if (ev.distinguishesFactOpinion) score += 10;
  if (ev.usesQualifiers) score += 10;
  if (ev.absolutistCount) score -= ev.absolutistCount * 10;
  return clamp(score, 0, 100);
}

/** 推理层 → 推理有效性分数（50 基准加减；含 v2 新增两个高阶锚点，各 +20 便于后期调整） */
export function scoreReasoning(ev: ReasoningEvidence): number {
  let score = 50;
  if (ev.providesPremises) score += 15;
  if (ev.completeChain) score += 15;
  if (ev.identifiesAssumptions) score += 20;
  // v2 新增：区分演绎/归纳（推理类型意识，高阶）
  if (ev.distinguishesDeductiveInductive) score += 20;
  // v2 新增：反事实思考（高阶批判思维）
  if (ev.considersCounterfactuals) score += 20;
  if (ev.fallacyTypes && ev.fallacyTypes.length > 0) score -= ev.fallacyTypes.length * 10;
  return clamp(score, 0, 100);
}