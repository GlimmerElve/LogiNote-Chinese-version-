import type { NoteItem } from '../../types';
import { argumentContextHash, compareArgumentContextIds } from '../../services/argumentContext/hash.ts';
import { createArgumentContextPointer } from '../../services/argumentContext/reader.ts';
import { readTaskScopedArgumentContextPack, validateTaskScopedArgumentContextPack } from '../../services/argumentContext/taskScopedReader.ts';
import type { ArgumentContextNode, ArgumentEvidenceSpan } from '../../services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import { parseReviewAssessment, type ReviewCriterionId } from '../../services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, parseReviewReferenceRubric, verifyReviewReferenceRubric,
  type ReviewReferenceItem } from '../../services/reviewReferenceRubric.ts';
import { ARGUMENT_QUESTION_FRAME_REASONS } from '../../services/argumentContext/questionBindingTypes.ts';
import type { ArgumentQuestionFrameReason, ArgumentQuestionFrameSelectors, ArgumentQuestionFrameVerification,
  ArgumentQuestionSourceFrame, FrozenArgumentQuestionFrames } from '../../services/argumentContext/questionBindingTypes.ts';
import { adaptSavedKnowledgeNote } from './argumentSourceAdapter.ts';
import type { ArgumentProjectionRuntime } from './argumentProjectionRuntime.ts';

const LIMITATIONS: FrozenArgumentQuestionFrames['limitations'] = { semanticTruth: 'not_certified',
  questionRelevance: 'not_independently_assessed', answerEvaluation: 'not_performed', scoreWrite: 'disabled', cognitionWrite: 'disabled' };
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code: string): never => { throw new Error(`argument_question_frames_${code}`); };
function closed(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_shape');
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail('invalid_shape');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_id');
}
function targets(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 20) return fail('invalid_targets');
  value.forEach(id); if (new Set(value).size !== value.length) fail('invalid_targets');
}
function hashes(value: unknown[]): void { if (value.some(hash => typeof hash !== 'string' || !HASH.test(hash))) fail('invalid_hash'); }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).sort(), bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index]
    && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
const matches = (note: NoteItem, target: string) => note.noteType === 'knowledge' && (note.title === target || !!note.aliases?.includes(target));
const sorted = (ids: string[]) => [...new Set(ids)].sort(compareArgumentContextIds);
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function parseArgumentQuestionFrameSelectors(value: unknown): ArgumentQuestionFrameSelectors {
  closed(value, ['questionMessageId', 'knowledgeTargets', 'assessment', 'referenceRubric']);
  id(value.questionMessageId); targets(value.knowledgeTargets);
  const assessment = parseReviewAssessment(value.assessment, value.knowledgeTargets);
  const referenceRubric = parseReviewReferenceRubric(value.referenceRubric, assessment, value.knowledgeTargets);
  return { questionMessageId: value.questionMessageId, knowledgeTargets: [...value.knowledgeTargets], assessment, referenceRubric };
}

/** Candidate IDs/ranking are selectors. Membership must come from a freshly read saved note. */
async function referenceMembership(selectors: ArgumentQuestionFrameSelectors, notes: NoteItem[]): Promise<ArgumentQuestionFrameReason | null> {
  if (!await verifyReviewReferenceRubric(selectors.referenceRubric, notes)) return 'reference_changed';
  for (const target of selectors.knowledgeTargets) {
    const matching = notes.filter(note => matches(note, target));
    if (matching.length !== 1) return matching.length > 1 ? 'ambiguous_target' : 'reference_changed';
    const note = matching[0], items = selectors.referenceRubric.items.filter(item => item.knowledgeTarget === target);
    if (!items.length || items.some(item => item.noteId !== note.id)) return 'reference_membership_invalid';
    for (const item of items) {
      // Rebuild the existing native catalog, not a model-generated answer. Query only prioritizes
      // bounded candidates; IDs/catalog hash never independently authenticate an interval.
      const catalog = await buildReviewReferenceCatalog([note], [target], [note.id], item.quote);
      if (!catalog.candidates.some(candidate => candidate.noteId === item.noteId && candidate.knowledgeTarget === item.knowledgeTarget
        && candidate.sourceHash === item.sourceHash && candidate.sourceUpdatedAt === item.sourceUpdatedAt
        && candidate.start === item.start && candidate.end === item.end && candidate.quote === item.quote
        && candidate.sectionPath === item.sectionPath)) return 'reference_membership_invalid';
    }
  }
  return null;
}

