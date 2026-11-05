import { argumentContextHash, argumentCanonicalTextHash } from '../argumentContext/hash';
import { validateArgumentProjectionBuildInput } from '../argumentContext/construction';
import { createArgumentContextPointer } from '../argumentContext/reader';
import { reviewedTaskScopeNodeIds } from '../argumentContext/scopedAdmission';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../argumentContext/buildTypes';
import type { ArgumentContextProjection, ArgumentContextScope, ArgumentSourceIdentity } from '../argumentContext/types';
import type { ArgumentReferenceDisclosureContext } from '../argumentContext/referenceDisclosure';
import { prepareReferencePropositionReviewInput, validateReferencePropositions, type ReferencePropositionBundle,
  type ReferencePropositionDraft, type ReferencePropositionReview } from './referencePropositionAnchors';

export const SOURCE_PROPOSITION_LIMITS = { context: 64000, draft: 24000, review: 24000, reviewInput: 96000,
  bundle: 64000, proof: 256000, projectionProof: 1024000, anchors: 96, text: 1600 } as const;
export interface SourcePropositionContext {
  version: 1; protocol: 'review-source-proposition-context-v1' | 'review-task-source-proposition-context-v2'; source: ArgumentSourceIdentity;
  sourceBindingHash: string; buildId: string; resultHash: string; structureHash: string; sourceKey: string;
  scope: ArgumentContextScope; scopeHash: string; canonicalText: string;
  quotes: ArgumentProjectionBuildInput['quotes']; projection: ArgumentContextProjection;
  qualification: ArgumentProjectionBuildInput['sourceQualification'];
}
export interface SourcePropositionDraft {
  version: 1; protocol: 'review-source-proposition-draft-v1'; contextHash: string;
  anchors: { id: string; nodeId: string; quoteId: string; start: number; end: number; text: string }[];
}
export interface SourcePropositionReview {
  version: 1 | 2; protocol: 'review-source-proposition-review-v1' | 'review-task-source-proposition-review-v2'; reviewId: string; contextHash: string; draftHash: string;
  anchors: { id: string; decision: 'accept' | 'reject' | 'unknown'; roleSupported: boolean; completeMeaning: boolean;
    scopePreserved: boolean; reason: string }[];
}
export interface SourcePropositionReviewInput {
  version: 1; protocol: 'review-source-proposition-review-input-v1'; reviewId: string; contextHash: string; draftHash: string;
  reference: SourcePropositionContext; draft: SourcePropositionDraft;
}
export interface SourcePropositionBundle {
  version: 1 | 2; protocol: 'review-source-proposition-bundle-v1' | 'review-task-source-proposition-bundle-v2'; contextHash: string; draftHash: string; reviewHash: string;
  reviewId: string; source: ArgumentSourceIdentity; sourceBindingHash: string; buildId: string; resultHash: string;
  structureHash: string; sourceKey: string; bundleHash: string;
  anchors: (SourcePropositionDraft['anchors'][number] & { role: ArgumentContextProjection['nodes'][number]['role'];
    parent: ArgumentProjectionBuildInput['quotes'][number] })[];
  semanticTruth: 'not_certified'; writes: 'disabled';
}
export interface SourcePropositionProof {
  input: ArgumentProjectionBuildInput; result: ArgumentProjectionBuildResult; draft: SourcePropositionDraft;
  review: SourcePropositionReview; bundle: SourcePropositionBundle;
}
export interface SourceReviewedQuestionPropositionBundle {
  version: 2; protocol: 'review-source-question-proposition-bundle-v2'; contractHash: string; contextHash: string;
  bundleHash: string; anchors: ReferencePropositionBundle['anchors'];
  reviewBasis: { kind: 'source-reviewed'; sourceBundleHashes: string[]; questionSpecificReview: 'not_performed' };
  semanticTruth: 'not_certified'; writes: 'disabled';
}
export type ReviewedReferencePropositionBundle = ReferencePropositionBundle | SourceReviewedQuestionPropositionBundle;
export interface SourcePropositionProjectionProof {
  version: 2; protocol: 'review-source-proposition-projection-proof-v2'; sources: SourcePropositionProof[];
}
export type ReviewedReferencePropositionProof = { draft: ReferencePropositionDraft; review: ReferencePropositionReview }
  | SourcePropositionProjectionProof;
export type SourcePropositionReply = { status: 'ready'; bundle: SourcePropositionBundle } | { status: 'held'; reasons: string[] };
export type SourceQuestionPropositionReply = { status: 'ready'; bundle: SourceReviewedQuestionPropositionBundle;
  proof: SourcePropositionProjectionProof } | { status: 'held'; reasons: string[] };
