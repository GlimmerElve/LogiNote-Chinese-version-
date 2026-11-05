/** Isolated identity experiment: source registration and identity selection are different calls.
 * Coordinates and finite wording constraints are local; semantic identity is never certified here. */
import {IDENTITY_KINDS, type IdentityKind, buildIdentityReadingInputV1} from './entityIdentityGateV1.ts';
import {resolveReferentSelectionV3, type ReferentSelectionV3, type ReferentUnitCatalogV3,
  type LocatedReferentV3} from './entityReferentUnitsV3.ts';
import type {ReferentContext} from './entityReferentBindings.ts';
import type {ReferenceTaskPlanV5} from './entityReferentTasksV5.ts';

function check(ok: unknown, message: string): asserts ok {if (!ok) throw new Error(message);}
function fields(value: any, names: string[]) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...names].sort().join('|'), 'identity_v2_fields');
}
function identityKind(value: unknown): asserts value is IdentityKind {
  check(IDENTITY_KINDS.includes(value as IdentityKind), 'identity_v2_kind');
}
const overlaps = (a: LocatedReferentV3, b: LocatedReferentV3) =>
  a.window === b.window && a.start < b.end && b.start < a.end;
function locations(catalog: ReferentUnitCatalogV3, raw: unknown, min: number) {
  check(Array.isArray(raw) && raw.length >= min && raw.length <= 8, 'identity_v2_sources');
  const found = raw.map(value => resolveReferentSelectionV3(catalog, value, true));
  check(new Set(found.map(p => JSON.stringify([p.window, p.start, p.end]))).size === found.length,
    'identity_v2_duplicate_source');
  return found;
}

export interface IdentityObjectV2 {
  id: string; kind: IdentityKind; scopeId: string | null;
  source: ReferentSelectionV3[]; scopeEvidence: ReferentSelectionV3[];
}
export interface IdentityRegistryV2 {
  revision: 'identity-object-registry-v2'; documentId: string; snapshotId: string;
  objects: Array<IdentityObjectV2 & {locations: LocatedReferentV3[]; scopeLocations: LocatedReferentV3[]}>;
  wire: {objects: IdentityObjectV2[]}; semanticCertified: false; productionAdmission: false;
}
export interface IdentityMentionV2 {id: string; mention: ReferentSelectionV3}
export interface IdentityPacketOptionsV2 {
  /** Retrieval may supply ranked IDs. Similarity order does not prove identity. Omit to examine all objects. */
  candidateIdsByTask?: Record<string, string[]>;
  maxCandidatesPerTask?: number; maxCharsPerTask?: number; neighbors?: number;
}
export interface IdentityTaskV2 {
  id: string; mention: ReferentSelectionV3; allowedKinds: IdentityKind[]; kindBasis: string;
  candidateIds: string[]; sourceUnitIds: string[];
}
export interface IdentityPacketV2 {
  revision: 'identity-selection-packet-v2'; documentId: string; snapshotId: string;
  input: {sources: Array<{unitId: string; nodeId: string | null; window: string; text: string}>;
    objects: IdentityObjectV2[]; tasks: IdentityTaskV2[]};
  deferred: Array<{id: string; reason: string}>;
  exclusions: Array<{id: string; objectId: string; reason: string}>;
  policy: {maxCandidatesPerTask: number; maxCharsPerTask: number; neighbors: number};
  semanticCertified: false; productionAdmission: false;
}

/** This stage supplies original reading context, never a previous answer or a hand-labeled identity. */
export function buildIdentityRegistrationV2(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  plan: ReferenceTaskPlanV5, taskIds: string[]) {
  check(plan.documentId === ctx.documentId && plan.snapshotId === ctx.snapshotId, 'identity_v2_plan_snapshot');
  const built = buildIdentityReadingInputV1(ctx, catalog, plan, taskIds);
  built.input.mentions.forEach(m => resolveReferentSelectionV3(built.catalog, m.mention));
  return built;
}

