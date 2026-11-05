import { REVIEW_ASSESSMENT_CRITERIA, REVIEW_ASSESSMENT_TASKS } from '../reviewAssessment';
import { argumentContextHash } from './hash';
import { validateArgumentContextPack } from './validator';
import { ARGUMENT_CONTEXT_LIMITS, ARGUMENT_CONTEXT_TASKS } from './types';
import type {
  ArgumentContextAuthority, ArgumentContextPack, ArgumentContextProjection, ArgumentContextScope,
  ArgumentContextTask, ArgumentEvidenceSpan, ArgumentFrameSelection,
  FrozenArgumentSourceFrames,
} from './types';

export interface ArgumentSourceFramesInput {
  questionMessageId: string;
  scope: ArgumentContextScope;
  task: ArgumentContextTask;
  policy: FrozenArgumentSourceFrames['policy'];
  /** Authoritative, independently supplied stored projections, not model-authenticated pack claims. */
  packs: { pack: ArgumentContextPack; authority: ArgumentContextAuthority; projection: ArgumentContextProjection }[];
  selections: ArgumentFrameSelection[];
}

const MAX_FRAMES = 20;
const MAX_ITEMS = 12;
const MAX_REASONS = 128;
const MAX_SCOPE_ENTITIES = 20000;
const HASH = /^[a-f0-9]{64}$/;
const fail = (reason: string): never => { throw new Error(`来源框架契约无效：${reason}`); };

function closed(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('object');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !fields.includes(key) && !optional.includes(key))
    || fields.some((key) => !Object.hasOwn(item, key))) return fail('fields');
  return item;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || /^(?:[a-z]:[\\/]|[\\/])/i.test(value)) return fail('id');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) return fail('hash');
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail('array');
}
function ids(value: unknown, max: number): asserts value is string[] {
  list(value, max);
  value.forEach(id);
  if (new Set(value).size !== value.length) return fail('duplicate_id');
}
function identityShape(value: unknown): void {
  const source = closed(value, ['kind', 'entityId', 'rootScopeId', 'version', 'contentHash', 'coordinateSpace',
    'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion'], ['personal']);
  if (!['knowledge-note', 'uploaded-document', 'personal-cognition'].includes(source.kind as string)
    || !['saved-note-utf16', 'parsed-text-utf16', 'personal-expression-utf16'].includes(source.coordinateSpace as string)) return fail('source_kind');
  ['entityId', 'rootScopeId', 'version', 'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion'].forEach((key) => id(source[key]));
  hash(source.contentHash);
  if (Object.hasOwn(source, 'personal')) {
    const personal = closed(source.personal, ['recordId', 'revisionId', 'branchId']);
    Object.values(personal).forEach(id);
  }
}
function scopeShape(value: unknown): void {
  const scope = closed(value, ['scopeId', 'rootScopeId', 'corpus', 'allowedSourceKinds', 'allowedNoteIds', 'allowedDocIds', 'allowedRecordIds']);
  id(scope.scopeId); id(scope.rootScopeId);
  if (!['reference', 'personal'].includes(scope.corpus as string)) return fail('corpus');
  ids(scope.allowedSourceKinds, 3);
  if (scope.allowedSourceKinds.some((kind) => !['knowledge-note', 'uploaded-document', 'personal-cognition'].includes(kind))) return fail('source_kind');
  ['allowedNoteIds', 'allowedDocIds', 'allowedRecordIds'].forEach((key) => ids(scope[key], MAX_SCOPE_ENTITIES));
}
function spanShape(value: unknown): void {
  const span = closed(value, ['sentenceId', 'start', 'end', 'quote']);
  id(span.sentenceId);
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || (span.start as number) < 0
    || (span.end as number) <= (span.start as number) || (span.end as number) > ARGUMENT_CONTEXT_LIMITS.sourceCharacters
    || typeof span.quote !== 'string' || !span.quote.length || span.quote.length > ARGUMENT_CONTEXT_LIMITS.readCharacters) return fail('span');
}
function selectionShape(value: unknown, frozen = false): void {
  const frame = closed(value, ['frameId', 'packHash', 'scopeEvidence', 'items', ...(frozen ? ['source', 'structureHash', 'seedNodeIds'] : [])]);
  id(frame.frameId); hash(frame.packHash);
  list(frame.scopeEvidence, ARGUMENT_CONTEXT_LIMITS.evidence);
  frame.scopeEvidence.forEach(spanShape);
  list(frame.items, MAX_ITEMS);
  for (const valueItem of frame.items) {
    const item = closed(valueItem, ['itemId', 'criterionId', 'nodeIds', 'relationIds']);
    id(item.itemId);
    if (typeof item.criterionId !== 'string' || !Object.hasOwn(REVIEW_ASSESSMENT_CRITERIA, item.criterionId)) return fail('criterion');
    ids(item.nodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes);
    ids(item.relationIds, ARGUMENT_CONTEXT_LIMITS.readRelations);
  }
  if (frozen) { identityShape(frame.source); hash(frame.structureHash); ids(frame.seedNodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes); }
}
function uniqueSelections(selections: ArgumentFrameSelection[]): void {
  const frames = new Set<string>(), items = new Set<string>();
  for (const frame of selections) {
    if (frames.has(frame.frameId)) return fail('duplicate_frame');
    frames.add(frame.frameId);
    for (const item of frame.items) {
      if (items.has(item.itemId)) return fail('duplicate_item');
      items.add(item.itemId);
    }
  }
}
function inputShape(value: ArgumentSourceFramesInput): void {
  closed(value, ['questionMessageId', 'scope', 'task', 'policy', 'packs', 'selections']);
  id(value.questionMessageId); scopeShape(value.scope);
  if (!(ARGUMENT_CONTEXT_TASKS as readonly string[]).includes(value.task)) return fail('task');
  if (!['any_allowed_frame', 'all_selected_frames'].includes(value.policy)) return fail('policy');
  list(value.packs, MAX_FRAMES); list(value.selections, MAX_FRAMES);
  const packs = new Set<string>();
  for (const entry of value.packs) {
    closed(entry, ['pack', 'authority', 'projection']);
    if (!entry.pack || typeof entry.pack !== 'object') return fail('pack');
    hash(entry.pack.packHash);
    if (packs.has(entry.pack.packHash)) return fail('duplicate_pack');
    packs.add(entry.pack.packHash);
  }
  value.selections.forEach((frame) => selectionShape(frame));
  uniqueSelections(value.selections);
}

