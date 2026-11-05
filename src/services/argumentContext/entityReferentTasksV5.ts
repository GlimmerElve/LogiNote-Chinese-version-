/** Finite lexical exclusions only. No local antecedent or entity identity inference. */
import type {ReferentContext} from './entityReferentBindings.ts';
import {assertReferenceInventoryV4, type ReferenceInventoryV4} from './entityReferentInventoryV4.ts';
import {resolveReferentSelectionV3, type ReferentUnitCatalogV3} from './entityReferentUnitsV3.ts';
import {validateReferenceDecisionsV4, buildReferenceIndexV4, type ReferenceStageV4} from './entityReferentDecisionsV4.ts';
import type {EntityOccurrenceIndex} from './entityOccurrenceIndex.ts';

const WORD_INTERNAL = ['其他', '之前', '之后', '之间', '此外', '其次', '那么'] as const;
const check = (ok: unknown, msg: string) => {if (!ok) throw new Error(msg);};
export function buildReferenceTaskPlanV5(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, inventory: ReferenceInventoryV4) {
  assertReferenceInventoryV4(ctx, catalog, inventory);
  const positions = inventory.tasks.map(t => {
    const u = catalog.units.find(u => u.id === t.mention.unitId)!;
    let at = -1; for (let i = 0; i < t.mention.occurrence; i++) at = u.text.indexOf(t.mention.phrase!, at + 1);
    check(at >= 0, 'reference_task_location');
    const word = WORD_INTERNAL.flatMap(token => {
      const hits: Array<{token: string; occurrence: number; start: number}> = [];
      let occurrence = 0;
      for (let p = u.text.indexOf(token); p >= 0; p = u.text.indexOf(token, p + 1)) {
        occurrence++;
        if (p <= at && at + t.mention.phrase!.length <= p + token.length && t.mention.phrase!.length < token.length)
          hits.push({token, occurrence, start: p});
      }
      return hits;
    })[0];
    return {id: t.id, mention: {...t.mention},
      disposition: word ? 'local_word_internal' as const : 'model_judgment' as const,
      lexicalEvidence: word ? {token: word.token, location: resolveReferentSelectionV3(catalog,
        {unitId: u.id, phrase: word.token, occurrence: word.occurrence})} : null,
      mentionContext: {before: u.text.slice(Math.max(0, at - 20), at), selected: t.mention.phrase!,
        after: u.text.slice(at + t.mention.phrase!.length, at + t.mention.phrase!.length + 28)}};
  });
  return {revision: 'referent-task-plan-v5', documentId: ctx.documentId, snapshotId: ctx.snapshotId,
    positions, modelTaskIds: positions.filter(t => t.disposition === 'model_judgment').map(t => t.id),
    localDecisions: positions.filter(t => t.disposition === 'local_word_internal').map(t => ({id: t.id,
      status: 'rejected' as const, targets: [], reason: `本地有限词形规则：${t.mention.phrase}是“${t.lexicalEvidence!.token}”内部片段，不是独立指代位置。`})),
    semanticCertified: false, productionAdmission: false, graphEdgesCreated: 0};
}
export type ReferenceTaskPlanV5 = ReturnType<typeof buildReferenceTaskPlanV5>;
export function assertReferenceTaskPlanV5(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  inventory: ReferenceInventoryV4, plan: ReferenceTaskPlanV5) {
  check(JSON.stringify(plan) === JSON.stringify(buildReferenceTaskPlanV5(ctx, catalog, inventory)), 'reference_task_plan_changed');
}
export function validateReferenceDecisionsV5(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  inventory: ReferenceInventoryV4, plan: ReferenceTaskPlanV5, stage: ReferenceStageV4, raw: unknown) {
  assertReferenceTaskPlanV5(ctx, catalog, inventory, plan);
  const model = validateReferenceDecisionsV4(ctx, catalog, inventory, stage, raw, plan.modelTaskIds);
  const reserved = new Set(plan.localDecisions.map(d => d.id));
  // Model attempts to overwrite local exclusions remain issues in model.rawDecisions/ledger.
  const combined = validateReferenceDecisionsV4(ctx, catalog, inventory, stage,
    [...model.rawDecisions.filter((d: any) => !reserved.has(d?.id)), ...plan.localDecisions]);
  return {revision: 'referent-decisions-v5', documentId: ctx.documentId, snapshotId: ctx.snapshotId, stage,
    rawModelDecisions: structuredClone(raw), model, combined,
    provenance: combined.decisions.map(d => ({id: d.id, origin: reserved.has(d.id) ? 'local_word_internal_rule' : 'model_response'})),
    allCandidatesHandled: model.allCandidatesHandled && combined.allCandidatesHandled,
    semanticCertified: false, productionAdmission: false, graphEdgesCreated: 0};
}
export type ReferenceDecisionsV5 = ReturnType<typeof validateReferenceDecisionsV5>;
export function buildReferenceIndexV5(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  inventory: ReferenceInventoryV4, plan: ReferenceTaskPlanV5, literal: EntityOccurrenceIndex, result: ReferenceDecisionsV5) {
  check(result.stage === 'review', 'reference_independent_review_required');
  const checked = validateReferenceDecisionsV5(ctx, catalog, inventory, plan, result.stage, result.rawModelDecisions);
  check(JSON.stringify(checked) === JSON.stringify(result), 'reference_decisions_changed');
  const index = buildReferenceIndexV4(ctx, catalog, inventory, literal, checked.combined);
  return {...index, revision: 'reviewed-referent-index-v5', batchLedgerComplete: checked.allCandidatesHandled,
    positionLedgerComplete: checked.allCandidatesHandled, decisionProvenance: checked.provenance,
    localExcludedPositions: plan.localDecisions.length, diagnosticOnly: true, semanticCertified: false, productionAdmission: false};
}