export class SourcePropositionError extends Error {}
const fail = (code: string): never => { throw new SourcePropositionError(code); };
const held = (error: unknown) => ({ status: 'held' as const,
  reasons: [error instanceof SourcePropositionError ? error.message : 'source_proposition_unavailable'] });
function data(raw: unknown, depth = 0): void {
  if (depth > 64) fail('invalid_source_proposition_shape');
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string' || typeof raw === 'number' && Number.isFinite(raw)) return;
  if (!raw || typeof raw !== 'object') fail('invalid_source_proposition_shape');
  if (Array.isArray(raw)) {
    if (raw.length > 2048 || Reflect.ownKeys(raw).length !== raw.length + 1
      || Object.keys(raw).some((key, index) => key !== String(index))) fail('invalid_source_proposition_shape');
  } else if (![Object.prototype, null].includes(Object.getPrototypeOf(raw as object))
    || Reflect.ownKeys(raw as object).some(key => typeof key !== 'string')) fail('invalid_source_proposition_shape');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.entries(descriptors).some(([key, value]) => !Object.hasOwn(value, 'value')
    || (key !== 'length' || !Array.isArray(raw)) && !value.enumerable)) fail('invalid_source_proposition_shape');
  Object.entries(descriptors).forEach(([key, value]) => { if (key !== 'length' || !Array.isArray(raw)) data(value.value, depth + 1); });
}
function closed(raw: unknown, fields: string[], code: string): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join('|') !== [...fields].sort().join('|')) fail(code);
  return raw as Record<string, any>;
}
function dense(raw: unknown, maximum: number, code: string): any[] {
  if (!Array.isArray(raw) || raw.length > maximum || Object.keys(raw).length !== raw.length
    || Object.keys(raw).some((key, index) => key !== String(index))) fail(code);
  return raw as any[];
}
function utf16(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = raw.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  } return true;
}
const id = (raw: unknown) => { if (!utf16(raw) || !raw.trim() || raw.length > 300) fail('invalid_source_proposition_id'); };
const hash = (raw: unknown) => { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) fail('invalid_source_proposition_hash'); };
const budget = (raw: unknown, maximum: number, code: string) => { if (JSON.stringify(raw).length > maximum) fail(code); };
async function equal(left: unknown, right: unknown) { return await argumentContextHash(left) === await argumentContextHash(right); }
function qualification(context: SourcePropositionContext) {
  if (context.protocol === 'review-task-source-proposition-context-v2') {
    if (!['knowledge-note', 'uploaded-document'].includes(context.source.kind) || context.scope.corpus !== 'reference'
      || context.qualification.status !== 'eligible' || !reviewedTaskScopeNodeIds(context.projection).length) fail('source_proposition_not_qualified');
    return;
  }
  if (!['knowledge-note', 'uploaded-document'].includes(context.source.kind) || context.scope.corpus !== 'reference'
    || context.qualification.status !== 'eligible' || context.projection.quality.status !== 'eligible'
    || context.projection.build.origin !== 'validated-projection' || context.projection.build.gaps.length
    || !context.projection.nodes.length || !context.projection.build.scopes.length
    || context.projection.build.scopes.some(scope => scope.status !== 'reviewed_for_scope')
    || [...context.projection.nodes, ...context.projection.relations, ...context.projection.prerequisiteGroups]
      .some(row => row.admission !== 'admitted' || row.semanticStatus !== 'reviewed')
    || context.projection.prerequisiteGroups.some(group => group.operator === 'unknown')) fail('source_proposition_not_qualified');
}
/** Source menus and drafts cover every usable task node, never upgrade or delete audit rows. */
export function sourcePropositionRequiredNodeIds(context: SourcePropositionContext): string[] {
  return context.protocol === 'review-task-source-proposition-context-v2' ? reviewedTaskScopeNodeIds(context.projection)
    : context.projection.nodes.map(node => node.id);
}
function ownParent(context: SourcePropositionContext, nodeId: string, quoteId: string) {
  const node = context.projection.nodes.find(node => node.id === nodeId), parent = context.quotes.find(quote => quote.quoteId === quoteId);
  if (!sourcePropositionRequiredNodeIds(context).includes(nodeId) || !node || !parent || !node.evidence.some(span => span.sentenceId === parent.evidence.sentenceId
    && span.start === parent.evidence.start && span.end === parent.evidence.end && span.quote === parent.evidence.quote)) fail('source_proposition_parent_mismatch');
  return { node, parent };
}
async function contextValid(raw: SourcePropositionContext) {
  data(raw); const value = closed(raw, ['version', 'protocol', 'source', 'sourceBindingHash', 'buildId', 'resultHash', 'structureHash', 'sourceKey',
    'scope', 'scopeHash', 'canonicalText', 'quotes', 'projection', 'qualification'], 'invalid_source_proposition_context');
  if (value.version !== 1 || !['review-source-proposition-context-v1', 'review-task-source-proposition-context-v2'].includes(value.protocol)
    || !utf16(value.canonicalText)) fail('invalid_source_proposition_context');
  for (const field of ['sourceBindingHash', 'buildId', 'resultHash', 'structureHash', 'sourceKey', 'scopeHash']) hash(value[field]);
  closed(raw.qualification, ['status', 'policyVersion', 'evidence'], 'invalid_source_proposition_context');
  id(raw.qualification.policyVersion);
  const qualificationEvidence = dense(raw.qualification.evidence, 16, 'invalid_source_proposition_context');
  if (!qualificationEvidence.length) fail('source_proposition_not_qualified');
  const qualificationLocations = new Set<string>();
  for (const span of qualificationEvidence) {
    closed(span, ['sentenceId', 'start', 'end', 'quote'], 'invalid_source_proposition_context'); id(span.sentenceId);
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start
      || span.end > raw.canonicalText.length || !utf16(span.quote) || span.quote !== raw.canonicalText.slice(span.start, span.end)) fail('source_proposition_parent_mismatch');
    const location = JSON.stringify([span.sentenceId, span.start, span.end]);
    if (qualificationLocations.has(location)) fail('invalid_source_proposition_context'); qualificationLocations.add(location);
  }
  qualification(raw);
  const quoteIds = new Set<string>();
  for (const row of dense(raw.quotes, 256, 'invalid_source_proposition_context')) {
    closed(row, ['quoteId', 'evidence', 'chunkIds', 'completeSentence'], 'invalid_source_proposition_context'); id(row.quoteId);
    if (quoteIds.has(row.quoteId) || typeof row.completeSentence !== 'boolean') fail('invalid_source_proposition_context'); quoteIds.add(row.quoteId);
    const span = closed(row.evidence, ['sentenceId', 'start', 'end', 'quote'], 'invalid_source_proposition_context'); id(span.sentenceId);
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start
      || span.end > raw.canonicalText.length || !utf16(span.quote) || span.quote !== raw.canonicalText.slice(span.start, span.end)) fail('source_proposition_parent_mismatch');
    const chunks = dense(row.chunkIds, 256, 'invalid_source_proposition_context'); chunks.forEach(id);
    if (!chunks.length || new Set(chunks).size !== chunks.length) fail('invalid_source_proposition_context');
  }
  await createArgumentContextPointer(raw.projection, { source: raw.source, canonicalText: raw.canonicalText, structureHash: raw.structureHash }, raw.scope, [raw.projection.nodes[0].id]);
  if (!await equal(raw.source, raw.projection.source) || await argumentCanonicalTextHash(raw.canonicalText) !== raw.source.contentHash
    || await argumentContextHash(raw.scope) !== raw.scopeHash
    || await argumentContextHash({ source: raw.source, structureHash: raw.structureHash }) !== raw.sourceKey) fail('source_proposition_binding_changed');
  for (const node of raw.projection.nodes) for (const span of node.evidence)
    if (!raw.quotes.some(parent => parent.evidence.sentenceId === span.sentenceId && parent.evidence.start === span.start
      && parent.evidence.end === span.end && parent.evidence.quote === span.quote)) fail('source_proposition_parent_mismatch');
  budget(raw, SOURCE_PROPOSITION_LIMITS.context, 'source_proposition_context_budget_exceeded');
}