/** Freeze a source-valid proposal, not a semantically trusted entity registry. Fail the whole registry on bad shape. */
export function validateIdentityRegistryV2(catalog: ReferentUnitCatalogV3, raw: unknown): IdentityRegistryV2 {
  const wire = raw as {objects: IdentityObjectV2[]}; fields(wire, ['objects']);
  check(Array.isArray(wire.objects) && wire.objects.length <= 64, 'identity_v2_object_budget');
  const seen = new Set<string>();
  const objects = wire.objects.map(o => {
    fields(o, ['id', 'kind', 'scopeId', 'source', 'scopeEvidence']);
    check(typeof o.id === 'string' && /^O[1-9]\d*$/u.test(o.id) && !seen.has(o.id), 'identity_v2_object_id');
    seen.add(o.id); identityKind(o.kind);
    check(o.scopeId === null || typeof o.scopeId === 'string', 'identity_v2_scope_id');
    check(o.kind !== 'study' || o.scopeId === null, 'identity_v2_study_scope');
    return {...structuredClone(o), locations: locations(catalog, o.source, 1),
      scopeLocations: locations(catalog, o.scopeEvidence, o.scopeId === null ? 0 : 1)};
  });
  for (const o of objects) if (o.scopeId !== null)
    check(objects.some(s => s.id === o.scopeId && s.kind === 'study'), 'identity_v2_unknown_study_scope');
  return {revision: 'identity-object-registry-v2', documentId: catalog.documentId, snapshotId: catalog.snapshotId,
    objects, wire: structuredClone(wire), semanticCertified: false, productionAdmission: false};
}

/** Deliberately finite. A bare “这/其/他们/被试” has no locally inferred semantic category. */
export function allowedIdentityKindsV2(phrase: string | null) {
  if (['本研究', '该研究', '这项研究', '上述研究'].includes(phrase ?? ''))
    return {kinds: ['study'] as IdentityKind[], basis: 'literal_study_phrase'};
  if (['这一结果', '该结果', '上述结果'].includes(phrase ?? ''))
    return {kinds: ['event'] as IdentityKind[], basis: 'literal_result_phrase'};
  return {kinds: [...IDENTITY_KINDS], basis: 'semantic_category_unresolved'};
}

function assertRegistry(catalog: ReferentUnitCatalogV3, registry: IdentityRegistryV2) {
  check(JSON.stringify(registry) === JSON.stringify(validateIdentityRegistryV2(catalog, registry.wire)),
    'identity_v2_registry_changed');
}
const card = (o: IdentityObjectV2): IdentityObjectV2 => ({id: o.id, kind: o.kind, scopeId: o.scopeId,
  source: structuredClone(o.source), scopeEvidence: structuredClone(o.scopeEvidence)});

