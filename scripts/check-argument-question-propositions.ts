import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { createArgumentProjectionEnvironmentRegistry, type ArgumentProjectionRoots } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentProjectionSourceScope } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { createArgumentQuestionRuntime, type ArgumentQuestionPropositionOptions } from '../src/electron/rag/argumentQuestionRuntime.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import type { ArgumentQuestionFrameSelectors } from '../src/services/argumentContext/questionBindingTypes.ts';
import type { ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import { prepareReferencePropositionReviewInput, finalizeReferencePropositions,
  type ReferencePropositionDraft } from '../src/services/reviewComparison/referencePropositionAnchors.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { evaluateFrozenPropositionReviewReferenceShadow } from '../src/services/reviewComparison/frozenPropositionShadow.ts';
import { createFrozenPropositionReferenceModel, type FrozenPropositionReferenceInput } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { ReviewQuestionIntent } from '../src/services/reviewIntent.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import type { NoteItem } from '../src/types.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';

// Real host source/admission/projection/owner/receipt plumbing; all material is
// newly-created synthetic temporary data and all semantic votes are test votes.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in proposition runtime checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-question-propositions-'));
const OWNER = 87;
let checks = 0, fixtures = 0, votes = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const note = (id: string, title: string, content: string, noteType: 'knowledge' | 'project'): NoteItem => ({
  id, title, content, noteType, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
  tags: [], links: [], backlinks: [], dueDates: [],
});
const project = note('synthetic-project', '纯合成项目', '不是用户项目。', 'project');
const source = { ...note('synthetic-knowledge', '合成回环设备', '# 含义\n\n回环就绪是设备可以开始训练的状态。\n\n## 边界\n\n只有本次设备已供电且自检通过时才适用。', 'knowledge'), parentId: project.id };
const otherProject = note('synthetic-other-project', '另一纯合成项目', '隔离。', 'project');
// This fixture deliberately exercises the legacy question-level protocol; the
// production provider also accepts a separate source-reviewed v2 proof.
type Prepared = { bundle: import('../src/services/reviewComparison/referencePropositionAnchors.ts').ReferencePropositionBundle;
  proof: { draft: ReferencePropositionDraft; review: import('../src/services/reviewComparison/referencePropositionAnchors.ts').ReferencePropositionReview } };

async function syntheticPreparation(context: ArgumentReferenceDisclosureContext): Promise<Prepared> {
  const draft: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1',
    contractHash: context.contractHash, contextHash: await argumentContextHash(context),
    anchors: context.frames.flatMap(frame => frame.nodes.map((node, index) => {
      const quote = context.quotes.find(quote => quote.quoteId === node.quoteIds[0])!;
      return { id: `${frame.frameId}-P${index + 1}`, frameId: frame.frameId, nodeId: node.id,
        quoteId: quote.quoteId, start: quote.start, end: quote.end, text: quote.text };
    })) };
  const input = await prepareReferencePropositionReviewInput(context, draft);
  const review = { version: 1 as const, protocol: 'review-reference-proposition-review-v1' as const,
    reviewId: input.reviewId, contextHash: input.contextHash, draftHash: input.draftHash,
    anchors: draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept' as const,
      roleSupported: true, completeMeaning: true, scopePreserved: true, reason: 'Synthetic fixed test vote; not semantic accuracy.' })) };
  const result = await finalizeReferencePropositions(context, draft, review);
  assert.equal(result.status, 'ready'); assert.ok(result.status === 'ready');
  return { bundle: result.bundle, proof: { draft, review } };
}