/** Pure structural/context binding validation, not host permission or current-source authority.
 * Validate descriptors before cloning and retain one snapshot across every await. */
export async function validateSourcePropositionContextSnapshot(context: SourcePropositionContext): Promise<SourcePropositionContext> {
  data(context); const snapshot = structuredClone(context);
  await contextValid(snapshot); return structuredClone(snapshot);
}

/** Caller must FIRST independently authenticate active projection, source policy,
 * and retained construction proof. Recomputable flags/hashes are not authority. */
export async function prepareSourcePropositionContext(input: ArgumentProjectionBuildInput, result: ArgumentProjectionBuildResult): Promise<SourcePropositionContext> {
  data(input); data(result); const savedInput = structuredClone(input), savedResult = structuredClone(result);
  await validateArgumentProjectionBuildInput(savedInput);
  closed(savedResult, ['version', 'contractVersion', 'buildId', 'reviewId', 'draftHash', 'resultHash', 'status', 'projection', 'authority', 'audit', 'limitations'], 'invalid_source_proposition_result');
  const { resultHash, ...resultBody } = savedResult;
  if (savedResult.version !== 1 || savedResult.contractVersion !== savedInput.contractVersion || savedResult.buildId !== savedInput.buildId
    || !['reviewed_complete', 'reviewed_scoped'].includes(savedResult.status) || await argumentContextHash(resultBody) !== resultHash
    || !await equal(savedResult.authority.source, savedInput.source) || !await equal(savedResult.projection.source, savedInput.source)
    || savedResult.authority.canonicalText !== savedInput.canonicalText || !await equal(savedResult.limitations, savedInput.limitations)) fail('source_proposition_binding_changed');
  closed(savedResult.authority, ['source', 'canonicalText', 'structureHash'], 'invalid_source_proposition_result');
  const audit = closed(savedResult.audit, ['nodes', 'relations', 'groups', 'scopes'], 'invalid_source_proposition_result');
  for (const rows of Object.values(audit)) for (const row of dense(rows, 128, 'invalid_source_proposition_result'))
    closed(row, ['id', 'decision', 'quoteIds', 'reason'], 'invalid_source_proposition_result');
  const context: SourcePropositionContext = { version: 1, protocol: savedResult.status === 'reviewed_scoped'
    ? 'review-task-source-proposition-context-v2' : 'review-source-proposition-context-v1', source: savedInput.source,
    sourceBindingHash: savedInput.sourceBindingHash, buildId: savedInput.buildId, resultHash: savedResult.resultHash,
    structureHash: savedResult.authority.structureHash, sourceKey: await argumentContextHash({ source: savedInput.source, structureHash: savedResult.authority.structureHash }),
    scope: savedInput.scope, scopeHash: savedInput.scopeHash, canonicalText: savedInput.canonicalText, quotes: savedInput.quotes,
    projection: savedResult.projection, qualification: savedInput.sourceQualification };
  await contextValid(context); return structuredClone(context);
}
function draftValid(draft: SourcePropositionDraft, context: SourcePropositionContext) {
  data(draft); closed(draft, ['version', 'protocol', 'contextHash', 'anchors'], 'invalid_source_proposition_draft');
  if (draft.version !== 1 || draft.protocol !== 'review-source-proposition-draft-v1') fail('invalid_source_proposition_draft'); hash(draft.contextHash);
  const ids = new Set<string>(), locations = new Set<string>();
  for (const row of dense(draft.anchors, SOURCE_PROPOSITION_LIMITS.anchors, 'invalid_source_proposition_draft')) {
    closed(row, ['id', 'nodeId', 'quoteId', 'start', 'end', 'text'], 'invalid_source_proposition_draft'); [row.id, row.nodeId, row.quoteId].forEach(id);
    const { parent } = ownParent(context, row.nodeId, row.quoteId), span = parent.evidence;
    const location = JSON.stringify([row.nodeId, row.quoteId, row.start, row.end]);
    if (ids.has(row.id) || locations.has(location) || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)
      || row.start < span.start || row.end > span.end || row.end <= row.start || !utf16(row.text) || !row.text.trim()
      || row.text.length > SOURCE_PROPOSITION_LIMITS.text || context.canonicalText.slice(row.start, row.end) !== row.text) fail('invalid_source_proposition_anchor');
    ids.add(row.id); locations.add(location);
  }
  if (sourcePropositionRequiredNodeIds(context).some(nodeId => !draft.anchors.some(anchor => anchor.nodeId === nodeId))) fail('source_proposition_required_nodes_missing');
  budget(draft, SOURCE_PROPOSITION_LIMITS.draft, 'source_proposition_draft_budget_exceeded');
}
function reviewValid(review: SourcePropositionReview) {
  data(review); closed(review, ['version', 'protocol', 'reviewId', 'contextHash', 'draftHash', 'anchors'], 'invalid_source_proposition_review');
  if (review.version === 1 ? review.protocol !== 'review-source-proposition-review-v1'
    : review.version !== 2 || review.protocol !== 'review-task-source-proposition-review-v2') fail('invalid_source_proposition_review');
  id(review.reviewId); hash(review.contextHash); hash(review.draftHash); const ids = new Set<string>();
  for (const row of dense(review.anchors, SOURCE_PROPOSITION_LIMITS.anchors, 'invalid_source_proposition_review')) {
    closed(row, ['id', 'decision', 'roleSupported', 'completeMeaning', 'scopePreserved', 'reason'], 'invalid_source_proposition_review'); id(row.id);
    if (ids.has(row.id) || !['accept', 'reject', 'unknown'].includes(row.decision)
      || ['roleSupported', 'completeMeaning', 'scopePreserved'].some(field => typeof row[field] !== 'boolean')
      || !utf16(row.reason) || !row.reason.trim() || row.reason.length > 320) fail('invalid_source_proposition_review'); ids.add(row.id);
  } budget(review, SOURCE_PROPOSITION_LIMITS.review, 'source_proposition_review_budget_exceeded');
}
export async function prepareSourcePropositionReviewInput(context: SourcePropositionContext, draft: SourcePropositionDraft): Promise<SourcePropositionReviewInput> {
  data(context); data(draft); const reference = structuredClone(context), savedDraft = structuredClone(draft);
  await contextValid(reference); draftValid(savedDraft, reference);
  const contextHash = await argumentContextHash(reference), draftHash = await argumentContextHash(savedDraft);
  if (savedDraft.contextHash !== contextHash) fail('source_proposition_binding_changed');
  const input: SourcePropositionReviewInput = { version: 1, protocol: 'review-source-proposition-review-input-v1',
    reviewId: `source-propositions:${await argumentContextHash({ contextHash, draftHash })}`, contextHash, draftHash, reference, draft: savedDraft };
  budget(input, SOURCE_PROPOSITION_LIMITS.reviewInput, 'source_proposition_review_input_budget_exceeded'); return input;
}
export async function finalizeSourcePropositions(context: SourcePropositionContext, draft: SourcePropositionDraft, review: SourcePropositionReview): Promise<SourcePropositionReply> {
  try {
    data(context); data(draft); reviewValid(review);
    const savedContext = structuredClone(context), savedDraft = structuredClone(draft), savedReview = structuredClone(review);
    const input = await prepareSourcePropositionReviewInput(savedContext, savedDraft);
    const scoped = savedContext.protocol === 'review-task-source-proposition-context-v2';
    if (savedReview.version !== (scoped ? 2 : 1)) fail('source_proposition_review_binding_changed');
    if (savedReview.reviewId !== input.reviewId || savedReview.contextHash !== input.contextHash || savedReview.draftHash !== input.draftHash) fail('source_proposition_review_binding_changed');
    if (savedReview.anchors.length !== savedDraft.anchors.length || savedReview.anchors.some(row => !savedDraft.anchors.some(anchor => anchor.id === row.id))) fail('source_proposition_review_incomplete');
    const accepted = (row: SourcePropositionReview['anchors'][number]) => row.decision === 'accept' && row.roleSupported && row.completeMeaning && row.scopePreserved;
    if (savedReview.anchors.some(row => row.decision === 'accept' && !accepted(row))) fail('source_proposition_review_held');
    if (!scoped && savedReview.anchors.some(row => !accepted(row))) fail('source_proposition_review_held');
    const goodNodes = new Set(sourcePropositionRequiredNodeIds(savedContext).filter(nodeId => savedDraft.anchors
      .filter(anchor => anchor.nodeId === nodeId).every(anchor => accepted(savedReview.anchors.find(row => row.id === anchor.id)!))));
    const usable = new Set(scoped ? reviewedTaskScopeNodeIds(savedContext.projection, goodNodes) : sourcePropositionRequiredNodeIds(savedContext));
    if (!usable.size) fail('source_proposition_review_held');
    const body: Omit<SourcePropositionBundle, 'bundleHash'> = { version: scoped ? 2 : 1,
      protocol: scoped ? 'review-task-source-proposition-bundle-v2' : 'review-source-proposition-bundle-v1',
      contextHash: input.contextHash, draftHash: input.draftHash, reviewHash: await argumentContextHash(savedReview), reviewId: input.reviewId,
      source: savedContext.source, sourceBindingHash: savedContext.sourceBindingHash, buildId: savedContext.buildId, resultHash: savedContext.resultHash,
      structureHash: savedContext.structureHash, sourceKey: savedContext.sourceKey,
      anchors: savedDraft.anchors.filter(anchor => usable.has(anchor.nodeId)).map(anchor => { const { node, parent } = ownParent(savedContext, anchor.nodeId, anchor.quoteId);
        return { ...anchor, role: node.role, parent: structuredClone(parent) }; }), semanticTruth: 'not_certified', writes: 'disabled' };
    const bundle = { ...body, bundleHash: await argumentContextHash(body) }; budget(bundle, SOURCE_PROPOSITION_LIMITS.bundle, 'source_proposition_bundle_budget_exceeded');
    return { status: 'ready', bundle };
  } catch (error) { return held(error); }
}
export async function validateSourcePropositions(input: ArgumentProjectionBuildInput, result: ArgumentProjectionBuildResult,
  bundle: SourcePropositionBundle, proof: { draft: SourcePropositionDraft; review: SourcePropositionReview }): Promise<SourcePropositionReply> {
  try {
    data(input); data(result); data(bundle); data(proof); closed(proof, ['draft', 'review'], 'invalid_source_proposition_proof');
    closed(bundle, ['version', 'protocol', 'contextHash', 'draftHash', 'reviewHash', 'reviewId', 'source', 'sourceBindingHash',
      'buildId', 'resultHash', 'structureHash', 'sourceKey', 'bundleHash', 'anchors', 'semanticTruth', 'writes'], 'invalid_source_proposition_bundle');
    if ((bundle.version === 1 ? bundle.protocol !== 'review-source-proposition-bundle-v1'
      : bundle.version !== 2 || bundle.protocol !== 'review-task-source-proposition-bundle-v2')
      || bundle.semanticTruth !== 'not_certified' || bundle.writes !== 'disabled') fail('invalid_source_proposition_bundle');
    id(bundle.reviewId);
    for (const field of ['contextHash', 'draftHash', 'reviewHash', 'sourceBindingHash', 'buildId', 'resultHash', 'structureHash', 'sourceKey', 'bundleHash'] as const) hash(bundle[field]);
    for (const anchor of dense(bundle.anchors, SOURCE_PROPOSITION_LIMITS.anchors, 'invalid_source_proposition_bundle')) {
      closed(anchor, ['id', 'nodeId', 'quoteId', 'start', 'end', 'text', 'role', 'parent'], 'invalid_source_proposition_bundle');
      closed(anchor.parent, ['quoteId', 'evidence', 'chunkIds', 'completeSentence'], 'invalid_source_proposition_bundle');
      closed(anchor.parent.evidence, ['sentenceId', 'start', 'end', 'quote'], 'invalid_source_proposition_bundle');
    }
    budget(bundle, SOURCE_PROPOSITION_LIMITS.bundle, 'source_proposition_bundle_budget_exceeded');
    const saved = structuredClone({ input, result, bundle, proof }); budget(saved, SOURCE_PROPOSITION_LIMITS.proof, 'source_proposition_proof_budget_exceeded');
    const context = await prepareSourcePropositionContext(saved.input, saved.result), rebuilt = await finalizeSourcePropositions(context, saved.proof.draft, saved.proof.review);
    if (rebuilt.status !== 'ready') return rebuilt;
    if (!await equal(saved.bundle, rebuilt.bundle)) fail('source_proposition_bundle_changed'); return rebuilt;
  } catch (error) { return held(error); }
}
const proofFields = ['input', 'result', 'draft', 'review', 'bundle'];
async function questionContext(context: ArgumentReferenceDisclosureContext) {
  // Reuse the legacy closed context/qualification gate only. No review vote is
  // fabricated, and the unused empty review ID is never saved or used as audit.
  const empty: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1', contractHash: context.contractHash,
    contextHash: await argumentContextHash(context), anchors: [] };
  await prepareReferencePropositionReviewInput(context, empty);
}

