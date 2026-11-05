/** Opt-in v2. Context locates a short mention; it is never substituted for that mention. */
import type {EntityOccurrenceIndex} from './entityOccurrenceIndex.ts';
import type {ReferentContext, ReferentIssue, ReviewedReferentIndex} from './entityReferentBindings.ts';

export interface ReferentLocator {window: string; quote: string; contextQuote: string}
export interface ReferentTargetV2 extends ReferentLocator {nodeId: string}
export interface ReferentProposalV2 {
  id: string; nodeId: string; mention: ReferentLocator; targets: ReferentTargetV2[];
  status: 'proposed' | 'unresolved'; reason: string;
}
export interface ReferentDecisionV2 {
  id: string; mention: ReferentLocator; targets: ReferentTargetV2[];
  status: 'confirmed' | 'unresolved' | 'rejected'; reason: string;
}
export interface LocatedReferentV2 extends ReferentTargetV2 {start: number; end: number; contextStart: number; contextEnd: number}
export interface ValidReferentProposalV2 extends ReferentProposalV2 {
  mentionLocation: LocatedReferentV2; targetLocations: LocatedReferentV2[];
}
export interface ReviewedReferentV2 extends Omit<ValidReferentProposalV2, 'status'> {
  status: ReferentDecisionV2['status']; initialMention: ReferentLocator;
  initialTargets: ReferentTargetV2[]; mentionChanged: boolean; targetsChanged: boolean;
}
const check = (ok: unknown, message: string) => {if (!ok) throw new Error(message);};
const exact = (value: any, fields: string[]) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...fields].sort().join('|'), 'fields');
const text = (value: unknown, max: number) => check(typeof value === 'string' && value.trim() && value.length <= max, 'text');
const locationKey = (a: {nodeId: string; window: string; start: number; end: number}) => JSON.stringify([a.nodeId, a.window, a.start, a.end]);
const targetKey = (as: Array<{nodeId: string; window: string; start: number; end: number}>) => as.map(locationKey).sort().join('|');
const overlap = (a: LocatedReferentV2, b: LocatedReferentV2) => a.window === b.window && a.start < b.end && b.start < a.end;
function contextMaps(ctx: ReferentContext) {
  text(ctx.documentId, 300); text(ctx.snapshotId, 300);
  const windows = new Map(ctx.windows.map(w => [w.id, w])), nodes = new Map(ctx.nodes.map(n => [n.id, n]));
  check(windows.size === ctx.windows.length && nodes.size === ctx.nodes.length, 'duplicate_context_id');
  return {windows, nodes};
}

/** No fuzzy matching or first-occurrence fallback. All offsets are restored locally. */
export function locateReferentV2(ctx: ReferentContext, a: ReferentTargetV2): LocatedReferentV2 {
  exact(a, ['nodeId', 'window', 'quote', 'contextQuote']);
  text(a.nodeId, 300); text(a.window, 300); text(a.quote, 240); text(a.contextQuote, 800);
  const {windows, nodes} = contextMaps(ctx), n = nodes.get(a.nodeId), w = windows.get(a.window);
  check(n && w, 'anchor_identity');
  const contextStart = w!.text.indexOf(a.contextQuote);
  check(contextStart >= 0, 'context_not_in_window');
  check(w!.text.indexOf(a.contextQuote, contextStart + 1) < 0, 'context_not_unique');
  const relative = a.contextQuote.indexOf(a.quote);
  check(relative >= 0, 'quote_not_in_context');
  check(a.contextQuote.indexOf(a.quote, relative + 1) < 0, 'quote_not_unique_in_context');
  const contextEnd = contextStart + a.contextQuote.length;
  const withinSource = n!.source.filter(s => s.window === a.window).some(s => {
    const base = w!.text.indexOf(s.quote);
    check(base >= 0 && w!.text.indexOf(s.quote, base + 1) < 0, 'node_source_not_unique');
    return contextStart >= base && contextEnd <= base + s.quote.length;
  });
  check(withinSource, 'context_not_in_node');
  const start = contextStart + relative;
  return {...a, start, end: start + a.quote.length, contextStart, contextEnd};
}
function locateTargets(ctx: ReferentContext, values: any, mention: LocatedReferentV2, populated: boolean) {
  check(Array.isArray(values) && values.length <= 12 && (populated ? values.length > 0 : values.length === 0), 'targets_count');
  const seen = new Set<string>();
  return (values as ReferentTargetV2[]).map(t => {
    const p = locateReferentV2(ctx, t), k = locationKey(p);
    check(!seen.has(k), 'duplicate_target'); seen.add(k);
    check(!overlap(mention, p), 'target_overlaps_mention');
    return p;
  });
}
const counts = (raw: any[]) => {
  const out = new Map<string, number>();
  for (const p of raw) if (typeof p?.id === 'string') out.set(p.id, (out.get(p.id) || 0) + 1);
  return out;
};
const issue = (p: any, stage: ReferentIssue['stage'], e: unknown): ReferentIssue =>
  ({id: typeof p?.id === 'string' ? p.id : '(invalid)', stage, reason: e instanceof Error ? e.message : 'invalid'});