/** Deduplicate source text across targets. Required target, candidate and scope units are atomic: no text truncation. */
export function buildIdentitySelectionPacketV2(catalog: ReferentUnitCatalogV3, mentions: IdentityMentionV2[],
  registry: IdentityRegistryV2, options: IdentityPacketOptionsV2 = {}): IdentityPacketV2 {
  assertRegistry(catalog, registry);
  check(mentions.length > 0 && mentions.length <= 40 && new Set(mentions.map(m => m.id)).size === mentions.length,
    'identity_v2_tasks');
  const policy = {maxCandidatesPerTask: options.maxCandidatesPerTask ?? 16,
    maxCharsPerTask: options.maxCharsPerTask ?? 14000, neighbors: options.neighbors ?? 1};
  check(Number.isInteger(policy.maxCandidatesPerTask) && policy.maxCandidatesPerTask > 0 && policy.maxCandidatesPerTask <= 64
    && Number.isInteger(policy.maxCharsPerTask) && policy.maxCharsPerTask > 0
    && Number.isInteger(policy.neighbors) && policy.neighbors >= 0 && policy.neighbors <= 3, 'identity_v2_budget');
  const byId = new Map(registry.objects.map(o => [o.id, o]));
  const units = new Map(catalog.units.map(u => [u.id, u]));
  check(units.size === catalog.units.length, 'identity_v2_duplicate_unit');
  if (options.candidateIdsByTask) check(Object.keys(options.candidateIdsByTask).every(id => mentions.some(m => m.id === id)),
    'identity_v2_unknown_task_candidates');
  const tasks: IdentityTaskV2[] = [], deferred: IdentityPacketV2['deferred'] = [], exclusions: IdentityPacketV2['exclusions'] = [];
  for (const m of mentions) {
    const mention = resolveReferentSelectionV3(catalog, m.mention), constraint = allowedIdentityKindsV2(m.mention.phrase);
    const ids = options.candidateIdsByTask?.[m.id] ?? registry.objects.map(o => o.id);
    check(new Set(ids).size === ids.length && ids.every(id => byId.has(id)), 'identity_v2_candidate_ids');
    const candidates = ids.map(id => byId.get(id)!).filter(o => {
      const reason = !constraint.kinds.includes(o.kind) ? 'literal_kind_mismatch'
        : o.locations.some(p => overlaps(p, mention)) ? 'self_target' : null;
      if (reason) exclusions.push({id: m.id, objectId: o.id, reason});
      return !reason;
    });
    if (candidates.length > policy.maxCandidatesPerTask) {
      deferred.push({id: m.id, reason: 'candidate_budget_requires_recall_refinement'}); continue;
    }
    const required = new Set<string>([m.mention.unitId]);
    for (const o of candidates) {
      [...o.source, ...o.scopeEvidence].forEach(s => required.add(s.unitId));
      if (o.scopeId !== null) byId.get(o.scopeId)!.source.forEach(s => required.add(s.unitId));
    }
    const charCount = () => [...required].reduce((sum, id) => sum + units.get(id)!.text.length, 0);
    if (charCount() > policy.maxCharsPerTask) {
      deferred.push({id: m.id, reason: 'protected_context_exceeds_budget'}); continue;
    }
    // Add adjacent original units (including headings/gaps), not just adjacent graph nodes.
    for (const id of [...required]) {
      const u = units.get(id)!, ordered = catalog.units.filter(p => p.window === u.window)
        .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
      const at = ordered.findIndex(p => p.id === id);
      for (let distance = 1; distance <= policy.neighbors; distance++) for (const next of [ordered[at-distance], ordered[at+distance]])
        if (next && !required.has(next.id) && charCount() + next.text.length <= policy.maxCharsPerTask) required.add(next.id);
    }
    tasks.push({id: m.id, mention: structuredClone(m.mention), allowedKinds: constraint.kinds, kindBasis: constraint.basis,
      candidateIds: candidates.map(o => o.id), sourceUnitIds: [...required]});
  }
  const selected = new Set(tasks.flatMap(t => t.sourceUnitIds));
  const sources = catalog.units.filter(u => selected.has(u.id)).map(u => ({unitId: u.id, nodeId: u.nodeId || null,
    window: u.window, text: u.text}));
  const objectIds = new Set(tasks.flatMap(t => t.candidateIds));
  for (const id of [...objectIds]) {const scope = byId.get(id)!.scopeId; if (scope) objectIds.add(scope);}
  const objects = registry.objects.filter(o => objectIds.has(o.id)).map(card);
  return {revision: 'identity-selection-packet-v2', documentId: catalog.documentId, snapshotId: catalog.snapshotId,
    input: {sources, objects, tasks}, deferred, exclusions, policy, semanticCertified: false, productionAdmission: false};
}

