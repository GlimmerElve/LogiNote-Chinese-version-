import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteItem } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionTaskReview } from '../src/services/argumentContext/buildTypes.ts';
import { ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL } from '../src/services/argumentContext/buildTypes.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionTaskReviewInput, readArgumentProjectionTaskReview,
  buildArgumentProjectionSourceReviewInput, readArgumentProjectionSourceReview, finalizeArgumentProjectionBuild,
  verifyArgumentProjectionBuildResult } from '../src/services/argumentContext/construction.ts';
import { buildArgumentProjectionTaskReviewRequest, ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT } from '../src/services/argumentContext/buildPrompts.ts';
import { reviewedTaskScopeNodeIds } from '../src/services/argumentContext/scopedAdmission.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { createPersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { createPersistentSourcePropositionStore } from '../src/electron/rag/referenceSourcePropositionStore.ts';
import { createArgumentContextPointer } from '../src/services/argumentContext/reader.ts';
import { readTaskScopedArgumentContextPack } from '../src/services/argumentContext/taskScopedReader.ts';
import { prepareSourcePropositionContext, sourcePropositionRequiredNodeIds, prepareSourcePropositionReviewInput,
  finalizeSourcePropositions, validateSourcePropositions, type SourcePropositionReview } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { prepareSourcePropositionParentSelection, readSourcePropositionParentSelection } from '../src/services/reviewComparison/sourcePropositionSelection.ts';
import { buildSourcePropositions, createSourcePropositionBuildModel, TASK_SOURCE_PROPOSITION_REVIEW_PROMPT } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { createCurrentSourcePropositionReader, createReferenceSourcePropositionProvider } from '../src/electron/rag/referenceSourcePropositionProvider.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';

// Fixed synthetic votes exercise engineering contracts, not model semantic accuracy.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Task admission checks forbid network');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-task-admission-'));
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const copy = <T>(value: T): T => structuredClone(value);
const paragraphs = ['本实验把蓝印就绪定义为系统能够接收任务的状态。',
  '该状态只有系统已联网时才成立。', '例如，合成系统甲已联网，可以接收任务。',
  '蓝印规则只适用于已联网且自动模式的系统。', '人工模式是上述规则的例外。'];
const note: NoteItem = { id: 'synthetic-task-admission-note', title: '合成任务范围测试',
  content: paragraphs.join('\n\n'), noteType: 'knowledge', createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
const scope: ArgumentContextScope = { scopeId: 'synthetic-task-scope', rootScopeId: 'synthetic-task-root',
  corpus: 'reference', allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] };
