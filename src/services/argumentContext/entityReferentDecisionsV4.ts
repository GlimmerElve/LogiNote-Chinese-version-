/** Fixed position ledger + v3 source validation. Not a local coreference model. */
import type {ReferentContext, ReferentIssue} from './entityReferentBindings.ts';
import type {EntityOccurrenceIndex} from './entityOccurrenceIndex.ts';
import type {ReferentSelectionV3, ReferentUnitCatalogV3} from './entityReferentUnitsV3.ts';
import {referenceBatchTasksV4, type ReferenceInventoryV4} from './entityReferentInventoryV4.ts';
import {validateReferentProposalsV3, validateReferentReviewV3, buildReviewedReferentIndexV3} from './entityReferentBindingsV3.ts';

export type ReferenceStageV4 = 'proposal' | 'review';
export interface ReferenceDecisionV4 {
  id: string; status: 'proposed' | 'confirmed' | 'unresolved' | 'rejected'; targets: ReferentSelectionV3[]; reason: string;
}
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
const fields = (v: any) => v && !Array.isArray(v) && Object.keys(v).sort().join('|') === 'id|reason|status|targets';
export function validateReferenceDecisionsV4(
  ctx: ReferentContext, catalog: ReferentUnitCatalogV3, inventory: ReferenceInventoryV4,
  stage: ReferenceStageV4, raw: unknown, taskIds?: string[],
) {
  check(stage === 'proposal' || stage === 'review', 'reference_stage');
  const tasks = referenceBatchTasksV4(ctx, catalog, inventory, taskIds);
  check(Array.isArray(raw) && raw.length <= 160, 'reference_decision_budget');
  const values = raw as any[], counts = new Map<string, number>();
  for (const d of values) if (typeof d?.id === 'string') counts.set(d.id, (counts.get(d.id) || 0) + 1);
  const byId = new Map(tasks.map(t => [t.id, t])), validWire: ReferenceDecisionV4[] = [], issues: ReferentIssue[] = [];
  for (const d of values) try {
    check(fields(d), 'decision_fields'); check(typeof d.id === 'string' && byId.has(d.id), 'unknown_reference_task');
    check(counts.get(d.id) === 1, 'duplicate_decision_id');
    check((stage === 'proposal' ? ['proposed', 'unresolved', 'rejected'] : ['confirmed', 'unresolved', 'rejected']).includes(d.status), 'reference_decision_status');
    validWire.push({id: d.id, status: d.status, targets: d.targets, reason: d.reason});
  } catch (e) {issues.push({id: typeof d?.id === 'string' ? d.id : '(invalid)', stage, reason: e instanceof Error ? e.message : 'invalid'});}
  // System placeholders carry no antecedent answers, including positions skipped by an earlier model output.
  const placeholders = validateReferentProposalsV3(ctx, catalog, tasks.map(t => ({id: t.id, mention: t.mention,
    targets: [], status: 'unresolved', reason: 'System position placeholder; not an initial model answer.'})));
  check(!placeholders.issues.length, 'reference_task_sources_changed');
  const sourceChecked = validateReferentReviewV3(ctx, catalog, placeholders, validWire.map(d => ({...d,
    mention: byId.get(d.id)!.mention, status: d.status === 'proposed' ? 'confirmed' : d.status})));
  issues.push(...sourceChecked.issues.map(i => ({...i, stage})));
  const acceptedIds = new Set(sourceChecked.reviewed.map(r => r.id));
  const decisions = validWire.filter(d => acceptedIds.has(d.id)).map(d => ({...d,
    targets: d.targets.map(t => ({...t})), mention: {...byId.get(d.id)!.mention}}));
  const ledger = tasks.map(t => {
    const d = decisions.find(d => d.id === t.id), errors = issues.filter(i => i.id === t.id).map(i => i.reason);
    return {id: t.id, mention: {...t.mention}, status: d?.status ?? (counts.has(t.id) ? 'invalid' : 'missing'),
      decisionPresent: counts.has(t.id), sourceValid: !!d, issues: errors};
  });
  return {revision: 'referent-decisions-v4', documentId: ctx.documentId, snapshotId: ctx.snapshotId, stage,
    taskIds: tasks.map(t => t.id), rawDecisions: structuredClone(values), decisions, ledger, issues,
    sourceChecked: {...sourceChecked, issues}, allCandidatesHandled: !issues.length && decisions.length === tasks.length,
    lexicalCoverageOnly: true, semanticCertified: false, truthCertified: false, productionAdmission: false, graphEdgesCreated: 0};
}
export type ReferenceDecisionsV4 = ReturnType<typeof validateReferenceDecisionsV4>;
export function buildReferenceIndexV4(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, inventory: ReferenceInventoryV4,
  literal: EntityOccurrenceIndex, result: ReferenceDecisionsV4) {
  check(result.stage === 'review', 'reference_independent_review_required');
  check(result.documentId === ctx.documentId && result.snapshotId === ctx.snapshotId, 'reference_result_snapshot');
  const checked = validateReferenceDecisionsV4(ctx, catalog, inventory, result.stage, result.rawDecisions, result.taskIds);
  check(JSON.stringify(checked) === JSON.stringify(result), 'reference_decisions_changed');
  const index = buildReviewedReferentIndexV3(ctx, catalog, literal, checked.sourceChecked);
  return {...index, revision: 'reviewed-referent-index-v4', batchLedgerComplete: checked.allCandidatesHandled,
    positionLedgerComplete: checked.allCandidatesHandled && checked.taskIds.length === inventory.tasks.length,
    positionCoverageIsNotSemanticCoverage: true, diagnosticOnly: true, productionAdmission: false};
}
