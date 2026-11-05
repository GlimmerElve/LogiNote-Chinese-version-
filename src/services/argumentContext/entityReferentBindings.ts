/** Source-anchored model decisions. Local validation does not resolve or certify coreference. */
import type {EntityIndexNode, EntityIndexWindow, EntityOccurrenceIndex} from './entityOccurrenceIndex.ts';

export interface ReferentAnchor {window: string; quote: string}
export interface ReferentTarget extends ReferentAnchor {nodeId: string}
export interface ReferentProposal {
  id: string; nodeId: string; mention: ReferentAnchor; targets: ReferentTarget[];
  status: 'proposed' | 'unresolved'; reason: string;
}
export interface ReferentDecision {
  id: string; status: 'confirmed' | 'unresolved' | 'rejected'; targets: ReferentTarget[]; reason: string;
}
export interface ReferentContext {
  documentId: string; snapshotId: string; windows: EntityIndexWindow[]; nodes: EntityIndexNode[];
}
interface LocatedAnchor extends ReferentTarget {start: number; end: number}
export interface ValidReferentProposal extends ReferentProposal {
  mentionLocation: LocatedAnchor; targetLocations: LocatedAnchor[];
}
export interface ReviewedReferent extends Omit<ValidReferentProposal, 'status'> {
  status: ReferentDecision['status']; initialStatus: ReferentProposal['status'];
  initialTargets: ReferentTarget[];
}
export interface ReferentIssue {id: string; stage: 'proposal' | 'review'; reason: string}
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
const exact = (value: any, fields: string[]) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.sort().join('|'), 'fields');
const text = (value: unknown, max: number) => check(typeof value === 'string' && value.trim() && value.length <= max, 'text');
const key = (a: ReferentTarget) => JSON.stringify([a.nodeId, a.window, a.quote]);

