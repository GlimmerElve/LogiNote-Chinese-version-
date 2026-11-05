/** Experimental identity gate. Model scope assertions remain untrusted semantic proposals. */
import {referentReadingInputV3, referentReadingProjectionV3, resolveReferentSelectionV3,
  type ReferentSelectionV3, type ReferentUnitCatalogV3} from './entityReferentUnitsV3.ts';
import type {ReferentContext} from './entityReferentBindings.ts';
import type {ReferenceTaskPlanV5} from './entityReferentTasksV5.ts';

export const IDENTITY_KINDS = ['study', 'group', 'condition', 'event', 'concept'] as const;
export type IdentityKind = typeof IDENTITY_KINDS[number];
function check(v: unknown, msg: string): asserts v {if (!v) throw new Error(msg);}
const fields = (v: any, names: string[]) => check(v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...names].sort().join('|'), 'identity_fields');
const kind = (v: unknown) => check(IDENTITY_KINDS.includes(v as IdentityKind), 'identity_kind');

/** Give uncovered original text addressable IDs too; never manufacture argument nodes. */
export function buildIdentityReadingInputV1(ctx: ReferentContext, catalog: ReferentUnitCatalogV3,
  plan: ReferenceTaskPlanV5, taskIds: string[]) {
  const view = referentReadingInputV3(ctx, catalog);
  check(taskIds.length > 0 && taskIds.length <= 40 && new Set(taskIds).size === taskIds.length, 'identity_task_ids');
  check(taskIds.every(id => plan.modelTaskIds.includes(id)), 'identity_unknown_task');
  const contextUnits = ctx.windows.flatMap((w, wi) => {
    const out: typeof catalog.units = []; let cursor = 0, counter = 0;
    const add = (start: number, end: number) => {
      const raw = w.text.slice(start, end), p = referentReadingProjectionV3(raw);
      if (p.text) out.push({id: `W${wi + 1}.C${++counter}`, nodeId: '', window: w.id,
        sourceIndex: -1, start, end, raw, ...p, type: null});
    };
    for (const u of catalog.units.filter(u => u.window === w.id).sort((a,b) => a.start-b.start || a.end-b.end)) {
      if (u.start > cursor) add(cursor, u.start);
      cursor = Math.max(cursor, u.end);
    }
    if (cursor < w.text.length) add(cursor, w.text.length);
    return out;
  });
  const extended = {...catalog, units: [...catalog.units, ...contextUnits]};
  const windows = view.windows.map(w => {
    let contextAt = 0;
    const gaps = contextUnits.filter(u => u.window === w.id);
    return {...w, segments: w.segments.map(s => s.kind === 'context'
      ? {...s, unitId: gaps[contextAt++].id} : s)};
  });
  return {catalog: extended, input: {windows, mentions: taskIds.map(id => {
    const p = plan.positions.find(p => p.id === id)!;
    return {id, mention: p.mention, mentionContext: p.mentionContext};
  })}};
}

