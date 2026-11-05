import { COGNITIVE_EVIDENCE_CONTRACT, type ShadowAssessment, type ShadowBehavior, type ShadowGraph, type ShadowInput, type ShadowWarning } from './types';
import { SHADOW_BEHAVIORS } from './rubric';
import { verifiedShadowUserEvidence } from './scoring';

/** Explicit prompt opt-in keeps switching back to a frozen pre-audit prompt compatible. */
export function requiresCognitiveEvidenceAudit(promptId: string): boolean {
  return promptId === 'flow-shadow-assess-v4.1-light' || promptId === 'flow-shadow-assess-v4.2-light'
    || promptId === 'flow-shadow-assess-v4.3-light' || promptId === 'flow-shadow-assess-v4.4-light'
    || promptId === 'flow-shadow-assess-v4.5-light' || promptId === 'flow-shadow-assess-v4.6-light';
}

/** Verifies the model's explicit evidence declaration, not whether it found all relevant language. */
export function auditShadowCognitiveEvidence(input: ShadowInput, graph: ShadowGraph, assessment: ShadowAssessment,
  requireContract = false): { assessment: ShadowAssessment; warnings: ShadowWarning[] } {
  const strict = requireContract || assessment.behaviorContract === COGNITIVE_EVIDENCE_CONTRACT;
  const evidence = verifiedShadowUserEvidence(input, graph, assessment).evidence;
  const warnings: ShadowWarning[] = [];
  const behaviors = assessment.behaviors.map((behavior): ShadowBehavior => {
    if (!SHADOW_BEHAVIORS.some(definition => definition.code === behavior.code && definition.dimension === 'strategy')) return behavior;
    const hold = (code: string, message: string) => {
      warnings.push({ code, target: behavior.code, message });
      return { ...behavior, direction: null };
    };
    if (!strict && behavior.polarity === undefined) return behavior; // Historical records keep their original interpretation.
    if (behavior.state !== 'observed') return { ...behavior, direction: null };
    const p = behavior.polarity;
    if (!p) return hold('cognitive_audit_missing', '本次缺少两极证据核对，仅暂缓该认知方向；不阻断图与能力评价。');
    const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 20
      && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && evidence.has(id) && behavior.evidenceIds.includes(id));
    if (!validIds(p.negative) || !validIds(p.positive) || p.negative.some(id => p.positive.includes(id))) {
      return hold('cognitive_polarity_unbound', '两极证据须分开列出有效用户原话ID，并同时计入本条evidenceIds。');
    }
    const negative = p.negative.length > 0, positive = p.positive.length > 0;
    const direction = behavior.direction;
    const numeric = typeof direction === 'number' && [-2, -1, 0, 1, 2].includes(direction);
    if (p.resolution === 'mixed' || p.resolution === 'insufficient') {
      return direction == null ? behavior : hold('cognitive_direction_withheld', '两极未解决或证据不足，方向应为空，不改判为均衡或任一极。');
    }
    if (p.resolution === 'single_pole' && negative !== positive && numeric && direction !== 0
      && (positive ? direction > 0 : direction < 0)) return behavior;
    if (p.resolution === 'balanced' && negative && positive && direction === 0) return behavior;
    // Whether the original speech actually retracts/corrects a position still requires semantic review.
    if (p.resolution === 'resolved' && negative && positive && numeric && direction !== 0 && behavior.reason.trim()) return behavior;
    return hold('cognitive_resolution_mismatch', '证据分组、解决状态与方向不自洽，仅暂缓此方向；本地不代判语义。');
  });
  return { assessment: { ...assessment, ...(strict ? { behaviorContract: COGNITIVE_EVIDENCE_CONTRACT } : {}), behaviors }, warnings };
}