async function rig(options: ArgumentQuestionPropositionOptions = {}, publish = true) {
  const dataRoot = path.join(temporary, String(++fixtures)); await fs.mkdir(dataRoot);
  const roots: ArgumentProjectionRoots = { dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') };
  let notes: NoteItem[] = [project, source, otherProject];
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  const environments = createArgumentProjectionEnvironmentRegistry(() => roots);
  const questions = createArgumentQuestionRuntime(environments, options);
  async function environment(owner = OWNER, noteId = project.id) {
    const reply = await environments.getEnvironment(owner, { kind: 'learning-note', noteId });
    assert.equal(reply.status, 'available'); return reply.status === 'available' ? reply.environmentId : assert.fail();
  }
  const environmentId = await environment();
  if (publish) await environments.withEnvironment(OWNER, environmentId, async (runtime, capturedRoots, scope) => {
    const sourceScope = createArgumentProjectionSourceScope(scope, { kind: 'knowledge-note', entityId: source.id });
    await withRagSourceTransaction(Object.values(capturedRoots), async () => {
      const base = await readSavedArgumentProjectionSource({ ...capturedRoots, scope: sourceScope }, { kind: 'knowledge-note', entityId: source.id });
      assert.ok(base);
      await runtime.admission.record(base, { reviewId: `synthetic-admission-${++votes}`, policyVersion: 'synthetic-policy-v1', decision: 'eligible',
        evidence: [base.quotes.at(-1)!.evidence], checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
        reason: 'Synthetic host source vote.', reviewedAt: '2026-10-07T02:00:00.000Z' });
    });
    const input = await runtime.host.withSource({ kind: 'knowledge-note', entityId: source.id }, async input => structuredClone(input));
    assert.ok(input);
    const quote = (fragment: string) => { const q = input.quotes.find(quote => quote.evidence.quote.includes(fragment)); assert.ok(q); return q.quoteId; };
    const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
      nodes: [{ id: 'N1', role: 'definition', quoteIds: [quote('回环就绪是')] }, { id: 'N2', role: 'condition', quoteIds: [quote('已供电且自检通过')] }],
      relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'],
        requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quote('回环就绪是'), quote('已供电且自检通过')] }] };
    const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
    const result = await finalizeArgumentProjectionBuild(input, draft, review);
    assert.equal((await runtime.store.publish({ publicationId: `synthetic-publication-${++votes}`, result,
      proof: { input, draft, review }, expectedActiveHash: null })).status, 'published');
  });
  async function selectors(questionMessageId = 'synthetic-proposition-question'): Promise<ArgumentQuestionFrameSelectors> {
    const actual = notes.find(note => note.id === source.id)!;
    const assessment = freezeReviewAssessment('definition', [actual.title]);
    const catalog = await buildReviewReferenceCatalog([actual], [actual.title], [actual.id]);
    const meaning = catalog.candidates.find(item => item.quote.includes('回环就绪是'))!, boundary = catalog.candidates.find(item => item.quote.includes('已供电且自检通过'))!;
    assert.ok(meaning && boundary);
    return { questionMessageId, knowledgeTargets: [actual.title], assessment,
      referenceRubric: freezeReviewReferenceRubric(`concept_meaning=${meaning.candidateId};concept_boundary=${boundary.candidateId}`, assessment, catalog) };
  }
  async function changeSource() {
    notes = notes.map(note => note.id === source.id ? { ...note, content: note.content.replace('开始训练', '开始合成训练'), updatedAt: '2026-10-07T03:00:00.000Z' } : note);
    await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  }
  return { roots, environments, questions, environmentId, environment, selectors, changeSource };
}

