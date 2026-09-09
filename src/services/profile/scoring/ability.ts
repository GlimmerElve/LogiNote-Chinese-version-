import { ConceptEvidence, JudgmentEvidence, ReasoningEvidence, ArgumentAnalysis } from '../../../types';

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
  // 模糊词：封顶 4 个，每个 -8
  if (ev.vagueTerms && ev.vagueTerms.length > 0) score -= Math.min(ev.vagueTerms.length, 4) * 8;
  // 概念理解错误（严重）：封顶 3 个，每个 -20
  if (ev.conceptErrors && ev.conceptErrors.length > 0) score -= Math.min(ev.conceptErrors.length, 3) * 20;
  return clamp(score, 0, 100);
}

/** 判断层 → 判断合理性分数（50 基准加减） */
export function scoreJudgment(ev: JudgmentEvidence): number {
  let score = 50;
  if (ev.considersConditions) score += 20;
  if (ev.distinguishesFactOpinion) score += 10;
  if (ev.usesQualifiers) score += 10;
  // 绝对化表达：封顶 3 次，每次 -12
  if (ev.absolutistCount) score -= Math.min(ev.absolutistCount, 3) * 12;
  // 判断错误（严重）：封顶 3 个，每个 -20
  if (ev.judgmentErrors && ev.judgmentErrors.length > 0) score -= Math.min(ev.judgmentErrors.length, 3) * 20;
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
  // 逻辑谬误：封顶 4 个类型，每类型 -15
  if (ev.fallacyTypes && ev.fallacyTypes.length > 0) score -= Math.min(ev.fallacyTypes.length, 4) * 15;
  return clamp(score, 0, 100);
}

/**
 * 结论粒度 → 三层能力（N 条结论取算术平均）。
 * 每条结论：50 基准 + 正向锚点加分 + 负向锚点扣分 + 该结论 issues 按 layer 扣分 + clamp(0,100)。
 * 注意：fallacyType 不在此处扣分（它专用于周报 errorRate / fallacyBreakdown），
 *       推理层的负向扣分统一来自该结论 issues 里 layer===reasoning 的问题，避免双重扣分。
 */
export function scoreLayeredFromArguments(args: ArgumentAnalysis[]): {
  conceptClarity: number;
  judgmentReasonableness: number;
  reasoningValidity: number;
} {
  if (!args || args.length === 0) {
    return { conceptClarity: 50, judgmentReasonableness: 50, reasoningValidity: 50 };
  }

  let sumConcept = 0;
  let sumJudgment = 0;
  let sumReasoning = 0;

  for (const a of args) {
    // 概念层：正向锚点（负向统一走 issues）
    let c = 50;
    if (a.redefinesInOwnWords) c += 15;
    if (a.distinguishesSimilarConcepts) c += 15;
    if (a.givesCounterExamples) c += 10;

    // 判断层：正向锚点（负向统一走 issues）
    let j = 50;
    if (a.considersConditions) j += 20;
    if (a.distinguishesFactOpinion) j += 10;
    if (a.usesQualifiers) j += 10;

    // 推理层：正向锚点（负向统一走 issues，含谬误）
    let r = 50;
    if (a.hasPremise) r += 15;
    if (a.completeChain) r += 15;
    if (a.identifiesAssumption) r += 20;
    if (a.distinguishesDeductiveInductive) r += 20;
    if (a.considersCounterfactual) r += 20;

    // 统一关键问题：按 layer 扣对应分（封顶 3 条，每条 -20）
    const conceptIssues = (a.issues || []).filter((i) => i.layer === 'concept');
    const judgmentIssues = (a.issues || []).filter((i) => i.layer === 'judgment');
    const reasoningIssues = (a.issues || []).filter((i) => i.layer === 'reasoning');
    c -= Math.min(conceptIssues.length, 3) * 20;
    j -= Math.min(judgmentIssues.length, 3) * 20;
    r -= Math.min(reasoningIssues.length, 3) * 20;

    sumConcept += clamp(c, 0, 100);
    sumJudgment += clamp(j, 0, 100);
    sumReasoning += clamp(r, 0, 100);
  }

  const n = args.length;
  return {
    conceptClarity: sumConcept / n,
    judgmentReasonableness: sumJudgment / n,
    reasoningValidity: sumReasoning / n,
  };
}