export function validateReferentProposalsV2(ctx: ReferentContext, raw: unknown[]) {
  contextMaps(ctx); check(Array.isArray(raw) && raw.length <= 160, 'proposal_budget');
  const ids = counts(raw), accepted: ValidReferentProposalV2[] = [], issues: ReferentIssue[] = [];
  for (const p of raw as any[]) {
    try {
      exact(p, ['id', 'nodeId', 'mention', 'targets', 'status', 'reason']);
      text(p.id, 80); text(p.nodeId, 300); text(p.reason, 600);
      check(ids.get(p.id) === 1, 'duplicate_reference_id');
      exact(p.mention, ['window', 'quote', 'contextQuote']);
      check(['proposed', 'unresolved'].includes(p.status), 'proposal_status');
      const mentionLocation = locateReferentV2(ctx, {...p.mention, nodeId: p.nodeId});
      const targetLocations = locateTargets(ctx, p.targets, mentionLocation, p.status === 'proposed');
      accepted.push({...p, mention: {...p.mention}, targets: p.targets.map((t: any) => ({...t})), mentionLocation, targetLocations});
    } catch (e) {issues.push(issue(p, 'proposal', e));}
  }
  return {revision: 'referent-proposals-v2', documentId: ctx.documentId, snapshotId: ctx.snapshotId, accepted, issues,
    semanticCertified: false, usableForRetrieval: false, graphEdgesCreated: 0};
}
export type ReferentProposalsV2 = ReturnType<typeof validateReferentProposalsV2>;
export function validateReferentReviewV2(ctx: ReferentContext, initial: ReferentProposalsV2, raw: unknown[]) {
  check(initial.documentId === ctx.documentId && initial.snapshotId === ctx.snapshotId, 'snapshot_mismatch');
  check(Array.isArray(raw) && raw.length <= 160, 'review_budget');
  const checked = validateReferentProposalsV2(ctx, initial.accepted.map(({id, nodeId, mention, targets, status, reason}) =>
    ({id, nodeId, mention, targets, status, reason})));
  check(!checked.issues.length, 'initial_sources_changed');
  for (const p of checked.accepted) {
    const prior = initial.accepted.find(v => v.id === p.id)!;
    check(JSON.stringify([p.mentionLocation, p.targetLocations]) === JSON.stringify([prior.mentionLocation, prior.targetLocations]), 'initial_coordinates_changed');
  }
  const byId = new Map(checked.accepted.map(p => [p.id, p])), ids = counts(raw);
  const reviewed: ReviewedReferentV2[] = [], issues: ReferentIssue[] = [];
  for (const d of raw as any[]) {
    try {
      exact(d, ['id', 'mention', 'status', 'targets', 'reason']); text(d.id, 80); text(d.reason, 600);
      check(ids.get(d.id) === 1, 'duplicate_decision_id');
      const p = byId.get(d.id); check(p, 'unknown_reference_id');
      check(['confirmed', 'unresolved', 'rejected'].includes(d.status), 'review_status');
      exact(d.mention, ['window', 'quote', 'contextQuote']);
      const mentionLocation = locateReferentV2(ctx, {...d.mention, nodeId: p!.nodeId});
      // Refine the same occurrence, not a different pronoun elsewhere in the node.
      check(overlap(mentionLocation, p!.mentionLocation)
        && mentionLocation.start >= p!.mentionLocation.contextStart && mentionLocation.end <= p!.mentionLocation.contextEnd, 'review_mention_moved');
      const targetLocations = locateTargets(ctx, d.targets, mentionLocation, d.status === 'confirmed');
      reviewed.push({...p!, mention: {...d.mention}, mentionLocation, status: d.status, reason: d.reason,
        targets: d.targets.map((t: any) => ({...t})), targetLocations,
        initialMention: {...p!.mention}, initialTargets: p!.targets.map(t => ({...t})),
        mentionChanged: locationKey(mentionLocation) !== locationKey(p!.mentionLocation),
        targetsChanged: targetKey(targetLocations) !== targetKey(p!.targetLocations)});
    } catch (e) {issues.push(issue(d, 'review', e));}
  }
  for (const p of checked.accepted) if (!ids.has(p.id)) issues.push({id: p.id, stage: 'review', reason: 'missing_decision'});
  return {revision: 'reviewed-referents-v2', documentId: ctx.documentId, snapshotId: ctx.snapshotId, reviewed, issues,
    semanticCertified: false, truthCertified: false, graphEdgesCreated: 0, productionAdmission: false};
}
export type ReferentReviewV2 = ReturnType<typeof validateReferentReviewV2>;

