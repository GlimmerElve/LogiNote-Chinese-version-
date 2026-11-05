import { CognitiveStyle, CognitiveStyleEvidence } from '../../../types';
import { ema, clamp } from './ability';

/**
 * 认知/表达风格折叠（EMA 0.15），供画像融合（profileFusion）调用。
 * 认知风格：双极 -100~+100（含 v2 新增第五维 deepVsSurface）。
 * 表达风格：偏好型 0-1 + 能力型 0-100。
 * 说明：STYLE_ALPHA 从 0.4 降到 0.15，避免单次复盘拉动过大、收敛过快。
 */

const STYLE_ALPHA = 0.15;

/** 认知风格四维 + 第五维（deepVsSurface） */
const COGNITIVE_KEYS: Array<keyof CognitiveStyle> = [
  'abstractVsConcrete',
  'systematicVsScattered',
  'divergentVsConvergent',
  'cautiousVsDogmatic',
  'deepVsSurface',
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

/** 把某维的双向锚点折算为 -100~+100：正极命中每个 +25，负极命中每个 -25，累加后 clamp。 */
function bipolarScore(
  ev: CognitiveStyleEvidence,
  pos: Array<keyof CognitiveStyleEvidence>,
  neg: Array<keyof CognitiveStyleEvidence>,
): number | undefined {
  const positiveHits = pos.filter((k) => ev[k] === true).length;
  const negativeHits = neg.filter((k) => ev[k] === true).length;
  // 没有观察到任何锚点表示“未知”，不能用 0 冒充稳定的中性风格。
  if (positiveHits + negativeHits === 0) return undefined;
  return clamp((positiveHits - negativeHits) * 25, -100, 100);
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
    cautiousVsDogmatic: bipolarScore(ev, ['qualifiesStatements', 'marksUncertainty', 'delayedReflection'], ['absolutistClaims', 'leavesNoRoom', 'quickReaction']),
    deepVsSurface: bipolarScore(ev, ['linksBroaderFramework', 'probesMechanism', 'reflectsOnAssumptions'], ['repeatsSurfaceInfo', 'noWhyProbing']),
  };
}