const ref = { kind: 'knowledge-note' as const, entityId: note.id };
async function inputFor(): Promise<ArgumentProjectionBuildInput> {
  const base = await adaptSavedKnowledgeNote({ note, rootScopeId: scope.rootScopeId, scope });
  return prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    chunks: base.chunks, scope, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-task-policy', evidence: [base.quotes[0].evidence] } });
}
function q(input: ArgumentProjectionBuildInput, text: string) {
  const quote = input.quotes.find(row => row.evidence.quote === text); assert.ok(quote, text); return quote.quoteId;
}
function draftFor(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const [definition, condition, example, inline, exception] = paragraphs.map(text => q(input, text));
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'definition', quoteIds: [definition] }, { id: 'N2', role: 'condition', quoteIds: [condition] },
      { id: 'N3', role: 'example', quoteIds: [example] }, { id: 'N4', role: 'condition', quoteIds: [inline] },
      { id: 'N5', role: 'exception', quoteIds: [exception] }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [condition] },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N1', kind: 'illustrates', quoteIds: [example] },
      { id: 'E3', sourceNodeId: 'N5', targetNodeId: 'N4', kind: 'exception_of', quoteIds: [exception] }], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'], requiredGroupIds: [], quoteIds: [definition, condition] },
      { id: 'S2', seedNodeId: 'N3', task: 'example', requiredNodeIds: ['N1', 'N3'], requiredRelationIds: ['E2'], requiredGroupIds: [], quoteIds: [definition, example] },
      { id: 'S3', seedNodeId: 'N4', task: 'condition', requiredNodeIds: ['N4', 'N5'], requiredRelationIds: ['E3'], requiredGroupIds: [], quoteIds: [inline, exception] }] };
}
async function voteFor(input: ArgumentProjectionBuildInput, draft: ArgumentProjectionDraft): Promise<ArgumentProjectionTaskReview> {
  const reviewInput = await buildArgumentProjectionTaskReviewInput(input, draft);
  const legacy = fixedAcceptProjectionReview(reviewInput);
  const review: ArgumentProjectionTaskReview = { ...legacy, version: 3, protocol: ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL,
    nodes: legacy.nodes.map(row => ({ ...row, completeMeaning: true })), sourceCoverage: reviewInput.sourceCoverageTargets.map(row => ({
      ...row, decision: 'accept', reason: '合成固定审核，仅测试合同，不是模型准确率。', restrictions: [], inferences: [] })) };
  review.sourceCoverage[1].restrictions = [{ representation: 'edge', kind: 'requires_condition', sourceQuoteIds: [q(input, paragraphs[1])], targetQuoteIds: [q(input, paragraphs[0])] }];
  review.sourceCoverage[3].restrictions = [{ representation: 'embedded', kind: 'requires_condition', sourceQuoteIds: [q(input, paragraphs[3])], targetQuoteIds: [q(input, paragraphs[3])] }];
  review.sourceCoverage[4].restrictions = [{ representation: 'edge', kind: 'exception_of', sourceQuoteIds: [q(input, paragraphs[4])], targetQuoteIds: [q(input, paragraphs[3])] }];
  return review;
}
try {
  const input = await inputFor(), draft = draftFor(input), review = await voteFor(input, draft);
  const reviewInput = await buildArgumentProjectionTaskReviewInput(input, draft);
  const v2Input = await buildArgumentProjectionSourceReviewInput(input, draft);
  assert.notEqual(reviewInput.reviewId, v2Input.reviewId);
  assert.deepEqual(await readArgumentProjectionTaskReview(JSON.stringify(review), reviewInput), review);
  await assert.rejects(readArgumentProjectionSourceReview(JSON.stringify(review), v2Input));
  await assert.rejects(readArgumentProjectionSourceReview(JSON.stringify(review), reviewInput as any));
  const v2 = { ...review, version: 2, protocol: v2Input.protocol, reviewId: v2Input.reviewId,
    sourceCoverage: review.sourceCoverage.map(row => ({ ...row, restrictions: row.restrictions.map(({ representation: _representation, ...restriction }) => restriction) })) };
  await assert.rejects(readArgumentProjectionTaskReview(v2, reviewInput));
  assert.equal((await finalizeArgumentProjectionBuild(input, draft, v2)).status, 'reviewed_partial');
  pass('v3 is hash-bound and strictly separated; historical v2 embedded-looking obligations are not reinterpreted');
  const result = await finalizeArgumentProjectionBuild(input, draft, review);
  assert.equal(result.status, 'reviewed_scoped');
  assert.deepEqual(result.projection.relations, (await finalizeArgumentProjectionBuild(input, draft, review)).projection.relations);
  assert.ok(!result.projection.relations.some(edge => edge.sourceNodeId === edge.targetNodeId));
  assert.deepEqual(reviewedTaskScopeNodeIds(result.projection), ['N1', 'N2', 'N4', 'N5']);
  assert.equal(result.projection.build.scopes[0].status, 'reviewed_for_scope');
  assert.equal(result.projection.build.scopes[1].status, 'partial');
  assert.equal(result.projection.build.scopes[2].status, 'reviewed_for_scope');
  assert.equal(result.projection.nodes.length, 5);
  await verifyArgumentProjectionBuildResult(result, { input, draft, review });
  pass('inline restriction needs no self-edge; full optional graph/gaps remain, only complete task closures are usable');
  for (const seed of ['N1', 'N4']) {
    const task = seed === 'N1' ? 'definition' : 'condition';
    const pointer = await createArgumentContextPointer(result.projection, result.authority, scope, [seed]);
    const pack = await readTaskScopedArgumentContextPack(result.projection, result.authority, { pointer, scope, task });
    assert.equal(pack.completeness.status, 'complete_for_scope');
  }
  const optionalPointer = await createArgumentContextPointer(result.projection, result.authority, scope, ['N3']);
  assert.notEqual((await readTaskScopedArgumentContextPack(result.projection, result.authority, { pointer: optionalPointer, scope, task: 'example' })).completeness.status, 'complete_for_scope');
  pass('definition and condition read complete; defective optional example remains held without promoting its vote');
  const falseInline = copy(review);
  falseInline.sourceCoverage[1].restrictions[0].representation = 'embedded';
  assert.equal((await finalizeArgumentProjectionBuild(input, draft, falseInline)).projection.build.scopes[0].status, 'partial');
  const orphan = copy(draft); orphan.relations[0].targetNodeId = 'N3';
  orphan.scopes[0].requiredNodeIds.push('N3');
  const orphanVote = await voteFor(input, orphan);
  assert.equal((await finalizeArgumentProjectionBuild(input, orphan, orphanVote)).projection.build.scopes[0].status, 'partial');
  pass('cross-sentence and wrong-target conditions remain held; embedded flag cannot hide missing actual dependency');
  const missingException = copy(draft); missingException.scopes[2].requiredNodeIds = ['N4']; missingException.scopes[2].requiredRelationIds = [];
  const omitted = await finalizeArgumentProjectionBuild(input, missingException, await voteFor(input, missingException));
  assert.equal(omitted.projection.build.scopes[2].status, 'partial');
  pass('required exception cannot be dropped from the target task even though unrelated scopes may remain available');
  const uncertainty = copy(review); uncertainty.sourceCoverage[4].decision = 'unknown';
  assert.equal((await finalizeArgumentProjectionBuild(input, draft, uncertainty)).status, 'reviewed_partial');
  const absent = copy(review); absent.sourceCoverage.pop();
  assert.equal((await finalizeArgumentProjectionBuild(input, draft, absent)).status, 'reviewed_partial');
  pass('unknown or absent original coverage stays source-wide held, never guessed to be optional');
  const badExample = copy(review); Object.assign(badExample.nodes[2], { decision: 'unknown', completeMeaning: false });
  const isolated = await finalizeArgumentProjectionBuild(input, draft, badExample);
  assert.equal(isolated.status, 'reviewed_scoped');
  assert.equal(isolated.projection.nodes[2].admission, 'audit_only');
  assert.deepEqual(reviewedTaskScopeNodeIds(isolated.projection), ['N1', 'N2', 'N4', 'N5']);
  pass('unreviewed optional node retained as audit_only, not erased or promoted, does not poison disjoint complete task');
  const critical = copy(review); Object.assign(critical.nodes[1], { decision: 'reject', completeMeaning: false });
  const criticalResult = await finalizeArgumentProjectionBuild(input, draft, critical);
  assert.ok(!reviewedTaskScopeNodeIds(criticalResult.projection).includes('N1'));
  pass('a required node rejection still blocks its complete task; no automatic accept or reference-derived user penalty');
  const malformed = copy(review) as any; delete malformed.sourceCoverage[3].restrictions[0].representation;
  await assert.rejects(readArgumentProjectionTaskReview(malformed, reviewInput));
  const hidden = copy(review); Object.defineProperty(hidden, 'length', { value: 1 });
  await assert.rejects(readArgumentProjectionTaskReview(hidden, reviewInput));
  await assert.rejects(readArgumentProjectionTaskReview(JSON.stringify(review).replace('"version":3', '"version":3,"version":3'), reviewInput));
  pass('new restriction representation is required, closed and rejects hidden/duplicate raw fields');
  let current: ArgumentProjectionBuildInput | null = copy(input);
  const host = { rootScopeId: scope.rootScopeId, withSource: async <T>(_ref: typeof ref, action: (input: ArgumentProjectionBuildInput | null) => Promise<T>) => action(copy(current)) };
  const projections = createPersistentArgumentProjectionStore(path.join(temporary, 'projections'), host);
  const receipt = await projections.publish({ publicationId: 'synthetic-scoped-publication', result: isolated,
    proof: { input, draft, review: badExample }, expectedActiveHash: null });
  assert.equal(receipt.status, 'published'); assert.equal(receipt.candidateStatus, 'reviewed_scoped');
  const restarted = createPersistentArgumentProjectionStore(path.join(temporary, 'projections'), host);
  assert.deepEqual(await restarted.read(ref), isolated);
  pass('real persistent store/reconstructed reader replays full scoped graph and retained original proof');
  const context = await prepareSourcePropositionContext(input, isolated);
  assert.equal(context.protocol, 'review-task-source-proposition-context-v2');
  assert.equal(context.projection.nodes.length, 5);
  assert.deepEqual(sourcePropositionRequiredNodeIds(context), ['N1', 'N2', 'N4', 'N5']);
  const menu = await prepareSourcePropositionParentSelection(context);
  assert.ok(!menu.parentChoices.some(parent => parent.nodeId === 'N3'));
  const selection = { version: 3, protocol: 'review-source-proposition-parent-selection-v3', contextHash: menu.contextHash,
    anchors: menu.parentChoices.map(parent => ({ parentChoiceId: parent.parentChoiceId })) };
  const propositionDraft = await readSourcePropositionParentSelection(selection, context);
  const pInput = await prepareSourcePropositionReviewInput(context, propositionDraft);
  const pReview: SourcePropositionReview = { version: 2, protocol: 'review-task-source-proposition-review-v2', reviewId: pInput.reviewId,
    contextHash: pInput.contextHash, draftHash: pInput.draftHash, anchors: propositionDraft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '合成固定票，仅验工程合同。' })) };
  const pResult = await finalizeSourcePropositions(context, propositionDraft, pReview); assert.ok(pResult.status === 'ready');
  const proof = { input, result: isolated, draft: propositionDraft, review: pReview, bundle: pResult.bundle };
  assert.equal((await validateSourcePropositions(input, isolated, pResult.bundle, { draft: propositionDraft, review: pReview })).status, 'ready');
  pass('whole-parent selection/review covers all and only usable closure nodes while full original graph remains in proof');
  const incompleteP = copy(pReview);
  const refusedId = propositionDraft.anchors.find(anchor => anchor.nodeId === 'N5')!.id;
  Object.assign(incompleteP.anchors.find(row => row.id === refusedId)!, { decision: 'unknown', completeMeaning: false });
  const partialP = await finalizeSourcePropositions(context, propositionDraft, incompleteP);
  assert.ok(partialP.status === 'ready');
  assert.equal(partialP.bundle.version, 2);
  assert.deepEqual(partialP.bundle.anchors.map(anchor => anchor.nodeId).sort(), ['N1', 'N2']);
  assert.equal((await validateSourcePropositions(input, isolated, partialP.bundle,
    { draft: propositionDraft, review: incompleteP })).status, 'ready');
  const forged = copy(partialP.bundle); forged.anchors.push(copy(pResult.bundle.anchors.find(anchor => anchor.nodeId === 'N5')!));
  assert.equal((await validateSourcePropositions(input, isolated, forged,
    { draft: propositionDraft, review: incompleteP })).status, 'held');
  const oldP = { ...pReview, version: 1 as const, protocol: 'review-source-proposition-review-v1' as const };
  assert.equal((await finalizeSourcePropositions(context, propositionDraft, oldP)).status, 'held');
  const noTaskP = copy(incompleteP);
  Object.assign(noTaskP.anchors.find(row => row.id === propositionDraft.anchors.find(anchor => anchor.nodeId === 'N2')!.id)!, { decision: 'reject', scopePreserved: false });
  assert.equal((await finalizeSourcePropositions(context, propositionDraft, noTaskP)).status, 'held');
  pass('partial P audit isolates a disjoint complete task, retains original unknown vote, forbids omitted required nodes and legacy relabeling');
  const partialBuild = await buildSourcePropositions(input, isolated, {
    draft: async () => copy(propositionDraft), review: async () => JSON.stringify(incompleteP),
  });
  assert.ok(partialBuild.status === 'ready');
  assert.deepEqual(partialBuild.proof.review, incompleteP); assert.equal(partialBuild.proof.draft.anchors.length, 4);
  assert.equal(partialBuild.modelRequests.total, 2);
  const duplicate = JSON.stringify(pReview).replace('"version":2', '"version":2,"version":2');
  const getterVote = copy(pReview); let getterCalls = 0;
  Object.defineProperty(getterVote, 'version', { enumerable: true, get: () => { getterCalls++; return 2; } });
  for (const raw of [duplicate, getterVote, JSON.stringify(oldP)]) {
    const held = await buildSourcePropositions(input, isolated, { draft: async () => copy(propositionDraft), review: async () => raw });
    assert.equal(held.status, 'held'); assert.equal(held.modelRequests.total, 2);
  }
  assert.equal(getterCalls, 0);
  let dispatchedPrompt = '';
  await createSourcePropositionBuildModel(async request => { dispatchedPrompt = request.systemPrompt; return JSON.stringify(pReview); }).review(pInput);
  assert.equal(dispatchedPrompt, TASK_SOURCE_PROPOSITION_REVIEW_PROMPT);
  pass('new P builder uses explicit scoped prompt, strict raw decoder, full retained proof and unchanged two-request budget');
  const pStores = createPersistentSourcePropositionStore(path.join(temporary, 'propositions'), restarted, scope.rootScopeId);
  const binding = await restarted.withActiveBinding!(ref, async (_result, _input, active) => active); assert.ok(binding);
  assert.equal((await pStores.publish(ref, binding, proof)).status, 'stored');
  assert.deepEqual(await createPersistentSourcePropositionStore(path.join(temporary, 'propositions'), restarted, scope.rootScopeId).read(ref), proof);
  pass('scoped source propositions persist and replay against real active projection binding, zero model reads');
  const assessment = freezeReviewAssessment('definition', [note.title]);
  const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
  const candidate = (text: string) => { const row = catalog.candidates.find(entry => entry.quote === text); assert.ok(row); return row.candidateId; };
  const rubric = freezeReviewReferenceRubric(`concept_meaning=${candidate(paragraphs[0])};concept_boundary=${candidate(paragraphs[1])}`, assessment, catalog);
  const frames = createArgumentQuestionFrameService({ runtime: { host, store: restarted }, readReferenceNotes: async () => [copy(note)] });
  const frozen = await frames.prepare({ questionMessageId: 'synthetic-scoped-question', knowledgeTargets: [note.title], assessment, referenceRubric: rubric });
  assert.equal(frozen.status, 'fixed'); assert.equal((await frames.verify(frozen)).status, 'current');
  pass('fixed original question standard reads complete stored definition despite unrelated rejected example, with no model or rubric rewriting');
  const disclosure = await buildArgumentReferenceDisclosure(frozen); assert.equal(disclosure.status, 'ready');
  const provider = createReferenceSourcePropositionProvider({ readCurrent: createCurrentSourcePropositionReader(restarted), storage: pStores });
  assert.equal((await provider.loadForQuestion(disclosure.context)).status, 'ready'); provider.revoke();
  pass('actual provider loads saved scoped propositions and projects the fixed question with no model adapter or new request');
  const partialStores = createPersistentSourcePropositionStore(path.join(temporary, 'partial-propositions'), restarted, scope.rootScopeId);
  assert.equal((await partialStores.publish(ref, binding, partialBuild.proof)).status, 'stored');
  const partialRestart = createPersistentSourcePropositionStore(path.join(temporary, 'partial-propositions'), restarted, scope.rootScopeId);
  assert.deepEqual(await partialRestart.read(ref), partialBuild.proof);
  const partialProvider = createReferenceSourcePropositionProvider({ readCurrent: createCurrentSourcePropositionReader(restarted), storage: partialRestart });
  assert.equal((await partialProvider.loadForQuestion(disclosure.context)).status, 'ready');
  const conditionAssessment = freezeReviewAssessment('condition', [note.title]);
  const conditionRubric = freezeReviewReferenceRubric(`condition_scope=${candidate(paragraphs[3])},${candidate(paragraphs[4])}`, conditionAssessment, catalog);
  const conditionFrozen = await frames.prepare({ questionMessageId: 'synthetic-held-condition-question', knowledgeTargets: [note.title], assessment: conditionAssessment, referenceRubric: conditionRubric });
  assert.equal(conditionFrozen.status, 'fixed', JSON.stringify(conditionFrozen));
  const conditionDisclosure = await buildArgumentReferenceDisclosure(conditionFrozen);
  assert.equal(conditionDisclosure.status, 'ready');
  assert.equal((await partialProvider.loadForQuestion(conditionDisclosure.context)).status, 'held'); partialProvider.revoke();
  pass('saved partial P proof reloads: complete definition usable, condition with unreviewed required exception held, zero model reads');
  current = null;
  assert.equal(await restarted.read(ref), null); assert.equal(await pStores.read(ref), null);
  pass('source deletion revokes graph and proposition authority; scoped publication does not weaken current-source checks');
  const request = await buildArgumentProjectionTaskReviewRequest(input, draft);
  assert.equal(request.systemPrompt, ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT);
  assert.equal(request.skipProfileInjection, true); assert.equal(request.skipMemoryInjection, true);
  assert.ok(request.systemPrompt.includes('support成员表示该联合推断中的贡献，不表示单独充分'));
  assert.ok(request.systemPrompt.includes('condition') && request.systemPrompt.includes('同一结论'));
  pass('model contract audits the whole joint inference and reconciles source inventory; not program-fabricated semantic votes');
  console.log(`Argument task admission: ${checks} offline groups passed (synthetic fixtures; 0 model/network/production writes).`);
} finally {
  globalThis.fetch = originalFetch;
  // Temporary synthetic directory only; not a workspace/vault root.
  await fs.rm(temporary, { recursive: true, force: true });
}
