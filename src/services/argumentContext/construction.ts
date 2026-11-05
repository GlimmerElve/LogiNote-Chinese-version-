import { argumentContextHash, compareArgumentContextIds } from './hash';
import { createArgumentContextPointer } from './reader';
import { validateArgumentContextSourceFoundation } from './validator';
import { ARGUMENT_CONTEXT_RELATIONS, ARGUMENT_CONTEXT_ROLES, ARGUMENT_CONTEXT_TASKS,
  type ArgumentContextGap, type ArgumentContextProjection, type ArgumentEvidenceSpan } from './types';
import { ARGUMENT_PROJECTION_BUILD_LIMITS as LIMITS, ARGUMENT_PROJECTION_BUILD_VERSION,
  ARGUMENT_PROJECTION_DECISIONS,
  ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS, ARGUMENT_PROJECTION_SOURCE_REVIEW_ROW_SCHEMAS,
  ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL,
  ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL,
  type ArgumentProjectionBuildInput, type ArgumentProjectionBuildProof, type ArgumentProjectionBuildResult,
  type ArgumentProjectionDraft, type ArgumentProjectionReview, type ArgumentProjectionReviewDecision,
  type ArgumentProjectionReviewInput, type ArgumentProjectionSourceInput,
  type ArgumentProjectionGroundedReviewInput, type ArgumentProjectionGroundedReview,
  type ArgumentProjectionSourceReviewInput, type ArgumentProjectionSourceReview } from './buildTypes';
import { reviewedTaskScopeNodeIds } from './scopedAdmission';
import { assertArgumentProjectionSourceReviewData, snapshotArgumentProjectionSourceReviewRaw,
  argumentProjectionSourceCoverageTargets, validateArgumentProjectionSourceCoverage,
  argumentProjectionSourceCoverageGaps } from './sourceReview';

const fail = (code: string): never => { throw new Error(`argument_projection_${code}`); };
const LIMITATIONS: ArgumentProjectionBuildInput['limitations'] = {
  semanticTruth: 'not_certified', productionWrites: 'disabled', scoreWrite: 'disabled', cognitionWrite: 'disabled',
};
export interface ArgumentProjectionReviewRowDiagnostic {
  kind: 'nodes' | 'relations' | 'groups' | 'scopes'; rowIndex: number;
  /** Names come only from the host's known schema, not model-supplied keys/IDs. */
  missingFields: string[]; unexpectedFieldCount: number;
}
class ReviewRowShapeError extends Error {
  constructor(readonly diagnostic: ArgumentProjectionReviewRowDiagnostic) { super('argument_projection_invalid_shape'); }
}
/** A bounded host-only diagnostic, not a reply/authority or response repair. */
export function getArgumentProjectionReviewRowDiagnostic(error: unknown): ArgumentProjectionReviewRowDiagnostic | undefined {
  return error instanceof ReviewRowShapeError ? structuredClone(error.diagnostic) : undefined;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(item, key))) fail('invalid_shape');
  return item;
}
function text(value: unknown, maximum = 300): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_string');
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_array');
}
function ids(value: unknown, maximum: number, nonempty = false): asserts value is string[] {
  array(value, maximum); value.forEach((id) => text(id));
  if ((nonempty && !value.length) || new Set(value).size !== value.length) fail('invalid_ids');
}
function enumValue(value: unknown, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) fail('invalid_enum');
}
function boolean(value: unknown): void { if (typeof value !== 'boolean') fail('invalid_boolean'); }
function prefixedId(value: unknown, prefix: string): void {
  text(value);
  if (!new RegExp(`^${prefix}[1-9][0-9]{0,5}$`, 'u').test(value)) fail('invalid_id');
}
function uniqueRows(rows: { id: string }[]): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) fail('duplicate_id');
}
function boundary(source: string, offset: number): boolean {
  const left = source.charCodeAt(offset - 1), right = source.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}
