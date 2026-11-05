/** Experimental source-context recovery. Local code locates text, not entities, events or antecedents. */
import {buildIdentityRegistrationV2, buildIdentitySelectionPacketV2, validateIdentityRegistryV2,
  validateIdentitySelectionV2, type IdentityRegistryV2, type IdentityMentionV2,
  type IdentityPacketV2, type IdentityPacketOptionsV2, type IdentityDecisionV2} from './entityIdentitySelectionV2.ts';
import type {IdentityKind} from './entityIdentityGateV1.ts';
import {resolveReferentSelectionV3, referentReadingProjectionV3, type ReferentSelectionV3,
  type ReferentUnitCatalogV3, type LocatedReferentV3} from './entityReferentUnitsV3.ts';
import type {ReferentContext} from './entityReferentBindings.ts';
import type {ReferenceTaskPlanV5} from './entityReferentTasksV5.ts';

function check(ok: unknown, message: string): asserts ok {if (!ok) throw new Error(message);}
const overlap = (a: LocatedReferentV3, b: LocatedReferentV3) => a.window === b.window && a.start < b.end && b.start < a.end;
// Exact lexical guard only. A descriptive sentence containing these words is not an alias-only source.
const BARE_REFERENCES = new Set(['本研究', '该研究', '上述研究', '这项研究', '该结果', '这一结果', '上述结果', '这', '其', '其中', '他们', '它', '它们']);
const bare = (quote: string) => BARE_REFERENCES.has(referentReadingProjectionV3(quote).text);
export function auditIdentityRegistryV3(catalog: ReferentUnitCatalogV3, registry: IdentityRegistryV2) {
  check(JSON.stringify(registry) === JSON.stringify(validateIdentityRegistryV2(catalog, registry.wire)), 'identity_v3_registry_changed');
  const aliasOnlyObjectIds = registry.objects.filter(o => o.locations.every(p => bare(p.quote))).map(o => o.id);
  return {aliasOnlyObjectIds, unresolvedScopeObjectIds: registry.objects.filter(o => o.scopeId !== null
    && aliasOnlyObjectIds.includes(o.scopeId)).map(o => o.id),
    kindCounts: Object.fromEntries(['study', 'group', 'condition', 'event', 'concept'].map(kind =>
      [kind, registry.objects.filter(o => o.kind === kind).length])),
    semanticCertified: false, productionAdmission: false};
}

/** Delimiters select a reading aid, not a new semantic chunk. Entire original unit remains available. */
export function identityMentionFocusV3(catalog: ReferentUnitCatalogV3, mention: ReferentSelectionV3) {
  resolveReferentSelectionV3(catalog, mention);
  const unit = catalog.units.find(u => u.id === mention.unitId)!;
  check(typeof mention.phrase === 'string', 'identity_v3_focus_phrase');
  let at = -1; for (let i = 0; i < mention.occurrence; i++) at = unit.text.indexOf(mention.phrase, at+1);
  const end = at+mention.phrase.length;
  const bounds = [0]; let depth = 0;
  for (let i = 0; i < unit.text.length; i++) {
    const c = unit.text[i]; if ('(（[【'.includes(c)) depth++;
    else if (')）]】'.includes(c)) depth = Math.max(0, depth-1);
    const period = c === '.' && !(/[A-Za-z0-9]/u.test(unit.text[i-1] ?? '') && /[A-Za-z0-9]/u.test(unit.text[i+1] ?? ''));
    if (depth === 0 && (/[。！？!?；;]/u.test(c) || period)) bounds.push(i+1);
  }
  bounds.push(unit.text.length);
  const start = Math.max(...bounds.filter(b => b <= at)), stop = Math.min(...bounds.filter(b => b >= end));
  return {unitId: unit.id, phrase: mention.phrase, occurrence: mention.occurrence,
    before: unit.text.slice(start, at), selected: unit.text.slice(at, end), after: unit.text.slice(end, stop),
    readingAidOnly: true};
}