function boundarySplitsSurrogate(text: string, offset: number): boolean {
  if (!offset || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
function withinScope(span: ArgumentEvidenceSpan, scope: ArgumentEvidenceSpan[]): boolean {
  return scope.some((entry) => entry.sentenceId === span.sentenceId && entry.start <= span.start && entry.end >= span.end);
}
function validateFrameEvidence(frame: ArgumentFrameSelection, pack: ArgumentContextPack, authority: ArgumentContextAuthority): void {
  const sentences = new Map(pack.hierarchy.sentences.map((sentence) => [sentence.id, sentence]));
  const nodes = new Map(pack.nodes.map((node) => [node.id, node]));
  const relations = new Map(pack.relations.map((relation) => [relation.id, relation]));
  const seenSpans = new Set<string>();
  let characters = 0;
  for (const span of frame.scopeEvidence) {
    const sentence = sentences.get(span.sentenceId), key = `${span.sentenceId}:${span.start}:${span.end}`;
    if (!sentence || span.start < sentence.start || span.end > sentence.end || span.end > authority.canonicalText.length
      || authority.canonicalText.slice(span.start, span.end) !== span.quote
      || boundarySplitsSurrogate(authority.canonicalText, span.start) || boundarySplitsSurrogate(authority.canonicalText, span.end)
      || seenSpans.has(key)) return fail('scope_evidence');
    seenSpans.add(key); characters += span.quote.length;
  }
  if (characters > ARGUMENT_CONTEXT_LIMITS.readCharacters) return fail('scope_character_budget');
  for (const item of frame.items) {
    const itemNodes = new Set(item.nodeIds);
    for (const nodeId of item.nodeIds) {
      const node = nodes.get(nodeId);
      if (!node || node.admission !== 'admitted' || node.semanticStatus !== 'reviewed'
        || !pack.completeness.readNodeIds.includes(nodeId)
        || node.evidence.some((span) => !withinScope(span, frame.scopeEvidence))) return fail('item_node');
    }
    for (const relationId of item.relationIds) {
      const relation = relations.get(relationId);
      if (!relation || relation.admission !== 'admitted' || relation.semanticStatus !== 'reviewed'
        || !pack.completeness.readRelationIds.includes(relationId)
        || !itemNodes.has(relation.sourceNodeId) || !itemNodes.has(relation.targetNodeId)
        || relation.evidence.some((span) => !withinScope(span, frame.scopeEvidence))) return fail('item_relation');
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

/**
 * S1 freezes only the declared, stored source/structure scope. It neither reads an answer nor
 * independently certifies question relevance, source truth or the reviewer's semantic decision.
 * All selected frames must be admitted before freezing; the policy cannot splice their criteria.
 */
export async function freezeArgumentSourceFrames(input: ArgumentSourceFramesInput): Promise<FrozenArgumentSourceFrames> {
  const snapshot = structuredClone(input);
  inputShape(snapshot);
  const reasons: string[] = [], frames: FrozenArgumentSourceFrames['frames'] = [];
  const reason = (code: string, frameId?: string): void => { reasons.push(frameId ? `${code}:${frameId}` : code); };
  const supportedTask = Object.hasOwn(REVIEW_ASSESSMENT_TASKS, snapshot.task);
  const criteria: readonly string[] = supportedTask
    ? REVIEW_ASSESSMENT_TASKS[snapshot.task as keyof typeof REVIEW_ASSESSMENT_TASKS].criterionIds : [];
  if (!supportedTask) reason('unsupported_assessment_task');
  if (snapshot.task === 'comparison' && snapshot.policy !== 'all_selected_frames') reason('comparison_requires_all');
  if (!snapshot.selections.length) reason('no_selected_frames');
  const packs = new Map(snapshot.packs.map((entry) => [entry.pack.packHash, entry]));
  const verified = new Set<string>();
  for (const selection of snapshot.selections) {
    const entry = packs.get(selection.packHash);
    if (!entry) { reason('missing_pack', selection.frameId); continue; }
    if (!verified.has(selection.packHash)) {
      await validateArgumentContextPack(entry.pack, entry.authority, snapshot.scope, entry.projection);
      verified.add(selection.packHash);
    }
    const { pack, authority } = entry;
    if (supportedTask && pack.task !== snapshot.task) return fail('pack_task');
    validateFrameEvidence(selection, pack, authority);
    if (snapshot.scope.corpus !== 'reference' || pack.source.kind === 'personal-cognition') reason('personal_source_not_reference', selection.frameId);
    if (pack.quality.status !== 'eligible') reason('source_quality_not_eligible', selection.frameId);
    if (pack.completeness.status !== 'complete_for_scope') reason('source_frame_not_complete', selection.frameId);
    if (!selection.scopeEvidence.length) reason('missing_scope_evidence', selection.frameId);
    if (!selection.items.length) reason('missing_frame_items', selection.frameId);
    if (supportedTask) {
      if (selection.items.some((item) => !criteria.includes(item.criterionId))) return fail('task_criterion');
      if (criteria.some((criterion) => !selection.items.some((item) => item.criterionId === criterion))) reason('incomplete_criteria', selection.frameId);
    }
    for (const item of selection.items) {
      if (!item.nodeIds.length) reason('missing_item_nodes', selection.frameId);
      // Supports and rebuttals are stored logical links; a condition/example alone is not one.
      // Their presence still does not certify semantic sufficiency or the user's answer.
      if (item.criterionId === 'inference_link' && !item.relationIds.some((relationId) => {
        const kind = pack.relations.find((relation) => relation.id === relationId)?.kind;
        return kind === 'support' || kind === 'oppose';
      })) {
        reason('missing_inference_relation', selection.frameId);
      }
    }
    const frameNodes = new Set(selection.items.flatMap((item) => item.nodeIds));
    const frameRelations = new Set(selection.items.flatMap((item) => item.relationIds));
    for (const group of snapshot.task === 'reasoning' ? pack.prerequisiteGroups : []) {
      if (frameNodes.has(group.conclusionNodeId)
        && ([...group.premiseNodeIds, ...group.conditionNodeIds].some((nodeId) => !frameNodes.has(nodeId))
          || group.relationIds.some((relationId) => !frameRelations.has(relationId)))) reason('incomplete_frame_prerequisites', selection.frameId);
    }
    frames.push({ ...selection, source: pack.source, structureHash: pack.structureHash, seedNodeIds: [...pack.seedNodeIds] });
  }
  const distinctReasons = [...new Set(reasons)];
  if (distinctReasons.length > MAX_REASONS) return fail('reasons');
  const body: Omit<FrozenArgumentSourceFrames, 'contractHash'> = {
    version: 1, contractVersion: 'argument-source-frames-v1', questionMessageId: snapshot.questionMessageId,
    scopeId: snapshot.scope.scopeId, scopeHash: await argumentContextHash(snapshot.scope),
    task: snapshot.task, scope: 'question_items', policy: snapshot.policy,
    status: distinctReasons.length ? 'held' : 'fixed', frames, reasons: distinctReasons,
    limitations: { answerEvaluation: 'not_performed', scoreWrite: 'disabled', cognitionWrite: 'disabled' },
  };
  const candidate = { ...body, contractHash: await argumentContextHash(body) };
  frozenShape(candidate);
  return deepFreeze(candidate);
}

function frozenShape(value: unknown): asserts value is FrozenArgumentSourceFrames {
  const contract = closed(value, ['version', 'contractVersion', 'contractHash', 'questionMessageId', 'scopeId', 'scopeHash', 'task', 'scope', 'policy', 'status', 'frames', 'reasons', 'limitations']);
  if (contract.version !== 1 || contract.contractVersion !== 'argument-source-frames-v1' || contract.scope !== 'question_items'
    || !['fixed', 'held'].includes(contract.status as string)
    || !['any_allowed_frame', 'all_selected_frames'].includes(contract.policy as string)
    || !(ARGUMENT_CONTEXT_TASKS as readonly string[]).includes(contract.task as string)) return fail('contract');
  hash(contract.contractHash); hash(contract.scopeHash); id(contract.questionMessageId); id(contract.scopeId);
  list(contract.frames, MAX_FRAMES);
  contract.frames.forEach((frame) => selectionShape(frame, true));
  uniqueSelections(contract.frames as ArgumentFrameSelection[]);
  list(contract.reasons, MAX_REASONS);
  if (contract.reasons.some((reason) => typeof reason !== 'string' || !reason.length || reason.length > 400)
    || new Set(contract.reasons).size !== contract.reasons.length) return fail('reasons');
  const limitations = closed(contract.limitations, ['answerEvaluation', 'scoreWrite', 'cognitionWrite']);
  if (limitations.answerEvaluation !== 'not_performed' || limitations.scoreWrite !== 'disabled' || limitations.cognitionWrite !== 'disabled') return fail('limitations');
}

/** Replays the same pre-answer input; changed authorities/scopes/selection cannot rebind an old question. */
export async function validateFrozenArgumentSourceFrames(contract: FrozenArgumentSourceFrames, input: ArgumentSourceFramesInput): Promise<void> {
  const snapshot = structuredClone(contract), originalInput = structuredClone(input);
  frozenShape(snapshot);
  const { contractHash, ...body } = snapshot;
  if (await argumentContextHash(body) !== contractHash) return fail('contract_hash');
  const expected = await freezeArgumentSourceFrames(originalInput);
  if (expected.contractHash !== contractHash || await argumentContextHash(expected) !== await argumentContextHash(snapshot)) return fail('question_snapshot_changed');
}