function interval(source: string, start: unknown, end: unknown): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
    || (end as number) <= (start as number) || (end as number) > source.length
    || !boundary(source, start as number) || !boundary(source, end as number)) fail('invalid_span');
}
function serializedBudget(value: unknown): void {
  if (JSON.stringify(value).length > LIMITS.requestCharacters) fail('request_budget');
}
function rawObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return structuredClone(raw);
  if (raw.length > LIMITS.requestCharacters) fail('response_budget');
  try { return JSON.parse(raw) as unknown; } catch { return fail('invalid_json'); }
}
function evidence(span: ArgumentEvidenceSpan, input: ArgumentProjectionSourceInput): void {
  object(span, ['sentenceId', 'start', 'end', 'quote']); text(span.sentenceId);
  interval(input.canonicalText, span.start, span.end);
  const sentence = input.hierarchy.sentences.find((row) => row.id === span.sentenceId);
  if (!sentence || span.start < sentence.start || span.end > sentence.end
    || span.quote !== input.canonicalText.slice(span.start, span.end) || !span.quote.trim()) fail('quote_mismatch');
}
function covered(start: number, end: number, intervals: { start: number; end: number }[]): boolean {
  let until = start;
  for (const part of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (part.end <= until) continue;
    if (part.start > until) return false;
    until = Math.max(until, part.end);
    if (until >= end) return true;
  }
  return until >= end;
}
function physicalCoverage(source: string, intervals: { start: number; end: number }[]): void {
  let until = 0;
  for (const part of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (part.start > until && source.slice(until, part.start).trim()) fail('incomplete_hierarchy');
    until = Math.max(until, part.end);
  }
  if (source.slice(until).trim()) fail('incomplete_hierarchy');
}

async function sourceShape(input: ArgumentProjectionSourceInput): Promise<void> {
  object(input, ['source', 'canonicalText', 'hierarchy', 'scope', 'chunks', 'sourceQualification']);
  // S2 extends the reference construction channel only; it cannot requalify a personal belief.
  if (input.source?.kind === 'personal-cognition' || input.scope?.corpus !== 'reference') fail('reference_only');
  await validateArgumentContextSourceFoundation(input.source, input.canonicalText, input.hierarchy, input.scope);
  if (!input.canonicalText.trim() || input.hierarchy.sentences.some((sentence) => !sentence.quote.trim())) fail('empty_source_evidence');
  physicalCoverage(input.canonicalText, input.hierarchy.blocks);
  physicalCoverage(input.canonicalText, input.hierarchy.sentences);
  const orderedSentences = [...input.hierarchy.sentences].sort((a, b) => a.start - b.start || a.end - b.end);
  if (orderedSentences.some((sentence, index) => index > 0 && orderedSentences[index - 1].end > sentence.start)) fail('overlapping_sentences');
  array(input.chunks, LIMITS.chunks);
  if (!input.chunks.length || !input.hierarchy.sentences.length) fail('missing_source_containers');
  const sentenceById = new Map(input.hierarchy.sentences.map((sentence) => [sentence.id, sentence]));
  for (const chunk of input.chunks) {
    object(chunk, ['id', 'start', 'end', 'content', 'sentenceIds', 'forcedSplit']); text(chunk.id);
    interval(input.canonicalText, chunk.start, chunk.end); boolean(chunk.forcedSplit);
    if (chunk.content !== input.canonicalText.slice(chunk.start, chunk.end)) fail('chunk_content_mismatch');
    ids(chunk.sentenceIds, LIMITS.quotes, true);
    for (const id of chunk.sentenceIds) {
      const sentence = sentenceById.get(id);
      if (!sentence || chunk.start >= sentence.end || chunk.end <= sentence.start) fail('chunk_sentence_mismatch');
    }
  }
  uniqueRows(input.chunks);
  for (const sentence of input.hierarchy.sentences) {
    if (!covered(sentence.start, sentence.end, input.chunks.filter((chunk) => chunk.sentenceIds.includes(sentence.id)))) fail('missing_chunk_coverage');
  }
  const qualification = input.sourceQualification;
  object(qualification, ['status', 'policyVersion', 'evidence']);
  enumValue(qualification.status, ['eligible', 'review_only', 'unassessed']); text(qualification.policyVersion);
  array(qualification.evidence, LIMITS.quoteReferences);
  qualification.evidence.forEach((span) => evidence(span, input));
  const signatures = qualification.evidence.map((span) => `${span.sentenceId}:${span.start}:${span.end}`);
  if (new Set(signatures).size !== signatures.length) fail('duplicate_evidence');
  if (qualification.status === 'eligible' && !qualification.evidence.length) fail('missing_qualification_evidence');
}

