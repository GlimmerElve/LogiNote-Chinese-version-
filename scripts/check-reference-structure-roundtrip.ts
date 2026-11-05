import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NoteItem } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionReview,
  ArgumentProjectionBuildResult, ArgumentProjectionSourceReview } from '../src/services/argumentContext/buildTypes.ts';
import { ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionAuthorityHost } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, buildArgumentProjectionSourceReviewInput, finalizeArgumentProjectionBuild }
  from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { createPersistentArgumentProjectionStore, argumentProjectionLedgerFileName }
  from '../src/electron/rag/argumentProjectionStore.ts';
import { createPersistentSourcePropositionStore, sourcePropositionLedgerFileName }
  from '../src/electron/rag/referenceSourcePropositionStore.ts';
import { createStoredArgumentContextPointer, readStoredArgumentContextPack }
  from '../src/electron/rag/argumentProjectionReader.ts';
import { readTaskScopedArgumentContextPack } from '../src/services/argumentContext/taskScopedReader.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { createCurrentSourcePropositionReader, createReferenceSourcePropositionProvider }
  from '../src/electron/rag/referenceSourcePropositionProvider.ts';
import { prepareSourcePropositionContext, prepareSourcePropositionReviewInput, finalizeSourcePropositions,
  type SourcePropositionDraft, type SourcePropositionProof, type SourcePropositionReview }
  from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { buildSourcePropositionSelectionParentChoices } from '../src/services/reviewComparison/sourcePropositionSelection.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';