function within(span: ArgumentEvidenceSpan, items: ReviewReferenceItem[]): boolean {
  return items.some(item => item.start <= span.start && item.end >= span.end && item.quote.slice(span.start - item.start, span.end - item.start) === span.quote);
}
/** Exact original occurrence and all non-whitespace characters, not text similarity. */
function covers(item: ReviewReferenceItem, evidence: ArgumentEvidenceSpan[]): boolean {
  for (let at = item.start; at < item.end; at++) {
    if (/\s/u.test(item.quote[at - item.start])) continue;
    if (!evidence.some(span => span.start <= at && span.end > at)) return false;
  }
  return true;
}
const CRITERION_ROLES: Record<Exclude<ReviewCriterionId, 'inference_link'>, ArgumentContextNode['role'][]> = {
  concept_meaning: ['definition'], concept_boundary: ['definition', 'condition', 'exception'],
  example_fit: ['example'], distinction: ['comparison'], fact_scope: ['fact'],
  condition_scope: ['condition', 'exception'], actual_premise: ['premise', 'fact', 'condition'],
  attribution_scope: ['fact', 'claim', 'condition'],
};

async function frameFor(result: ArgumentProjectionBuildResult, input: ArgumentProjectionBuildInput,
  selectors: ArgumentQuestionFrameSelectors, target: string, items: ReviewReferenceItem[], fixedSeed?: string[]):
  Promise<{ frame: ArgumentQuestionSourceFrame | null; reason: ArgumentQuestionFrameReason }> {
  if (input.sourceQualification.status !== 'eligible' || result.projection.quality.status !== 'eligible') return { frame: null, reason: 'source_not_eligible' };
  const task = selectors.assessment.taskType!;
  // This optional structural shadow has only six reviewed policies. The new textual attribution
  // assessment stays usable; do not invent a structural policy or block the mastery evaluator.
  if (task === 'attribution') return { frame: null, reason: 'task_scope_unavailable' };
  const seeds = fixedSeed ?? sorted(result.projection.build.scopes.filter(scope => scope.task === task && scope.status === 'reviewed_for_scope').map(scope => scope.seedNodeId));
  let reason: ArgumentQuestionFrameReason = 'task_scope_unavailable';
  // One stored reviewed task scope must cover the whole target. Combining unrelated partial
  // scopes, sources, or frames cannot manufacture a complete per-target standard.
  for (const seed of seeds) {
    const pointer = await createArgumentContextPointer(result.projection, result.authority, input.scope, [seed]);
    const pack = await readTaskScopedArgumentContextPack(result.projection, result.authority, { pointer, scope: input.scope, task });
    await validateTaskScopedArgumentContextPack(pack, result.authority, input.scope, result.projection);
    if (pack.completeness.status !== 'complete_for_scope') continue;
    const nodes = pack.nodes.filter(node => node.admission === 'admitted' && node.semanticStatus === 'reviewed'
      && node.evidence.length && node.evidence.every(span => within(span, items)));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const frameItems: ArgumentQuestionSourceFrame['items'] = [];
    let invalid = false;
    for (const item of items) {
      let itemNodes: ArgumentContextNode[], relationIds: string[] = [];
      if (item.criterionId === 'inference_link') {
        const relations = pack.relations.filter(relation => relation.admission === 'admitted' && relation.semanticStatus === 'reviewed'
          && (relation.kind === 'support' || relation.kind === 'oppose') && byId.has(relation.sourceNodeId) && byId.has(relation.targetNodeId)
          // A stored inference may cite both the already-selected actual premise
          // and the inference statement. Retain every original span; never trim
          // it to this criterion or borrow unselected source text. Full coverage
          // of THIS inference item below remains an independent requirement.
          && relation.evidence.length && relation.evidence.every(span => within(span, items)));
        if (!relations.length || !covers(item, relations.flatMap(relation => relation.evidence))) {
          invalid = true; reason = 'inference_relation_missing'; break;
        }
        // Explicit stored condition links are retained when the selected target's originals
        // cover them. They never substitute for the support/oppose inference link itself.
        const conditions = pack.relations.filter(relation => relation.kind === 'requires_condition' && relation.admission === 'admitted'
          && relation.semanticStatus === 'reviewed' && byId.has(relation.sourceNodeId) && byId.has(relation.targetNodeId)
          && relation.evidence.length && relation.evidence.every(span => within(span, items)));
        const selectedRelations = [...relations, ...conditions];
        relationIds = sorted(selectedRelations.map(relation => relation.id));
        itemNodes = sorted(selectedRelations.flatMap(relation => [relation.sourceNodeId, relation.targetNodeId])).map(nodeId => byId.get(nodeId)!);
      } else {
        itemNodes = nodes.filter(node => CRITERION_ROLES[item.criterionId].includes(node.role) && node.evidence.every(span => within(span, [item])));
        if (!itemNodes.length || !covers(item, itemNodes.flatMap(node => node.evidence))) {
          invalid = true; reason = 'item_structure_incomplete'; break;
        }
      }
      frameItems.push({ itemId: item.itemId, criterionId: item.criterionId, start: item.start, end: item.end,
        quote: item.quote, nodeIds: sorted(itemNodes.map(node => node.id)), relationIds });
    }
    if (invalid) continue;
    // Definitions/examples/comparisons may have necessary reviewed links too. Retain
    // only links declared by this task closure, grounded in this original item and
    // any other already-frozen originals needed by the same relation, with
    // BOTH endpoints already covered by the original criterion selections. This does
    // not manufacture an inference link or expand the fixed reference standard.
    const selectedEndpointIds = new Set(frameItems.flatMap(item => item.nodeIds));
    const requiredLinks = new Set(pack.completeness.requiredRelationIds);
    const criterionLinks: Partial<Record<ReviewCriterionId, string[]>> = {
      concept_meaning: ['requires_condition'], concept_boundary: ['requires_condition', 'exception_of'],
      condition_scope: ['requires_condition', 'exception_of'], fact_scope: ['requires_condition', 'exception_of'],
      example_fit: ['illustrates'], distinction: ['contrasts'], actual_premise: ['requires_condition'],
    };
    for (const item of frameItems) {
      const kinds = criterionLinks[item.criterionId]; if (!kinds) continue;
      const original = items.find(entry => entry.itemId === item.itemId)!;
      const links = pack.relations.filter(relation => requiredLinks.has(relation.id) && kinds.includes(relation.kind)
        && relation.admission === 'admitted' && relation.semanticStatus === 'reviewed'
        && selectedEndpointIds.has(relation.sourceNodeId) && selectedEndpointIds.has(relation.targetNodeId)
        && relation.evidence.length && relation.evidence.every(span => within(span, items))
        && relation.evidence.some(span => within(span, [original])));
      item.relationIds = sorted([...item.relationIds, ...links.map(relation => relation.id)]);
    }
    const selectedNodes = new Set(frameItems.flatMap(item => item.nodeIds)), selectedRelations = new Set(frameItems.flatMap(item => item.relationIds));
    if (pack.completeness.requiredNodeIds.some(nodeId => !selectedNodes.has(nodeId))
      || pack.completeness.requiredRelationIds.some(relationId => !selectedRelations.has(relationId))
      || pack.prerequisiteGroups.some(group => group.admission !== 'admitted' || group.semanticStatus !== 'reviewed' || group.operator === 'unknown'
        || !selectedNodes.has(group.conclusionNodeId) || [...group.premiseNodeIds, ...group.conditionNodeIds].some(nodeId => !selectedNodes.has(nodeId))
        || group.relationIds.some(relationId => !selectedRelations.has(relationId)))) {
      reason = 'prerequisite_incomplete'; continue;
    }
    return { frame: { frameId: `target-${selectors.knowledgeTargets.indexOf(target) + 1}`, knowledgeTarget: target,
      noteId: input.source.entityId, source: structuredClone(input.source), sourceScopeHash: input.scopeHash,
      sourceBindingHash: input.sourceBindingHash, structureHash: result.authority.structureHash, seedNodeIds: [seed], pack, items: frameItems }, reason };
  }
  return { frame: null, reason };
}

