import type { ShadowBehaviorCode, ShadowCognitiveAxis, ShadowExpressionStyle } from './types.ts';

export interface ShadowCognitiveAxisDefinition {
  key: ShadowCognitiveAxis;
  behavior: ShadowBehaviorCode;
  label: string;
  negative: string;
  positive: string;
}

/** Mirrors the existing production profile coordinate system without importing or writing to it. */
export const SHADOW_COGNITIVE_AXES: readonly ShadowCognitiveAxisDefinition[] = [
  { key: 'abstractVsConcrete', behavior: 'abstract_concrete', label: '具象—抽象', negative: '具象', positive: '抽象' },
  { key: 'systematicVsScattered', behavior: 'structured_connections', label: '零散—系统', negative: '零散', positive: '系统' },
  { key: 'divergentVsConvergent', behavior: 'explore_converge', label: '收敛—发散', negative: '收敛', positive: '发散' },
  { key: 'cautiousVsDogmatic', behavior: 'uncertainty_calibration', label: '武断—谨慎', negative: '武断', positive: '谨慎' },
  { key: 'deepVsSurface', behavior: 'assumption_inspection', label: '表面—深度', negative: '表面', positive: '深度' },
] as const;

export const SHADOW_EXPRESSION_STYLE_LABELS: Record<ShadowExpressionStyle, string> = {
  academic: '学术建构型',
  critical: '逻辑批判型',
  practical: '实用行动型',
  divergent: '发散探索型',
  objective: '客观陈述型',
};

export const SHADOW_EXPRESSION_STYLES = Object.keys(SHADOW_EXPRESSION_STYLE_LABELS) as ShadowExpressionStyle[];

/**
 * Transparent shadow-only bridge from directly observed expression behavior to the existing five style axes.
 * It replaces the old nine-argument-type shortcut but preserves the profile's public coordinate system.
 */
export const SHADOW_EXPRESSION_WEIGHTS: Record<ShadowBehaviorCode, Partial<Record<ShadowExpressionStyle, number>>> = {
  concept_framing: { academic: .9, critical: .2, practical: .1, divergent: .2, objective: .1 },
  evidence_description: { academic: .2, critical: .2, practical: .3, divergent: .1, objective: .9 },
  mechanism_explanation: { academic: .6, critical: .7, practical: .2, divergent: .2, objective: .2 },
  comparison_review: { academic: .3, critical: .8, practical: .1, divergent: .6, objective: .2 },
  action_application: { academic: .1, critical: .1, practical: .9, divergent: .2, objective: .2 },
  abstract_concrete: {}, structured_connections: {}, explore_converge: {}, uncertainty_calibration: {}, assumption_inspection: {},
};

export function cognitiveDirectionLabel(definition: ShadowCognitiveAxisDefinition, direction: number | null | undefined): string {
  if (direction == null) return '方向未提供';
  if (direction === 0) return `${definition.negative}与${definition.positive}均衡`;
  const pole = direction > 0 ? definition.positive : definition.negative;
  return `${Math.abs(direction) === 2 ? '明显偏' : '偏'}${pole}`;
}