function orderedUnits(ctx: ReferentContext, catalog: ReferentUnitCatalogV3) {
  check(ctx.documentId === catalog.documentId && ctx.snapshotId === catalog.snapshotId, 'identity_v3_context_snapshot');
  const order = new Map(ctx.windows.map((w, i) => [w.id, i]));
  for (const u of catalog.units) {
    const window = ctx.windows.find(w => w.id === u.window);
    check(window && window.text.slice(u.start, u.end) === u.raw, 'identity_v3_source_changed');
  }
  return [...catalog.units].sort((a, b) => order.get(a.window)!-order.get(b.window)! || a.start-b.start || a.end-b.end || a.id.localeCompare(b.id));
}
/** Only detect syntactic heading-shaped source gaps; do not infer their topics or semantic scope. */
function headingLike(text: string) {
  return text.length <= 160 && !/[。；;]/u.test(text)
    && /^(?:#{1,6}\s+\S|\d+(?:\.\d+){0,5}\.?\s+\S)/u.test(text.trim());
}
function contextUnitIds(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, mention: ReferentSelectionV3) {
  const ordered = orderedUnits(ctx, catalog), target = resolveReferentSelectionV3(catalog, mention);
  const wi = ctx.windows.findIndex(w => w.id === target.window);
  // Entire current window is protected. One previous window is a bounded context fallback, not the long-range recall policy.
  const localWindows = new Set(ctx.windows.slice(Math.max(0, wi-1), wi+1).map(w => w.id));
  const local = ordered.filter(u => localWindows.has(u.window));
  const earlier = ordered.filter(u => ctx.windows.findIndex(w => w.id === u.window) < wi
    || (u.window === target.window && u.start <= target.start));
  const heading = earlier.filter(u => !u.nodeId && headingLike(u.text)).at(-1);
  return {unitIds: [...new Set([...local.map(u => u.id), ...(heading ? [heading.id] : [])])],
    headingUnitIds: heading ? [heading.id] : [], section: ctx.windows[wi].section ?? ''};
}

export function buildIdentityRegistrationV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  plan: ReferenceTaskPlanV5, ids: string[]) {
  const built = buildIdentityRegistrationV2(ctx, catalog, plan, ids);
  return {catalog: built.catalog, input: {...built.input, mentions: built.input.mentions.map(m => ({...m,
    focus: identityMentionFocusV3(built.catalog, m.mention),
    context: contextUnitIds(ctx, built.catalog, m.mention)}))}};
}

export interface IdentityPacketV3 {
  revision: 'identity-context-packet-v3'; base: IdentityPacketV2;
  input: {sources: IdentityPacketV2['input']['sources']; objects: IdentityPacketV2['input']['objects'];
    tasks: Array<IdentityPacketV2['input']['tasks'][number] & {focus: ReturnType<typeof identityMentionFocusV3>;
      contextCandidateUnitIds: string[]; headingUnitIds: string[]; section: string}>;
    unresolvedScopeObjectIds: string[]};
  registryAudit: ReturnType<typeof auditIdentityRegistryV3>;
  deferred: Array<{id: string; reason: string}>;
  semanticCertified: false; productionAdmission: false;
}