export interface IdentityDecisionV2 {
  id: string; status: 'match' | 'unresolved' | 'not_reference'; referentKind: IdentityKind | null;
  objectIds: string[]; reason: string;
}
/** Every choice must come from that target's packet. Valid geometry is still not semantic correctness. */
export function validateIdentitySelectionV2(catalog: ReferentUnitCatalogV3, registry: IdentityRegistryV2,
  packet: IdentityPacketV2, raw: unknown) {
  assertRegistry(catalog, registry);
  check(packet.documentId === catalog.documentId && packet.snapshotId === catalog.snapshotId, 'identity_v2_packet_snapshot');
  const byObject = new Map(registry.objects.map(o => [o.id, o]));
  const byUnit = new Map(catalog.units.map(u => [u.id, u]));
  for (const s of packet.input.sources) {
    const u = byUnit.get(s.unitId);
    check(u && s.text === u.text && s.window === u.window && s.nodeId === (u.nodeId || null), 'identity_v2_source_changed');
  }
  const shown = new Set(packet.input.sources.map(s => s.unitId));
  const shownObjects = new Map(packet.input.objects.map(o => [o.id, o]));
  check(shownObjects.size === packet.input.objects.length, 'identity_v2_duplicate_candidate');
  for (const o of shownObjects.values()) check(byObject.has(o.id)
    && JSON.stringify(o) === JSON.stringify(card(byObject.get(o.id)!)), 'identity_v2_candidate_changed');
  const expected = new Map(packet.input.tasks.map(t => [t.id, t]));
  check(expected.size === packet.input.tasks.length, 'identity_v2_duplicate_task');
  for (const t of expected.values()) {
    const rule = allowedIdentityKindsV2(t.mention.phrase);
    resolveReferentSelectionV3(catalog, t.mention);
    check(JSON.stringify(t.allowedKinds) === JSON.stringify(rule.kinds) && t.kindBasis === rule.basis,
      'identity_v2_kind_rule_changed');
    check(t.sourceUnitIds.every(id => shown.has(id)) && t.sourceUnitIds.includes(t.mention.unitId), 'identity_v2_hidden_context');
    check(new Set(t.candidateIds).size === t.candidateIds.length && t.candidateIds.every(id => shownObjects.has(id)),
      'identity_v2_candidate_ids');
    for (const id of t.candidateIds) {
      const o = byObject.get(id)!;
      const refs = [...o.source, ...o.scopeEvidence, ...(o.scopeId === null ? [] : byObject.get(o.scopeId)!.source)];
      check(refs.every(s => t.sourceUnitIds.includes(s.unitId)), 'identity_v2_hidden_candidate_source');
    }
  }
  const wire = raw as {decisions: IdentityDecisionV2[]}; fields(wire, ['decisions']);
  check(Array.isArray(wire.decisions) && wire.decisions.length <= 40, 'identity_v2_decision_budget');
  const counts = new Map<string, number>(); for (const d of wire.decisions) counts.set(d?.id, (counts.get(d?.id) ?? 0)+1);
  const issues: Array<{id: string; reason: string}> = [];
  const decisions: Array<IdentityDecisionV2 & {nodeIds: string[]; scopeId: string | null;
    readingLocations: LocatedReferentV3[]; semanticAccepted: false; entityIdentityEligible: false}> = [];
  for (const d of wire.decisions) try {
    fields(d, ['id', 'status', 'referentKind', 'objectIds', 'reason']);
    check(expected.has(d.id) && counts.get(d.id) === 1, 'identity_v2_decision_id');
    const task = expected.get(d.id)!;
    check(['match', 'unresolved', 'not_reference'].includes(d.status), 'identity_v2_status');
    check(typeof d.reason === 'string' && d.reason.trim().length > 0 && d.reason.length <= 600, 'identity_v2_reason');
    check(Array.isArray(d.objectIds) && d.objectIds.length <= 12 && new Set(d.objectIds).size === d.objectIds.length,
      'identity_v2_object_choices');
    if (d.status !== 'match') {
      check(d.objectIds.length === 0 && d.referentKind === null, 'identity_v2_empty_decision');
      decisions.push({...structuredClone(d), nodeIds: [], scopeId: null, readingLocations: [],
        semanticAccepted: false, entityIdentityEligible: false});
      continue;
    }
    identityKind(d.referentKind);
    check(task.allowedKinds.includes(d.referentKind), 'identity_v2_literal_kind_mismatch');
    check(d.objectIds.length > 0 && d.objectIds.every(id => task.candidateIds.includes(id)),
      'identity_v2_choice_outside_candidates');
    const chosen = d.objectIds.map(id => byObject.get(id)!);
    check(chosen.every(o => o.kind === d.referentKind), 'identity_v2_object_type_mismatch');
    const mention = resolveReferentSelectionV3(catalog, task.mention);
    check(chosen.every(o => o.locations.every(p => !overlaps(p, mention))), 'identity_v2_self_target');
    const scopes = [...new Set(chosen.map(o => o.kind === 'study' ? o.id : o.scopeId).filter((s): s is string => s !== null))];
    check(scopes.length <= 1, 'identity_v2_cross_study_mismatch');
    // Restore known coordinates locally instead of asking the model to copy them again.
    // These are reading provenance, NOT proof that the semantic connection is valid.
    const reading = [mention, ...chosen.flatMap(o => [...o.locations, ...o.scopeLocations])];
    const readingLocations = [...new Map(reading.map(p => [JSON.stringify([p.window, p.start, p.end]), p])).values()];
    decisions.push({...structuredClone(d), scopeId: scopes.length === 1 && chosen.every(o => o.kind === 'study' || o.scopeId !== null)
      ? scopes[0] : null, nodeIds: [...new Set(chosen.flatMap(o => o.locations.map(p => p.nodeId).filter(Boolean)))],
      readingLocations, semanticAccepted: false, entityIdentityEligible: false});
  } catch (error) {issues.push({id: d?.id ?? '(decision)', reason: (error as Error).message});}
  for (const id of expected.keys()) if (!counts.has(id)) issues.push({id, reason: 'identity_v2_missing_decision'});
  return {revision: 'identity-selection-gate-v2', decisions, issues, deferred: structuredClone(packet.deferred),
    sourceAndShapeComplete: issues.length === 0 && decisions.length === expected.size,
    allTasksHandled: packet.deferred.length === 0 && issues.length === 0 && decisions.length === expected.size,
    semanticCertified: false, productionAdmission: false, automaticEntityMerges: 0, graphEdgesCreated: 0};
}

