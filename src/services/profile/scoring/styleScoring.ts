import { CognitiveStyle, ExpressionStyle } from '../../../types';
import { ema, clamp } from './ability';

/**
 * 认知/表达风格折叠（EMA 0.4），供画像融合（profileFusion）调用。
 * 认知风格：双极 -100~+100（含 v2 新增第五维 deepVsSurface）。
 * 表达风格：偏好型 0-1 + 能力型 0-100。
 */

const STYLE_ALPHA = 0.4;

/** 认知风格四维 + 第五维（deepVsSurface） */
const COGNITIVE_KEYS: Array<keyof CognitiveStyle> = [
  'abstractVsConcrete',
  'systematicVsScattered',
  'divergentVsConvergent',
  'cautiousVsDogmatic',
  'deepVsSurface',
];

/** 表达风格：0-1 偏好型指标（正则统计密度来源，v2） */
const EXPR_RATIO_KEYS: Array<keyof ExpressionStyle> = [
  'prefersExample',
  'prefersAnalogy',
  'prefersDefinition',
  'prefersDerivation',
  'conclusionFirst',
];

/** 表达风格：0-100 能力型指标（AI 语义判断） */
const EXPR_SCORE_KEYS: Array<keyof ExpressionStyle> = [
  'terminologyAccuracy',
  'selfCorrection',
];

/** 折叠认知风格：对存在的增量字段做 EMA + clamp（-100~100） */
export function foldCognitiveStyle(
  cur: CognitiveStyle,
  inc?: Partial<CognitiveStyle>,
): CognitiveStyle {
  const next = { ...cur };
  if (inc) {
    for (const key of COGNITIVE_KEYS) {
      const v = inc[key];
      if (typeof v === 'number') {
        next[key] = clamp(ema(cur[key] ?? 0, v, STYLE_ALPHA), -100, 100);
      }
    }
  }
  return next;
}

/** 折叠表达风格：偏好型 0-1 + 能力型 0-100 */
export function foldExpressionStyle(
  cur: ExpressionStyle,
  inc?: Partial<ExpressionStyle>,
): ExpressionStyle {
  const next = { ...cur };
  if (inc) {
    for (const key of EXPR_RATIO_KEYS) {
      const v = inc[key];
      if (typeof v === 'number') {
        next[key] = clamp(ema(cur[key] ?? 0, v, STYLE_ALPHA), 0, 1);
      }
    }
    for (const key of EXPR_SCORE_KEYS) {
      const v = inc[key];
      if (typeof v === 'number') {
        next[key] = clamp(ema(cur[key] ?? 50, v, STYLE_ALPHA), 0, 100);
      }
    }
  }
  return next;
}