/** Raw context alternatives have no locally assigned kind. The model may propose only a context binding, not an entity merge. */
export function buildIdentityContextPacketV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  mentions: IdentityMentionV2[], registry: IdentityRegistryV2, options: IdentityPacketOptionsV2 = {}): IdentityPacketV3 {
  const registryAudit = auditIdentityRegistryV3(catalog, registry);
  const candidateIdsByTask = Object.fromEntries(mentions.map(m => [m.id,
    (options.candidateIdsByTask?.[m.id] ?? registry.objects.map(o => o.id))
      .filter(id => !registryAudit.aliasOnlyObjectIds.includes(id))]));
  const base = buildIdentitySelectionPacketV2(catalog, mentions, registry, {...options, neighbors: 0, candidateIdsByTask});
  const ordered = orderedUnits(ctx, catalog), units = new Map(ordered.map(u => [u.id, u]));
  const tasks: IdentityPacketV3['input']['tasks'] = [], deferred = [...base.deferred];
  for (const task of base.input.tasks) {
    const context = contextUnitIds(ctx, catalog, task.mention);
    const ids = [...new Set([...task.sourceUnitIds, ...context.unitIds])];
    if (ids.reduce((sum, id) => sum+units.get(id)!.text.length, 0) > base.policy.maxCharsPerTask) {
      deferred.push({id: task.id, reason: 'protected_window_context_exceeds_budget'}); continue;
    }
    tasks.push({...task, sourceUnitIds: ids, focus: identityMentionFocusV3(catalog, task.mention),
      contextCandidateUnitIds: context.unitIds, headingUnitIds: context.headingUnitIds, section: context.section});
  }
  const selected = new Set(tasks.flatMap(t => t.sourceUnitIds));
  const sources = ordered.filter(u => selected.has(u.id)).map(u => ({unitId: u.id, nodeId: u.nodeId || null, window: u.window, text: u.text}));
  const objectIds = new Set(tasks.flatMap(t => t.candidateIds));
  for (const o of registry.objects) if (objectIds.has(o.id) && o.scopeId !== null) objectIds.add(o.scopeId);
  const objects = base.input.objects.filter(o => objectIds.has(o.id));
  const projectedBase: IdentityPacketV2 = {...base, input: {sources, objects, tasks: tasks.map(({focus, contextCandidateUnitIds,
    headingUnitIds, section, ...t}) => t)}, deferred};
  return {revision: 'identity-context-packet-v3', base: projectedBase, input: {sources, objects, tasks,
    unresolvedScopeObjectIds: registryAudit.unresolvedScopeObjectIds}, registryAudit, deferred,
    semanticCertified: false, productionAdmission: false};
}

export interface IdentityDecisionV3 {
  id: string; status: IdentityDecisionV2['status'] | 'context_match'; referentKind: IdentityKind | null;
  objectIds: string[]; contextSources: ReferentSelectionV3[]; reason: string;
}
/** Context-match is a source-backed proposal, never confirmation of a concrete entity or graph relation. */
export function validateIdentityContextV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3, registry: IdentityRegistryV2,
  mentions: IdentityMentionV2[], packet: IdentityPacketV3, raw: unknown, options: IdentityPacketOptionsV2 = {}) {
  check(JSON.stringify(packet) === JSON.stringify(buildIdentityContextPacketV3(ctx, catalog, mentions, registry, options)),
    'identity_v3_packet_changed');
  const wire = raw as {decisions: IdentityDecisionV3[]};
  check(wire && Object.keys(wire).join('|') === 'decisions' && Array.isArray(wire.decisions)
    && wire.decisions.length <= 40, 'identity_v3_fields');
  const counts = new Map<string, number>(); for (const d of wire.decisions) counts.set(d?.id, (counts.get(d?.id) ?? 0)+1);
  const issues: Array<{id: string; reason: string}> = [], decisions: Array<IdentityDecisionV3 & {
    nodeIds: string[]; readingLocations: LocatedReferentV3[]; bindingLevel: 'entity_proposal' | 'context_proposal' | 'none';
    semanticAccepted: false; entityIdentityEligible: false}> = [];
  for (const d of wire.decisions) try {
    check(d && !Array.isArray(d) && Object.keys(d).sort().join('|') === 'contextSources|id|objectIds|reason|referentKind|status',
      'identity_v3_decision_fields');
    const task = packet.input.tasks.find(t => t.id === d.id);
    check(task && counts.get(d.id) === 1, 'identity_v3_decision_id');
    check(Array.isArray(d.contextSources) && d.contextSources.length <= 8, 'identity_v3_context_sources');
    if (d.status === 'context_match') {
      check(Array.isArray(d.objectIds) && d.objectIds.length === 0 && task.allowedKinds.includes(d.referentKind!) && d.contextSources.length > 0,
        'identity_v3_context_contract');
      check(typeof d.reason === 'string' && d.reason.trim() && d.reason.length <= 600, 'identity_v3_reason');
      const found = d.contextSources.map(s => {
        check(task.contextCandidateUnitIds.includes(s.unitId), 'identity_v3_context_outside_candidates');
        const p = resolveReferentSelectionV3(catalog, s, true), target = resolveReferentSelectionV3(catalog, task.mention);
        check(!overlap(p, target), 'identity_v3_context_self_target');
        check(!bare(p.quote), 'identity_v3_alias_only_context'); return p;
      });
      check(new Set(found.map(p => JSON.stringify([p.window, p.start, p.end]))).size === found.length, 'identity_v3_duplicate_context');
      decisions.push({...structuredClone(d), nodeIds: [...new Set(found.map(p => p.nodeId).filter(Boolean))],
        readingLocations: found, bindingLevel: 'context_proposal', semanticAccepted: false, entityIdentityEligible: false});
    } else {
      check(d.contextSources.length === 0, 'identity_v3_context_on_entity_decision');
      const result = validateIdentitySelectionV2(catalog, registry, packet.base, {decisions: [{id: d.id, status: d.status,
        referentKind: d.referentKind, objectIds: d.objectIds, reason: d.reason}]});
      const bad = result.issues.find(i => i.id === d.id); check(!bad, bad?.reason ?? 'identity_v3_entity_invalid');
      const accepted = result.decisions.find(a => a.id === d.id); check(accepted, 'identity_v3_entity_missing');
      decisions.push({...structuredClone(d), nodeIds: accepted.nodeIds, readingLocations: accepted.readingLocations,
        bindingLevel: d.status === 'match' ? 'entity_proposal' : 'none', semanticAccepted: false, entityIdentityEligible: false});
    }
  } catch (error) {issues.push({id: d?.id ?? '(decision)', reason: (error as Error).message});}
  for (const task of packet.input.tasks) if (!counts.has(task.id)) issues.push({id: task.id, reason: 'identity_v3_missing_decision'});
  return {revision: 'identity-context-gate-v3', decisions, issues, deferred: packet.deferred,
    sourceAndShapeComplete: issues.length === 0 && decisions.length === packet.input.tasks.length,
    allTasksHandled: packet.deferred.length === 0 && issues.length === 0 && decisions.length === mentions.length,
    semanticCertified: false, productionAdmission: false, automaticEntityMerges: 0, graphEdgesCreated: 0};
}