async function sourceMatchesNote(input: ArgumentProjectionBuildInput, note: NoteItem): Promise<boolean> {
  const saved = await adaptSavedKnowledgeNote({ note, rootScopeId: input.source.rootScopeId, scope: input.scope });
  return input.canonicalText === note.content && await equal(input.source, saved.source);
}
async function compositeHash(frames: ArgumentQuestionSourceFrame[]): Promise<string> {
  return argumentContextHash(frames.map(({ pack, ...frame }) => ({ ...frame, packHash: pack.packHash })));
}

export interface ArgumentQuestionFrameServiceOptions {
  /** Internal host dependency. No request is allowed to provide its own projection or scope. */
  runtime: Pick<ArgumentProjectionRuntime, 'host' | 'store'>;
  /** Independently scoped, freshly loaded SAVED notes, not a renderer draft or stale note cache. */
  readReferenceNotes(): Promise<NoteItem[]>;
}

/**
 * Short sequential source snapshots; never nest source/store locks or hold a lock over a model.
 * The final pass rechecks every frozen source. It observes ordinary concurrent edits, but cannot
 * exclude unobserved external-editor ABA or turn multiple sources into a filesystem transaction.
 * Actual question relevance is still the pre-answer selector's responsibility, not certified here.
 */
export function createArgumentQuestionFrameService(options: ArgumentQuestionFrameServiceOptions) {
  if (!options || typeof options.readReferenceNotes !== 'function' || !options.runtime?.host || !options.runtime?.store) fail('invalid_host');
  const { runtime, readReferenceNotes } = options;

  async function recheckFrames(selectors: ArgumentQuestionFrameSelectors, frames: ArgumentQuestionSourceFrame[], notes: NoteItem[]): Promise<ArgumentQuestionFrameReason[]> {
    const reasons: ArgumentQuestionFrameReason[] = [];
    for (const frame of frames) {
      const note = notes.find(item => item.id === frame.noteId);
      if (!note) { reasons.push('reference_changed'); continue; }
      try {
        const current = await runtime.store.withActive({ kind: 'knowledge-note', entityId: frame.noteId }, async (result, input) => {
          if (!await sourceMatchesNote(input, note) || !equal(input.source, frame.source)
            || input.scopeHash !== frame.sourceScopeHash || input.sourceBindingHash !== frame.sourceBindingHash) return { reason: 'source_changed' as const };
          if (result.authority.structureHash !== frame.structureHash) return { reason: 'projection_changed' as const };
          await validateTaskScopedArgumentContextPack(frame.pack, result.authority, input.scope, result.projection);
          const reread = await frameFor(result, input, selectors, frame.knowledgeTarget,
            selectors.referenceRubric.items.filter(item => item.knowledgeTarget === frame.knowledgeTarget), frame.seedNodeIds);
          // Fixed seed and exact original criterion mappings only. No new seed/item selection.
          if (!reread.frame || !equal(reread.frame, frame)) return { reason: 'snapshot_changed' as const };
          return { reason: null };
        });
        if (current === null) reasons.push('projection_unavailable');
        else if (current.reason) reasons.push(current.reason);
      } catch { reasons.push('source_unavailable'); }
    }
    return [...new Set(reasons)];
  }

  async function finish(selectors: ArgumentQuestionFrameSelectors, frames: ArgumentQuestionSourceFrame[], reasons: ArgumentQuestionFrameReason[]): Promise<FrozenArgumentQuestionFrames> {
    const body: Omit<FrozenArgumentQuestionFrames, 'contractHash'> = {
      version: 1, contractVersion: 'argument-question-frames-v1', originQuestionMessageId: selectors.questionMessageId,
      rootScopeId: runtime.host.rootScopeId, taskType: selectors.assessment.taskType, knowledgeTargets: [...selectors.knowledgeTargets],
      assessment: structuredClone(selectors.assessment), referenceRubric: structuredClone(selectors.referenceRubric),
      rubricHash: await argumentContextHash(selectors.referenceRubric), snapshotBindingHash: await compositeHash(frames),
      status: reasons.length ? 'held' : 'fixed', policy: 'all_target_frames', frames: structuredClone(frames),
      reasons: [...new Set(reasons)], limitations: { ...LIMITATIONS },
    };
    return deepFreeze({ ...body, contractHash: await argumentContextHash(body) });
  }

  async function prepare(value: ArgumentQuestionFrameSelectors): Promise<FrozenArgumentQuestionFrames> {
    const selectors = parseArgumentQuestionFrameSelectors(structuredClone(value)), reasons: ArgumentQuestionFrameReason[] = [], frames: ArgumentQuestionSourceFrame[] = [];
    if (selectors.assessment.status !== 'fixed') return finish(selectors, frames, ['task_unavailable']);
    if (selectors.referenceRubric.status !== 'fixed') return finish(selectors, frames, ['reference_unavailable']);
    let notes: NoteItem[];
    try { notes = structuredClone(await readReferenceNotes()); }
    catch { return finish(selectors, frames, ['reference_changed']); }
    const membership = await referenceMembership(selectors, notes);
    if (membership) return finish(selectors, frames, [membership]);
    for (const target of selectors.knowledgeTargets) {
      const items = selectors.referenceRubric.items.filter(item => item.knowledgeTarget === target), note = notes.find(item => item.id === items[0].noteId)!;
      try {
        const selected = await runtime.store.withActive({ kind: 'knowledge-note', entityId: note.id }, async (result, input) => {
          if (!await sourceMatchesNote(input, note)) return { frame: null, reason: 'source_changed' as const };
          return frameFor(result, input, selectors, target, items);
        });
        if (selected?.frame) frames.push(selected.frame); else reasons.push(selected?.reason ?? 'projection_unavailable');
      } catch { reasons.push('source_unavailable'); }
    }
    try {
      const after = structuredClone(await readReferenceNotes()), changed = await referenceMembership(selectors, after);
      if (changed) reasons.push(changed);
      reasons.push(...await recheckFrames(selectors, frames, after));
      // A source may change while the final sequential structure pass is reading another source.
      if (!await verifyReviewReferenceRubric(selectors.referenceRubric, await readReferenceNotes())) reasons.push('reference_changed');
    } catch { reasons.push('source_unavailable'); }
    return finish(selectors, frames, reasons);
  }

  async function verify(value: FrozenArgumentQuestionFrames): Promise<ArgumentQuestionFrameVerification> {
    const contract = structuredClone(value);
    const held = (reasons: ArgumentQuestionFrameReason[]): ArgumentQuestionFrameVerification => ({ status: 'held',
      contractHash: typeof contract?.contractHash === 'string' && HASH.test(contract.contractHash) ? contract.contractHash : '0'.repeat(64), reasons: [...new Set(reasons)] });
    let selectors: ArgumentQuestionFrameSelectors;
    try {
      closed(contract, ['version', 'contractVersion', 'contractHash', 'originQuestionMessageId', 'rootScopeId', 'taskType', 'knowledgeTargets',
        'assessment', 'referenceRubric', 'rubricHash', 'snapshotBindingHash', 'status', 'policy', 'frames', 'reasons', 'limitations']);
      id(contract.originQuestionMessageId); id(contract.rootScopeId); hashes([contract.contractHash, contract.rubricHash, contract.snapshotBindingHash]);
      if (contract.version !== 1 || contract.contractVersion !== 'argument-question-frames-v1' || contract.policy !== 'all_target_frames'
        || !['fixed', 'held'].includes(contract.status) || contract.rootScopeId !== runtime.host.rootScopeId
        || !Array.isArray(contract.frames) || contract.frames.length > 20 || !Array.isArray(contract.reasons)
        || contract.reasons.length > ARGUMENT_QUESTION_FRAME_REASONS.length
        || contract.reasons.some(reason => !ARGUMENT_QUESTION_FRAME_REASONS.includes(reason))
        || new Set(contract.reasons).size !== contract.reasons.length || !equal(contract.limitations, LIMITATIONS)) return held(['contract_invalid']);
      const { contractHash, ...body } = contract;
      if (await argumentContextHash(body) !== contractHash) return held(['contract_invalid']);
      selectors = parseArgumentQuestionFrameSelectors({ questionMessageId: contract.originQuestionMessageId, knowledgeTargets: contract.knowledgeTargets,
        assessment: contract.assessment, referenceRubric: contract.referenceRubric });
      if (contract.taskType !== selectors.assessment.taskType || contract.rubricHash !== await argumentContextHash(selectors.referenceRubric)
        || contract.snapshotBindingHash !== await compositeHash(contract.frames)) return held(['contract_invalid']);
      if (contract.status === 'held') return held(contract.reasons.length ? contract.reasons : ['contract_invalid']);
      if (contract.reasons.length || selectors.assessment.status !== 'fixed' || selectors.referenceRubric.status !== 'fixed'
        || contract.frames.length !== selectors.knowledgeTargets.length) return held(['contract_invalid']);
      for (const [index, frame] of contract.frames.entries()) {
        closed(frame, ['frameId', 'knowledgeTarget', 'noteId', 'source', 'sourceScopeHash', 'sourceBindingHash', 'structureHash', 'seedNodeIds', 'pack', 'items']);
        closed(frame.source, ['kind', 'entityId', 'rootScopeId', 'version', 'contentHash', 'coordinateSpace', 'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion']);
        if (frame.frameId !== `target-${index + 1}` || frame.knowledgeTarget !== selectors.knowledgeTargets[index]
          || frame.noteId !== frame.source.entityId || frame.source.kind !== 'knowledge-note'
          || frame.source.rootScopeId !== contract.rootScopeId || !Array.isArray(frame.seedNodeIds) || frame.seedNodeIds.length !== 1
          || !Array.isArray(frame.items) || !frame.items.length || frame.items.length > 12) return held(['contract_invalid']);
        hashes([frame.sourceScopeHash, frame.sourceBindingHash, frame.structureHash]);
        for (const item of frame.items) closed(item, ['itemId', 'criterionId', 'start', 'end', 'quote', 'nodeIds', 'relationIds']);
      }
    } catch { return held(['contract_invalid']); }
    try {
      const notes = structuredClone(await readReferenceNotes()), membership = await referenceMembership(selectors, notes);
      if (membership) return held([membership]);
      const reasons = await recheckFrames(selectors, contract.frames, notes);
      if (!await verifyReviewReferenceRubric(selectors.referenceRubric, await readReferenceNotes())) reasons.push('reference_changed');
      return reasons.length ? held(reasons) : { status: 'current', contractHash: contract.contractHash, reasons: [] };
    } catch { return held(['source_unavailable']); }
  }
  return { prepare, verify };
}