/** Pure lexical containers only. Punctuation/connectives do not create roles or logical edges. */
function quotationCandidates(input: ArgumentProjectionSourceInput): ArgumentProjectionBuildInput['quotes'] {
  const candidates: { evidence: ArgumentEvidenceSpan; completeSentence: boolean }[] = [];
  const sentences = [...input.hierarchy.sentences].sort((a, b) => a.start - b.start || a.end - b.end || compareArgumentContextIds(a.id, b.id));
  for (const sentence of sentences) {
    candidates.push({ evidence: { sentenceId: sentence.id, start: sentence.start, end: sentence.end, quote: sentence.quote }, completeSentence: true });
    const cuts = new Set([0, sentence.quote.length]);
    for (const match of sentence.quote.matchAll(/[，,；;：:\r\n]/gu)) cuts.add(match.index + match[0].length);
    for (const match of sentence.quote.matchAll(/因此|所以|因而|从而|但是|然而|否则/gu)) if (match.index > 0) cuts.add(match.index);
    const positions = [...cuts].sort((a, b) => a - b);
    for (let index = 0; index < positions.length - 1; index += 1) {
      let start = positions[index], end = positions[index + 1];
      while (start < end && /\s/u.test(sentence.quote[start])) start += 1;
      while (end > start && /\s/u.test(sentence.quote[end - 1])) end -= 1;
      if (start === end || start === 0 && end === sentence.quote.length) continue;
      const actualStart = sentence.start + start, actualEnd = sentence.start + end;
      candidates.push({ evidence: { sentenceId: sentence.id, start: actualStart, end: actualEnd,
        quote: input.canonicalText.slice(actualStart, actualEnd) }, completeSentence: false });
    }
  }
  if (candidates.length > LIMITS.quotes) fail('quote_budget');
  return candidates.map((candidate, index) => ({ quoteId: `Q${index + 1}`, ...candidate,
    chunkIds: input.chunks.filter((chunk) => chunk.sentenceIds.includes(candidate.evidence.sentenceId)
      && chunk.start < candidate.evidence.end && chunk.end > candidate.evidence.start).map((chunk) => chunk.id).sort(compareArgumentContextIds) }));
}

/** Freeze a host-owned source into a bounded, full-source construction request. No I/O or model call. */
export async function prepareArgumentProjectionBuild(sourceInput: ArgumentProjectionSourceInput): Promise<ArgumentProjectionBuildInput> {
  const source = structuredClone(sourceInput);
  await sourceShape(source);
  const scopeHash = await argumentContextHash(source.scope), sourceBindingHash = await argumentContextHash(source);
  const payload: Omit<ArgumentProjectionBuildInput, 'buildId'> = { ...source, version: 1,
    contractVersion: ARGUMENT_PROJECTION_BUILD_VERSION, scopeHash, sourceBindingHash,
    quotes: quotationCandidates(source), limitations: { ...LIMITATIONS } };
  const input: ArgumentProjectionBuildInput = { ...payload, buildId: await argumentContextHash(payload) };
  serializedBudget(input);
  return structuredClone(input);
}

function sourceInputOf(input: ArgumentProjectionBuildInput): ArgumentProjectionSourceInput {
  return { source: input.source, canonicalText: input.canonicalText, hierarchy: input.hierarchy,
    scope: input.scope, chunks: input.chunks, sourceQualification: input.sourceQualification };
}
/** Rebuild all host-derived quotes/hashes. A self-supplied buildId cannot authorize changed source data. */
export async function validateArgumentProjectionBuildInput(inputInput: ArgumentProjectionBuildInput): Promise<void> {
  const input = structuredClone(inputInput);
  object(input, ['source', 'canonicalText', 'hierarchy', 'scope', 'chunks', 'sourceQualification', 'version', 'contractVersion',
    'buildId', 'scopeHash', 'sourceBindingHash', 'quotes', 'limitations']);
  const expected = await prepareArgumentProjectionBuild(sourceInputOf(input));
  if (!exactReplayShape(input, expected) || await argumentContextHash(input) !== await argumentContextHash(expected)) fail('build_input_changed');
}

