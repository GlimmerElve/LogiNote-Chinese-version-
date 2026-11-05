/** v3 selectors remove context copying; semantic decisions still belong to the model. */
import type {ReferentContext, ReferentIssue} from './entityReferentBindings.ts';
import type {EntityOccurrenceIndex} from './entityOccurrenceIndex.ts';
import {assertReferentUnitCatalogV3, resolveReferentSelectionV3, type ReferentUnitCatalogV3, type ReferentSelectionV3, type LocatedReferentV3} from './entityReferentUnitsV3.ts';
export interface ReferentProposalV3 {id: string; mention: ReferentSelectionV3; targets: ReferentSelectionV3[]; status: 'proposed' | 'unresolved'; reason: string}
export interface ReferentDecisionV3 extends Omit<ReferentProposalV3, 'status'> {status: 'confirmed' | 'unresolved' | 'rejected'}
interface ValidProposalV3 extends ReferentProposalV3 {nodeId: string; mentionLocation: LocatedReferentV3; targetLocations: LocatedReferentV3[]}
interface ReviewedV3 extends Omit<ValidProposalV3, 'status'> {
  status: ReferentDecisionV3['status']; initialMention: ReferentSelectionV3; initialTargets: ReferentSelectionV3[]; mentionChanged: boolean; targetsChanged: boolean;
}
const check = (ok: unknown, msg: string) => {if (!ok) throw new Error(msg);};
const exact = (v: any, fields: string[]) => check(v && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...fields].sort().join('|'), 'fields');
const locationKey = (a: LocatedReferentV3) => JSON.stringify([a.nodeId, a.window, a.start, a.end]);
const targetKey = (as: LocatedReferentV3[]) => as.map(locationKey).sort().join('|');
const overlap = (a: LocatedReferentV3, b: LocatedReferentV3) => a.window === b.window && a.start < b.end && b.start < a.end;
const counts = (raw: any[]) => {const m = new Map<string, number>(); for (const p of raw) if (typeof p?.id === 'string') m.set(p.id, (m.get(p.id) || 0) + 1); return m;};
function base(p: any) {
  exact(p, ['id', 'mention', 'targets', 'status', 'reason']);
  check(typeof p.id === 'string' && p.id.trim() && p.id.length <= 80, 'reference_id');
  check(typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= 600, 'reason');
}
function targets(c: ReferentUnitCatalogV3, raw: any, mention: LocatedReferentV3, populated: boolean): LocatedReferentV3[] {
  check(Array.isArray(raw) && raw.length <= 12 && (populated ? raw.length > 0 : raw.length === 0), 'targets_count');
  const seen = new Set<string>();
  return raw.map(s => {
    const p = resolveReferentSelectionV3(c, s, true), k = locationKey(p);
    check(!overlap(p, mention), 'target_overlaps_mention'); check(!seen.has(k), 'duplicate_target'); seen.add(k); return p;
  });
}
const issue = (p: any, stage: ReferentIssue['stage'], e: unknown): ReferentIssue =>
  ({id: typeof p?.id === 'string' ? p.id : '(invalid)', stage, reason: e instanceof Error ? e.message : 'invalid'});