try {
  const legacy = await rig(), legacySelectors = await legacy.selectors(), legacyReceipt = await legacy.questions.prepare(OWNER, legacy.environmentId, legacySelectors);
  assert.equal(legacyReceipt.status, 'fixed');
  assert.deepEqual(Object.keys(legacyReceipt).sort(), ['contractHash', 'freezeId', 'originQuestionMessageId', 'reasons', 'selectorsHash', 'status', 'version']);
  assert.equal((await legacy.questions.read(OWNER, legacy.environmentId, legacyReceipt)).status, 'ready');
  assert.deepEqual(await legacy.questions.readPropositions(OWNER, legacy.environmentId, legacyReceipt), { status: 'held', reasons: ['propositions_not_prepared'] });
  pass('未配置provider保持旧fixed receipt形状及read流程，不自动补命题');

  let calls = 0, capturedContext: ArgumentReferenceDisclosureContext | undefined, returned: Prepared | undefined;
  const options: ArgumentQuestionPropositionOptions = { preparePropositions: async context => {
    calls++; capturedContext = structuredClone(context); returned = await syntheticPreparation(context); return returned;
  } };
  const r = await rig(options);
  options.preparePropositions = async () => { assert.fail('Late callback replacement must not execute'); };
  options.timeoutMs = 1;
  const original = await r.selectors(), receipt = await r.questions.prepare(OWNER, r.environmentId, original);
  assert.equal(receipt.status, 'fixed'); assert.equal(calls, 1); assert.ok(capturedContext && returned);
  const disclosure = await r.questions.readPropositions(OWNER, r.environmentId, receipt);
  assert.equal(disclosure.status, 'ready'); assert.ok(disclosure.status === 'ready');
  assert.deepEqual(disclosure.context, capturedContext);
  assert.deepEqual(disclosure.binding, { freezeId: receipt.freezeId!, contractHash: receipt.contractHash!,
    contextHash: await argumentContextHash(disclosure.context), bundleHash: disclosure.bundle.bundleHash });
  assert.equal(disclosure.bundle.semanticTruth, 'not_certified'); assert.equal(disclosure.bundle.writes, 'disabled');
  assert.ok(!JSON.stringify(disclosure).includes(r.roots.vaultRoot) && !JSON.stringify(disclosure).includes('canonicalText'));
  assert.deepEqual(Object.keys(receipt).sort(), Object.keys(legacyReceipt).sort());
  pass('host真实已审源只在首次题前提供context，验证proof后绑定receipt/hash；callback和budget构造时捕获');

  returned.bundle.anchors[0].text = 'Provider迟改不能污染host'; returned.proof.review.anchors[0].decision = 'reject';
  disclosure.bundle.anchors[0].text = 'Renderer迟改不能污染host'; disclosure.context.quotes[0].text = '客户端迟改';
  const stable = await r.questions.readPropositions(OWNER, r.environmentId, receipt);
  assert.equal(stable.status, 'ready'); assert.ok(stable.status === 'ready');
  assert.notEqual(stable.bundle.anchors[0].text, 'Provider迟改不能污染host');
  assert.notEqual(stable.bundle.anchors[0].text, 'Renderer迟改不能污染host');
  assert.deepEqual(await r.questions.prepare(OWNER, r.environmentId, original), receipt); assert.equal(calls, 1);
  assert.equal((await r.questions.verify(OWNER, r.environmentId, receipt)).status, 'current');
  pass('provider和返回DTO迟改不改变retained snapshot；复用/verify/read不重跑provider');

  const lease2 = await r.environment();
  assert.equal((await r.questions.readPropositions(OWNER, r.environmentId, receipt)).status, 'held');
  assert.equal((await r.questions.readPropositions(OWNER, lease2, receipt)).status, 'ready');
  assert.deepEqual(await r.questions.prepare(OWNER, lease2, original), receipt); assert.equal(calls, 1);
  pass('同scope续租可重核retained bundle，不为旧receipt追补或重新生成');

  assert.equal((await r.questions.readPropositions(OWNER, lease2, { ...receipt, contractHash: 'a'.repeat(64) })).status, 'held');
  assert.equal((await r.questions.readPropositions(OWNER, lease2, { ...receipt, proof: returned.proof })).status, 'held');
  assert.equal((await r.questions.readPropositions(OWNER, lease2, { ...receipt, bundle: returned.bundle })).status, 'held');
  const otherLease = await r.environment(OWNER + 1);
  assert.deepEqual(await r.questions.readPropositions(OWNER + 1, otherLease, receipt), { status: 'held', reasons: ['receipt_unavailable'] });
  const wrongSelection = await r.environment(OWNER, otherProject.id);
  assert.equal((await r.questions.readPropositions(OWNER, wrongSelection, receipt)).status, 'held');
  assert.equal(calls, 1);
  pass('伪receipt/renderer proof或bundle/owner错/selection错全部held，不新增模型或源权限');

  const restarted = createArgumentQuestionRuntime(r.environments, { preparePropositions: async () => assert.fail('Restart must not reconstruct old proof') });
  const renewed = await r.environment();
  assert.deepEqual(await restarted.readPropositions(OWNER, renewed, receipt), { status: 'held', reasons: ['receipt_unavailable'] });
  pass('重启不从持久化字段或renderer proof重建旧命题凭据');

  let jointPreparations = 0, jointReferenceReads = 0, jointPropositionReads = 0, jointCalls = 0;
  const joint = await rig({ preparePropositions: async context => { jointPreparations++; return syntheticPreparation(context); } });
  const jointApi: ReviewArgumentQuestionApi = {
    getEnvironment: selection => joint.environments.getEnvironment(OWNER, selection),
    freezeQuestion: (environmentId, selectors) => joint.questions.prepare(OWNER, environmentId, selectors),
    verifyQuestion: (environmentId, receipt) => joint.questions.verify(OWNER, environmentId, receipt),
    readQuestion: (environmentId, receipt) => { jointReferenceReads++; return joint.questions.read(OWNER, environmentId, receipt); },
    readQuestionPropositions: (environmentId, receipt) => { jointPropositionReads++; return joint.questions.readPropositions(OWNER, environmentId, receipt); },
  };
  const jointClient = createReviewArgumentQuestionClient(project.id, 'synthetic-joint-proposition-session', () => jointApi);
  const jointSelectors = await joint.selectors('joint-definition-question');
  const jointIntent: ReviewQuestionIntent = { version: 1, questionMessageId: jointSelectors.questionMessageId,
    knowledgeTargets: jointSelectors.knowledgeTargets, assessment: jointSelectors.assessment, referenceRubric: jointSelectors.referenceRubric };
  jointIntent.referenceStructure = await jointClient.freeze(jointIntent);
  assert.equal(jointIntent.referenceStructure.status, 'fixed'); assert.equal(jointPreparations, 1);
  const jointAnswer: ReviewComparisonAnswer = { activityId: 'synthetic-joint-proposition-review', questionText: '什么是回环就绪？说明它的使用边界。',
    evidence: { messageId: 'synthetic-joint-answer', answer: '回环就绪是设备可以开始训练的状态。只有本次设备已供电且自检通过时才适用。',
      hintLevel: 0, consultedMaterialIds: [], targetKnowledgeNames: jointSelectors.knowledgeTargets, questionIntent: jointIntent } };
  const jointBefore = structuredClone(jointAnswer);
  const jointRequests: { system: string; user: unknown }[] = [];
  const jointModel = createFrozenPropositionReferenceModel(async request => {
    jointCalls++; assert.ok(jointCalls <= 2);
    assert.equal(request.workflow, 'review-scoring'); assert.equal(request.skipMemoryInjection, true);
    assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
    const input = JSON.parse(request.userInput);
    jointRequests.push({ system: request.systemPromptOverride!, user: structuredClone(input) });
    if (jointCalls === 1) {
      assert.equal(input.answer.text, jointAnswer.evidence.answer);
      assert.equal(Object.hasOwn(input, 'reference'), false);
      return { content: JSON.stringify({ version: 1, packetId: input.packetId, requirements: [], edges: [], claims: [
        { id: 'A1', role: 'definition', quote: '回环就绪是设备可以开始训练的状态' },
        { id: 'A2', role: 'condition', quote: '只有本次设备已供电且自检通过时才适用' },
      ] }) };
    }
    const wire = input as FrozenPropositionReferenceInput;
    assert.equal(wire.version, 5); assert.equal(wire.protocol, 'review-frozen-reference-propositions-v5');
    assert.ok(wire.frames.every(frame => frame.nodes.every(node => node.propositions.length === 1)));
    return { content: JSON.stringify({ version: 5, evaluationId: wire.evaluationId,
      contractHash: wire.contractHash, bundleHash: wire.bundleHash,
      items: wire.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported', scope: 'same',
        matches: item.requiredNodeIds.map(nodeId => {
          const node = frame.nodes.find(node => node.id === nodeId)!;
          return { claimId: node.role === 'definition' ? 'user/A1' : 'user/A2', propositionId: node.propositions[0].id };
        }) }))) }) };
  });
  const jointResult = await evaluateFrozenPropositionReviewReferenceShadow(jointAnswer,
    { readReferencePropositions: jointClient.readReferencePropositions }, jointModel);
  assert.equal(jointResult.result.status, 'reviewed', JSON.stringify(jointResult.result));
  assert.equal(jointResult.result.frames[0].status, 'covered'); assert.equal(jointResult.result.observations.length, 2);
  assert.equal(jointCalls, 2); assert.equal(jointRequests.length, 2);
  assert.equal(jointReferenceReads, 4); assert.equal(jointPropositionReads, 4); assert.equal(jointPreparations, 1);
  assert.equal(jointResult.result.modelRequests.total, 2);
  assert.equal(jointResult.result.scoreWrite, 'disabled'); assert.equal(jointResult.result.cognitionWrite, 'disabled');
  assert.equal(jointResult.result.semanticTruth, 'not_certified');
  assert.ok(jointResult.result.propositionBinding?.bundleHash);
  assert.deepEqual(jointAnswer, jointBefore);
  pass('真实临时来源/host proof→client四次授权读取→真实factory两次mock请求→v5 codec及原host gate完整联验；无云/评分/认知写入');

  for (const [label, provider, reason] of [
    ['空provider结果', async () => null, 'propositions_not_prepared'],
    ['provider异常', async () => { throw new Error('MODEL_SECRET_TEXT_MUST_NOT_ESCAPE'); }, 'proposition_preparation_unavailable'],
    ['坏bundle/proof', async (context: ArgumentReferenceDisclosureContext) => { const prepared = await syntheticPreparation(context); prepared.bundle.bundleHash = 'f'.repeat(64); return prepared; }, 'proposition_proof_unavailable'],
    ['hidden proof字段', async (context: ArgumentReferenceDisclosureContext) => { const prepared = await syntheticPreparation(context); Object.defineProperty(prepared.proof, 'hidden', { value: true }); return prepared; }, 'proposition_proof_unavailable'],
    ['getter proof字段', async (context: ArgumentReferenceDisclosureContext) => { const prepared = await syntheticPreparation(context); const draft = prepared.proof.draft; Object.defineProperty(prepared.proof, 'draft', { enumerable: true, get: () => draft }); return prepared; }, 'proposition_proof_unavailable'],
  ] as const) {
    let attempts = 0;
    const failure = await rig({ preparePropositions: async context => { attempts++; return provider(context); } });
    const selection = await failure.selectors(), fixed = await failure.questions.prepare(OWNER, failure.environmentId, selection);
    assert.equal(fixed.status, 'fixed'); assert.equal((await failure.questions.read(OWNER, failure.environmentId, fixed)).status, 'ready');
    assert.deepEqual(await failure.questions.readPropositions(OWNER, failure.environmentId, fixed), { status: 'held', reasons: [reason] });
    assert.deepEqual(await failure.questions.prepare(OWNER, failure.environmentId, selection), fixed); assert.equal(attempts, 1);
    pass(`${label}仅新命题held，正常fixed/read不受污染，无答案后重试/异常文本泄露`);
  }

  const timeout = await rig({ timeoutMs: 2, preparePropositions: async () => new Promise(() => {}) });
  const timedReceipt = await timeout.questions.prepare(OWNER, timeout.environmentId, await timeout.selectors());
  assert.equal(timedReceipt.status, 'fixed');
  assert.deepEqual(await timeout.questions.readPropositions(OWNER, timeout.environmentId, timedReceipt), { status: 'held', reasons: ['proposition_preparation_timeout'] });
  assert.equal((await timeout.questions.read(OWNER, timeout.environmentId, timedReceipt)).status, 'ready');
  pass('bounded provider超时仅命题held，旧receipt仍fixed、旧结构仍可读取');

  let missingAttempts = 0;
  const missingStructure = await rig({ preparePropositions: async context => { missingAttempts++; return syntheticPreparation(context); } }, false);
  const absentReceipt = await missingStructure.questions.prepare(OWNER, missingStructure.environmentId, await missingStructure.selectors());
  assert.equal(absentReceipt.status, 'held'); assert.equal(missingAttempts, 0);
  assert.equal((await missingStructure.questions.readPropositions(OWNER, missingStructure.environmentId, absentReceipt)).status, 'held');
  pass('题前结构held不调用provider，不拿新命题反向升级旧参考合同');

  const changed = await rig({ preparePropositions: syntheticPreparation });
  const changedReceipt = await changed.questions.prepare(OWNER, changed.environmentId, await changed.selectors());
  assert.equal((await changed.questions.readPropositions(OWNER, changed.environmentId, changedReceipt)).status, 'ready');
  await changed.changeSource();
  const changedLease = await changed.environment();
  assert.equal((await changed.questions.readPropositions(OWNER, changedLease, changedReceipt)).status, 'held');
  assert.deepEqual((await changed.questions.prepare(OWNER, changedLease, await changed.selectors())).reasons, ['question_already_frozen']);
  pass('源正文/版本变更令旧命题held，同题不从新来源追补');

  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const concurrent = await rig({ preparePropositions: async context => { entered(); await blocked; return syntheticPreparation(context); } });
  const concurrentSelectors = await concurrent.selectors(), firstPreparing = concurrent.questions.prepare(OWNER, concurrent.environmentId, concurrentSelectors);
  await started;
  assert.deepEqual((await concurrent.questions.prepare(OWNER, concurrent.environmentId, concurrentSelectors)).reasons, ['question_freeze_pending']);
  release(); const completed = await firstPreparing;
  assert.equal(completed.status, 'fixed'); assert.equal((await concurrent.questions.readPropositions(OWNER, concurrent.environmentId, completed)).status, 'ready');
  pass('provider仍进行中不先暴露fixed receipt，阻止答题后迟到anchors注入');

  let releaseRevoked!: () => void, enteredRevoked!: () => void;
  const revokedBlocked = new Promise<void>(resolve => { releaseRevoked = resolve; }), revokedStarted = new Promise<void>(resolve => { enteredRevoked = resolve; });
  const revoked = await rig({ preparePropositions: async context => { enteredRevoked(); await revokedBlocked; return syntheticPreparation(context); } });
  const revokedPreparing = revoked.questions.prepare(OWNER, revoked.environmentId, await revoked.selectors());
  await revokedStarted; revoked.questions.revoke(OWNER); releaseRevoked();
  assert.deepEqual((await revokedPreparing).reasons, ['receipt_unavailable']);
  pass('provider等待中owner revoke，迟到proof不能复活receipt/bundle');

  const reading = await rig({ preparePropositions: syntheticPreparation });
  const readingReceipt = await reading.questions.prepare(OWNER, reading.environmentId, await reading.selectors());
  const inFlight = reading.questions.readPropositions(OWNER, reading.environmentId, readingReceipt);
  reading.questions.revoke();
  assert.equal((await inFlight).status, 'held');
  pass('readPropositions await期间global revoke，迟到重建不得返回ready');

  let releaseChanged!: () => void, enteredChanged!: () => void;
  const changedBlocked = new Promise<void>(resolve => { releaseChanged = resolve; }), changedStarted = new Promise<void>(resolve => { enteredChanged = resolve; });
  const changedDuring = await rig({ preparePropositions: async context => { enteredChanged(); await changedBlocked; return syntheticPreparation(context); } });
  const changedDuringPreparation = changedDuring.questions.prepare(OWNER, changedDuring.environmentId, await changedDuring.selectors());
  await changedStarted; await changedDuring.changeSource(); releaseChanged();
  const changedDuringReceipt = await changedDuringPreparation;
  const finalLease = await changedDuring.environment();
  assert.equal((await changedDuring.questions.readPropositions(OWNER, finalLease, changedDuringReceipt)).status, 'held');
  pass('provider期间实际保存源发生变化，前后源回核阻止旧候选返回ready');

  let releaseLate!: (value: Prepared | null) => void, lateContext: ArgumentReferenceDisclosureContext | undefined;
  const late = await rig({ timeoutMs: 2, preparePropositions: async context => {
    lateContext = structuredClone(context); return new Promise<Prepared | null>(resolve => { releaseLate = resolve; });
  } });
  const lateSelectors = await late.selectors(), lateReceipt = await late.questions.prepare(OWNER, late.environmentId, lateSelectors);
  assert.equal(lateReceipt.status, 'fixed'); assert.ok(lateContext);
  releaseLate(await syntheticPreparation(lateContext));
  assert.deepEqual(await late.questions.readPropositions(OWNER, late.environmentId, lateReceipt),
    { status: 'held', reasons: ['proposition_preparation_timeout'] });
  assert.deepEqual(await late.questions.prepare(OWNER, late.environmentId, lateSelectors), lateReceipt);
  pass('timeout后provider迟到合法bundle也不回写原entry、不升级同题');

  const eviction = await rig({ preparePropositions: syntheticPreparation });
  const evictionReceipt = await eviction.questions.prepare(OWNER, eviction.environmentId, await eviction.selectors('eviction-original'));
  for (let index = 0; index < 200; index++) {
    const selector = await eviction.selectors(`eviction-${index}`);
    selector.referenceRubric = { ...selector.referenceRubric, status: 'unavailable', items: [], reason: 'missing_selection' };
    assert.equal((await eviction.questions.prepare(OWNER, eviction.environmentId, selector)).status, 'held');
  }
  assert.deepEqual(await eviction.questions.readPropositions(OWNER, eviction.environmentId, evictionReceipt),
    { status: 'held', reasons: ['receipt_unavailable'] });
  pass('每owner 200合同eviction同时移除命题凭据，不凭bundle hash复活');

  let releaseEvicted!: () => void, enteredEvicted!: () => void;
  const evictedBlocked = new Promise<void>(resolve => { releaseEvicted = resolve; }), evictedStarted = new Promise<void>(resolve => { enteredEvicted = resolve; });
  const pendingEviction = await rig({ timeoutMs: 30000, preparePropositions: async context => {
    enteredEvicted(); await evictedBlocked; return syntheticPreparation(context);
  } });
  const pendingEvictionPreparation = pendingEviction.questions.prepare(OWNER, pendingEviction.environmentId, await pendingEviction.selectors('pending-eviction-original'));
  await evictedStarted;
  for (let index = 0; index < 200; index++) {
    const selector = await pendingEviction.selectors(`pending-eviction-${index}`);
    selector.referenceRubric = { ...selector.referenceRubric, status: 'unavailable', items: [], reason: 'missing_selection' };
    await pendingEviction.questions.prepare(OWNER, pendingEviction.environmentId, selector);
  }
  releaseEvicted();
  assert.deepEqual((await pendingEvictionPreparation).reasons, ['receipt_unavailable']);
  pass('provider等待中entry被evict，entry identity检查拒绝迟到proof');

  console.log(`Argument question proposition checks passed: ${checks} synthetic groups; 0 network, 0 real vault, no semantic accuracy claim.`);
} finally {
  globalThis.fetch = previousFetch;
  const absolute = path.resolve(temporary), intended = path.resolve(os.tmpdir());
  assert.ok(path.dirname(absolute) === intended && path.basename(absolute).startsWith('loginote-question-propositions-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