function quoteIds(value: unknown, quotes: Set<string>): asserts value is string[] {
  ids(value, LIMITS.quoteReferences, true);
  if (value.some((id) => !quotes.has(id))) fail('unknown_quote');
}
function draftShape(draft: ArgumentProjectionDraft, input: ArgumentProjectionBuildInput): void {
  object(draft, ['version', 'buildId', 'nodes', 'relations', 'groups', 'scopes']);
  if (draft.version !== 1 || draft.buildId !== input.buildId) fail('draft_binding_mismatch');
  array(draft.nodes, LIMITS.nodes); array(draft.relations, LIMITS.relations); array(draft.groups, LIMITS.groups); array(draft.scopes, LIMITS.scopes);
  if (!draft.nodes.length || !draft.scopes.length) fail('missing_draft_scope');
  const quotes = new Set(input.quotes.map((quote) => quote.quoteId));
  for (const node of draft.nodes) {
    object(node, ['id', 'role', 'quoteIds']); prefixedId(node.id, 'N'); enumValue(node.role, ARGUMENT_CONTEXT_ROLES); quoteIds(node.quoteIds, quotes);
  }
  uniqueRows(draft.nodes);
  const nodes = new Map(draft.nodes.map((node) => [node.id, node]));
  for (const relation of draft.relations) {
    object(relation, ['id', 'sourceNodeId', 'targetNodeId', 'kind', 'quoteIds']); prefixedId(relation.id, 'E');
    enumValue(relation.kind, ARGUMENT_CONTEXT_RELATIONS); quoteIds(relation.quoteIds, quotes);
    const source = nodes.get(relation.sourceNodeId), target = nodes.get(relation.targetNodeId);
    if (!source || !target) fail('orphan_relation');
    if (source.id === target.id) fail('self_relation');
    if (relation.kind === 'support' && source.quoteIds.length === target.quoteIds.length
      && source.quoteIds.every((id) => target.quoteIds.includes(id))) fail('copied_self_support');
  }
  uniqueRows(draft.relations);
  const relations = new Map(draft.relations.map((relation) => [relation.id, relation]));
  for (const group of draft.groups) {
    object(group, ['id', 'conclusionNodeId', 'premiseNodeIds', 'conditionNodeIds', 'relationIds', 'operator', 'quoteIds']); prefixedId(group.id, 'G');
    if (!nodes.has(group.conclusionNodeId)) fail('orphan_group');
    ids(group.premiseNodeIds, LIMITS.nodes); ids(group.conditionNodeIds, LIMITS.nodes); ids(group.relationIds, LIMITS.relations);
    enumValue(group.operator, ['all', 'any', 'unknown']); quoteIds(group.quoteIds, quotes);
    const members = [...group.premiseNodeIds, ...group.conditionNodeIds];
    if (!members.length || new Set(members).size !== members.length || members.includes(group.conclusionNodeId)
      || members.some((id) => !nodes.has(id))) fail('invalid_group_members');
    for (const id of group.relationIds) {
      const relation = relations.get(id);
      if (!relation || relation.targetNodeId !== group.conclusionNodeId || !members.includes(relation.sourceNodeId)
        || relation.kind !== 'support' && relation.kind !== 'requires_condition') fail('invalid_group_relation');
    }
  }
  uniqueRows(draft.groups);
  const groups = new Map(draft.groups.map((group) => [group.id, group]));
  const scopeKeys = new Set<string>();
  for (const scope of draft.scopes) {
    object(scope, ['id', 'seedNodeId', 'task', 'requiredNodeIds', 'requiredRelationIds', 'requiredGroupIds', 'quoteIds']); prefixedId(scope.id, 'S');
    enumValue(scope.task, ARGUMENT_CONTEXT_TASKS); quoteIds(scope.quoteIds, quotes);
    ids(scope.requiredNodeIds, LIMITS.nodes, true); ids(scope.requiredRelationIds, LIMITS.relations); ids(scope.requiredGroupIds, LIMITS.groups);
    if (!nodes.has(scope.seedNodeId) || !scope.requiredNodeIds.includes(scope.seedNodeId)
      || scope.requiredNodeIds.some((id) => !nodes.has(id)) || scope.requiredRelationIds.some((id) => !relations.has(id))
      || scope.requiredGroupIds.some((id) => !groups.has(id))) fail('orphan_scope');
    const key = `${scope.seedNodeId}:${scope.task}`;
    if (scopeKeys.has(key)) fail('duplicate_scope'); scopeKeys.add(key);
    for (const id of scope.requiredRelationIds) {
      const relation = relations.get(id)!;
      if (!scope.requiredNodeIds.includes(relation.sourceNodeId) || !scope.requiredNodeIds.includes(relation.targetNodeId)) fail('scope_missing_endpoint');
    }
    for (const id of scope.requiredGroupIds) {
      const group = groups.get(id)!;
      if (![group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].every((member) => scope.requiredNodeIds.includes(member))
        || !group.relationIds.every((relation) => scope.requiredRelationIds.includes(relation))) fail('scope_missing_group_member');
    }
  }
  uniqueRows(draft.scopes);
  serializedBudget(draft);
}

/** Closed extraction response. Model coordinates, admission, confidence and source quality are rejected. */
export async function readArgumentProjectionDraft(raw: unknown, inputInput: ArgumentProjectionBuildInput): Promise<ArgumentProjectionDraft> {
  const input = structuredClone(inputInput), draft = rawObject(raw) as ArgumentProjectionDraft;
  await validateArgumentProjectionBuildInput(input);
  draftShape(draft, input);
  return structuredClone(draft);
}