/** Same lookup shape as v1, with exact short-mention coordinates and a correction trace. */
export function buildReviewedReferentIndexV2(ctx: ReferentContext, literal: EntityOccurrenceIndex, review: ReferentReviewV2) {
  check(literal.documentId === ctx.documentId && review.documentId === ctx.documentId && review.snapshotId === ctx.snapshotId, 'index_identity');
  const {windows} = contextMaps(ctx);
  for (const o of literal.occurrences) check(windows.get(o.window)?.text.slice(o.start, o.end) === o.quote, 'literal_index_source_changed');
  const bindings = review.reviewed.map(r => {
    const mention = locateReferentV2(ctx, {...r.mention, nodeId: r.nodeId});
    const targets = locateTargets(ctx, r.targets, mention, r.status === 'confirmed');
    check(JSON.stringify([mention, targets]) === JSON.stringify([r.mentionLocation, r.targetLocations]), 'review_source_changed');
    const entityIds = r.status === 'confirmed' ? [...new Set(targets.flatMap(t => literal.occurrences.filter(o =>
      o.documentId === ctx.documentId && o.window === t.window && o.start === t.start && o.end === t.end).map(o => o.entityId)))] : [];
    return {id: r.id, nodeId: r.nodeId, mention, status: r.status, targets, entityIds,
      basis: 'independent_model_review_source_anchored_reference',
      entityProjection: entityIds.length ? 'direct_literal_antecedent' : 'no_entity_inheritance', semanticCertified: false,
      usableForRetrieval: r.status === 'confirmed',
      correction: {initialMention: r.initialMention, initialTargets: r.initialTargets, mentionChanged: r.mentionChanged, targetsChanged: r.targetsChanged}};
  });
  const choices = new Map<string, Set<string>>();
  for (const b of bindings.filter(b => b.usableForRetrieval)) {
    const k = locationKey(b.mention); if (!choices.has(k)) choices.set(k, new Set());
    choices.get(k)!.add(targetKey(b.targets));
  }
  const issues = [...review.issues];
  for (const b of bindings) if ((choices.get(locationKey(b.mention))?.size || 0) > 1) {
    b.usableForRetrieval = false; issues.push({id: b.id, stage: 'review', reason: 'conflicting_confirmed_targets'});
  }
  return {revision: 'reviewed-referent-index-v2', documentId: ctx.documentId, snapshotId: ctx.snapshotId, bindings, issues,
    recursiveInheritance: false, literalOccurrencesModified: false, graphEdgesCreated: 0, productionAdmission: false};
}

/** No global pronoun alias. Repeated phrases with different objects require a selected occurrence. */
export function lookupReviewedReferentsV2(index: ReviewedReferentIndex, input: {
  question: string; contextNodeId?: string; referenceId?: string; allowedNodeIds: Set<string>; allowedContextNodeIds?: Set<string>;
}) {
  const empty = (status: string) => ({status, bindingIds: [] as string[], nodeIds: [] as string[], entityIds: [] as string[], semanticCertified: false});
  if (!input.contextNodeId) return empty('context_required');
  if (!(input.allowedContextNodeIds ?? input.allowedNodeIds).has(input.contextNodeId)) return empty('context_outside_boundary');
  const candidates = index.bindings.filter(b => b.nodeId === input.contextNodeId && b.usableForRetrieval);
  const explicit = candidates.filter(b => {
    if (b.mention.quote.length > 1) return input.question.includes(b.mention.quote);
    // A one-character mention must be quoted or explicitly asked about, not found inside 之前/之后/etc.
    return ['“' + b.mention.quote + '”', '「' + b.mention.quote + '」', '"' + b.mention.quote + '"'].some(q => input.question.includes(q))
      || input.question.startsWith(b.mention.quote + '指');
  });
  let selected = input.referenceId ? candidates.filter(b => b.id === input.referenceId) : explicit;
  if (!selected.length && !input.referenceId && /它|他们|她们|该(?:结果|实验|研究)|这个(?:结果|实验)|这种(?:情况|现象)/u.test(input.question)
    && candidates.length === 1) selected = candidates;
  if (!selected.length) return empty(input.referenceId ? 'reference_not_available' : 'no_matching_reviewed_reference');
  if (selected.some(b => b.targets.some(t => !input.allowedNodeIds.has(t.nodeId)))) return empty('antecedent_outside_boundary');
  if (!input.referenceId) {
    const phraseTargets = new Map<string, Set<string>>();
    for (const b of selected) {
      if (!phraseTargets.has(b.mention.quote)) phraseTargets.set(b.mention.quote, new Set());
      phraseTargets.get(b.mention.quote)!.add(targetKey(b.targets));
    }
    if ([...phraseTargets.values()].some(v => v.size > 1)) return empty('ambiguous_context');
  }
  return {status: 'model_reviewed_binding_used', bindingIds: selected.map(b => b.id),
    nodeIds: [...new Set(selected.flatMap(b => b.targets.map(t => t.nodeId)))],
    entityIds: [...new Set(selected.flatMap(b => b.entityIds))], semanticCertified: false};
}
