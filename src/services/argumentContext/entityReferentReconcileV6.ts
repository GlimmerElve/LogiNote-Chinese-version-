/** Compare independently source-validated judgments. Agreement is not semantic truth. */
import type {ReferentContext} from './entityReferentBindings.ts';
import type {ReferenceInventoryV4} from './entityReferentInventoryV4.ts';
import {resolveReferentSelectionV3, type ReferentSelectionV3, type ReferentUnitCatalogV3} from './entityReferentUnitsV3.ts';
import {validateReferenceDecisionsV5, type ReferenceDecisionsV5, type ReferenceTaskPlanV5} from './entityReferentTasksV5.ts';

export type ReferentComparisonV6 = 'local_excluded' | 'same_binding' | 'same_rejection' | 'same_unresolved'
  | 'status_disagreement' | 'target_disagreement' | 'source_invalid';
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};

/** Equal restored spans, ignoring selector order only. Never infer equivalent entities or merge partial groups. */
export function referentTargetKeysV6(catalog: ReferentUnitCatalogV3, targets: ReferentSelectionV3[]) {
  return [...new Set(targets.map(t => {
    const s = resolveReferentSelectionV3(catalog, t, true);
    return JSON.stringify([s.nodeId, s.window, s.start, s.end]);
  }))].sort();
}

export function reconcileReferenceDecisionsV6(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  inventory: ReferenceInventoryV4, plan: ReferenceTaskPlanV5,
  initial: ReferenceDecisionsV5, review: ReferenceDecisionsV5) {
  check(initial.stage === 'proposal' && review.stage === 'review', 'reconciliation_stages');
  for (const value of [initial, review]) {
    check(value.documentId === ctx.documentId && value.snapshotId === ctx.snapshotId, 'reconciliation_snapshot');
    const actual = validateReferenceDecisionsV5(ctx, catalog, inventory, plan, value.stage, value.rawModelDecisions);
    check(JSON.stringify(actual) === JSON.stringify(value), 'reconciliation_decisions_changed');
  }
  const local = new Set(plan.localDecisions.map(d => d.id));
  const rows = inventory.tasks.map(t => {
    const a = initial.combined.decisions.find(d => d.id === t.id) || null;
    const b = review.combined.decisions.find(d => d.id === t.id) || null;
    const al = initial.combined.ledger.find(d => d.id === t.id)!;
    const bl = review.combined.ledger.find(d => d.id === t.id)!;
    let comparison: ReferentComparisonV6;
    if (local.has(t.id)) comparison = 'local_excluded';
    else if (!a || !b) comparison = 'source_invalid';
    else if (a.status === 'proposed' && b.status === 'confirmed') {
      comparison = JSON.stringify(referentTargetKeysV6(catalog, a.targets)) === JSON.stringify(referentTargetKeysV6(catalog, b.targets))
        ? 'same_binding' : 'target_disagreement';
    } else if (a.status === 'rejected' && b.status === 'rejected') comparison = 'same_rejection';
    else if (a.status === 'unresolved' && b.status === 'unresolved') comparison = 'same_unresolved';
    else comparison = 'status_disagreement';
    const nodes = (d: typeof a) => [...new Set(d?.targets.map(s => resolveReferentSelectionV3(catalog, s, true).nodeId) || [])].sort();
    return {id: t.id, mention: {...t.mention}, comparison,
      initial: a ? structuredClone(a) : null, review: b ? structuredClone(b) : null,
      initialLedger: structuredClone(al), reviewLedger: structuredClone(bl),
      // Same node does not mean the same group, subject, proposition, or study identity.
      sameTargetNodeSet: !!a?.targets.length && !!b?.targets.length && JSON.stringify(nodes(a)) === JSON.stringify(nodes(b)),
      needsResolution: ['status_disagreement','target_disagreement','source_invalid','same_unresolved'].includes(comparison),
      requiresSemanticAudit: comparison === 'same_binding', finalDecision: null};
  });
  return {revision: 'referent-comparison-v6', documentId: ctx.documentId, snapshotId: ctx.snapshotId, rows,
    resolutionQueue: rows.filter(r => r.needsResolution).map(r => r.id),
    allPositionsCompared: rows.length === inventory.tasks.length,
    sourceLedgerComplete: initial.allCandidatesHandled && review.allCandidatesHandled,
    agreementCertifiesIdentity: false, initialAutoFallback: false, reviewAutoOverridesInitial: false,
    modelAnswerRewritten: false, retrievalPolicyChanged: false, semanticCertified: false,
    productionAdmission: false, graphEdgesCreated: 0};
}