export async function buildArgumentProjectionReviewInput(inputInput: ArgumentProjectionBuildInput,
  draftInput: ArgumentProjectionDraft): Promise<ArgumentProjectionReviewInput> {
  const input = structuredClone(inputInput), suppliedDraft = structuredClone(draftInput);
  const draft = await readArgumentProjectionDraft(suppliedDraft, input);
  const payload: Omit<ArgumentProjectionReviewInput, 'reviewId'> = { version: 1,
    contractVersion: ARGUMENT_PROJECTION_BUILD_VERSION, buildId: input.buildId, draftHash: await argumentContextHash(draft),
    source: input.source, canonicalText: input.canonicalText, hierarchy: input.hierarchy, chunks: input.chunks,
    scopeHash: input.scopeHash, sourceBindingHash: input.sourceBindingHash, quotes: input.quotes, draft };
  const reviewInput: ArgumentProjectionReviewInput = { ...payload, reviewId: await argumentContextHash(payload) };
  serializedBudget(reviewInput);
  return structuredClone(reviewInput);
}

/** New opt-in hash binds the full source + unchanged draft + complete-sentence scan contract.
 * The legacy review hash and proof are intentionally untouched. */
export async function buildArgumentProjectionSourceReviewInput(inputInput: ArgumentProjectionBuildInput,
  draftInput: ArgumentProjectionDraft): Promise<ArgumentProjectionSourceReviewInput> {
  return buildGroundedReviewInput(inputInput, draftInput, ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL) as Promise<ArgumentProjectionSourceReviewInput>;
}
export async function buildArgumentProjectionTaskReviewInput(input: ArgumentProjectionBuildInput,
  draft: ArgumentProjectionDraft): Promise<ArgumentProjectionGroundedReviewInput> {
  return buildGroundedReviewInput(input, draft, ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL);
}
async function buildGroundedReviewInput(inputInput: ArgumentProjectionBuildInput,
  draftInput: ArgumentProjectionDraft, protocol: ArgumentProjectionGroundedReviewInput['protocol']): Promise<ArgumentProjectionGroundedReviewInput> {
  assertArgumentProjectionSourceReviewData(inputInput); assertArgumentProjectionSourceReviewData(draftInput);
  const input = structuredClone(inputInput), suppliedDraft = structuredClone(draftInput);
  const common = await buildArgumentProjectionReviewInput(input, suppliedDraft);
  const { reviewId: _legacyReviewId, ...fields } = common;
  void _legacyReviewId;
  const payload = { ...fields, protocol,
    sourceCoverageTargets: argumentProjectionSourceCoverageTargets(input) };
  const reviewInput = { ...payload, reviewId: await argumentContextHash(payload) };
  serializedBudget(reviewInput);
  return structuredClone(reviewInput);
}

function reviewShape(review: ArgumentProjectionReview | ArgumentProjectionGroundedReview,
  reviewInput: ArgumentProjectionReviewInput | ArgumentProjectionGroundedReviewInput): void {
  if (review.version === 2 || review.version === 3) {
    validateArgumentProjectionSourceCoverage(review, reviewInput as ArgumentProjectionGroundedReviewInput);
  } else {
    object(review, ['version', 'reviewId', 'nodes', 'relations', 'groups', 'scopes']);
    if (review.version !== 1 || review.reviewId !== reviewInput.reviewId) fail('review_binding_mismatch');
  }
  const quotes = new Set(reviewInput.quotes.map((quote) => quote.quoteId));
  const validateRows = (kind: 'nodes' | 'relations' | 'groups' | 'scopes') => {
    const schema = (review.version !== 1 ? ARGUMENT_PROJECTION_SOURCE_REVIEW_ROW_SCHEMAS : ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS)[kind];
    const flags: readonly string[] = schema.booleanFields;
    const rows = review[kind] as unknown as (ArgumentProjectionReviewDecision & Record<string, unknown>)[];
    const originals = reviewInput.draft[kind];
    array(rows, originals.length); uniqueRows(rows);
    if (rows.length !== originals.length) fail('missing_review_slot');
    for (const [rowIndex, row] of rows.entries()) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const missingFields = schema.fields.filter(field => !Object.hasOwn(row, field));
        const allowed: readonly string[] = schema.fields;
        const unexpectedFieldCount = Object.keys(row).filter(field => !allowed.includes(field)).length;
        if (missingFields.length || unexpectedFieldCount) throw new ReviewRowShapeError({ kind, rowIndex,
          missingFields: [...missingFields], unexpectedFieldCount });
      }
      object(row, [...schema.fields]); text(row.id);
      const original = originals.find((item) => item.id === row.id);
      if (!original) fail('unknown_review_slot');
      enumValue(row.decision, ARGUMENT_PROJECTION_DECISIONS); quoteIds(row.quoteIds, quotes); text(row.reason, 1000);
      flags.forEach((flag) => boolean(row[flag]));
      if (!row.quoteIds.some((id) => original.quoteIds.includes(id))) fail('review_evidence_mismatch');
      if (row.decision === 'accept' && (flags.some((flag) => row[flag] !== true)
        || !original.quoteIds.every((id) => row.quoteIds.includes(id)))) fail('unsupported_accept');
      if (kind === 'relations') {
        const relation = original as ArgumentProjectionDraft['relations'][number];
        if (row.sourceNodeId !== relation.sourceNodeId || row.targetNodeId !== relation.targetNodeId || row.kind !== relation.kind) fail('review_direction_changed');
      }
      if (kind === 'groups') {
        const group = original as ArgumentProjectionDraft['groups'][number];
        if (row.operator !== group.operator) fail('review_operator_changed');
        if (row.decision === 'accept' && group.operator === 'unknown') fail('unknown_operator_accept');
      }
    }
  };
  validateRows('nodes');
  validateRows('relations');
  validateRows('groups');
  validateRows('scopes');
  serializedBudget(review);
}