function contextMaps(ctx: ReferentContext) {
  text(ctx.documentId, 300); text(ctx.snapshotId, 300);
  const windows = new Map(ctx.windows.map(w => [w.id, w])), nodes = new Map(ctx.nodes.map(n => [n.id, n]));
  check(windows.size === ctx.windows.length && nodes.size === ctx.nodes.length, 'duplicate_context_id');
  return {windows, nodes};
}
/** Locate only within the named node's original source; ambiguous occurrences stay out. */
function locate(ctx: ReferentContext, anchor: ReferentTarget): LocatedAnchor {
  const {windows, nodes} = contextMaps(ctx), n = nodes.get(anchor.nodeId), w = windows.get(anchor.window);
  text(anchor.quote, 240); check(n && w, 'anchor_identity');
  const hits = new Map<string, LocatedAnchor>();
  for (const s of n!.source.filter(s => s.window === anchor.window)) {
    const base = w!.text.indexOf(s.quote);
    check(base >= 0 && w!.text.indexOf(s.quote, base + 1) < 0, 'node_source_not_unique');
    for (let at = s.quote.indexOf(anchor.quote); at >= 0; at = s.quote.indexOf(anchor.quote, at + 1)) {
      const start = base + at, end = start + anchor.quote.length;
      hits.set(start + ':' + end, {...anchor, start, end});
    }
  }
  check(hits.size === 1, hits.size ? 'mention_not_unique' : 'anchor_not_in_node');
  return [...hits.values()][0];
}
function targets(ctx: ReferentContext, values: any, mention: LocatedAnchor, populated: boolean) {
  check(Array.isArray(values) && values.length <= 12 && (populated ? values.length > 0 : values.length === 0), 'targets_count');
  const seen = new Set<string>();
  return (values as ReferentTarget[]).map(t => {
    exact(t, ['nodeId', 'window', 'quote']); text(t.nodeId, 300); text(t.window, 300);
    check(!seen.has(key(t)), 'duplicate_target'); seen.add(key(t));
    const p = locate(ctx, t);
    check(p.window !== mention.window || p.end <= mention.start || p.start >= mention.end, 'target_overlaps_mention');
    return p;
  });
}
export function validateReferentProposals(ctx: ReferentContext, raw: unknown[]) {
  contextMaps(ctx); check(Array.isArray(raw) && raw.length <= 160, 'proposal_budget');
  const accepted: ValidReferentProposal[] = [], issues: ReferentIssue[] = [];
  const counts = new Map<string, number>();
  for (const p of raw as any[]) if (typeof p?.id === 'string') counts.set(p.id, (counts.get(p.id) || 0) + 1);
  for (const p of raw as any[]) {
    try {
      exact(p, ['id', 'nodeId', 'mention', 'targets', 'status', 'reason']);
      text(p.id, 80); text(p.nodeId, 300); text(p.reason, 600);
      check(counts.get(p.id) === 1, 'duplicate_reference_id');
      exact(p.mention, ['window', 'quote']); text(p.mention.window, 300);
      check(['proposed', 'unresolved'].includes(p.status), 'proposal_status');
      const mention = locate(ctx, {nodeId: p.nodeId, ...p.mention});
      const selected = targets(ctx, p.targets, mention, p.status === 'proposed');
      accepted.push({...p, mention: {...p.mention}, targets: p.targets.map((t: any) => ({...t})), mentionLocation: mention, targetLocations: selected});
    } catch (e) {issues.push({id: typeof p?.id === 'string' ? p.id : '(invalid)', stage: 'proposal', reason: (e as Error).message});}
  }
  return {revision: 'referent-proposals-v1', documentId: ctx.documentId, snapshotId: ctx.snapshotId, accepted, issues,
    semanticCertified: false, usableForRetrieval: false, graphEdgesCreated: 0};
}
export function validateReferentReview(ctx: ReferentContext, initial: ReturnType<typeof validateReferentProposals>, raw: unknown[]) {
  contextMaps(ctx); check(initial.documentId === ctx.documentId && initial.snapshotId === ctx.snapshotId, 'snapshot_mismatch');
  check(Array.isArray(raw) && raw.length <= 160, 'review_budget');
  // Revalidate sources even if a caller accidentally reuses a version key with changed text.
  const original = initial.accepted.map(({id, nodeId, mention, targets, status, reason}) => ({id, nodeId, mention, targets, status, reason}));
  const checked = validateReferentProposals(ctx, original);
  check(!checked.issues.length, 'initial_sources_changed');
  const byId = new Map(checked.accepted.map(p => [p.id, p]));
  const counts = new Map<string, number>();
  for (const d of raw as any[]) if (typeof d?.id === 'string') counts.set(d.id, (counts.get(d.id) || 0) + 1);
  const reviewed: ReviewedReferent[] = [], issues: ReferentIssue[] = [];
  for (const d of raw as any[]) {
    try {
      exact(d, ['id', 'status', 'targets', 'reason']); text(d.id, 80); text(d.reason, 600);
      check(counts.get(d.id) === 1, 'duplicate_decision_id');
      const p = byId.get(d.id); check(p, 'unknown_reference_id');
      check(['confirmed', 'unresolved', 'rejected'].includes(d.status), 'review_status');
      const selected = targets(ctx, d.targets, p!.mentionLocation, d.status === 'confirmed');
      reviewed.push({...p!, status: d.status, reason: d.reason, targets: d.targets.map((t: any) => ({...t})), targetLocations: selected,
        initialStatus: p!.status, initialTargets: p!.targets.map(t => ({...t}))});
    } catch (e) {issues.push({id: typeof d?.id === 'string' ? d.id : '(invalid)', stage: 'review', reason: (e as Error).message});}
  }
  for (const p of checked.accepted) if (!counts.has(p.id)) issues.push({id: p.id, stage: 'review', reason: 'missing_decision'});
  return {revision: 'reviewed-referents-v1', documentId: ctx.documentId, snapshotId: ctx.snapshotId, reviewed, issues,
    semanticCertified: false, truthCertified: false, graphEdgesCreated: 0, productionAdmission: false};
}
/** Project direct, reviewed references. Never inherit all entities in an antecedent node. */
export function buildReviewedReferentIndex(ctx: ReferentContext, literal: EntityOccurrenceIndex, review: ReturnType<typeof validateReferentReview>) {
  check(literal.documentId === ctx.documentId && review.documentId === ctx.documentId && review.snapshotId === ctx.snapshotId, 'index_identity');
  const {windows, nodes} = contextMaps(ctx);
  const projected = review.reviewed.map(r => {
    check(nodes.has(r.nodeId), 'review_node_changed');
    const mention = locate(ctx, {nodeId: r.nodeId, ...r.mention});
    check(mention.start === r.mentionLocation.start && mention.end === r.mentionLocation.end, 'review_source_changed');
    const selected = targets(ctx, r.targets, mention, r.status === 'confirmed');
    const entityIds = r.status === 'confirmed' ? [...new Set(selected.flatMap(t => literal.occurrences.filter(o => {
      // Entire target phrase must be the recorded entity occurrence, not a containing paragraph.
      check(windows.get(o.window)?.text.slice(o.start, o.end) === o.quote, 'literal_index_source_changed');
      return o.documentId === ctx.documentId && o.window === t.window && o.start === t.start && o.end === t.end;
    }).map(o => o.entityId)))] : [];
    return {id: r.id, nodeId: r.nodeId, mention, status: r.status, targets: selected, entityIds,
      basis: 'model_reviewed_source_anchored_reference', entityProjection: entityIds.length ? 'direct_literal_antecedent' : 'no_entity_inheritance',
      semanticCertified: false};
  });
  const choices = new Map<string, Set<string>>();
  for (const b of projected.filter(b => b.status === 'confirmed')) {
    const at = JSON.stringify([b.nodeId, b.mention.window, b.mention.start, b.mention.end]);
    if (!choices.has(at)) choices.set(at, new Set());
    choices.get(at)!.add(b.targets.map(t => JSON.stringify([t.nodeId, t.window, t.start, t.end])).sort().join('|'));
  }
  const conflicts: ReferentIssue[] = [];
  const bindings = projected.map(b => {
    const at = JSON.stringify([b.nodeId, b.mention.window, b.mention.start, b.mention.end]);
    const conflicting = (choices.get(at)?.size ?? 0) > 1;
    if (conflicting) conflicts.push({id: b.id, stage: 'review', reason: 'conflicting_confirmed_targets'});
    return {...b, usableForRetrieval: b.status === 'confirmed' && !conflicting};
  });
  return {revision: 'reviewed-referent-index-v1', documentId: ctx.documentId, snapshotId: ctx.snapshotId, bindings,
    issues: [...review.issues, ...conflicts], recursiveInheritance: false, literalOccurrencesModified: false, graphEdgesCreated: 0, productionAdmission: false};
}
export type ReviewedReferentIndex = ReturnType<typeof buildReviewedReferentIndex>;

