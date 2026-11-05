import type { ShadowRecord } from '../flowShadow/types';
import { verifiedShadowUserEvidence } from '../flowShadow/scoring';
import { auditShadowCognitiveEvidence } from '../flowShadow/cognitiveEvidence';
import { SHADOW_BEHAVIORS } from '../flowShadow/rubric';
import {
  SHADOW_COGNITIVE_AXES, SHADOW_EXPRESSION_STYLES, SHADOW_EXPRESSION_STYLE_LABELS,
  SHADOW_EXPRESSION_WEIGHTS, cognitiveDirectionLabel,
} from '../flowShadow/profileAlignment';
import type { FlowStylePresentation, FlowStyleObservation } from './types';

/** Uses the evidence gate and weights of the V2 profile signal extractor. Read only. */
export function buildFlowStylePresentation(record: ShadowRecord): FlowStylePresentation {
  const checked = verifiedShadowUserEvidence(record.input, record.graph, record.assessment);
  const assessment = auditShadowCognitiveEvidence(record.input, record.graph, record.assessment).assessment;
  const usable = assessment.behaviors.filter(behavior => behavior.state === 'observed'
    && behavior.evidenceIds.length > 0 && behavior.evidenceIds.every(id => checked.evidence.has(id))
    && !record.input.task.promptedBehaviors.includes(behavior.code));
  const observations = (behavior: (typeof usable)[number]): FlowStyleObservation => ({
    evidenceIds: [...behavior.evidenceIds], quotes: behavior.evidenceIds.map(id => checked.evidence.get(id)!.quote), reason: behavior.reason,
  });
  const expressionBehaviors = usable.filter(behavior => SHADOW_BEHAVIORS.some(definition => definition.code === behavior.code
    && definition.dimension === 'expression'));
  const raw = SHADOW_EXPRESSION_STYLES.map(style => expressionBehaviors.reduce((sum, behavior) => sum + (SHADOW_EXPRESSION_WEIGHTS[behavior.code][style] || 0), 0));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return {
    expression: SHADOW_EXPRESSION_STYLES.map((style, index) => ({ key: style, label: SHADOW_EXPRESSION_STYLE_LABELS[style],
      share: total > 0 ? Math.round(raw[index] / total * 1000) / 10 : null,
      observations: expressionBehaviors.filter(behavior => (SHADOW_EXPRESSION_WEIGHTS[behavior.code][style] || 0) > 0).map(observations) })),
    cognitive: SHADOW_COGNITIVE_AXES.map(axis => {
      const behavior = usable.find(item => item.code === axis.behavior);
      return { key: axis.key, label: axis.label, negative: axis.negative, positive: axis.positive,
        value: behavior?.direction == null ? null : behavior.direction * 50,
        directionLabel: behavior?.direction == null ? '本次证据不足' : cognitiveDirectionLabel(axis, behavior.direction),
        observations: behavior?.direction == null ? [] : [observations(behavior)] };
    }),
  };
}