/** Closed raw v2 only. Shape/hash verification is not source authority: finalization independently
 * rebuilds this input from the host's qualified canonical source and retained draft. */
export async function readArgumentProjectionSourceReview(raw: unknown,
  suppliedInput: ArgumentProjectionSourceReviewInput): Promise<ArgumentProjectionSourceReview> {
  assertArgumentProjectionSourceReviewData(suppliedInput);
  if (suppliedInput.protocol !== ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL) fail('review_binding_mismatch');
  return readGroundedReview(raw, suppliedInput) as Promise<ArgumentProjectionSourceReview>;
}
export async function readArgumentProjectionTaskReview(raw: unknown,
  suppliedInput: ArgumentProjectionGroundedReviewInput): Promise<ArgumentProjectionGroundedReview> {
  assertArgumentProjectionSourceReviewData(suppliedInput);
  if (suppliedInput.protocol !== ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL) fail('review_binding_mismatch');
  return readGroundedReview(raw, suppliedInput);
}
async function readGroundedReview(raw: unknown,
  suppliedInput: ArgumentProjectionGroundedReviewInput): Promise<ArgumentProjectionGroundedReview> {
  assertArgumentProjectionSourceReviewData(suppliedInput);
  const input = structuredClone(suppliedInput), review = snapshotArgumentProjectionSourceReviewRaw(raw) as ArgumentProjectionGroundedReview;
  object(input, ['version', 'contractVersion', 'reviewId', 'buildId', 'draftHash', 'source', 'canonicalText', 'quotes',
    'hierarchy', 'chunks', 'scopeHash', 'sourceBindingHash', 'draft', 'protocol', 'sourceCoverageTargets']);
  if (input.version !== 1 || input.contractVersion !== ARGUMENT_PROJECTION_BUILD_VERSION
    || (input.protocol === ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL ? review.version !== 2
      : input.protocol !== ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL || review.version !== 3)
    || input.draft.version !== 1 || input.draft.buildId !== input.buildId) fail('review_binding_mismatch');
  const { reviewId, ...payload } = input;
  if (await argumentContextHash(payload) !== reviewId || await argumentContextHash(input.draft) !== input.draftHash) fail('review_binding_mismatch');
  const targets = argumentProjectionSourceCoverageTargets(input);
  if (!exactReplayShape(input.sourceCoverageTargets, targets)) fail('source_coverage_mismatch');
  serializedBudget(input); reviewShape(review, input);
  return structuredClone(review);
}

function basicDecision(decision: ArgumentProjectionReviewDecision): ArgumentProjectionReviewDecision {
  return { id: decision.id, decision: decision.decision, quoteIds: [...decision.quoteIds], reason: decision.reason };
}

/** Hash canonicalization intentionally omits undefined object values; closed DTO replay must not. */
function exactReplayShape(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return Object.is(actual, expected);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(expected) && (!Array.isArray(actual) || actual.length !== expected.length)) return false;
  const actualObject = actual as Record<string, unknown>, expectedObject = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualObject).sort(compareArgumentContextIds), expectedKeys = Object.keys(expectedObject).sort(compareArgumentContextIds);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) => actualKeys[index] === key
    && exactReplayShape(actualObject[key], expectedObject[key]));
}