/** Rebuild only selected targets with the same source/registry; the first decisions are not an argument to this function. */
export function buildIndependentIdentityReviewV3(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  mentions: IdentityMentionV2[], registry: IdentityRegistryV2, ids: string[], options: IdentityPacketOptionsV2 = {}) {
  check(ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => mentions.some(m => m.id === id)),
    'identity_v3_review_ids');
  const subset = mentions.filter(m => ids.includes(m.id));
  const narrowed = {...options, candidateIdsByTask: options.candidateIdsByTask
    ? Object.fromEntries(ids.map(id => [id, options.candidateIdsByTask![id] ?? registry.objects.map(o => o.id)])) : undefined};
  return {mentions: subset, options: narrowed, packet: buildIdentityContextPacketV3(ctx, catalog, subset, registry, narrowed)};
}

export function reconcileIdentityContextV3(first: ReturnType<typeof validateIdentityContextV3>,
  review: ReturnType<typeof validateIdentityContextV3>) {
  const ids = new Set([...first.decisions.map(d => d.id), ...review.decisions.map(d => d.id),
    ...first.issues.map(i => i.id), ...review.issues.map(i => i.id), ...first.deferred.map(d => d.id)]);
  const signature = (d: typeof first.decisions[number]) => JSON.stringify([d.status, d.referentKind, [...d.objectIds].sort(),
    d.readingLocations.map(p => JSON.stringify([p.window, p.start, p.end])).sort()]);
  return {decisions: [...ids].map(id => {
    const a = first.decisions.find(d => d.id === id), b = review.decisions.find(d => d.id === id);
    const agree = a && b && !first.issues.some(i => i.id === id) && !review.issues.some(i => i.id === id)
      && signature(a) === signature(b);
    return {id, state: agree ? 'review_agrees' : 'pending', bindingLevel: agree ? a.bindingLevel : 'none',
      objectIds: agree ? a.objectIds : [], contextSources: agree ? a.contextSources : []};
  }), semanticCertified: false, productionAdmission: false, automaticEntityMerges: 0, graphEdgesCreated: 0};
}
