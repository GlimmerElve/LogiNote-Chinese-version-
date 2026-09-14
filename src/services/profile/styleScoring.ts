import {
  ArgumentFunctionType,
  ExpressionStyleKind,
  RawAnalysisRecord,
  SentenceAnnotation,
} from '../../types';

/**
 * 表达风格「论证类型 → 5 风格」折算（详见 implementation_plan.md）。
 * 数据流：LLM 逐句标注 9 类论证功能 → 前端统计计数 → 时间衰减加权 →
 * 类型占比归一化 → 权重矩阵 → 风格得分 → 百分比归一化 → 指数平滑 → 判定结论。
 */

/** 可配置参数（后续可外置） */
export const STYLE_HALF_LIFE_DAYS = 30;
export const STYLE_SMOOTH_ALPHA = 0.5;

/** 9 类论证功能的固定顺序（用于遍历与展示） */
export const ARGUMENT_TYPES: ArgumentFunctionType[] = [
  '定义',
  '对比',
  '假设',
  '举例',
  '推理',
  '反例削弱',
  '建议对策',
  '命名',
  '事实陈述',
];

/** 5 种表达风格的固定顺序（雷达轴顺序） */
export const EXPRESSION_KINDS: ExpressionStyleKind[] = [
  'academic',
  'critical',
  'practical',
  'divergent',
  'objective',
];

/** 5 风格 → 中文标签 */
export const EXPRESSION_STYLE_LABELS: Record<ExpressionStyleKind, string> = {
  academic: '学术建构型',
  critical: '逻辑批判型',
  practical: '实用行动型',
  divergent: '发散探索型',
  objective: '客观陈述型',
};

/**
 * 权重矩阵：类型 → 5 风格权重（严格按需求文档，不擅自改动）。
 * 行=9 类论证功能，列=5 风格。
 */
export const STYLE_WEIGHTS: Record<ArgumentFunctionType, Record<ExpressionStyleKind, number>> = {
  定义:     { academic: 0.9, critical: 0.3, practical: 0.1, divergent: 0.3, objective: 0.1 },
  对比:     { academic: 0.5, critical: 0.4, practical: 0.1, divergent: 0.5, objective: 0.1 },
  假设:     { academic: 0.1, critical: 0.6, practical: 0.1, divergent: 0.9, objective: 0.1 },
  举例:     { academic: 0.2, critical: 0.1, practical: 0.6, divergent: 0.6, objective: 0.4 },
  推理:     { academic: 0.4, critical: 0.9, practical: 0.2, divergent: 0.2, objective: 0.1 },
  反例削弱: { academic: 0.2, critical: 0.9, practical: 0.1, divergent: 0.3, objective: 0.1 },
  建议对策: { academic: 0.1, critical: 0.1, practical: 0.9, divergent: 0.1, objective: 0.1 },
  命名:     { academic: 0.9, critical: 0.2, practical: 0.1, divergent: 0.2, objective: 0.1 },
  事实陈述: { academic: 0.1, critical: 0.1, practical: 0.3, divergent: 0.2, objective: 0.9 },
};

/** 从逐句标注统计 9 类计数 */
export function computeTypeCounts(
  sentences: SentenceAnnotation[],
): Record<ArgumentFunctionType, number> {
  const counts = {} as Record<ArgumentFunctionType, number>;
  for (const t of ARGUMENT_TYPES) counts[t] = 0;
  for (const s of sentences) {
    if (s && counts[s.mainType] !== undefined) {
      counts[s.mainType] += 1;
    }
  }
  return counts;
}

/** 日期相差天数（B - A，按自然日） */
function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86400000);
}

/**
 * 时间衰减加权：对每条记录，权重 = 0.5 ^ (距今天数 / 半衰期)，
 * 加权类型得分 += 该记录计数 × 权重。返回 9 类加权总分。
 */
