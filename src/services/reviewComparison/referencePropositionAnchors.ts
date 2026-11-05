import { argumentContextHash } from '../argumentContext/hash';
import { ARGUMENT_CONTEXT_ROLES, ARGUMENT_CONTEXT_RELATIONS } from '../argumentContext/types';
import type { ArgumentReferenceDisclosureContext } from '../argumentContext/referenceDisclosure';
import { parseReviewAssessment, REVIEW_ASSESSMENT_CRITERIA } from '../reviewAssessment';

export const REFERENCE_PROPOSITION_LIMITS = { context: 32000, draft: 24000, review: 24000,
  reviewInput: 64000, bundle: 64000, anchors: 96, text: 1600 } as const;
type Source = ArgumentReferenceDisclosureContext['frames'][number]['source'];
type Role = ArgumentReferenceDisclosureContext['frames'][number]['nodes'][number]['role'];
export interface ReferencePropositionCandidate {
  id: string; frameId: string; nodeId: string; quoteId: string; start: number; end: number; text: string;
}
export interface ReferencePropositionDraft {
  version: 1; protocol: 'review-reference-proposition-draft-v1'; contractHash: string; contextHash: string;
  anchors: ReferencePropositionCandidate[];
}
export interface ReferencePropositionReviewInput {
  version: 1; protocol: 'review-reference-proposition-review-input-v1'; reviewId: string;
  contextHash: string; draftHash: string; reference: ArgumentReferenceDisclosureContext; draft: ReferencePropositionDraft;
}
export interface ReferencePropositionReview {
  version: 1; protocol: 'review-reference-proposition-review-v1'; reviewId: string; contextHash: string; draftHash: string;
  anchors: { id: string; decision: 'accept' | 'reject' | 'unknown'; roleSupported: boolean;
    completeMeaning: boolean; scopePreserved: boolean; reason: string }[];
}
export interface ReferencePropositionBundle {
  version: 1; protocol: 'review-reference-proposition-bundle-v1'; reviewId: string;
  contractHash: string; contextHash: string; draftHash: string; reviewHash: string; bundleHash: string;
  anchors: (ReferencePropositionCandidate & { role: Role; sourceKey: string; source: Source;
    parent: { quoteId: string; start: number; end: number; text: string } })[];
  semanticTruth: 'not_certified'; writes: 'disabled';
}
export type ReferencePropositionReply = { status: 'ready'; bundle: ReferencePropositionBundle }
  | { status: 'held'; reasons: string[] };
export class ReferencePropositionError extends Error {}
const fail = (code: string): never => { throw new ReferencePropositionError(code); };
const schema = (raw: unknown, fields: string[], code: string): Record<string, any> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string') || keys.sort().join('|') !== [...fields].sort().join('|')
    || Object.values(descriptors).some(value => !value.enumerable || !Object.hasOwn(value, 'value'))) return fail(code);
  return raw as Record<string, any>;
};
function dense(raw: unknown, maximum: number, code: string): any[] {
  if (!Array.isArray(raw) || raw.length > maximum || Object.keys(raw).length !== raw.length
    || Reflect.ownKeys(raw).length !== raw.length + 1
    || Object.keys(raw).some((key, index) => key !== String(index))
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some(value => !Object.hasOwn(value, 'value'))) return fail(code);
  return raw;
}
function utf16(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const id = (value: unknown, code: string) => {
  if (!utf16(value) || !value.trim() || value.length > 300) fail(code);
};
const hash = (value: unknown, code: string) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(code); };
function budget(value: unknown, maximum: number, code: string) {
  if (JSON.stringify(value).length > maximum) fail(code);
}
function uniqueIds(raw: unknown, maximum: number, code: string): string[] {
  const values = dense(raw, maximum, code); values.forEach(value => id(value, code));
  if (new Set(values).size !== values.length) fail(code);
  return values;
}
function coordinates(start: unknown, end: unknown, text: unknown, maximum: number, code: string) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)
    || !utf16(text) || !text.trim() || text.length > maximum || (end as number) - (start as number) !== text.length) fail(code);
}
function sourceSchema(raw: unknown, code: string) {
  const source = schema(raw, ['kind', 'entityId', 'version', 'contentHash', 'coordinateSpace', 'structureHash'], code);
  if (source.kind !== 'knowledge-note' || source.coordinateSpace !== 'saved-note-utf16') fail(code);
  id(source.entityId, code); id(source.version, code); hash(source.contentHash, code); hash(source.structureHash, code);
}