/** Independent review votes admit source-supported structure, never certify world truth or mastery. */
export async function finalizeArgumentProjectionBuild(inputInput: ArgumentProjectionBuildInput, draftInput: ArgumentProjectionDraft,
  reviewRaw: unknown): Promise<ArgumentProjectionBuildResult> {
  // Validate raw data before reading version or cloning; observation must not invoke model getters.
  const review = snapshotArgumentProjectionSourceReviewRaw(reviewRaw) as ArgumentProjectionReview | ArgumentProjectionGroundedReview;
  if (review.version !== 1) { assertArgumentProjectionSourceReviewData(inputInput); assertArgumentProjectionSourceReviewData(draftInput); }
  const input = structuredClone(inputInput), suppliedDraft = structuredClone(draftInput);
  const reviewInput = review.version === 3 ? await buildArgumentProjectionTaskReviewInput(input, suppliedDraft)
    : review.version === 2 ? await buildArgumentProjectionSourceReviewInput(input, suppliedDraft)
      : await buildArgumentProjectionReviewInput(input, suppliedDraft), draft = reviewInput.draft;
  reviewShape(review, reviewInput);
  const quoteById = new Map(input.quotes.map((quote) => [quote.quoteId, quote]));
  const nodeReview = new Map<string, ArgumentProjectionReview['nodes'][number]>(review.nodes.map((row) => [row.id, row] as const));
  const relationReview = new Map(review.relations.map((row) => [row.id, row] as const));
  const groupReview = new Map(review.groups.map((row) => [row.id, row])), scopeReview = new Map(review.scopes.map((row) => [row.id, row]));
  const gaps = new Map<string, ArgumentContextGap>();
  const gap = (code: ArgumentContextGap['code'], targetId?: string) => {
    gaps.set(`${code}:${targetId ?? ''}`, targetId === undefined ? { code } : { code, targetId });
  };
  const safeEvidence = (quoteIds: string[]) => quoteIds.every((id) => {
    const quote = quoteById.get(id)!;
    return input.chunks.some((chunk) => !chunk.forcedSplit && quote.chunkIds.includes(chunk.id)
      && chunk.start <= quote.evidence.start && chunk.end >= quote.evidence.end);
  });
  const evidenceFor = (ids: string[]) => ids.map((id) => structuredClone(quoteById.get(id)!.evidence));
  const stored = (admitted: boolean) => ({ admission: admitted ? 'admitted' as const : 'audit_only' as const,
    semanticStatus: admitted ? 'reviewed' as const : 'unreviewed' as const });
  const nodes: ArgumentContextProjection['nodes'] = draft.nodes.map((node) => {
    const admitted = nodeReview.get(node.id)!.decision === 'accept' && safeEvidence(node.quoteIds);
    if (!admitted) gap('unadmitted_node', node.id);
    return { id: node.id, role: node.role, evidence: evidenceFor(node.quoteIds), ...stored(admitted) };
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const relations: ArgumentContextProjection['relations'] = draft.relations.map((relation) => {
    // Exact endpoint quotations may legitimately be reused as relationship evidence. Their mere
    // presence is insufficient: the separate review must support both the relation and direction.
    const admitted = relationReview.get(relation.id)!.decision === 'accept' && safeEvidence(relation.quoteIds)
      && nodesById.get(relation.sourceNodeId)!.admission === 'admitted'
      && nodesById.get(relation.targetNodeId)!.admission === 'admitted';
    if (!admitted) gap('unadmitted_relation', relation.id);
    return { id: relation.id, sourceNodeId: relation.sourceNodeId, targetNodeId: relation.targetNodeId,
      kind: relation.kind, evidence: evidenceFor(relation.quoteIds), ...stored(admitted) };
  });
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]));
  const groups: ArgumentContextProjection['prerequisiteGroups'] = draft.groups.map((group) => {
    const members = [...group.premiseNodeIds, ...group.conditionNodeIds];
    const completeMembers = members.every((id) => group.relationIds.some((relationId) => {
      const relation = relationsById.get(relationId)!;
      return relation.sourceNodeId === id && relation.targetNodeId === group.conclusionNodeId
        && (group.conditionNodeIds.includes(id) ? relation.kind === 'requires_condition' : relation.kind === 'support');
    }));
    // One operator cannot represent '(P1 OR P2) AND C'. Such a mixed group requires a future nested contract.
    const representable = group.operator !== 'unknown' && !(group.operator === 'any' && group.premiseNodeIds.length && group.conditionNodeIds.length);
    const admitted = groupReview.get(group.id)!.decision === 'accept' && representable && completeMembers && safeEvidence(group.quoteIds)
      && [group.conclusionNodeId, ...members].every((id) => nodesById.get(id)!.admission === 'admitted')
      && group.relationIds.every((id) => relationsById.get(id)!.admission === 'admitted');
    if (!admitted) gap('unadmitted_group', group.id);
    if (!completeMembers) gap('missing_prerequisite', group.id);
    if (!representable) gap('unknown_prerequisite_operator', group.id);
    return { id: group.id, conclusionNodeId: group.conclusionNodeId, premiseNodeIds: [...group.premiseNodeIds],
      conditionNodeIds: [...group.conditionNodeIds], relationIds: [...group.relationIds], operator: group.operator, ...stored(admitted) };
  });
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const sourceCoverage = review.version !== 1 ? argumentProjectionSourceCoverageGaps(review,
    reviewInput as ArgumentProjectionGroundedReviewInput, { nodes, relations, prerequisiteGroups: groups }) : undefined;
  sourceCoverage?.gaps.forEach(item => gap(item.code, item.targetId));
  const scopes: ArgumentContextProjection['build']['scopes'] = draft.scopes.map((scope) => {
    const decision = scopeReview.get(scope.id)!;
    const complete = decision.decision === 'accept' && safeEvidence(scope.quoteIds) && !sourceCoverage?.incompleteScopeIds.has(scope.id)
      && scope.requiredNodeIds.every((id) => nodesById.get(id)!.admission === 'admitted')
      && scope.requiredRelationIds.every((id) => relationsById.get(id)!.admission === 'admitted')
      && scope.requiredGroupIds.every((id) => groupsById.get(id)!.admission === 'admitted');
    if (!complete) gap('scope_not_reviewed', scope.seedNodeId);
    return { seedNodeId: scope.seedNodeId, task: scope.task, requiredNodeIds: [...scope.requiredNodeIds],
      requiredRelationIds: [...scope.requiredRelationIds], requiredGroupIds: [...scope.requiredGroupIds],
      status: complete ? 'reviewed_for_scope' as const : decision.decision === 'unknown' ? 'unknown' as const : 'partial' as const };
  });
  if (input.sourceQualification.status === 'review_only') gap('source_review_only');
  if (input.sourceQualification.status === 'unassessed') gap('source_quality_unknown');
  const sort = <T extends { id: string }>(values: T[]) => values.sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const projection: ArgumentContextProjection = { version: 1, source: input.source, hierarchy: input.hierarchy,
    nodes: sort(nodes), relations: sort(relations), prerequisiteGroups: sort(groups), quality: { status: input.sourceQualification.status },
    build: { origin: 'validated-projection', scopes,
      gaps: [...gaps.values()].sort((a, b) => compareArgumentContextIds(a.code, b.code) || compareArgumentContextIds(a.targetId ?? '', b.targetId ?? '')) } };
  const authority = { source: input.source, canonicalText: input.canonicalText, structureHash: await argumentContextHash(projection) };
  // Exercise the same source/graph validator as a later authoritative read before publication.
  await createArgumentContextPointer(projection, authority, input.scope, [draft.scopes[0].seedNodeId]);
  const payload: Omit<ArgumentProjectionBuildResult, 'resultHash'> = { version: 1, contractVersion: ARGUMENT_PROJECTION_BUILD_VERSION,
    buildId: input.buildId, reviewId: reviewInput.reviewId, draftHash: reviewInput.draftHash,
    status: review.version === 3 ? reviewedTaskScopeNodeIds(projection).length ? 'reviewed_scoped' : 'reviewed_partial'
      : gaps.size === 0 ? 'reviewed_complete' : 'reviewed_partial', projection, authority,
    audit: { nodes: sort(review.nodes.map(basicDecision)), relations: sort(review.relations.map(basicDecision)),
      groups: sort(review.groups.map(basicDecision)), scopes: sort(review.scopes.map(basicDecision)) }, limitations: { ...LIMITATIONS } };
  return structuredClone({ ...payload, resultHash: await argumentContextHash(payload) });
}

/** Replay the independently retained input + draft + review; never trust a result's self-computed flags/hash. */
export async function verifyArgumentProjectionBuildResult(resultInput: ArgumentProjectionBuildResult,
  proofInput: ArgumentProjectionBuildProof): Promise<void> {
  assertArgumentProjectionSourceReviewData(resultInput); assertArgumentProjectionSourceReviewData(proofInput);
  const result = structuredClone(resultInput), proof = structuredClone(proofInput);
  object(proof, ['input', 'draft', 'review']);
  const expected = await finalizeArgumentProjectionBuild(proof.input, proof.draft, proof.review);
  if (!exactReplayShape(result, expected) || await argumentContextHash(result) !== await argumentContextHash(expected)) fail('result_replay_mismatch');
}
