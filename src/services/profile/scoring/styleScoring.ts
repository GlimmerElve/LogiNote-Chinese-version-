import { CognitiveStyle, ExpressionStyle, CognitiveStyleEvidence } from '../../../types';
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

/** 统计一组锚点中命中（true）的个数 */
function countHits(ev: CognitiveStyleEvidence, keys: Array<keyof CognitiveStyleEvidence>): number {
  return keys.filter((k) => ev[k] === true).length;
}

/** 把某维的双向锚点折算为 -100~+100： (正极命中/正极总数 − 负极命中/负极总数) × 100 */
function bipolarScore(
  ev: CognitiveStyleEvidence,
  pos: Array<keyof CognitiveStyleEvidence>,
  neg: Array<keyof CognitiveStyleEvidence>,
): number {
  const posRatio = pos.length > 0 ? countHits(ev, pos) / pos.length : 0;
  const negRatio = neg.length > 0 ? countHits(ev, neg) / neg.length : 0;
  return clamp((posRatio - negRatio) * 100, -100, 100);
}

/**
 * 认知风格证据锚点 → 双极分数（-100~+100）。
 * 不再让 LLM 直接报数字，而由可观察锚点归一化折算。
 */
export function scoreCognitiveStyle(ev: CognitiveStyleEvidence): Partial<CognitiveStyle> {
  return {
    abstractVsConcrete: bipolarScore(ev, ['usesAbstractTerms', 'generalizesDomain'], ['usesConcreteExamples', 'staysOperational']),
    systematicVsScattered: bipolarScore(ev, ['structuresHierarchically', 'connectsPoints'], ['jumpsDisconnected', 'listsWithoutOrder']),
    divergentVsConvergent: bipolarScore(ev, ['multipleAngles', 'considersAlternatives'], ['singleAnswerOnly', 'excludesAlternatives']),
    cautiousVsDogmatic: bipolarScore(ev, ['qualifiesStatements', 'marksUncertainty'], ['absolutistClaims', 'leavesNoRoom']),
    deepVsSurface: bipolarScore(ev, ['linksBroaderFramework', 'probesMechanism', 'reflectsOnAssumptions'], ['repeatsSurfaceInfo', 'noWhyProbing']),
  };
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