/** Structural qualification only. The caller must independently authenticate
 * the host's retained question/source receipt BEFORE supplying this context.
 * Its opaque sourceKey cannot be re-created from the reduced source DTO. */
function contextSchema(raw: unknown): asserts raw is ArgumentReferenceDisclosureContext {
  const code = 'invalid_proposition_context';
  const context = schema(raw, ['version', 'protocol', 'contractHash', 'rubricHash', 'originQuestionMessageId',
    'taskType', 'assessment', 'policy', 'coverage', 'frames', 'quotes', 'limitations'], code);
  if (context.version !== 1 || context.protocol !== 'review-frozen-reference-context-v1'
    || context.policy !== 'all_target_frames' || context.coverage !== 'complete_required') fail(code);
  hash(context.contractHash, code); hash(context.rubricHash, code); id(context.originQuestionMessageId, code);
  const limitations = schema(context.limitations, ['semanticTruth', 'writes'], code);
  if (limitations.semanticTruth !== 'not_certified' || limitations.writes !== 'disabled') fail(code);
  const assessment = schema(context.assessment, ['version', 'rubricVersion', 'status', 'taskType', 'requirements'], code);
  dense(assessment.requirements, 20, code).forEach(value => {
    const row = schema(value, ['knowledgeTarget', 'layer', 'criterionIds'], code);
    uniqueIds(row.criterionIds, 8, code);
  });
  const quotes = dense(context.quotes, 256, code), quoteIds = new Set<string>();
  for (const value of quotes) {
    const quote = schema(value, ['quoteId', 'sourceKey', 'start', 'end', 'text'], code);
    id(quote.quoteId, code); hash(quote.sourceKey, code);
    coordinates(quote.start, quote.end, quote.text, REFERENCE_PROPOSITION_LIMITS.context, code);
    if (quoteIds.has(quote.quoteId)) fail(code); quoteIds.add(quote.quoteId);
  }
  const frames = dense(context.frames, 20, code), frameIds = new Set<string>(), sourceKeys = new Map<string, string>();
  if (!frames.length) fail(code);
  for (const value of frames) {
    const frame = schema(value, ['frameId', 'knowledgeTarget', 'source', 'items', 'nodes', 'relations', 'groups'], code);
    id(frame.frameId, code); id(frame.knowledgeTarget, code); sourceSchema(frame.source, code);
    if (frameIds.has(frame.frameId)) fail(code); frameIds.add(frame.frameId);
    const nodes = dense(frame.nodes, 64, code), nodeIds = new Set<string>(), referencedQuotes = new Set<string>();
    const refs = (values: unknown) => {
      const ids = uniqueIds(values, 256, code); if (!ids.length || ids.some(value => !quoteIds.has(value))) fail(code);
      ids.forEach(value => referencedQuotes.add(value)); return ids;
    };
    for (const value of nodes) {
      const node = schema(value, ['id', 'role', 'quoteIds'], code); id(node.id, code);
      if (nodeIds.has(node.id) || !ARGUMENT_CONTEXT_ROLES.includes(node.role)) fail(code);
      nodeIds.add(node.id); refs(node.quoteIds);
    }
    const relations = dense(frame.relations, 128, code), relationIds = new Set<string>();
    for (const value of relations) {
      const relation = schema(value, ['id', 'sourceNodeId', 'targetNodeId', 'kind', 'quoteIds'], code); id(relation.id, code);
      if (relationIds.has(relation.id) || !nodeIds.has(relation.sourceNodeId) || !nodeIds.has(relation.targetNodeId)
        || relation.sourceNodeId === relation.targetNodeId || !ARGUMENT_CONTEXT_RELATIONS.includes(relation.kind)) fail(code);
      relationIds.add(relation.id); refs(relation.quoteIds);
    }
    const items = dense(frame.items, 60, code), itemIds = new Set<string>(); if (!items.length) fail(code);
    for (const value of items) {
      const item = schema(value, ['itemId', 'criterionId', 'quoteId', 'nodeIds', 'relationIds'], code); id(item.itemId, code);
      if (itemIds.has(item.itemId) || !Object.hasOwn(REVIEW_ASSESSMENT_CRITERIA, item.criterionId)) fail(code);
      itemIds.add(item.itemId); refs([item.quoteId]);
      const selectedNodes = uniqueIds(item.nodeIds, 64, code), selectedRelations = uniqueIds(item.relationIds, 128, code);
      if (!selectedNodes.length || selectedNodes.some(value => !nodeIds.has(value)) || selectedRelations.some(value => !relationIds.has(value))) fail(code);
    }
    const groups = dense(frame.groups, 64, code), groupIds = new Set<string>();
    for (const value of groups) {
      const group = schema(value, ['id', 'conclusionNodeId', 'premiseNodeIds', 'conditionNodeIds', 'relationIds', 'operator'], code); id(group.id, code);
      if (groupIds.has(group.id) || !nodeIds.has(group.conclusionNodeId) || !['all', 'any'].includes(group.operator)) fail(code);
      groupIds.add(group.id);
      if (uniqueIds(group.premiseNodeIds, 64, code).some(value => !nodeIds.has(value))
        || uniqueIds(group.conditionNodeIds, 64, code).some(value => !nodeIds.has(value))
        || uniqueIds(group.relationIds, 128, code).some(value => !relationIds.has(value))) fail(code);
    }
    const keys = new Set(quotes.filter(quote => referencedQuotes.has(quote.quoteId)).map(quote => quote.sourceKey));
    if (keys.size !== 1) fail(code);
    const key = [...keys][0], identity = JSON.stringify(Object.entries(frame.source).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (sourceKeys.has(key) && sourceKeys.get(key) !== identity) fail(code); sourceKeys.set(key, identity);
  }
  try {
    const parsed = parseReviewAssessment(assessment, frames.map(frame => frame.knowledgeTarget));
    if (parsed.status !== 'fixed' || parsed.taskType !== context.taskType) fail(code);
  } catch { fail(code); }
  budget(context, REFERENCE_PROPOSITION_LIMITS.context, 'proposition_context_budget_exceeded');
}
function draftSchema(raw: unknown): asserts raw is ReferencePropositionDraft {
  const code = 'invalid_proposition_draft', draft = schema(raw, ['version', 'protocol', 'contractHash', 'contextHash', 'anchors'], code);
  if (draft.version !== 1 || draft.protocol !== 'review-reference-proposition-draft-v1') fail(code);
  hash(draft.contractHash, code); hash(draft.contextHash, code);
  const ids = new Set<string>(), coordinatesSeen = new Set<string>();
  for (const value of dense(draft.anchors, REFERENCE_PROPOSITION_LIMITS.anchors, code)) {
    const anchor = schema(value, ['id', 'frameId', 'nodeId', 'quoteId', 'start', 'end', 'text'], code);
    for (const field of ['id', 'frameId', 'nodeId', 'quoteId']) id(anchor[field], code);
    coordinates(anchor.start, anchor.end, anchor.text, REFERENCE_PROPOSITION_LIMITS.text, code);
    const identity = JSON.stringify([anchor.frameId, anchor.nodeId, anchor.quoteId, anchor.start, anchor.end]);
    if (ids.has(anchor.id) || coordinatesSeen.has(identity)) fail(code); ids.add(anchor.id); coordinatesSeen.add(identity);
  }
  budget(draft, REFERENCE_PROPOSITION_LIMITS.draft, 'proposition_draft_budget_exceeded');
}
function reviewSchema(raw: unknown): asserts raw is ReferencePropositionReview {
  const code = 'invalid_proposition_review', review = schema(raw, ['version', 'protocol', 'reviewId', 'contextHash', 'draftHash', 'anchors'], code);
  if (review.version !== 1 || review.protocol !== 'review-reference-proposition-review-v1') fail(code);
  id(review.reviewId, code); hash(review.contextHash, code); hash(review.draftHash, code);
  const ids = new Set<string>();
  for (const value of dense(review.anchors, REFERENCE_PROPOSITION_LIMITS.anchors, code)) {
    const row = schema(value, ['id', 'decision', 'roleSupported', 'completeMeaning', 'scopePreserved', 'reason'], code);
    id(row.id, code);
    if (ids.has(row.id) || !['accept', 'reject', 'unknown'].includes(row.decision)
      || ['roleSupported', 'completeMeaning', 'scopePreserved'].some(field => typeof row[field] !== 'boolean')
      || !utf16(row.reason) || !row.reason.trim() || row.reason.length > 320) fail(code);
    ids.add(row.id);
  }
  budget(review, REFERENCE_PROPOSITION_LIMITS.review, 'proposition_review_budget_exceeded');
}
function resolve(context: ArgumentReferenceDisclosureContext, candidate: ReferencePropositionCandidate): ReferencePropositionBundle['anchors'][number] {
  const frame = context.frames.find(frame => frame.frameId === candidate.frameId);
  const node = frame?.nodes.find(node => node.id === candidate.nodeId), quote = context.quotes.find(quote => quote.quoteId === candidate.quoteId);
  if (!frame || !node || !quote || !node.quoteIds.includes(candidate.quoteId)
    || candidate.start < quote.start || candidate.end > quote.end
    || quote.text.slice(candidate.start - quote.start, candidate.end - quote.start) !== candidate.text) fail('invalid_proposition_anchor');
  // Exact coordinates disambiguate repeated phrases; never guess first occurrence
  // or cut by a connector. UTF-16 validity also rejects split surrogate pairs.
  return { ...structuredClone(candidate), role: node.role, sourceKey: quote.sourceKey, source: structuredClone(frame.source),
    parent: { quoteId: quote.quoteId, start: quote.start, end: quote.end, text: quote.text } };
}

/** Pure review preparation, not a call, authority grant or semantic decision.
 * No automatic candidates, keyword cuts, world-fact certification or writes. */
export async function prepareReferencePropositionReviewInput(context: ArgumentReferenceDisclosureContext,
  draft: ReferencePropositionDraft): Promise<ReferencePropositionReviewInput> {
  contextSchema(context); draftSchema(draft);
  const reference = structuredClone(context), savedDraft = structuredClone(draft);
  savedDraft.anchors.forEach(anchor => resolve(reference, anchor));
  const contextHash = await argumentContextHash(reference), draftHash = await argumentContextHash(savedDraft);
  if (savedDraft.contractHash !== reference.contractHash || savedDraft.contextHash !== contextHash) fail('proposition_binding_changed');
  const reviewId = `reference-propositions:${await argumentContextHash({ version: 1, contractHash: reference.contractHash, contextHash, draftHash })}`;
  const input: ReferencePropositionReviewInput = { version: 1, protocol: 'review-reference-proposition-review-input-v1',
    reviewId, contextHash, draftHash, reference, draft: savedDraft };
  budget(input, REFERENCE_PROPOSITION_LIMITS.reviewInput, 'proposition_review_input_budget_exceeded');
  return input;
}
const held = (error: unknown): ReferencePropositionReply => ({ status: 'held',
  reasons: [error instanceof ReferencePropositionError ? error.message : 'proposition_validation_unavailable'] });

/** The independent review must be supplied by a trusted caller, not copied from
 * the candidate producer or a bundle. All votes remain fallible semantic votes.
 * No rejected/unknown candidate is silently deleted to manufacture readiness. */
export async function finalizeReferencePropositions(context: ArgumentReferenceDisclosureContext, draft: ReferencePropositionDraft,
  review: ReferencePropositionReview): Promise<ReferencePropositionReply> {
  try {
    contextSchema(context); draftSchema(draft); reviewSchema(review);
    const savedContext = structuredClone(context), savedDraft = structuredClone(draft), savedReview = structuredClone(review);
    const input = await prepareReferencePropositionReviewInput(savedContext, savedDraft);
    if (savedReview.reviewId !== input.reviewId || savedReview.contextHash !== input.contextHash || savedReview.draftHash !== input.draftHash)
      fail('proposition_review_binding_changed');
    if (savedReview.anchors.length !== savedDraft.anchors.length || savedReview.anchors.some(row => !savedDraft.anchors.some(anchor => anchor.id === row.id)))
      fail('proposition_review_incomplete');
    if (savedReview.anchors.some(row => row.decision !== 'accept' || !row.roleSupported || !row.completeMeaning || !row.scopePreserved))
      fail('proposition_semantic_review_held');
    const anchors = savedDraft.anchors.map(anchor => resolve(savedContext, anchor));
    if (savedContext.frames.some(frame => frame.items.some(item => item.nodeIds.some(nodeId =>
      !anchors.some(anchor => anchor.frameId === frame.frameId && anchor.nodeId === nodeId))))) fail('proposition_required_nodes_missing');
    const body: Omit<ReferencePropositionBundle, 'bundleHash'> = { version: 1, protocol: 'review-reference-proposition-bundle-v1',
      reviewId: input.reviewId, contractHash: savedContext.contractHash, contextHash: input.contextHash, draftHash: input.draftHash,
      reviewHash: await argumentContextHash(savedReview), anchors, semanticTruth: 'not_certified', writes: 'disabled' };
    const bundle = { ...body, bundleHash: await argumentContextHash(body) };
    budget(bundle, REFERENCE_PROPOSITION_LIMITS.bundle, 'proposition_bundle_budget_exceeded');
    return { status: 'ready', bundle };
  } catch (error) { return held(error); }
}

/** Independently replays proof against the caller-authenticated current context;
 * bundle hashes alone are never proof of source authority or semantic review. */
export async function validateReferencePropositions(context: ArgumentReferenceDisclosureContext, bundle: ReferencePropositionBundle,
  proof: { draft: ReferencePropositionDraft; review: ReferencePropositionReview }): Promise<ReferencePropositionReply> {
  try {
    contextSchema(context);
    schema(proof, ['draft', 'review'], 'invalid_proposition_proof'); draftSchema(proof.draft); reviewSchema(proof.review);
    const value = schema(bundle, ['version', 'protocol', 'reviewId', 'contractHash', 'contextHash', 'draftHash', 'reviewHash',
      'bundleHash', 'anchors', 'semanticTruth', 'writes'], 'invalid_proposition_bundle');
    if (value.version !== 1 || value.protocol !== 'review-reference-proposition-bundle-v1'
      || value.semanticTruth !== 'not_certified' || value.writes !== 'disabled') fail('invalid_proposition_bundle');
    for (const field of ['contractHash', 'contextHash', 'draftHash', 'reviewHash', 'bundleHash']) hash(value[field], 'invalid_proposition_bundle');
    id(value.reviewId, 'invalid_proposition_bundle');
    for (const row of dense(value.anchors, REFERENCE_PROPOSITION_LIMITS.anchors, 'invalid_proposition_bundle')) {
      const anchor = schema(row, ['id', 'frameId', 'nodeId', 'quoteId', 'start', 'end', 'text', 'role', 'sourceKey', 'source', 'parent'], 'invalid_proposition_bundle');
      for (const field of ['id', 'frameId', 'nodeId', 'quoteId']) id(anchor[field], 'invalid_proposition_bundle');
      coordinates(anchor.start, anchor.end, anchor.text, REFERENCE_PROPOSITION_LIMITS.text, 'invalid_proposition_bundle');
      hash(anchor.sourceKey, 'invalid_proposition_bundle');
      if (!ARGUMENT_CONTEXT_ROLES.includes(anchor.role)) fail('invalid_proposition_bundle');
      sourceSchema(anchor.source, 'invalid_proposition_bundle');
      const parent = schema(anchor.parent, ['quoteId', 'start', 'end', 'text'], 'invalid_proposition_bundle');
      id(parent.quoteId, 'invalid_proposition_bundle');
      coordinates(parent.start, parent.end, parent.text, REFERENCE_PROPOSITION_LIMITS.context, 'invalid_proposition_bundle');
    }
    budget(bundle, REFERENCE_PROPOSITION_LIMITS.bundle, 'proposition_bundle_budget_exceeded');
    const savedContext = structuredClone(context), savedBundle = structuredClone(bundle), savedProof = structuredClone(proof);
    const rebuilt = await finalizeReferencePropositions(savedContext, savedProof.draft, savedProof.review);
    if (rebuilt.status !== 'ready') return rebuilt;
    // Rebuilding enforces every candidate, role, parent/source and review field;
    // even an attacker recomputing the submitted bundleHash cannot substitute it.
    if (await argumentContextHash(savedBundle) !== await argumentContextHash(rebuilt.bundle)) fail('proposition_bundle_changed');
    return rebuilt;
  } catch (error) { return held(error); }
}