// Fabricated explicit votes are fixtures for proof replay, NOT semantic gold.
// The test proves mechanical preservation, freshness and fail-closed reads only.
const previousFetch = globalThis.fetch;
let networkRequests = 0, modelRequests = 0, checks = 0, fixtureNumber = 0;
globalThis.fetch = async () => { networkRequests++; return assert.fail('Roundtrip checks forbid network'); };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-reference-roundtrip-'));
const clone = <T>(value: T): T => structuredClone(value);
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const rootScopeId = 'synthetic-reference-roundtrip-root';
const paragraphs = [
  '本次合成包裹📦带有蓝印。',
  '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。',
  '上述分拣推断只有在系统已联网且处于自动模式时成立。',
  '本实验中的“蓝印”是自动分拣标记。',
  '该定义只在合成实验环境内使用。',
  '实际物流中的蓝色印章不属于这个定义。',
];
const saved: NoteItem = { id: 'synthetic-reference-roundtrip-note', title: '合成蓝印分拣与定义',
  content: paragraphs.join('\r\n\r\n'), noteType: 'knowledge', createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
const scope: ArgumentContextScope = { scopeId: 'synthetic-reference-roundtrip-scope', rootScopeId, corpus: 'reference',
  allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [saved.id], allowedDocIds: [], allowedRecordIds: [] };
const ref = { kind: 'knowledge-note' as const, entityId: saved.id };

async function sourceInput(note: NoteItem = saved) {
  const base = await adaptSavedKnowledgeNote({ note, rootScopeId, scope });
  return prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    scope, chunks: base.chunks, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-roundtrip-policy',
      evidence: [base.quotes[0].evidence] } });
}
function quote(input: ArgumentProjectionBuildInput, text: string) {
  const found = input.quotes.find(row => row.evidence.quote === text); assert.ok(found, `Missing synthetic Q: ${text}`);
  return found.quoteId;
}
function correctDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const [fact, link, condition, definition, boundary, exception] = paragraphs.map(text => quote(input, text));
  const rule = quote(input, '本实验约定带有蓝印的包裹会进入二号通道，');
  const conclusion = quote(input, '所以本次合成包裹会进入二号通道。');
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [fact] }, { id: 'N2', role: 'premise', quoteIds: [rule] },
      { id: 'N3', role: 'conclusion', quoteIds: [conclusion] }, { id: 'N4', role: 'condition', quoteIds: [condition] },
      { id: 'N5', role: 'definition', quoteIds: [definition] }, { id: 'N6', role: 'condition', quoteIds: [boundary] },
      { id: 'N7', role: 'exception', quoteIds: [exception] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E2', sourceNodeId: 'N2', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N3', kind: 'requires_condition', quoteIds: [condition] },
      { id: 'E4', sourceNodeId: 'N6', targetNodeId: 'N5', kind: 'requires_condition', quoteIds: [boundary] },
      { id: 'E5', sourceNodeId: 'N7', targetNodeId: 'N5', kind: 'exception_of', quoteIds: [exception] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N3', premiseNodeIds: ['N1', 'N2'], conditionNodeIds: ['N4'],
      relationIds: ['E1', 'E2', 'E3'], operator: 'all', quoteIds: [fact, link, condition] }],
    scopes: [{ id: 'S1', seedNodeId: 'N3', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3', 'N4'],
      requiredRelationIds: ['E1', 'E2', 'E3'], requiredGroupIds: ['G1'], quoteIds: [fact, link, condition] },
    { id: 'S2', seedNodeId: 'N5', task: 'definition', requiredNodeIds: ['N5', 'N6', 'N7'],
      requiredRelationIds: ['E4', 'E5'], requiredGroupIds: [], quoteIds: [definition, boundary, exception] }] };
}
function hostState(input: ArgumentProjectionBuildInput) {
  let current: ArgumentProjectionBuildInput | null = clone(input), currentNote = clone(saved), tail = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => { const job = tail.then(action); tail = job.then(() => undefined, () => undefined); return job; };
  const host: ArgumentProjectionAuthorityHost = { rootScopeId, withSource: (requested, action) => serial(async () => {
    assert.deepEqual(requested, ref); return action(clone(current));
  }) };
  return { host, set: (next: ArgumentProjectionBuildInput | null, note: NoteItem = saved) => serial(async () => {
    current = clone(next); currentNote = clone(note);
  }), readNotes: async () => [clone(currentNote)] };
}
async function selectors(task: 'definition' | 'reasoning', note: NoteItem = saved) {
  const assessment = freezeReviewAssessment(task, [note.title]);
  const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
  const candidate = (text: string) => { const row = catalog.candidates.find(item => item.quote === text); assert.ok(row, text); return row.candidateId; };
  const marker = task === 'reasoning'
    ? `actual_premise=${candidate(paragraphs[0])},${candidate(paragraphs[2])};inference_link=${candidate(paragraphs[1])}`
    : `concept_meaning=${candidate(paragraphs[3])};concept_boundary=${candidate(paragraphs[4])},${candidate(paragraphs[5])}`;
  const referenceRubric = freezeReviewReferenceRubric(marker, assessment, catalog); assert.equal(referenceRubric.status, 'fixed');
  return { questionMessageId: `synthetic-roundtrip-${task}`, knowledgeTargets: [note.title], assessment, referenceRubric };
}
async function sourceProof(input: ArgumentProjectionBuildInput, result: ArgumentProjectionBuildResult): Promise<SourcePropositionProof> {
  const context = await prepareSourcePropositionContext(input, result);
  const draft: SourcePropositionDraft = { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
    anchors: context.projection.nodes.map(node => {
      const span = node.evidence[0], parent = input.quotes.find(q => q.evidence.sentenceId === span.sentenceId
        && q.evidence.start === span.start && q.evidence.end === span.end); assert.ok(parent);
      return { id: `P-${node.id}`, nodeId: node.id, quoteId: parent.quoteId, start: span.start, end: span.end, text: span.quote };
    }) };
  const prepared = await prepareSourcePropositionReviewInput(context, draft);
  const review: SourcePropositionReview = { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: prepared.reviewId,
    contextHash: prepared.contextHash, draftHash: prepared.draftHash, anchors: draft.anchors.map(row => ({ id: row.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true,
      reason: '纯合成固定票，仅证明程序回放；不是模型语义准确率证据。' })) };
  const ready = await finalizeSourcePropositions(context, draft, review); assert.ok(ready.status === 'ready', JSON.stringify(ready));
  return { input: clone(input), result: clone(result), draft, review, bundle: ready.bundle };
}
async function fixture(edit?: (draft: ArgumentProjectionDraft, review: ArgumentProjectionReview) => void) {
  const input = await sourceInput(), draft = correctDraft(input), reviewInput = await buildArgumentProjectionReviewInput(input, draft);
  const review = fixedAcceptProjectionReview(reviewInput); edit?.(draft, review);
  // Changing a draft changes reviewId; reissue explicit fixture votes for that actual draft.
  const actualReview = await buildArgumentProjectionReviewInput(input, draft); review.reviewId = actualReview.reviewId;
  const result = await finalizeArgumentProjectionBuild(input, draft, review), state = hostState(input);
  const directory = path.join(temporary, `projection-${++fixtureNumber}`), publicationId = `synthetic-roundtrip-${fixtureNumber}`;
  const store = createPersistentArgumentProjectionStore(directory, state.host);
  const request = { publicationId, result, proof: { input, draft, review }, expectedActiveHash: null };
  const receipt = await store.publish(request);
  const service = createArgumentQuestionFrameService({ runtime: { host: state.host, store }, readReferenceNotes: state.readNotes });
  return { input, draft, review, result, state, directory, request, receipt, store, service };
}
async function sourceReviewedFixture(edit?: (review: ArgumentProjectionSourceReview) => void) {
  const input = await sourceInput(), draft = correctDraft(input);
  const reviewInput = await buildArgumentProjectionSourceReviewInput(input, draft);
  const common = fixedAcceptProjectionReview(reviewInput);
  const conclusion = draft.nodes.find(row => row.id === 'N3')!.quoteIds;
  const definition = draft.nodes.find(row => row.id === 'N5')!.quoteIds;
  const review: ArgumentProjectionSourceReview = { ...common, version: 2, protocol: ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL,
    nodes: common.nodes.map(row => ({ ...row, completeMeaning: true })),
    sourceCoverage: reviewInput.sourceCoverageTargets.map(target => {
      const restrictions: ArgumentProjectionSourceReview['sourceCoverage'][number]['restrictions'] = [];
      const inferences: ArgumentProjectionSourceReview['sourceCoverage'][number]['inferences'] = [];
      if (target.quoteId === quote(input, paragraphs[1])) inferences.push({ conclusionQuoteIds: [...conclusion],
        premiseQuoteIds: [...draft.nodes[0].quoteIds, ...draft.nodes[1].quoteIds], conditionQuoteIds: [...draft.nodes[3].quoteIds], operator: 'all' });
      if (target.quoteId === quote(input, paragraphs[2])) restrictions.push({ kind: 'requires_condition',
        sourceQuoteIds: [...draft.nodes[3].quoteIds], targetQuoteIds: [...conclusion] });
      if (target.quoteId === quote(input, paragraphs[4])) restrictions.push({ kind: 'requires_condition',
        sourceQuoteIds: [...draft.nodes[5].quoteIds], targetQuoteIds: [...definition] });
      if (target.quoteId === quote(input, paragraphs[5])) restrictions.push({ kind: 'exception_of',
        sourceQuoteIds: [...draft.nodes[6].quoteIds], targetQuoteIds: [...definition] });
      return { ...target, decision: 'accept', reason: '纯合成源级固定票，仅测试来源义务的机械回放，不认证语义。', restrictions, inferences };
    }) };
  edit?.(review);
  const result = await finalizeArgumentProjectionBuild(input, draft, review), state = hostState(input);
  const directory = path.join(temporary, `projection-${++fixtureNumber}`), publicationId = `synthetic-roundtrip-v2-${fixtureNumber}`;
  const store = createPersistentArgumentProjectionStore(directory, state.host);
  const request = { publicationId, result, proof: { input, draft, review }, expectedActiveHash: null };
  const receipt = await store.publish(request);
  const service = createArgumentQuestionFrameService({ runtime: { host: state.host, store }, readReferenceNotes: state.readNotes });
  return { input, draft, review, result, state, directory, request, receipt, store, service };
}
function neverModel() {
  return { draft: async () => { modelRequests++; return assert.fail('Read must not draft'); },
    review: async () => { modelRequests++; return assert.fail('Read must not review'); } };
}
async function taskPack(store: ReturnType<typeof createPersistentArgumentProjectionStore>, seed: string, task: 'definition' | 'reasoning') {
  const pointer = await createStoredArgumentContextPointer(store, ref, [seed]); assert.ok(pointer);
  return store.withActive(ref, async (result, input) => readTaskScopedArgumentContextPack(result.projection,
    result.authority, { pointer, scope: input.scope, task }));
}
async function copiedLedger(directory: string, mutate: (ledger: any) => void) {
  const copyDirectory = path.join(temporary, `corrupt-${++fixtureNumber}`); await fs.mkdir(copyDirectory);
  const target = path.join(copyDirectory, argumentProjectionLedgerFileName(rootScopeId));
  const ledger = JSON.parse(await fs.readFile(path.join(directory, argumentProjectionLedgerFileName(rootScopeId)), 'utf8'));
  mutate(ledger); const { ledgerHash: _old, ...body } = ledger; ledger.ledgerHash = await argumentContextHash(body);
  await fs.writeFile(target, JSON.stringify(ledger), { flag: 'wx' }); return copyDirectory;
}