export function computeWeightedTypeScores(
  records: RawAnalysisRecord[],
  halfLifeDays: number = STYLE_HALF_LIFE_DAYS,
): Record<ArgumentFunctionType, number> {
  const scores = {} as Record<ArgumentFunctionType, number>;
  for (const t of ARGUMENT_TYPES) scores[t] = 0;

  const now = new Date();
  for (const rec of records || []) {
    const day = new Date(rec.analysisDate + 'T00:00:00');
    if (isNaN(day.getTime())) continue;
    const ageDays = Math.max(0, daysBetween(day, now));
    const weight = Math.pow(0.5, ageDays / halfLifeDays);
    for (const t of ARGUMENT_TYPES) {
      scores[t] += (rec.counts?.[t] ?? 0) * weight;
    }
  }
  return scores;
}

/** 计算风格分布（类型占比 + 风格原始得分 + 风格百分比归一化） */
export function computeStyleDistribution(weightedTypeScores: Record<ArgumentFunctionType, number>): {
  typeRatios: Record<ArgumentFunctionType, number>;
  styleScores: Record<ExpressionStyleKind, number>;
  stylePercent: Record<ExpressionStyleKind, number>;
} {
  const total = ARGUMENT_TYPES.reduce((s, t) => s + (weightedTypeScores[t] || 0), 0);

  const typeRatios = {} as Record<ArgumentFunctionType, number>;
  for (const t of ARGUMENT_TYPES) {
    typeRatios[t] = total > 0 ? (weightedTypeScores[t] || 0) / total : 0;
  }

  // 风格原始得分 = Σ [ 类型占比(i) × 权重矩阵(i, 风格) ]
  const styleScores = {} as Record<ExpressionStyleKind, number>;
  for (const k of EXPRESSION_KINDS) {
    let sum = 0;
    for (const t of ARGUMENT_TYPES) {
      sum += typeRatios[t] * STYLE_WEIGHTS[t][k];
    }
    styleScores[k] = sum;
  }

  // 风格百分比：风格得分 / 五风格得分之和 × 100
  const scoreTotal = EXPRESSION_KINDS.reduce((s, k) => s + styleScores[k], 0);
  const stylePercent = {} as Record<ExpressionStyleKind, number>;
  for (const k of EXPRESSION_KINDS) {
    stylePercent[k] = scoreTotal > 0 ? (styleScores[k] / scoreTotal) * 100 : 0;
  }

  return { typeRatios, styleScores, stylePercent };
}

/** 指数平滑（仅用于雷达图 display；prev 为空时直接用 next） */
export function smoothDisplay(
  prev: Record<ExpressionStyleKind, number> | null | undefined,
  next: Record<ExpressionStyleKind, number>,
  alpha: number = STYLE_SMOOTH_ALPHA,
): Record<ExpressionStyleKind, number> {
  if (!prev) return { ...next };
  const out = {} as Record<ExpressionStyleKind, number>;
  for (const k of EXPRESSION_KINDS) {
    out[k] = alpha * next[k] + (1 - alpha) * (prev[k] ?? 0);
  }
  return out;
}

/** 判定结论：第一名-第二名 ≥10 主导型 / 5~10 偏主型 / <5 混合型 */
export function judgeStyle(
  stylePercent: Record<ExpressionStyleKind, number>,
): string {
  const sorted = [...EXPRESSION_KINDS].sort((a, b) => stylePercent[b] - stylePercent[a]);
  const first = sorted[0];
  const second = sorted[1];
  const gap = stylePercent[first] - stylePercent[second];
  const firstLabel = EXPRESSION_STYLE_LABELS[first];
  const secondLabel = EXPRESSION_STYLE_LABELS[second];
  if (gap >= 10) return `主导型：倾向于【${firstLabel}】`;
  if (gap >= 5) return `偏主型：以【${firstLabel}】为主，兼有【${secondLabel}】特征`;
  return `混合型：【${firstLabel} + ${secondLabel}】混合`;
}