/** Coordinate/type/scope consistency only: this cannot prove an LLM's study assignment. */
export function validateIdentityResolutionV1(catalog: ReferentUnitCatalogV3,
  mentions: Array<{id: string; mention: ReferentSelectionV3}>, raw: unknown) {
  const wire = raw as any; fields(wire, ['studies','objects','decisions']);
  check(Array.isArray(wire.studies) && wire.studies.length <= 16, 'identity_study_budget');
  check(Array.isArray(wire.objects) && wire.objects.length <= 40, 'identity_object_budget');
  check(Array.isArray(wire.decisions) && wire.decisions.length <= 40, 'identity_decision_budget');
  const locate = (values: unknown, min: number) => {
    check(Array.isArray(values) && values.length >= min && values.length <= 8, 'identity_sources');
    const locations = values.map(v => resolveReferentSelectionV3(catalog, v, true));
    check(new Set(locations.map(v => JSON.stringify([v.window,v.start,v.end]))).size === locations.length, 'identity_duplicate_source');
    return locations;
  };
  const studies = new Map<string, any>(), objects = new Map<string, any>(), issues: Array<{id:string;reason:string}> = [];
  for (const s of wire.studies) {
    try {
      fields(s,['id','source']); check(/^S[1-9]\d*$/u.test(s.id) && !studies.has(s.id), 'identity_study_id');
      studies.set(s.id, {...s, locations: locate(s.source,1)});
    } catch (e) {issues.push({id: s?.id || '(study)', reason: (e as Error).message});}
  }
  for (const o of wire.objects) {
    try {
      fields(o,['id','kind','studyId','source','scopeEvidence']);
      check(/^O[1-9]\d*$/u.test(o.id) && !objects.has(o.id), 'identity_object_id'); kind(o.kind);
      check(o.studyId === null || studies.has(o.studyId), 'identity_object_study');
      const locations = locate(o.source,1), scopeLocations = locate(o.scopeEvidence,o.studyId === null ? 0 : 1);
      objects.set(o.id,{...o,locations,scopeLocations,nodeIds:[...new Set(locations.map(p=>p.nodeId).filter(Boolean))]});
    } catch (e) {issues.push({id:o?.id || '(object)',reason:(e as Error).message});}
  }
  const expected = new Map(mentions.map(m=>[m.id,m])), counts = new Map<string,number>();
  for (const d of wire.decisions) counts.set(d?.id,(counts.get(d?.id)||0)+1);
  const decisions: Array<any> = [];
  for (const d of wire.decisions) {
    try {
      fields(d,['id','status','referentKind','studyId','objectIds','evidence','reason']);
      check(expected.has(d.id) && counts.get(d.id) === 1, 'identity_decision_id');
      check(['match','unresolved','not_reference'].includes(d.status), 'identity_status');
      check(typeof d.reason === 'string' && d.reason.trim() && d.reason.length <= 600, 'identity_reason');
      check(Array.isArray(d.objectIds) && d.objectIds.length <= 12 && new Set(d.objectIds).size === d.objectIds.length, 'identity_object_choices');
      check(d.studyId === null || studies.has(d.studyId), 'identity_decision_study');
      const evidence = locate(d.evidence,d.status === 'match' ? 1 : 0);
      if (d.status !== 'match') {
        check(d.objectIds.length === 0 && d.referentKind === null && d.studyId === null, 'identity_empty_decision');
        decisions.push({...d,evidenceLocations:evidence,gate:'not_bound',nodeIds:[],entityIdentityEligible:false}); continue;
      }
      kind(d.referentKind); check(d.objectIds.length > 0 && d.objectIds.every((id:string)=>objects.has(id)), 'identity_missing_object');
      const chosen = d.objectIds.map((id:string)=>objects.get(id));
      check(chosen.every((o:any)=>o.kind === d.referentKind), 'identity_object_type_mismatch');
      const mention = resolveReferentSelectionV3(catalog,expected.get(d.id)!.mention);
      check(chosen.every((o:any)=>o.locations.every((p:any)=>!(p.window===mention.window && p.start<mention.end && mention.start<p.end))), 'identity_self_target');
      check(chosen.every((o:any)=>d.studyId===null || o.studyId===null || o.studyId===d.studyId), 'identity_cross_study_mismatch');
      const nodeIds = [...new Set<string>(chosen.flatMap((o:any)=>o.nodeIds))];
      const preciseScope = d.studyId !== null && chosen.every((o:any)=>o.studyId === d.studyId);
      decisions.push({...d,evidenceLocations:evidence,gate:nodeIds.length ? (preciseScope ? 'scoped_candidate' : 'node_context_candidate') : 'source_context_only',
        nodeIds,entityIdentityEligible:preciseScope && nodeIds.length > 0,semanticAccepted:false});
    } catch (e) {issues.push({id:d?.id || '(decision)',reason:(e as Error).message});}
  }
  for (const id of expected.keys()) if (!counts.has(id)) issues.push({id,reason:'identity_missing_decision'});
  return {revision:'scoped-identity-gate-v1',studies:[...studies.values()],objects:[...objects.values()],decisions,issues,
    sourceAndShapeComplete:issues.length===0 && decisions.length===mentions.length,
    semanticCertified:false,automaticEntityMerges:0,productionAdmission:false,graphEdgesCreated:0};
}
