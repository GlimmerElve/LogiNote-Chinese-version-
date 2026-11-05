import { parseCoreDerivations, type CoreDerivationResult, type CoreDerivationStep } from './derivation';
import { parseCoreSemanticAudit, parseCoreAuditDecisions, type AuditCandidate, type AuditDecision } from './semanticAudit';
import type { CoreArgumentInput } from './types';

export interface CoreAuditBatch { candidates: AuditCandidate[]; decisions: AuditDecision[]; decisionContract?: 'compact-v5' }
export const CORE_SHADOW_AUDIT_OPTIONS = Object.freeze({ visibility: 'blind-candidates', contract: 'relation-function' } as const);
function demand(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const METADATA_LAYERS = new Set(['quote_unresolved_section', 'quote_unresolved', 'unresolved', 'quote_attachment', 'attachment']);
/** Missing metadata remains review-required; it does not invalidate independently
 * bound argument steps. Any core material/step/conclusion quarantine still blocks
 * a claim of complete step coverage. */
export function coreAuditBlockingQuarantines(baseline: CoreDerivationResult) {
  return baseline.quarantined.filter(q => !METADATA_LAYERS.has(q.layer));
}

/** Structural mapping only; no prioritisation, semantic filtering or inferred edges. */
export function coreAuditCandidates(baseline: CoreDerivationResult): AuditCandidate[] {
  const ref = (id: string) => {
    const material = baseline.derivation.materials.find(m => m.id === id);
    demand(material?.source.length === 1, '影子复核要求单一定位引文，不能静默丢弃多来源');
    return structuredClone(material.source[0]);
  };
  return baseline.derivation.steps.map(step => ({ id: step.id, kind: step.kind,
    target: ref(step.conclusion), premises: step.premises.map(ref), reason: step.reason }));
}

/** Apply explicit revocations only to a new shadow projection. Never delete source
 * materials, trim joint premise groups, guess method edges, or apply a retarget. */
export function replayCoreSemanticAudit(source: CoreArgumentInput, baseline: CoreDerivationResult, batches: CoreAuditBatch[]) {
  demand(coreAuditBlockingQuarantines(baseline).length === 0, '基线存在核心隔离项，不能把残缺推导投影当完整联测');
  const expected = new Map(coreAuditCandidates(baseline).map(c => [c.id, c]));
  const decisions = new Map<string, AuditDecision>();
  for (const batch of batches) {
    for (const candidate of batch.candidates) {
      const original = expected.get(candidate.id);
      demand(original && JSON.stringify(original) === JSON.stringify(candidate), '审计候选与基线步骤不一致');
      demand(!decisions.has(candidate.id), '审计批次重复覆盖步骤');
    }
    demand(batch.decisionContract === undefined || batch.decisionContract === 'compact-v5', '影子审计传输契约非法');
    const parse = batch.decisionContract === 'compact-v5' ? parseCoreAuditDecisions : parseCoreSemanticAudit;
    const checked = parse(JSON.stringify({ decisions: batch.decisions }), { source, candidates: batch.candidates }, CORE_SHADOW_AUDIT_OPTIONS);
    for (const decision of checked) decisions.set(decision.id, structuredClone(decision));
  }
  demand(decisions.size === expected.size && [...expected.keys()].every(id => decisions.has(id)), '审计未完整覆盖所有步骤，未生成部分修订冒充完整结果');
  const revoked: Array<{ step: CoreDerivationStep; decision: AuditDecision }> = [];
  const pendingRetargets: Array<{ step: CoreDerivationStep; decision: AuditDecision }> = [];
  const steps = baseline.derivation.steps.flatMap(step => {
    const decision = decisions.get(step.id)!;
    if (decision.action === 'revoke') { revoked.push({ step: structuredClone(step), decision }); return []; }
    if (decision.action === 'retarget') pendingRetargets.push({ step: structuredClone(step), decision });
    return [structuredClone(step)]; // Even a pending retarget preserves original premises and reason.
  });
  const wire = {
    materials: structuredClone(baseline.derivation.materials), steps,
    conclusions: structuredClone(baseline.derivation.conclusions),
    unresolved: baseline.graph.unresolved.map(({ nodeId, reason }) => ({ ...(nodeId ? { nodeId } : {}), reason })),
  };
  const result = parseCoreDerivations(JSON.stringify(wire), structuredClone(source));
  demand(result.quarantined.length === 0, '影子修订投影出现隔离项，未宣称联测通过');
  const metadataQuarantine = baseline.quarantined.filter(q => METADATA_LAYERS.has(q.layer));
  result.quarantined.unshift(...structuredClone(metadataQuarantine));
  result.issues.unshift(...structuredClone(baseline.issues.filter(i => metadataQuarantine.some(q => q.id === i.id))));
  for (const { step, decision } of revoked) result.issues.push({ id: step.id, code: 'shadow_step_revoked', reason: `仅影子撤销论证步骤，材料保留：${decision.reason}` });
  for (const { step } of pendingRetargets) result.issues.push({ id: step.id, code: 'shadow_retarget_pending', reason: '改目标建议仅留痕，原步骤暂存，未自动增边或替换目标' });
  for (const chain of result.chains) chain.state = 'source_review_required';
  return { mode: 'shadow-replay' as const, result, revoked, pendingRetargets,
    reviewUses: [...decisions.values()], coverage: { reviewedSteps: decisions.size, baselineSteps: expected.size, metadataQuarantinePreserved: metadataQuarantine.length },
    boundary: { productionWrites: false, semanticCertified: false, automaticallyAddedEdges: 0, retargetsAutomaticallyApplied: false } as const };
}