export function validateReferentProposalsV3(ctx: ReferentContext, c: ReferentUnitCatalogV3, raw: unknown[]) {
  assertReferentUnitCatalogV3(ctx, c); check(Array.isArray(raw) && raw.length <= 160, 'proposal_budget');
  const ids = counts(raw), accepted: ValidProposalV3[] = [], issues: ReferentIssue[] = [];
  for (const p of raw as any[]) try {
    base(p); check(ids.get(p.id) === 1, 'duplicate_reference_id'); check(['proposed', 'unresolved'].includes(p.status), 'proposal_status');
    const mentionLocation = resolveReferentSelectionV3(c, p.mention), targetLocations = targets(c, p.targets, mentionLocation, p.status === 'proposed');
    accepted.push({...p, mention: {...p.mention}, targets: p.targets.map((s: any) => ({...s})), nodeId: mentionLocation.nodeId, mentionLocation, targetLocations});
  } catch (e) {issues.push(issue(p, 'proposal', e));}
  return {revision: 'referent-proposals-v3', documentId: ctx.documentId, snapshotId: ctx.snapshotId, accepted, issues,
    usableForRetrieval: false, semanticCertified: false, graphEdgesCreated: 0};
}
export type ReferentProposalsV3 = ReturnType<typeof validateReferentProposalsV3>;
export function validateReferentReviewV3(ctx: ReferentContext, c: ReferentUnitCatalogV3, initial: ReferentProposalsV3, raw: unknown[]) {
  assertReferentUnitCatalogV3(ctx, c);
  check(initial.documentId === ctx.documentId && initial.snapshotId === ctx.snapshotId, 'snapshot_mismatch');
  check(Array.isArray(raw) && raw.length <= 160, 'review_budget');
  const checked = validateReferentProposalsV3(ctx, c, initial.accepted.map(({id, mention, targets, status, reason}) => ({id, mention, targets, status, reason})));
  check(!checked.issues.length, 'initial_sources_changed');
  for (const p of checked.accepted) {
    const old = initial.accepted.find(v => v.id === p.id)!;
    check(JSON.stringify([p.mentionLocation, p.targetLocations]) === JSON.stringify([old.mentionLocation, old.targetLocations]), 'initial_coordinates_changed');
  }
  const byId = new Map(checked.accepted.map(p => [p.id, p])), ids = counts(raw), reviewed: ReviewedV3[] = [], issues: ReferentIssue[] = [];
  for (const d of raw as any[]) try {
    base(d); check(ids.get(d.id) === 1, 'duplicate_decision_id'); const p = byId.get(d.id); check(p, 'unknown_reference_id');
    check(['confirmed', 'unresolved', 'rejected'].includes(d.status), 'review_status');
    const mentionLocation = resolveReferentSelectionV3(c, d.mention);
    check(mentionLocation.unitId === p!.mentionLocation.unitId && overlap(mentionLocation, p!.mentionLocation), 'review_mention_moved');
    const targetLocations = targets(c, d.targets, mentionLocation, d.status === 'confirmed');
    reviewed.push({...p!, mention: {...d.mention}, targets: d.targets.map((s: any) => ({...s})), status: d.status, reason: d.reason,
      mentionLocation, targetLocations, initialMention: {...p!.mention}, initialTargets: p!.targets.map(s => ({...s})),
      mentionChanged: locationKey(mentionLocation) !== locationKey(p!.mentionLocation), targetsChanged: targetKey(targetLocations) !== targetKey(p!.targetLocations)});
  } catch (e) {issues.push(issue(d, 'review', e));}
  for (const p of checked.accepted) if (!ids.has(p.id)) issues.push({id: p.id, stage: 'review', reason: 'missing_decision'});
  return {revision: 'reviewed-referents-v3', documentId: ctx.documentId, snapshotId: ctx.snapshotId, reviewed, issues,
    semanticCertified: false, truthCertified: false, graphEdgesCreated: 0, productionAdmission: false};
}
export type ReferentReviewV3 = ReturnType<typeof validateReferentReviewV3>;
export function buildReviewedReferentIndexV3(ctx: ReferentContext, c: ReferentUnitCatalogV3, literal: EntityOccurrenceIndex, review: ReferentReviewV3) {
  assertReferentUnitCatalogV3(ctx, c);
  check(literal.documentId === ctx.documentId && review.documentId === ctx.documentId && review.snapshotId === ctx.snapshotId, 'index_identity');
  const windows = new Map(ctx.windows.map(w => [w.id, w]));
  for (const o of literal.occurrences) check(windows.get(o.window)?.text.slice(o.start, o.end) === o.quote, 'literal_index_source_changed');
  const bindings = review.reviewed.map(r => {
    check(['confirmed', 'unresolved', 'rejected'].includes(r.status), 'review_status');
    const mention = resolveReferentSelectionV3(c, r.mention), selected = targets(c, r.targets, mention, r.status === 'confirmed');
    check(JSON.stringify([mention, selected]) === JSON.stringify([r.mentionLocation, r.targetLocations]), 'review_source_changed');
    const entityIds = r.status === 'confirmed' ? [...new Set(selected.flatMap(t => literal.occurrences.filter(o =>
      o.documentId === ctx.documentId && o.window === t.window && o.start === t.start && o.end === t.end).map(o => o.entityId)))] : [];
    return {id: r.id, nodeId: r.nodeId, mention, status: r.status, targets: selected, entityIds,
      basis: 'independent_model_review_unit_selected_reference', entityProjection: entityIds.length ? 'direct_literal_antecedent' : 'no_entity_inheritance',
      semanticCertified: false, usableForRetrieval: r.status === 'confirmed',
      correction: {initialMention: r.initialMention, initialTargets: r.initialTargets, mentionChanged: r.mentionChanged, targetsChanged: r.targetsChanged}};
  });
  const choices = new Map<string, Set<string>>();
  for (const b of bindings.filter(b => b.usableForRetrieval)) {const k = locationKey(b.mention); if (!choices.has(k)) choices.set(k, new Set()); choices.get(k)!.add(targetKey(b.targets));}
  const issues = [...review.issues];
  for (const b of bindings) if ((choices.get(locationKey(b.mention))?.size || 0) > 1) {b.usableForRetrieval = false; issues.push({id: b.id, stage: 'review', reason: 'conflicting_confirmed_targets'});}
  return {revision: 'reviewed-referent-index-v3', documentId: ctx.documentId, snapshotId: ctx.snapshotId, bindings, issues,
    recursiveInheritance: false, literalOccurrencesModified: false, graphEdgesCreated: 0, productionAdmission: false};
}
