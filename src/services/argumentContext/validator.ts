import { argumentCanonicalTextHash, argumentContextHash, compareArgumentContextIds } from './hash';
import {
  ARGUMENT_CONTEXT_GAP_CODES, ARGUMENT_CONTEXT_LIMITS, ARGUMENT_CONTEXT_RELATIONS,
  ARGUMENT_CONTEXT_ROLES, ARGUMENT_CONTEXT_TASKS, DEFAULT_ARGUMENT_CONTEXT_BUDGET,
  type ArgumentContextAuthority, type ArgumentContextBudget, type ArgumentContextHierarchy,
  type ArgumentContextPack, type ArgumentContextProjection, type ArgumentContextRequest,
  type ArgumentContextScope, type ArgumentEvidenceSpan, type ArgumentSourceIdentity,
} from './types';

const SOURCE_KINDS = ['knowledge-note', 'uploaded-document', 'personal-cognition'];
const BLOCK_KINDS = ['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes'];
const LEGACY_FUNCTION_TYPES = ['定义', '对比', '假设', '举例', '推理', '反例削弱', '建议对策', '命名', '事实陈述'];
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code: string): never => { throw new Error(`argument_context_${code}`); };

function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key) && !optional.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(item, key))) fail('invalid_shape');
  return item;
}
function string(value: unknown, limit = 300): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > limit || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_string');
}
function enumeration(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('invalid_enum');
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_array');
}
function ids(value: unknown, maximum: number, nonempty = false): asserts value is string[] {
  array(value, maximum);
  value.forEach((id) => string(id));
  if ((nonempty && !value.length) || new Set(value).size !== value.length) fail('invalid_ids');
}
function uniqueRows(rows: { id: string }[]): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) fail('duplicate_id');
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid_integer');
}
function utf16Boundary(text: string, position: number): boolean {
  const before = text.charCodeAt(position - 1);
  const after = text.charCodeAt(position);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
function interval(text: string, start: unknown, end: unknown): void {
  integer(start, 0, text.length); integer(end, 1, text.length);
  if (end <= start || !utf16Boundary(text, start) || !utf16Boundary(text, end)) fail('invalid_span');
}
function sourceIdentity(input: ArgumentSourceIdentity): void {
  object(input, ['kind', 'entityId', 'rootScopeId', 'version', 'contentHash', 'coordinateSpace',
    'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion'], ['personal']);
  enumeration(input.kind, SOURCE_KINDS);
  string(input.entityId); string(input.rootScopeId); string(input.version);
  // Roots are opaque capabilities, not paths to expose to a model-facing pack.
  if (/[\\/]/u.test(input.rootScopeId) || /^[A-Za-z]:/u.test(input.rootScopeId)) fail('invalid_root_scope');
  if (typeof input.contentHash !== 'string' || !HASH.test(input.contentHash)) fail('invalid_hash');
  for (const key of ['parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion'] as const) string(input[key]);
  const expectedCoordinate = input.kind === 'knowledge-note' ? 'saved-note-utf16'
    : input.kind === 'uploaded-document' ? 'parsed-text-utf16' : 'personal-expression-utf16';
  if (input.coordinateSpace !== expectedCoordinate) fail('coordinate_mismatch');
  if (input.kind === 'personal-cognition') {
    object(input.personal, ['recordId', 'revisionId', 'branchId']);
    string(input.personal!.recordId); string(input.personal!.revisionId); string(input.personal!.branchId);
    if (input.entityId !== input.personal!.recordId || input.version !== input.personal!.revisionId) fail('personal_identity_mismatch');
  } else if (input.personal !== undefined) fail('source_kind_mismatch');
}
function scopeAuthority(scope: ArgumentContextScope, source: ArgumentSourceIdentity): void {
  object(scope, ['scopeId', 'rootScopeId', 'corpus', 'allowedSourceKinds', 'allowedNoteIds', 'allowedDocIds', 'allowedRecordIds']);
  string(scope.scopeId); string(scope.rootScopeId); enumeration(scope.corpus, ['reference', 'personal']);
  if (/[\\/]/u.test(scope.rootScopeId) || /^[A-Za-z]:/u.test(scope.rootScopeId)) fail('invalid_root_scope');
  ids(scope.allowedSourceKinds, 3); scope.allowedSourceKinds.forEach((kind) => enumeration(kind, SOURCE_KINDS));
  ids(scope.allowedNoteIds, 20000); ids(scope.allowedDocIds, 20000); ids(scope.allowedRecordIds, 20000);
  if (scope.rootScopeId !== source.rootScopeId || !scope.allowedSourceKinds.includes(source.kind)) fail('scope_denied');
  if (scope.corpus === 'reference' && source.kind === 'personal-cognition'
    || scope.corpus === 'personal' && source.kind !== 'personal-cognition') fail('corpus_denied');
  const authorized = source.kind === 'knowledge-note' ? scope.allowedNoteIds.includes(source.entityId)
    : source.kind === 'uploaded-document' ? scope.allowedDocIds.includes(source.entityId)
      : scope.allowedRecordIds.includes(source.personal!.recordId);
  if (!authorized) fail('source_denied');
}
function locator(value: unknown): void {
  const raw = value as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_locator');
  if (raw.kind === 'text') {
    object(raw, ['kind', 'charStart', 'charEnd']);
    integer(raw.charStart, 0, Number.MAX_SAFE_INTEGER); integer(raw.charEnd, 1, Number.MAX_SAFE_INTEGER);
    if (raw.charEnd <= raw.charStart) fail('invalid_locator');
  } else if (raw.kind === 'pdf') {
    object(raw, ['kind', 'page'], ['bbox']); integer(raw.page, 1, 1000000);
    if (raw.bbox !== undefined && (!Array.isArray(raw.bbox) || raw.bbox.length !== 4
      || raw.bbox.some((part) => typeof part !== 'number' || !Number.isFinite(part))
      || raw.bbox[2] < raw.bbox[0] || raw.bbox[3] < raw.bbox[1])) fail('invalid_locator');
  } else if (raw.kind === 'docx') {
    object(raw, ['kind', 'paragraphIndex'], ['runStart', 'runEnd']); integer(raw.paragraphIndex, 0, 1000000);
    if (raw.runStart !== undefined) integer(raw.runStart, 0, Number.MAX_SAFE_INTEGER);
    if (raw.runEnd !== undefined) integer(raw.runEnd, 0, Number.MAX_SAFE_INTEGER);
    if (raw.runStart !== undefined && raw.runEnd !== undefined && raw.runEnd < raw.runStart) fail('invalid_locator');
  } else if (raw.kind === 'pptx') {
    object(raw, ['kind', 'slideIndex'], ['shapeIndex', 'notes']); integer(raw.slideIndex, 0, 1000000);
    if (raw.shapeIndex !== undefined) integer(raw.shapeIndex, 0, 1000000);
    if (raw.notes !== undefined && typeof raw.notes !== 'boolean') fail('invalid_locator');
  } else fail('invalid_locator');
}
function hierarchy(input: ArgumentContextHierarchy, text: string): Map<string, ArgumentContextHierarchy['sentences'][number]> {
  object(input, ['sections', 'blocks', 'sentences']);
  array(input.sections, ARGUMENT_CONTEXT_LIMITS.sections); array(input.blocks, ARGUMENT_CONTEXT_LIMITS.blocks);
  array(input.sentences, ARGUMENT_CONTEXT_LIMITS.sentences);
  input.sections.forEach((section) => {
    object(section, ['id', 'path', 'parentId']); string(section.id);
    if (typeof section.path !== 'string' || section.path.length > 4000) fail('invalid_section');
    if (section.parentId !== null) string(section.parentId);
  });
  uniqueRows(input.sections);
  const sections = new Map(input.sections.map((item) => [item.id, item]));
  for (const section of input.sections) {
    const visited = new Set([section.id]);
    let parent = section.parentId;
    while (parent !== null) {
      if (visited.has(parent) || !sections.has(parent)) fail('invalid_section_parent');
      visited.add(parent); parent = sections.get(parent)!.parentId;
    }
  }
  input.blocks.forEach((block) => {
    object(block, ['id', 'kind', 'sectionId', 'start', 'end', 'previousId', 'nextId'], ['locator']);
    string(block.id); enumeration(block.kind, BLOCK_KINDS); interval(text, block.start, block.end);
    if (block.sectionId !== null && (!sections.has(block.sectionId) || typeof block.sectionId !== 'string')) fail('missing_section');
    if (block.previousId !== null) string(block.previousId);
    if (block.nextId !== null) string(block.nextId);
    if (block.locator !== undefined) locator(block.locator);
  });
  uniqueRows(input.blocks);
  const blocks = new Map(input.blocks.map((item) => [item.id, item]));
  const ordered = [...input.blocks].sort((a, b) => a.start - b.start || compareArgumentContextIds(a.id, b.id));
  for (let index = 0; index < ordered.length; index += 1) {
    const block = ordered[index];
    if (index > 0 && ordered[index - 1].end > block.start) fail('overlapping_blocks');
    if (block.previousId !== null && (ordered[index - 1]?.id !== block.previousId
      || blocks.get(block.previousId)?.nextId !== block.id)) fail('invalid_block_adjacency');
    if (block.nextId !== null && (ordered[index + 1]?.id !== block.nextId
      || blocks.get(block.nextId)?.previousId !== block.id)) fail('invalid_block_adjacency');
  }
  input.sentences.forEach((sentence) => {
    object(sentence, ['id', 'blockId', 'start', 'end', 'quote']); string(sentence.id); string(sentence.blockId);
    interval(text, sentence.start, sentence.end);
    const block = blocks.get(sentence.blockId);
    if (!block || sentence.start < block.start || sentence.end > block.end) fail('invalid_sentence_container');
    if (typeof sentence.quote !== 'string' || sentence.quote !== text.slice(sentence.start, sentence.end)) fail('quote_mismatch');
  });
  uniqueRows(input.sentences);
  return new Map(input.sentences.map((item) => [item.id, item]));
}
function evidence(input: ArgumentEvidenceSpan[], text: string, sentences: ReturnType<typeof hierarchy>): void {
  array(input, ARGUMENT_CONTEXT_LIMITS.evidence);
  if (!input.length) fail('missing_evidence');
  const signatures = new Set<string>();
  for (const span of input) {
    object(span, ['sentenceId', 'start', 'end', 'quote']); string(span.sentenceId);
    interval(text, span.start, span.end);
    const sentence = sentences.get(span.sentenceId);
    if (!sentence || span.start < sentence.start || span.end > sentence.end) fail('invalid_evidence_sentence');
    if (typeof span.quote !== 'string' || span.quote !== text.slice(span.start, span.end)) fail('quote_mismatch');
    const key = `${span.sentenceId}:${span.start}:${span.end}`;
    if (signatures.has(key)) fail('duplicate_evidence');
    signatures.add(key);
  }
}
function storedDecision(input: { admission: unknown; semanticStatus: unknown }): void {
  enumeration(input.admission, ['admitted', 'audit_only']); enumeration(input.semanticStatus, ['reviewed', 'unreviewed']);
}
function graph(projection: Pick<ArgumentContextProjection, 'nodes' | 'relations' | 'prerequisiteGroups'>,
  text: string, sentences: ReturnType<typeof hierarchy>): void {
  array(projection.nodes, ARGUMENT_CONTEXT_LIMITS.nodes); array(projection.relations, ARGUMENT_CONTEXT_LIMITS.relations);
  array(projection.prerequisiteGroups, ARGUMENT_CONTEXT_LIMITS.groups);
  projection.nodes.forEach((node) => {
    object(node, ['id', 'role', 'evidence', 'admission', 'semanticStatus'], ['legacyFunctionType']); string(node.id);
    enumeration(node.role, ARGUMENT_CONTEXT_ROLES); storedDecision(node); evidence(node.evidence, text, sentences);
    if (node.legacyFunctionType !== undefined) enumeration(node.legacyFunctionType, LEGACY_FUNCTION_TYPES);
  }); uniqueRows(projection.nodes);
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  projection.relations.forEach((relation) => {
    object(relation, ['id', 'sourceNodeId', 'targetNodeId', 'kind', 'evidence', 'admission', 'semanticStatus']);
    string(relation.id); string(relation.sourceNodeId); string(relation.targetNodeId);
    enumeration(relation.kind, ARGUMENT_CONTEXT_RELATIONS); storedDecision(relation);
    evidence(relation.evidence, text, sentences);
    const source = nodes.get(relation.sourceNodeId), target = nodes.get(relation.targetNodeId);
    if (!source || !target) fail('orphan_relation');
    if (source.id === target.id) fail('self_relation');
    const preciseEvidence = (node: typeof source) => [...new Set(node!.evidence.map((span) => `${span.start}:${span.end}`))].sort().join('|');
    if (relation.kind === 'support' && source.role === target.role
      && preciseEvidence(source) === preciseEvidence(target)) fail('copied_self_support');
  }); uniqueRows(projection.relations);
  const relationById = new Map(projection.relations.map((relation) => [relation.id, relation]));
  projection.prerequisiteGroups.forEach((group) => {
    object(group, ['id', 'conclusionNodeId', 'premiseNodeIds', 'conditionNodeIds', 'relationIds', 'operator', 'admission', 'semanticStatus']);
    string(group.id); string(group.conclusionNodeId);
    if (!nodes.has(group.conclusionNodeId)) fail('invalid_prerequisite_conclusion');
    ids(group.premiseNodeIds, ARGUMENT_CONTEXT_LIMITS.nodes); ids(group.conditionNodeIds, ARGUMENT_CONTEXT_LIMITS.nodes);
    ids(group.relationIds, ARGUMENT_CONTEXT_LIMITS.relations); enumeration(group.operator, ['all', 'any', 'unknown']); storedDecision(group);
    if (group.premiseNodeIds.includes(group.conclusionNodeId) || group.conditionNodeIds.includes(group.conclusionNodeId)
      || group.premiseNodeIds.some((id) => group.conditionNodeIds.includes(id))) fail('invalid_prerequisite_group');
    // Missing named members are retained as a gap; they never create invented premises.
    if (group.operator !== 'unknown' && !group.premiseNodeIds.length && !group.conditionNodeIds.length) fail('invalid_prerequisite_group');
    for (const id of group.relationIds) {
      const relation = relationById.get(id);
      if (relation && (relation.targetNodeId !== group.conclusionNodeId
        || ![...group.premiseNodeIds, ...group.conditionNodeIds].includes(relation.sourceNodeId)
        || relation.kind !== 'support' && relation.kind !== 'requires_condition')) fail('invalid_prerequisite_relation');
    }
  }); uniqueRows(projection.prerequisiteGroups);
}
function quality(input: ArgumentContextProjection['quality']): void {
  object(input, ['status']); enumeration(input.status, ['eligible', 'review_only', 'unassessed', 'not_applicable']);
}
function gaps(input: ArgumentContextProjection['build']['gaps']): void {
  array(input, ARGUMENT_CONTEXT_LIMITS.gaps);
  input.forEach((gap) => { object(gap, ['code'], ['targetId']); enumeration(gap.code, ARGUMENT_CONTEXT_GAP_CODES);
    if (gap.targetId !== undefined) string(gap.targetId); });
}
function projectionShape(projection: ArgumentContextProjection, text: string): void {
  object(projection, ['version', 'source', 'hierarchy', 'nodes', 'relations', 'prerequisiteGroups', 'quality', 'build']);
  if (projection.version !== 1) fail('invalid_version');
  sourceIdentity(projection.source); quality(projection.quality);
  graph(projection, text, hierarchy(projection.hierarchy, text));
  object(projection.build, ['origin', 'scopes', 'gaps']); enumeration(projection.build.origin, ['legacy-adapter', 'validated-projection']);
  array(projection.build.scopes, ARGUMENT_CONTEXT_LIMITS.scopes); gaps(projection.build.gaps);
  const keys = new Set<string>();
  for (const scope of projection.build.scopes) {
    object(scope, ['seedNodeId', 'task', 'requiredNodeIds', 'requiredRelationIds', 'requiredGroupIds', 'status']);
    string(scope.seedNodeId); enumeration(scope.task, ARGUMENT_CONTEXT_TASKS);
    ids(scope.requiredNodeIds, ARGUMENT_CONTEXT_LIMITS.nodes); ids(scope.requiredRelationIds, ARGUMENT_CONTEXT_LIMITS.relations);
    ids(scope.requiredGroupIds, ARGUMENT_CONTEXT_LIMITS.groups); enumeration(scope.status, ['reviewed_for_scope', 'partial', 'unknown']);
    if (scope.status === 'reviewed_for_scope' && !scope.requiredNodeIds.includes(scope.seedNodeId)) fail('invalid_reviewed_scope');
    const key = `${scope.seedNodeId}\u0000${scope.task}`;
    if (keys.has(key)) fail('duplicate_reviewed_scope'); keys.add(key);
  }
}
function authorityShape(authority: ArgumentContextAuthority): void {
  object(authority, ['source', 'canonicalText', 'structureHash']); sourceIdentity(authority.source);
  if (typeof authority.canonicalText !== 'string' || !authority.canonicalText.length
    || authority.canonicalText.length > ARGUMENT_CONTEXT_LIMITS.sourceCharacters) fail('invalid_canonical_text');
  if (typeof authority.structureHash !== 'string' || !HASH.test(authority.structureHash)) fail('invalid_hash');
}

export function normalizeArgumentContextBudget(input?: Partial<ArgumentContextBudget>): ArgumentContextBudget {
  const selected = input === undefined ? {} : structuredClone(input);
  object(selected, [], ['maxNodes', 'maxRelations', 'maxCharacters', 'maxDepth']);
  const result = { ...DEFAULT_ARGUMENT_CONTEXT_BUDGET, ...selected };
  integer(result.maxNodes, 0, ARGUMENT_CONTEXT_LIMITS.readNodes);
  integer(result.maxRelations, 0, ARGUMENT_CONTEXT_LIMITS.readRelations);
  integer(result.maxCharacters, 0, ARGUMENT_CONTEXT_LIMITS.readCharacters);
  integer(result.maxDepth, 0, ARGUMENT_CONTEXT_LIMITS.readDepth);
  return result;
}

/** Shared source foundation validation for construction; does not create reviewed graph decisions. */
export async function validateArgumentContextSourceFoundation(sourceInput: ArgumentSourceIdentity, textInput: string,
  hierarchyInput: ArgumentContextHierarchy, scopeInput: ArgumentContextScope): Promise<void> {
  const source = structuredClone(sourceInput), text = textInput, selectedHierarchy = structuredClone(hierarchyInput), scope = structuredClone(scopeInput);
  sourceIdentity(source); scopeAuthority(scope, source);
  if (typeof text !== 'string' || !text.length || text.length > ARGUMENT_CONTEXT_LIMITS.sourceCharacters) fail('invalid_canonical_text');
  hierarchy(selectedHierarchy, text);
  if (await argumentCanonicalTextHash(text) !== source.contentHash) fail('snapshot_changed');
}

export async function validateArgumentContextProjection(projectionInput: ArgumentContextProjection,
  authorityInput: ArgumentContextAuthority, requestInput: ArgumentContextRequest): Promise<void> {
  const projection = structuredClone(projectionInput), authority = structuredClone(authorityInput), request = structuredClone(requestInput);
  authorityShape(authority); projectionShape(projection, authority.canonicalText);
  object(request, ['pointer', 'scope', 'task'], ['budget']); enumeration(request.task, ARGUMENT_CONTEXT_TASKS);
  normalizeArgumentContextBudget(request.budget);
  const pointer = request.pointer;
  object(pointer, ['version', 'scopeId', 'scopeHash', 'source', 'structureHash', 'seedNodeIds']);
  if (pointer.version !== 1) fail('invalid_version');
  string(pointer.scopeId); sourceIdentity(pointer.source); ids(pointer.seedNodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes, true);
  if (pointer.seedNodeIds.some((id) => !projection.nodes.some((node) => node.id === id))) fail('missing_seed');
  if (typeof pointer.structureHash !== 'string' || !HASH.test(pointer.structureHash)
    || typeof pointer.scopeHash !== 'string' || !HASH.test(pointer.scopeHash)) fail('invalid_hash');
  scopeAuthority(request.scope, authority.source);
  if (request.scope.scopeId !== pointer.scopeId) fail('scope_changed');
  const [actualSourceHash, structureHash, projectionIdentity, authorityIdentity, pointerIdentity, scopeHash] = await Promise.all([
    argumentCanonicalTextHash(authority.canonicalText), argumentContextHash(projection), argumentContextHash(projection.source),
    argumentContextHash(authority.source), argumentContextHash(pointer.source), argumentContextHash(request.scope),
  ]);
  if (actualSourceHash !== authority.source.contentHash || projectionIdentity !== authorityIdentity
    || pointerIdentity !== authorityIdentity || structureHash !== authority.structureHash
    || pointer.structureHash !== authority.structureHash) fail('snapshot_changed');
  if (pointer.scopeHash !== scopeHash) fail('scope_changed');
}

/** Pack validation authenticates exact evidence and a closed, hashed response, not its semantic truth. */
export async function validateArgumentContextPack(packInput: ArgumentContextPack, authorityInput: ArgumentContextAuthority,
  scopeInput: ArgumentContextScope, projectionInput: ArgumentContextProjection): Promise<void> {
  const pack = structuredClone(packInput), authority = structuredClone(authorityInput), scope = structuredClone(scopeInput);
  const projection = structuredClone(projectionInput);
  authorityShape(authority);
  object(pack, ['version', 'packHash', 'source', 'scopeId', 'scopeHash', 'structureHash', 'task', 'budget', 'seedNodeIds', 'hierarchy',
    'nodes', 'relations', 'prerequisiteGroups', 'quality', 'completeness', 'limitations']);
  if (pack.version !== 1) fail('invalid_version');
  sourceIdentity(pack.source); scopeAuthority(scope, pack.source); string(pack.scopeId);
  if (scope.scopeId !== pack.scopeId) fail('scope_changed');
  enumeration(pack.task, ARGUMENT_CONTEXT_TASKS); ids(pack.seedNodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes, true);
  const budget = normalizeArgumentContextBudget(pack.budget);
  if (typeof pack.packHash !== 'string' || !HASH.test(pack.packHash)
    || typeof pack.structureHash !== 'string' || !HASH.test(pack.structureHash)
    || typeof pack.scopeHash !== 'string' || !HASH.test(pack.scopeHash)) fail('invalid_hash');
  quality(pack.quality); graph(pack, authority.canonicalText, hierarchy(pack.hierarchy, authority.canonicalText));
  if (pack.nodes.length > ARGUMENT_CONTEXT_LIMITS.readNodes || pack.relations.length > ARGUMENT_CONTEXT_LIMITS.readRelations) fail('pack_budget');
  if (pack.nodes.some((node) => node.admission !== 'admitted')
    || pack.relations.some((relation) => relation.admission !== 'admitted')
    || pack.prerequisiteGroups.some((group) => group.admission !== 'admitted' || group.operator === 'unknown')) fail('pack_unadmitted');
  const completeness = pack.completeness;
  object(completeness, ['status', 'requiredNodeIds', 'requiredRelationIds', 'requiredGroupIds', 'readNodeIds', 'readRelationIds',
    'readGroupIds', 'omittedNodeIds', 'omittedRelationIds', 'omittedGroupIds', 'gaps']);
  enumeration(completeness.status, ['complete_for_scope', 'partial', 'unknown']); gaps(completeness.gaps);
  if ([...pack.nodes, ...pack.relations, ...pack.prerequisiteGroups].some((item) => item.semanticStatus !== 'reviewed'
    && !completeness.gaps.some((gap) => gap.code === 'structure_unreviewed' && gap.targetId === item.id))) fail('pack_unreviewed');
  for (const key of ['requiredNodeIds', 'readNodeIds', 'omittedNodeIds'] as const) ids(completeness[key], ARGUMENT_CONTEXT_LIMITS.nodes);
  for (const key of ['requiredRelationIds', 'readRelationIds', 'omittedRelationIds'] as const) ids(completeness[key], ARGUMENT_CONTEXT_LIMITS.relations);
  for (const key of ['requiredGroupIds', 'readGroupIds', 'omittedGroupIds'] as const) ids(completeness[key], ARGUMENT_CONTEXT_LIMITS.groups);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  if (!same(completeness.readNodeIds, pack.nodes.map((node) => node.id))
    || !same(completeness.readRelationIds, pack.relations.map((relation) => relation.id))
    || !same(completeness.readGroupIds, pack.prerequisiteGroups.map((group) => group.id))) fail('pack_read_mismatch');
  for (const [read, omitted] of [[completeness.readNodeIds, completeness.omittedNodeIds],
    [completeness.readRelationIds, completeness.omittedRelationIds], [completeness.readGroupIds, completeness.omittedGroupIds]]) {
    if (read.some((id) => omitted.includes(id))) fail('pack_read_mismatch');
  }
  for (const group of pack.prerequisiteGroups) {
    if (![group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].every((id) => completeness.readNodeIds.includes(id))
      || !group.relationIds.every((id) => completeness.readRelationIds.includes(id))) fail('pack_missing_prerequisite');
  }
  if (completeness.status === 'complete_for_scope' && (completeness.gaps.length
    || completeness.omittedNodeIds.length || completeness.omittedRelationIds.length || completeness.omittedGroupIds.length
    || !pack.seedNodeIds.every((id) => completeness.readNodeIds.includes(id))
    || !completeness.requiredNodeIds.every((id) => completeness.readNodeIds.includes(id))
    || !completeness.requiredRelationIds.every((id) => completeness.readRelationIds.includes(id))
    || !completeness.requiredGroupIds.every((id) => completeness.readGroupIds.includes(id))
    || (scope.corpus === 'reference' ? pack.quality.status !== 'eligible'
      : pack.quality.status !== 'eligible' && pack.quality.status !== 'not_applicable'))) fail('invalid_completeness');
  object(pack.limitations, ['semanticTruth', 'questionCoverage', 'writes']);
  if (pack.limitations.semanticTruth !== 'not_certified' || pack.limitations.questionCoverage !== 'not_assessed'
    || pack.limitations.writes !== 'disabled') fail('invalid_limitations');
  const { packHash: _packHash, ...payload } = pack;
  const [actualSourceHash, actualPackHash, sourceHash, authorityHash, scopeHash] = await Promise.all([
    argumentCanonicalTextHash(authority.canonicalText), argumentContextHash(payload), argumentContextHash(pack.source), argumentContextHash(authority.source), argumentContextHash(scope),
  ]);
  if (actualSourceHash !== authority.source.contentHash || sourceHash !== authorityHash
    || pack.structureHash !== authority.structureHash || actualPackHash !== pack.packHash) fail('snapshot_changed');
  if (scopeHash !== pack.scopeHash) fail('scope_changed');
  // A self-recomputed pack hash cannot authenticate eligibility, stored reviewer decisions or
  // missing prerequisites. Replay the authoritative projection rather than trusting these flags.
  const { readArgumentContextPack } = await import('./reader');
  const expected = await readArgumentContextPack(projection, authority, {
    pointer: { version: 1, scopeId: pack.scopeId, scopeHash: pack.scopeHash, source: pack.source,
      structureHash: pack.structureHash, seedNodeIds: pack.seedNodeIds }, scope, task: pack.task, budget,
  });
  if (expected.packHash !== pack.packHash) fail('pack_projection_mismatch');
}