/** Query-time lookup uses a supplied context node; a bare pronoun is never guessed globally. */
export function lookupReviewedReferents(index: ReviewedReferentIndex, input: {
  question: string; contextNodeId?: string; allowedNodeIds: Set<string>; allowedContextNodeIds?: Set<string>;
}) {
  const empty = (status: string) => ({status, bindingIds: [] as string[], nodeIds: [] as string[], entityIds: [] as string[], semanticCertified: false});
  if (!input.contextNodeId) return empty('context_required');
  if (!(input.allowedContextNodeIds ?? input.allowedNodeIds).has(input.contextNodeId)) return empty('context_outside_boundary');
  const candidates = index.bindings.filter(b => b.nodeId === input.contextNodeId && b.usableForRetrieval);
  const explicit = candidates.filter(b => input.question.includes(b.mention.quote));
  const genericPronoun = /它|他们|她们|该(?:结果|实验|研究)|这个(?:结果|实验)|这种(?:情况|现象)/u.test(input.question);
  const selected = explicit.length ? explicit : genericPronoun && candidates.length === 1 ? candidates : [];
  if (!selected.length) return empty(candidates.length > 1 && genericPronoun ? 'ambiguous_context' : 'no_matching_reviewed_reference');
  if (selected.some(b => b.targets.some(t => !input.allowedNodeIds.has(t.nodeId)))) return empty('antecedent_outside_boundary');
  // Two identical phrases with different objects remain ambiguous, not a global alias merge.
  const phraseTargets = new Map<string, Set<string>>();
  for (const b of selected) {
    if (!phraseTargets.has(b.mention.quote)) phraseTargets.set(b.mention.quote, new Set());
    phraseTargets.get(b.mention.quote)!.add([...new Set(b.targets.map(t => t.nodeId))].sort().join('|'));
  }
  if ([...phraseTargets.values()].some(v => v.size > 1)) return empty('ambiguous_context');
  return {status: 'model_reviewed_binding_used', bindingIds: selected.map(b => b.id),
    nodeIds: [...new Set(selected.flatMap(b => b.targets.map(t => t.nodeId)))],
    entityIds: [...new Set(selected.flatMap(b => b.entityIds))], semanticCertified: false};
}
