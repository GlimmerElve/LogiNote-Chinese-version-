import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { createArgumentProjectionEnvironmentRegistry, type ArgumentProjectionRoots } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentProjectionSourceScope } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { createArgumentQuestionRuntime } from '../src/electron/rag/argumentQuestionRuntime.ts';
import { prepareStoredReferencePropositions } from '../src/electron/rag/referenceStoredPropositions.ts';
import { createPersistentSourcePropositionStore } from '../src/electron/rag/referenceSourcePropositionStore.ts';
import { createCurrentSourcePropositionReader, createReferenceSourcePropositionProvider } from '../src/electron/rag/referenceSourcePropositionProvider.ts';
import { createSourcePropositionBuildModel } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import { createFrozenPropositionReferenceModel, type FrozenPropositionReferenceInput } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import { evaluateFrozenPropositionReviewReferenceShadow } from '../src/services/reviewComparison/frozenPropositionShadow.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { NoteItem } from '../src/types.ts';

// Actual host/store/runtime/client/factories; synthetic files and fixed model
// responses only. This does not certify model accuracy or desktop UI rendering.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Persistent question checks forbid network');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-persistent-question-'));
const roots: ArgumentProjectionRoots = { dataRoot: temp, vaultRoot: path.join(temp, 'vault'), userStateDir: path.join(temp, 'user-state') };
const directory = path.join(temp, 'argument-propositions'), owner = 301;
const copy = <T>(value: T): T => structuredClone(value);
let checks = 0, sourceCalls = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const note = (id: string, title: string, content: string, noteType: 'project' | 'knowledge'): NoteItem => ({ id, title, content, noteType,
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] });
const project = note('persistent-project', '合成项目', '纯合成。', 'project');
const source = { ...note('persistent-source', '合成回环就绪', '回环就绪是设备可以开始训练的状态。\n\n只有本次设备已供电且自检通过时才适用。', 'knowledge'), parentId: project.id };
const ref = { kind: 'knowledge-note' as const, entityId: source.id };
try {
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, [project, source]);
  // Main uses a separate library build lease, not the review's project lease.
  // Per-source construction remains reusable only after the narrower reader
  // independently authorizes that source under its own current selection.
  const buildEnvironments = createArgumentProjectionEnvironmentRegistry(() => roots);
  const buildEnvironment = await buildEnvironments.getEnvironment(owner, { kind: 'library' }); assert.ok(buildEnvironment.status === 'available');
  const environments = createArgumentProjectionEnvironmentRegistry(() => roots);
  let environment = await environments.getEnvironment(owner, { kind: 'learning-note', noteId: project.id }); assert.ok(environment.status === 'available');
  const build = await buildEnvironments.withEnvironment(owner, buildEnvironment.environmentId, async (runtime, captured, scope) => {
    await withRagSourceTransaction(Object.values(captured), async () => {
      const base = await readSavedArgumentProjectionSource({ ...captured, scope: createArgumentProjectionSourceScope(scope, ref) }, ref); assert.ok(base);
      await runtime.admission.record(base, { reviewId: 'persistent-synthetic-admission', policyVersion: 'persistent-synthetic-policy', decision: 'eligible',
        evidence: [base.quotes[0].evidence], checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
        reason: 'Synthetic test admission.', reviewedAt: '2026-10-07T02:00:00.000Z' });
    });
    const input = await runtime.host.withSource(ref, async input => copy(input)); assert.ok(input);
    const q = ['回环就绪是', '已供电且自检通过'].map(text => input.quotes.find(item => item.evidence.quote.includes(text))!.quoteId);
    const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
      nodes: [{ id: 'N1', role: 'definition', quoteIds: [q[0]] }, { id: 'N2', role: 'condition', quoteIds: [q[1]] }], relations: [], groups: [],
      scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: q }] };
    const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)), result = await finalizeArgumentProjectionBuild(input, draft, review);
    assert.equal((await runtime.store.publish({ publicationId: 'persistent-synthetic-pub', result, proof: { input, draft, review }, expectedActiveHash: null })).status, 'published');
    return { input, draft, review, result, storage: createPersistentSourcePropositionStore(directory, runtime.store, scope.rootScopeId), readCurrent: createCurrentSourcePropositionReader(runtime.store) };
  });
  const assessment = freezeReviewAssessment('definition', [source.title]), catalog = await buildReviewReferenceCatalog([source], [source.title], [source.id]);
  const meaning = catalog.candidates.find(item => item.quote.includes('回环就绪是'))!, condition = catalog.candidates.find(item => item.quote.includes('已供电且自检通过'))!;
  const rubric = freezeReviewReferenceRubric(`concept_meaning=${meaning.candidateId};concept_boundary=${condition.candidateId}`, assessment, catalog);
  const selectors = (id: string) => ({ questionMessageId: id, knowledgeTargets: [source.title], assessment, referenceRubric: rubric });
  const questions = createArgumentQuestionRuntime(environments, { preparePropositions: prepareStoredReferencePropositions });
  const missing = await questions.prepare(owner, environment.environmentId, selectors('persistent-missing-question'));
  assert.equal(missing.status, 'fixed'); assert.equal((await questions.readPropositions(owner, environment.environmentId, missing)).status, 'held');
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); assert.equal(sourceCalls, 0);
  pass('生产题前loader缺失资产held，不读配置/建目录/隐式模型；原fixed参考仍可用');

  const model = createSourcePropositionBuildModel(async request => {
    sourceCalls++; const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') return JSON.stringify({ version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: wire.contextHash,
      anchors: wire.reference.projection.nodes.map((node: any, index: number) => {
        const span = node.evidence[0], quote = wire.reference.quotes.find((q: any) => q.evidence.start === span.start && q.evidence.end === span.end)!;
        return { id: `P${index + 1}`, nodeId: node.id, quoteId: quote.quoteId, start: span.start, end: span.end, text: span.quote };
      }) });
    return JSON.stringify({ version: 1, protocol: 'review-source-proposition-review-v1', reviewId: wire.reviewId, contextHash: wire.contextHash, draftHash: wire.draftHash,
      anchors: wire.draft.anchors.map((anchor: any) => ({ id: anchor.id, decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true, reason: 'Synthetic test review.' })) });
  });
  const provider = createReferenceSourcePropositionProvider({ readCurrent: build.readCurrent, storage: build.storage, model });
  const stored = await provider.build(ref, { consent: 'process-reference-propositions' });
  assert.ok(stored.status === 'ready', JSON.stringify(stored)); assert.equal(stored.retention, 'persistent'); assert.equal(sourceCalls, 2);
  const savedReview = copy(stored.proof.review), savedBundleHash = stored.bundle.bundleHash;
  provider.revoke();
  const renewed = await environments.getEnvironment(owner, { kind: 'learning-note', noteId: project.id }); assert.ok(renewed.status === 'available'); environment = renewed;
  const restarted = createArgumentQuestionRuntime(environments, { preparePropositions: prepareStoredReferencePropositions });
  assert.equal((await restarted.readPropositions(owner, renewed.environmentId, missing)).status, 'held');
  const firstReceipt = await restarted.prepare(owner, renewed.environmentId, selectors('persistent-question-1'));
  const secondReceipt = await restarted.prepare(owner, renewed.environmentId, selectors('persistent-question-2'));
  const first = await restarted.readPropositions(owner, renewed.environmentId, firstReceipt), second = await restarted.readPropositions(owner, renewed.environmentId, secondReceipt);
  assert.ok(first.status === 'ready', JSON.stringify(first)); assert.ok(second.status === 'ready', JSON.stringify(second));
  assert.ok(first.bundle.version === 2 && second.bundle.version === 2);
  assert.deepEqual(first.bundle.reviewBasis.sourceBundleHashes, [savedBundleHash]);
  assert.deepEqual(first.bundle.reviewBasis, second.bundle.reviewBasis); assert.notEqual(first.bundle.contextHash, second.bundle.contextHash);
  assert.equal(sourceCalls, 2); assert.ok(!JSON.stringify(first).includes('canonicalText') && !JSON.stringify(first).includes(temp));
  const disk = await environments.withEnvironment(owner, renewed.environmentId, async (runtime, _roots, scope) =>
    createPersistentSourcePropositionStore(directory, runtime.store, scope.rootScopeId).read(ref));
  assert.ok(disk); assert.deepEqual(disk.review, savedReview);
  pass('独立library构建lease→项目复习scope授权读取：清cache/续租/新runtime两新题复用原审票，0新增模型、旧receipt不重建');

  const api: ReviewArgumentQuestionApi = { getEnvironment: selection => environments.getEnvironment(owner, selection),
    freezeQuestion: (id, value) => restarted.prepare(owner, id, value), verifyQuestion: (id, receipt) => restarted.verify(owner, id, receipt),
    readQuestion: (id, receipt) => restarted.read(owner, id, receipt), readQuestionPropositions: (id, receipt) => restarted.readPropositions(owner, id, receipt) };
  const client = createReviewArgumentQuestionClient(project.id, 'persistent-session', () => api);
  let answerCalls = 0;
  const answerModel = createFrozenPropositionReferenceModel(async request => {
    answerCalls++; const input = JSON.parse(request.userInput);
    if (answerCalls === 1) return { content: JSON.stringify({ version: 1, packetId: input.packetId, requirements: [], edges: [], claims: [
      { id: 'A1', role: 'definition', quote: '回环就绪是设备可以开始训练的状态' }, { id: 'A2', role: 'condition', quote: '只有本次设备已供电且自检通过时才适用' }] }) };
    const wire = input as FrozenPropositionReferenceInput;
    return { content: JSON.stringify({ version: 5, evaluationId: wire.evaluationId, contractHash: wire.contractHash, bundleHash: wire.bundleHash,
      items: wire.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported', scope: 'same',
        matches: item.requiredNodeIds.map(id => { const node = frame.nodes.find(n => n.id === id)!;
          return { claimId: node.role === 'definition' ? 'user/A1' : 'user/A2', propositionId: node.propositions[0].id }; }) }))) }) };
  });
  const answer: ReviewComparisonAnswer = { activityId: 'persistent-review', questionText: '说明回环就绪。', evidence: { messageId: 'persistent-answer',
    answer: source.content, hintLevel: 0, targetKnowledgeNames: [source.title], questionIntent: { version: 1, questionMessageId: 'persistent-question-1',
      knowledgeTargets: [source.title], assessment, referenceRubric: rubric, referenceStructure: firstReceipt } } };
  const out = await evaluateFrozenPropositionReviewReferenceShadow(answer, { readReferencePropositions: client.readReferencePropositions }, answerModel);
  assert.equal(out.result.status, 'reviewed', JSON.stringify(out.result)); assert.equal(out.result.frames[0].status, 'covered');
  assert.equal(answerCalls, 2); assert.equal(sourceCalls, 2); assert.equal(out.result.scoreWrite, 'disabled'); assert.equal(out.result.cognitionWrite, 'disabled');
  pass('实际persisted loader→host凭据→真实client→v5两次mock核对→原完整结构host gate联验，未写分/认知');

  const next = await environments.getEnvironment(owner, { kind: 'learning-note', noteId: project.id }); assert.ok(next.status === 'available');
  await environments.withEnvironment(owner, next.environmentId, async runtime => {
    assert.equal((await runtime.store.publish({ publicationId: 'persistent-synthetic-repub', result: build.result,
      proof: { input: build.input, draft: build.draft, review: build.review }, expectedActiveHash: build.result.authority.structureHash })).status, 'published');
  });
  const republished = await restarted.prepare(owner, next.environmentId, selectors('persistent-after-repub'));
  assert.equal((await restarted.readPropositions(owner, next.environmentId, republished)).status, 'held');
  const freshRuntime = createArgumentQuestionRuntime(environments, { preparePropositions: prepareStoredReferencePropositions });
  const nextReceipt = await freshRuntime.prepare(owner, next.environmentId, selectors('persistent-after-repub-restart'));
  assert.equal((await freshRuntime.readPropositions(owner, next.environmentId, nextReceipt)).status, 'held');
  assert.equal(sourceCalls, 2); assert.equal(answerCalls, 2);
  pass('真实同hash重发布持续使新题资产失效，重启后不复活或自动补建');

  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, [project, { ...source, content: source.content.replace('开始训练', '开始合成训练') }]);
  assert.equal((await restarted.readPropositions(owner, next.environmentId, firstReceipt)).status, 'held');
  assert.equal(sourceCalls, 2); assert.equal(answerCalls, 2);
  pass('真实保存正文变化令旧题读取held，资料处理与答案核对预算仍分离');

  const main = await fs.readFile('src/electron/main.ts', 'utf8'), preload = await fs.readFile('src/electron/preload.ts', 'utf8');
  assert.ok(main.includes('preparePropositions: prepareStoredReferencePropositions'));
  for (const op of ['get-environment', 'prepare', 'status', 'run', 'cancel']) {
    const begin = main.indexOf(`ipcMain.handle('argument-reference-rag:${op}'`); assert.ok(begin >= 0);
    const handler = main.slice(begin, main.indexOf('\n  });', begin));
    assert.ok(handler.includes('referenceCallerAllowed(event)') && handler.includes('args.length'));
    assert.ok(preload.includes(`argument-reference-rag:${op}`));
  }
  assert.ok(!preload.includes('source-propositions:publish') && !preload.includes('source-propositions:write'));
  pass('main默认只读持久loader；新显式处理IPC同mainFrame guard，未暴露proof/发布或模型参数通道（静态核对）');
  console.log(`Persistent reference question: ${checks} synthetic offline groups passed; no real models or production writes.`);
} finally { globalThis.fetch = fetchBefore; await fs.rm(temp, { recursive: true, force: true }); }