/** Mechanical scope projection of already independently source-reviewed anchors.
 * No question-level accept票 is created, and no source or required closure expands. */
export async function projectReferenceSourcePropositions(context: ArgumentReferenceDisclosureContext,
  sources: SourcePropositionProof[]): Promise<SourceQuestionPropositionReply> {
  try {
    data(context); data(sources); dense(sources, 20, 'invalid_source_proposition_projection_proof');
    sources.forEach(source => closed(source, proofFields, 'invalid_source_proposition_projection_proof'));
    const reference = structuredClone(context), savedSources = structuredClone(sources);
    budget(savedSources, SOURCE_PROPOSITION_LIMITS.projectionProof, 'source_proposition_projection_proof_budget_exceeded'); await questionContext(reference);
    const validated = [] as { proof: SourcePropositionProof; context: SourcePropositionContext }[];
    for (const proof of savedSources) {
      const replay = await validateSourcePropositions(proof.input, proof.result, proof.bundle, { draft: proof.draft, review: proof.review });
      if (replay.status !== 'ready') return replay;
      validated.push({ proof: { ...proof, bundle: replay.bundle }, context: await prepareSourcePropositionContext(proof.input, proof.result) });
    }
    const used = new Set<number>(), anchors: ReferencePropositionBundle['anchors'] = [];
    for (const frame of reference.frames) {
      const matching = validated.map((row, index) => ({ row, index })).filter(({ row }) => row.context.source.kind === frame.source.kind
        && row.context.source.entityId === frame.source.entityId && row.context.source.version === frame.source.version
        && row.context.source.contentHash === frame.source.contentHash && row.context.source.coordinateSpace === frame.source.coordinateSpace
        && row.context.structureHash === frame.source.structureHash);
      if (matching.length !== 1) fail('source_proposition_source_missing_or_ambiguous');
      const { row, index } = matching[0]; used.add(index);
      // Same first seed+task rule as the original reader. These are stored read
      // obligations, not newly invented scoring standards or semantic guesses.
      const scopes = frame.nodes.map(node => row.context.projection.build.scopes.find(scope =>
        scope.seedNodeId === node.id && scope.task === reference.taskType)).filter(scope => scope !== undefined);
      const requiredNodes = new Set(scopes.flatMap(scope => scope.requiredNodeIds));
      const requiredRelations = new Set(scopes.flatMap(scope => scope.requiredRelationIds));
      const requiredGroups = new Set(scopes.flatMap(scope => scope.requiredGroupIds));
      const exact = (required: Set<string>, actual: string[]) => required.size === actual.length && actual.every(id => required.has(id));
      if (!scopes.length || !exact(requiredNodes, frame.nodes.map(node => node.id))
        || !exact(requiredRelations, frame.relations.map(relation => relation.id))
        || !exact(requiredGroups, frame.groups.map(group => group.id))) fail('source_proposition_required_closure_missing');
      for (const scope of scopes) for (const item of frame.items.filter(item => item.criterionId === 'inference_link' && item.nodeIds.includes(scope.seedNodeId)))
        if (scope.requiredNodeIds.some(id => !item.nodeIds.includes(id)) || scope.requiredRelationIds.some(id => !item.relationIds.includes(id))) fail('source_proposition_required_closure_missing');
      for (const node of frame.nodes) {
        const original = row.context.projection.nodes.find(candidate => candidate.id === node.id);
        if (!original || original.role !== node.role) fail('source_proposition_node_changed');
        for (const quoteId of node.quoteIds) {
          const quote = reference.quotes.find(quote => quote.quoteId === quoteId);
          if (!quote || quote.sourceKey !== row.context.sourceKey || !original.evidence.some(span => span.start === quote.start && span.end === quote.end && span.quote === quote.text)) fail('source_proposition_parent_mismatch');
        }
      }
      for (const relation of frame.relations) {
        const original = row.context.projection.relations.find(candidate => candidate.id === relation.id);
        if (!original || original.sourceNodeId !== relation.sourceNodeId || original.targetNodeId !== relation.targetNodeId || original.kind !== relation.kind) fail('source_proposition_relation_changed');
        if (relation.quoteIds.some(id => { const quote = reference.quotes.find(quote => quote.quoteId === id);
          return !quote || quote.sourceKey !== row.context.sourceKey || !original.evidence.some(span => span.start === quote.start && span.end === quote.end && span.quote === quote.text); })) fail('source_proposition_parent_mismatch');
      }
      for (const group of frame.groups) {
        const original = row.context.projection.prerequisiteGroups.find(candidate => candidate.id === group.id);
        if (!original || original.conclusionNodeId !== group.conclusionNodeId || original.operator !== group.operator
          || !await equal(original.premiseNodeIds, group.premiseNodeIds) || !await equal(original.conditionNodeIds, group.conditionNodeIds)
          || !await equal(original.relationIds, group.relationIds)) fail('source_proposition_group_changed');
        if ([group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].some(id => !frame.nodes.some(node => node.id === id))
          || group.relationIds.some(id => !frame.relations.some(relation => relation.id === id))) fail('source_proposition_required_closure_missing');
        for (const item of frame.items.filter(item => item.criterionId === 'inference_link' && item.nodeIds.includes(group.conclusionNodeId)))
          if ([group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].some(id => !item.nodeIds.includes(id))
            || group.relationIds.some(id => !item.relationIds.includes(id))) fail('source_proposition_required_closure_missing');
      }
      const required = new Set(frame.items.flatMap(item => item.nodeIds));
      for (const candidate of row.proof.bundle.anchors.filter(anchor => required.has(anchor.nodeId))) {
        const node = frame.nodes.find(node => node.id === candidate.nodeId)!;
        const parent = reference.quotes.find(quote => node.quoteIds.includes(quote.quoteId)
          && quote.sourceKey === row.context.sourceKey && quote.start === candidate.parent.evidence.start
          && quote.end === candidate.parent.evidence.end && quote.text === candidate.parent.evidence.quote);
        if (!parent) fail('source_proposition_parent_mismatch');
        anchors.push({ id: `SP-${await argumentContextHash({ frameId: frame.frameId, sourceBundleHash: row.proof.bundle.bundleHash, anchorId: candidate.id })}`,
          frameId: frame.frameId, nodeId: candidate.nodeId, quoteId: parent.quoteId, start: candidate.start, end: candidate.end, text: candidate.text,
          role: candidate.role, sourceKey: parent.sourceKey, source: structuredClone(frame.source),
          parent: { quoteId: parent.quoteId, start: parent.start, end: parent.end, text: parent.text } });
      }
      if ([...required].some(nodeId => !anchors.some(anchor => anchor.frameId === frame.frameId && anchor.nodeId === nodeId))) fail('source_proposition_required_nodes_missing');
    }
    if (used.size !== validated.length) fail('source_proposition_source_out_of_scope');
    const body: Omit<SourceReviewedQuestionPropositionBundle, 'bundleHash'> = { version: 2, protocol: 'review-source-question-proposition-bundle-v2',
      contractHash: reference.contractHash, contextHash: await argumentContextHash(reference), anchors,
      reviewBasis: { kind: 'source-reviewed', sourceBundleHashes: validated.map(row => row.proof.bundle.bundleHash).sort(), questionSpecificReview: 'not_performed' },
      semanticTruth: 'not_certified', writes: 'disabled' };
    const bundle = { ...body, bundleHash: await argumentContextHash(body) }; budget(bundle, SOURCE_PROPOSITION_LIMITS.bundle, 'source_proposition_question_bundle_budget_exceeded');
    return { status: 'ready', bundle, proof: { version: 2, protocol: 'review-source-proposition-projection-proof-v2', sources: savedSources } };
  } catch (error) { return held(error); }
}
export async function validateReviewedReferencePropositions(context: ArgumentReferenceDisclosureContext, bundle: ReviewedReferencePropositionBundle,
  proof: ReviewedReferencePropositionProof): Promise<{ status: 'ready'; bundle: ReviewedReferencePropositionBundle } | { status: 'held'; reasons: string[] }> {
  try {
    data(context); data(bundle); data(proof);
    if (bundle.version === 1) {
      closed(proof, ['draft', 'review'], 'invalid_source_proposition_projection_proof');
      return validateReferencePropositions(context, bundle, proof as { draft: ReferencePropositionDraft; review: ReferencePropositionReview });
    }
    closed(bundle, ['version', 'protocol', 'contractHash', 'contextHash', 'bundleHash', 'anchors', 'reviewBasis', 'semanticTruth', 'writes'], 'invalid_source_question_proposition_bundle');
    if (bundle.version !== 2 || bundle.protocol !== 'review-source-question-proposition-bundle-v2' || bundle.semanticTruth !== 'not_certified' || bundle.writes !== 'disabled') fail('invalid_source_question_proposition_bundle');
    closed(bundle.reviewBasis, ['kind', 'sourceBundleHashes', 'questionSpecificReview'], 'invalid_source_question_proposition_bundle');
    if (bundle.reviewBasis.kind !== 'source-reviewed' || bundle.reviewBasis.questionSpecificReview !== 'not_performed') fail('invalid_source_question_proposition_bundle');
    for (const field of ['contractHash', 'contextHash', 'bundleHash'] as const) hash(bundle[field]);
    const sourceHashes = dense(bundle.reviewBasis.sourceBundleHashes, 20, 'invalid_source_question_proposition_bundle'); sourceHashes.forEach(hash);
    if (!sourceHashes.length || new Set(sourceHashes).size !== sourceHashes.length
      || sourceHashes.some((value, index) => value !== [...sourceHashes].sort()[index])) fail('invalid_source_question_proposition_bundle');
    dense(bundle.anchors, SOURCE_PROPOSITION_LIMITS.anchors, 'invalid_source_question_proposition_bundle');
    budget(bundle, SOURCE_PROPOSITION_LIMITS.bundle, 'source_proposition_question_bundle_budget_exceeded');
    closed(proof, ['version', 'protocol', 'sources'], 'invalid_source_proposition_projection_proof');
    const typedProof = proof as SourcePropositionProjectionProof;
    if (typedProof.version !== 2 || typedProof.protocol !== 'review-source-proposition-projection-proof-v2') fail('invalid_source_proposition_projection_proof');
    const saved = structuredClone({ context, bundle, proof: typedProof }), rebuilt = await projectReferenceSourcePropositions(saved.context, saved.proof.sources);
    if (rebuilt.status !== 'ready') return rebuilt;
    if (!await equal(saved.bundle, rebuilt.bundle)) fail('source_proposition_question_bundle_changed');
    return { status: 'ready', bundle: rebuilt.bundle };
  } catch (error) { return held(error); }
}