try {
  if (process.argv[2] === '--child-read') {
    // A separate process has no retained store/provider objects or result cache.
    const originalTemporary = path.resolve(process.argv[3]);
    assert.equal(path.dirname(originalTemporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(originalTemporary).startsWith('loginote-reference-roundtrip-'));
    const snapshot = JSON.parse(await fs.readFile(path.join(originalTemporary, 'restart-snapshot.json'), 'utf8'));
    assert.deepEqual(Object.keys(snapshot).sort(), ['frames', 'input', 'propositionProof', 'result', 'sourceReviewed']);
    assert.equal(snapshot.input.source.entityId, saved.id); assert.equal(snapshot.input.source.rootScopeId, rootScopeId);
    const state = hostState(snapshot.input);
    const store = createPersistentArgumentProjectionStore(path.join(originalTemporary, 'projection-1'), state.host);
    assert.deepEqual(await store.read(ref), snapshot.result); assert.deepEqual(await store.readSource(ref), snapshot.input);
    const propositions = createPersistentSourcePropositionStore(path.join(originalTemporary, 'propositions'), store, rootScopeId);
    assert.deepEqual(await propositions.read(ref), snapshot.propositionProof);
    const service = createArgumentQuestionFrameService({ runtime: { host: state.host, store }, readReferenceNotes: state.readNotes });
    const provider = createReferenceSourcePropositionProvider({ readCurrent: createCurrentSourcePropositionReader(store),
      storage: propositions, model: neverModel() });
    for (const [index, task] of (['reasoning', 'definition'] as const).entries()) {
      const frame = await service.prepare(await selectors(task)); assert.equal(frame.status, 'fixed', JSON.stringify(frame.reasons));
      assert.deepEqual(frame, snapshot.frames[index]); assert.equal((await service.verify(frame)).status, 'current');
      const disclosure = await buildArgumentReferenceDisclosure(frame); assert.ok(disclosure.status === 'ready');
      assert.equal((await provider.loadForQuestion(disclosure.context)).status, 'ready');
    }
    assert.ok(/^projection-\d+$/u.test(snapshot.sourceReviewed.directoryName));
    const v2State = hostState(snapshot.sourceReviewed.input);
    const v2Store = createPersistentArgumentProjectionStore(path.join(originalTemporary, snapshot.sourceReviewed.directoryName), v2State.host);
    assert.deepEqual(await v2Store.read(ref), snapshot.sourceReviewed.result);
    const v2Ledger = JSON.parse(await fs.readFile(path.join(originalTemporary, snapshot.sourceReviewed.directoryName,
      argumentProjectionLedgerFileName(rootScopeId)), 'utf8'));
    assert.deepEqual(v2Ledger.sources[0].operations[0].request.proof.review, snapshot.sourceReviewed.review);
    const v2Propositions = createPersistentSourcePropositionStore(path.join(originalTemporary, 'propositions-v2'), v2Store, rootScopeId);
    assert.deepEqual(await v2Propositions.read(ref), snapshot.sourceReviewed.propositionProof);
    const v2Service = createArgumentQuestionFrameService({ runtime: { host: v2State.host, store: v2Store }, readReferenceNotes: v2State.readNotes });
    const v2Provider = createReferenceSourcePropositionProvider({ readCurrent: createCurrentSourcePropositionReader(v2Store),
      storage: v2Propositions, model: neverModel() });
    for (const task of ['reasoning', 'definition'] as const) {
      const frame = await v2Service.prepare(await selectors(task)); assert.equal(frame.status, 'fixed');
      assert.equal((await v2Service.verify(frame)).status, 'current');
      const disclosure = await buildArgumentReferenceDisclosure(frame); assert.ok(disclosure.status === 'ready');
      assert.equal((await v2Provider.loadForQuestion(disclosure.context)).status, 'ready');
    }
    assert.equal(networkRequests, 0); assert.equal(modelRequests, 0);
    console.log('CHILD PASS full proof/frames/propositions, 0 model/network requests');
  } else {
  const good = await fixture(); assert.equal(good.receipt.status, 'published');
  const ledgerPath = path.join(good.directory, argumentProjectionLedgerFileName(rootScopeId));
  const ledgerBytes = await fs.readFile(ledgerPath, 'utf8'), ledger = JSON.parse(ledgerBytes);
  assert.deepEqual(ledger.sources[0].operations[0].request, good.request);
  assert.equal(good.input.canonicalText, saved.content);
  for (const row of good.input.quotes) assert.equal(saved.content.slice(row.evidence.start, row.evidence.end), row.evidence.quote);
  const restarted = createPersistentArgumentProjectionStore(good.directory, good.state.host);
  assert.deepEqual(await restarted.read(ref), good.result); assert.deepEqual(await restarted.readSource(ref), good.input);
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBytes);
  const detached = await restarted.read(ref); detached!.projection.relations[0].targetNodeId = 'N1';
  assert.deepEqual(await restarted.read(ref), good.result);
  pass('完整proof保存→新实例重读无损：原文CRLF/emoji UTF-16坐标、版本、节点职责、方向/边、all组、条件/例外、两个scope及审票不变');

  const pointerBefore = await createStoredArgumentContextPointer(good.store, ref, ['N3']); assert.ok(pointerBefore);
  const pointerAfter = await createStoredArgumentContextPointer(restarted, ref, ['N3']); assert.deepEqual(pointerAfter, pointerBefore);
  const broadBefore = await readStoredArgumentContextPack(good.store, { pointer: pointerBefore, task: 'reasoning' });
  const broadAfter = await readStoredArgumentContextPack(restarted, { pointer: pointerAfter!, task: 'reasoning' });
  assert.deepEqual(broadAfter, broadBefore);
  for (const [seed, task] of [['N3', 'reasoning'], ['N5', 'definition']] as const) {
    const before = await taskPack(good.store, seed, task), after = await taskPack(restarted, seed, task);
    assert.deepEqual(after, before); assert.equal(after!.completeness.status, 'complete_for_scope');
    assert.equal(after!.limitations.semanticTruth, 'not_certified');
  }
  const definitionPack = await taskPack(restarted, 'N5', 'definition');
  assert.deepEqual(definitionPack!.relations.map(row => [row.id, row.sourceNodeId, row.targetNodeId, row.kind]),
    [['E4', 'N6', 'N5', 'requires_condition'], ['E5', 'N7', 'N5', 'exception_of']]);
  pass('宿主stored reader与任务闭包重启一致，定义例外/条件定向原样保留，未扩大scope或补造边');

  const restartedService = createArgumentQuestionFrameService({ runtime: { host: good.state.host, store: restarted }, readReferenceNotes: good.state.readNotes });
  const disclosures = [];
  for (const task of ['reasoning', 'definition'] as const) {
    const selected = await selectors(task), before = await good.service.prepare(selected), after = await restartedService.prepare(selected);
    assert.equal(after.status, 'fixed', JSON.stringify(after.reasons)); assert.deepEqual(after, before);
    assert.equal((await restartedService.verify(after)).status, 'current');
    const disclosure = await buildArgumentReferenceDisclosure(after); assert.ok(disclosure.status === 'ready'); disclosures.push(disclosure.context);
    assert.equal(disclosure.context.limitations.semanticTruth, 'not_certified'); assert.equal(disclosure.context.limitations.writes, 'disabled');
  }
  assert.deepEqual(disclosures[0].frames[0].groups[0], { id: 'G1', conclusionNodeId: 'N3', premiseNodeIds: ['N1', 'N2'],
    conditionNodeIds: ['N4'], relationIds: ['E1', 'E2', 'E3'], operator: 'all' });
  assert.deepEqual(disclosures[1].frames[0].relations.map(row => [row.id, row.sourceNodeId, row.targetNodeId, row.kind]),
    [['E4', 'N6', 'N5', 'requires_condition'], ['E5', 'N7', 'N5', 'exception_of']]);
  pass('题前冻结/独立verify/渐进披露重启同合同：联合推断、限制与例外方向保留，未评分或写认知');

  const propositionProof = await sourceProof(good.input, good.result), propositionDirectory = path.join(temporary, 'propositions');
  const propositions = createPersistentSourcePropositionStore(propositionDirectory, good.store, rootScopeId);
  const binding = await good.store.withActiveBinding!(ref, async (_result, _input, value) => value); assert.ok(binding);
  assert.equal((await propositions.publish(ref, binding, propositionProof)).status, 'stored');
  const propositionFile = path.join(propositionDirectory, sourcePropositionLedgerFileName(rootScopeId));
  const propositionBytes = await fs.readFile(propositionFile, 'utf8');
  assert.deepEqual(JSON.parse(propositionBytes).sources[0].active.proof, propositionProof);
  const restartedPropositions = createPersistentSourcePropositionStore(propositionDirectory, restarted, rootScopeId);
  assert.deepEqual(await restartedPropositions.read(ref), propositionProof);
  const provider = createReferenceSourcePropositionProvider({ readCurrent: createCurrentSourcePropositionReader(restarted),
    storage: restartedPropositions, model: neverModel() });
  for (const disclosure of disclosures) assert.equal((await provider.loadForQuestion(disclosure)).status, 'ready');
  assert.equal(await fs.readFile(propositionFile, 'utf8'), propositionBytes);
  assert.equal(modelRequests, 0); assert.equal(networkRequests, 0);
  pass('源命题full proof与actual publication/epoch持久绑定，新provider按题读取两套scope均0模型请求且账本不改');

  const sourceReviewed = await sourceReviewedFixture(); assert.equal(sourceReviewed.result.status, 'reviewed_complete');
  assert.equal(sourceReviewed.receipt.status, 'published'); assert.notEqual(sourceReviewed.result.reviewId, good.result.reviewId);
  const sourceReviewedFile = path.join(sourceReviewed.directory, argumentProjectionLedgerFileName(rootScopeId));
  const sourceReviewedLedger = JSON.parse(await fs.readFile(sourceReviewedFile, 'utf8'));
  assert.deepEqual(sourceReviewedLedger.sources[0].operations[0].request, sourceReviewed.request);
  assert.equal(sourceReviewedLedger.sources[0].operations[0].request.proof.review.version, 2);
  assert.deepEqual(sourceReviewedLedger.sources[0].operations[0].request.proof.review.sourceCoverage, sourceReviewed.review.sourceCoverage);
  const v2Proof = await sourceProof(sourceReviewed.input, sourceReviewed.result);
  const v2Binding = await sourceReviewed.store.withActiveBinding!(ref, async (_result, _input, value) => value); assert.ok(v2Binding);
  const v2Propositions = createPersistentSourcePropositionStore(path.join(temporary, 'propositions-v2'), sourceReviewed.store, rootScopeId);
  assert.equal((await v2Propositions.publish(ref, v2Binding, v2Proof)).status, 'stored');
  assert.deepEqual(await createPersistentArgumentProjectionStore(sourceReviewed.directory, sourceReviewed.state.host).read(ref), sourceReviewed.result);
  for (const task of ['reasoning', 'definition'] as const) assert.equal((await sourceReviewed.service.prepare(await selectors(task))).status, 'fixed');
  pass('新v2完整sourceCoverage、原文Q义务、completeMeaning独立票及旧v1完整proof分别保存/重放，不改历史v1审票');

  await fs.writeFile(path.join(temporary, 'restart-snapshot.json'), JSON.stringify({ input: good.input, result: good.result,
    propositionProof, frames: await Promise.all((['reasoning', 'definition'] as const).map(async task => restartedService.prepare(await selectors(task)))),
    sourceReviewed: { input: sourceReviewed.input, result: sourceReviewed.result, review: sourceReviewed.review,
      directoryName: path.basename(sourceReviewed.directory), propositionProof: v2Proof } }),
  { flag: 'wx' });
  const child = spawnSync(process.execPath, [path.resolve('scripts/run-tsx-safe.cjs'), fileURLToPath(import.meta.url), '--child-read', temporary],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.ok(child.stdout.includes('CHILD PASS full proof/frames/propositions, 0 model/network requests'));
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBytes); assert.equal(await fs.readFile(propositionFile, 'utf8'), propositionBytes);
  pass('独立Node进程模拟真正重启：完整图、原审proof、两题冻结合同与源命题零请求回读，不依赖同进程缓存');

  for (const [label, edit] of [
    ['缺全文Q覆盖', (review: ArgumentProjectionSourceReview) => { review.sourceCoverage.pop(); }],
    ['源覆盖unknown', (review: ArgumentProjectionSourceReview) => { review.sourceCoverage[0].decision = 'unknown'; }],
    ['源覆盖reject', (review: ArgumentProjectionSourceReview) => { review.sourceCoverage[0].decision = 'reject'; }],
  ] as const) {
    const badSourceReview = await sourceReviewedFixture(edit); assert.equal(badSourceReview.result.status, 'reviewed_partial');
    assert.equal(badSourceReview.receipt.status, 'held');
    const rebooted = createPersistentArgumentProjectionStore(badSourceReview.directory, badSourceReview.state.host);
    assert.equal(await rebooted.read(ref), null);
    const service = createArgumentQuestionFrameService({ runtime: { host: badSourceReview.state.host, store: rebooted }, readReferenceNotes: badSourceReview.state.readNotes });
    assert.equal((await service.prepare(await selectors('reasoning'))).status, 'held');
    pass(`新v2${label}：全部候选accept仍partial/发布held，重启题前held且0模型请求`);
  }
  const invalidV2 = clone(sourceReviewed.request) as typeof sourceReviewed.request & { proof: { review: Record<string, unknown> } };
  invalidV2.publicationId = 'synthetic-v2-extra-field'; invalidV2.proof.review.untrustedExtra = true;
  await assert.rejects(sourceReviewed.store.publish(invalidV2));
  assert.deepEqual(await sourceReviewed.store.read(ref), sourceReviewed.result);
  pass('新v2 proof仍closed：未允许字段不能进入存储，失败不替换当前完整source-reviewed图');

  const sourceContext = await prepareSourcePropositionContext(good.input, good.result);
  const parents = buildSourcePropositionSelectionParentChoices(sourceContext);
  const premiseParents = parents.filter(row => row.nodeId === 'N2');
  assert.equal(premiseParents.length, 1); assert.equal(premiseParents[0].text, '本实验约定带有蓝印的包裹会进入二号通道，');
  assert.notEqual(premiseParents[0].text, paragraphs[1]);
  assert.equal(propositionProof.bundle.anchors.find(row => row.nodeId === 'N2')!.text, premiseParents[0].text);
  const foreignDraft = clone(propositionProof.draft), fullQ = good.input.quotes.find(row => row.evidence.quote === paragraphs[1])!;
  Object.assign(foreignDraft.anchors.find(row => row.nodeId === 'N2')!, { quoteId: fullQ.quoteId,
    start: fullQ.evidence.start, end: fullQ.evidence.end, text: fullQ.evidence.quote });
  await assert.rejects(prepareSourcePropositionReviewInput(sourceContext, foreignDraft));
  pass('职责片段Q不会被持久层补成全文Q；父Q所有权禁止偷取未拥有全句，mock通过不认证“完整命题”语义');

  const tampered = clone(good.request); tampered.publicationId = 'synthetic-forged-edge';
  tampered.result.projection.relations[0].targetNodeId = 'N1';
  await assert.rejects(restarted.publish(tampered));
  assert.deepEqual(await restarted.read(ref), good.result); assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBytes);
  pass('只篡改结果中的边方向不能凭自带hash/proof入库，失败不改当前合法图');

  const rejected = await fixture((_draft, review) => { review.scopes[0].decision = 'unknown';
    review.scopes[0].requiredSetComplete = false; review.scopes[0].attributionSupported = false; });
  assert.equal(rejected.result.status, 'reviewed_partial'); assert.equal(rejected.receipt.status, 'held');
  assert.equal(await rejected.store.read(ref), null);
  assert.deepEqual(await rejected.store.readStaged(ref, rejected.request.publicationId), rejected.result);
  const rejectedRestart = createPersistentArgumentProjectionStore(rejected.directory, rejected.state.host);
  assert.equal(await rejectedRestart.read(ref), null);
  const rejectedService = createArgumentQuestionFrameService({ runtime: { host: rejected.state.host, store: rejectedRestart }, readReferenceNotes: rejected.state.readNotes });
  assert.equal((await rejectedService.prepare(await selectors('reasoning'))).status, 'held');
  pass('必要scope unknown/拒绝票只能保存为held staged，重启不升级active，题前held且0模型请求');

  const missingEdge = await fixture((draft, review) => {
    draft.relations = draft.relations.filter(row => row.id !== 'E3'); review.relations = review.relations.filter(row => row.id !== 'E3');
    draft.groups[0].relationIds = ['E1', 'E2']; draft.scopes[0].requiredRelationIds = ['E1', 'E2'];
  });
  assert.equal(missingEdge.result.status, 'reviewed_partial'); assert.equal(missingEdge.receipt.status, 'held');
  assert.equal((await missingEdge.service.prepare(await selectors('reasoning'))).status, 'held');
  assert.ok(!missingEdge.result.projection.relations.some(row => row.id === 'E3'));
  pass('已声明必要条件但缺对应边：固定全accept也不能补齐机械必要闭包，保存/重启题前held');

  const retainedFrame = await restartedService.prepare(await selectors('reasoning')); assert.equal(retainedFrame.status, 'fixed');
  const changedNote = { ...clone(saved), title: `${saved.title}（合成新版本）`, updatedAt: '2026-10-08T00:00:00.000Z' };
  const changedInput = await sourceInput(changedNote); assert.notEqual(changedInput.source.version, good.input.source.version);
  await good.state.set(changedInput, changedNote);
  assert.equal(await restarted.read(ref), null); assert.equal(await restartedPropositions.read(ref), null);
  assert.equal((await restartedService.prepare(await selectors('reasoning', changedNote))).status, 'held');
  assert.equal((await restartedService.verify(retainedFrame)).status, 'held');
  assert.equal((await provider.loadForQuestion(disclosures[0])).status, 'held');
  await assert.rejects(restarted.publish(good.request), /source_changed/);
  pass('真实适配器生成的新源版本使旧图/源命题/冻结问题全部失效，不改生产资料，不自动重建或重试');

  await good.state.set(good.input);
  const afterAba = createPersistentArgumentProjectionStore(good.directory, good.state.host);
  const afterAbaService = createArgumentQuestionFrameService({ runtime: { host: good.state.host, store: afterAba }, readReferenceNotes: good.state.readNotes });
  assert.equal(await afterAba.read(ref), null); assert.equal((await afterAbaService.prepare(await selectors('reasoning'))).status, 'held');
  assert.equal((await afterAbaService.verify(retainedFrame)).status, 'held');
  await assert.rejects(afterAba.publish(good.request), /source_changed/);
  assert.equal(await createPersistentSourcePropositionStore(propositionDirectory, afterAba, rootScopeId).read(ref), null);
  pass('已观察A→B→A源恢复并重启不能复活旧publication/epoch，必须显式新审构建，题前仍0请求');

  const pristine = await fixture();
  for (const [label, mutate] of [
    ['旧ledger版本', (value: any) => { value.version = 0; }],
    ['旧build contract', (value: any) => { value.sources[0].operations[0].request.proof.input.contractVersion = 'argument-projection-build-v0'; }],
    ['闭合字段损坏', (value: any) => { value.sources[0].operations[0].request.proof.review.scopes[0].untrustedExtra = true; }],
  ] as const) {
    const brokenDir = await copiedLedger(pristine.directory, mutate), brokenStore = createPersistentArgumentProjectionStore(brokenDir, pristine.state.host);
    await assert.rejects(brokenStore.read(ref));
    const brokenService = createArgumentQuestionFrameService({ runtime: { host: pristine.state.host, store: brokenStore }, readReferenceNotes: pristine.state.readNotes });
    assert.equal((await brokenService.prepare(await selectors('reasoning'))).status, 'held');
    assert.equal(modelRequests, 0); assert.equal(networkRequests, 0);
    pass(`${label}：即使重算外层ledger hash也不能跳过原proof重放，题前held，不迁移/放宽/请求模型`);
  }
  assert.equal(modelRequests, 0); assert.equal(networkRequests, 0);
  console.log(`Reference structure roundtrip: ${checks} synthetic offline groups passed; 0 model/network requests; `
    + 'mechanical preservation only, no semantic accuracy claim, no production index/cognition/score writes.');
  }
} finally {
  globalThis.fetch = previousFetch;
  const absolute = path.resolve(temporary);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('loginote-reference-roundtrip-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