/** A separate request over the same frozen candidates; no first answer, reason or choice is exposed. */
export function buildIndependentIdentityReviewV2(packet: IdentityPacketV2, taskIds: string[]) {
  check(taskIds.length > 0 && new Set(taskIds).size === taskIds.length
    && taskIds.every(id => packet.input.tasks.some(t => t.id === id)), 'identity_v2_review_ids');
  const tasks = packet.input.tasks.filter(t => taskIds.includes(t.id)), units = new Set(tasks.flatMap(t => t.sourceUnitIds));
  const objectIds = new Set(tasks.flatMap(t => t.candidateIds));
  for (const o of packet.input.objects) if (objectIds.has(o.id) && o.scopeId !== null) objectIds.add(o.scopeId);
  return {...structuredClone(packet), input: {tasks: structuredClone(tasks),
    sources: structuredClone(packet.input.sources.filter(s => units.has(s.unitId))),
    objects: structuredClone(packet.input.objects.filter(o => objectIds.has(o.id)))}, deferred: [],
    exclusions: packet.exclusions.filter(e => taskIds.includes(e.id))};
}

/** Disagreement never falls back to the first answer. Agreement is a review signal, not semantic proof. */
export function reconcileIdentitySelectionsV2(first: ReturnType<typeof validateIdentitySelectionV2>,
  review: ReturnType<typeof validateIdentitySelectionV2>) {
  const ids = new Set([...first.decisions.map(d => d.id), ...review.decisions.map(d => d.id),
    ...first.issues.map(i => i.id), ...review.issues.map(i => i.id), ...first.deferred.map(d => d.id)]);
  return {decisions: [...ids].map(id => {
    const a = first.decisions.find(d => d.id === id), b = review.decisions.find(d => d.id === id);
    const signature = (d: NonNullable<typeof a>) => JSON.stringify([d.status, d.referentKind, [...d.objectIds].sort(), d.scopeId]);
    const agree = a && b && !first.issues.some(i => i.id === id) && !review.issues.some(i => i.id === id)
      && signature(a) === signature(b);
    return {id, state: agree ? 'review_agrees' : 'pending', objectIds: agree && a.status === 'match' ? a.objectIds : []};
  }), semanticCertified: false, productionAdmission: false, automaticEntityMerges: 0, graphEdgesCreated: 0};
}
