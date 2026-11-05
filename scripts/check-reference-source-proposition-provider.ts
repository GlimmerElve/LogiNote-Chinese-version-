import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { createReferenceSourcePropositionProvider, createCurrentSourcePropositionReader, createSavedSourcePropositionModel,
  SOURCE_PROPOSITION_PROVIDER_LIMITS, type CurrentSourcePropositionSnapshot } from '../src/electron/rag/referenceSourcePropositionProvider.ts';
import type { SourcePropositionContext, SourcePropositionDraft, SourcePropositionReviewInput } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import type { SourcePropositionBuildModel } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { validateReviewedReferencePropositions } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { createArgumentProjectionEnvironmentRegistry, type ArgumentProjectionRoots } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentProjectionSourceScope } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { createArgumentQuestionRuntime } from '../src/electron/rag/argumentQuestionRuntime.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import { evaluateFrozenPropositionReviewReferenceShadow } from '../src/services/reviewComparison/frozenPropositionShadow.ts';
import { createFrozenPropositionReferenceModel, type FrozenPropositionReferenceInput } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { ArgumentReferenceModelConfig } from '../src/electron/rag/argumentReferenceModel.ts';
import type { NoteItem } from '../src/types.ts';

// No real vault, saved credentials, network or semantic accuracy claims.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in source provider checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-source-proposition-provider-'));
const copy = <T>(value: T): T => structuredClone(value);
const consent = { consent: 'process-reference-propositions' as const };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const zero = { draft: 0, review: 0, total: 0, limit: 2 };
async function draftFor(context: SourcePropositionContext): Promise<SourcePropositionDraft> {
  return { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
    anchors: context.projection.nodes.map((node, index) => {
      const span = node.evidence[0], parent = context.quotes.find(q => q.evidence.start === span.start && q.evidence.end === span.end && q.evidence.quote === span.quote)!;
      assert.ok(parent);
      const text = node.role === 'conclusion' && parent.evidence.quote.includes('所以') ? '本次合成包裹会进入二号通道' : span.quote;
      const start = span.start + span.quote.indexOf(text);
      return { id: `P${index + 1}`, nodeId: node.id, quoteId: parent.quoteId, start, end: start + text.length, text };
    }) };
}
const vote = (input: SourcePropositionReviewInput) => ({ version: 1 as const, protocol: 'review-source-proposition-review-v1' as const,
  reviewId: input.reviewId, contextHash: input.contextHash, draftHash: input.draftHash,
  anchors: input.draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept' as const, roleSupported: true,
    completeMeaning: true, scopePreserved: true, reason: 'Synthetic test reviewer vote, not semantic truth.' })) });
function model() {
  let calls = 0;
  const api: SourcePropositionBuildModel = { draft: async context => { calls++; return draftFor(context); },
    review: async input => { calls++; return vote(input); } };
  return { api, calls: () => calls };
}
try {
  const f = await createReferenceDisclosureFixture({ task: 'reasoning', theme: 'progressive-parcel-v1' });
  const ref = { kind: 'knowledge-note' as const, entityId: f.notes[0].id };
  const disclosed = await buildArgumentReferenceDisclosure(f.frozen); assert.ok(disclosed.status === 'ready');
  let snapshot: CurrentSourcePropositionSnapshot | null = { input: copy(f.inputs.get(ref.entityId)!), result: copy(f.results.get(ref.entityId)!),
    binding: { publicationId: 'synthetic-memory-publication', epoch: 1, resultHash: f.results.get(ref.entityId)!.resultHash,
      structureHash: f.results.get(ref.entityId)!.authority.structureHash } };
  let reads = 0;
  const m = model(), options = { readCurrent: async () => { reads++; return copy(snapshot); }, model: m.api };
  const p = createReferenceSourcePropositionProvider(options);
  assert.equal(reads, 0); assert.equal(m.calls(), 0);
  assert.deepEqual((await p.build(ref)).modelRequests, zero);
  assert.deepEqual((await p.build(ref, { consent: 'process-reference' as never })).modelRequests, zero);
  assert.equal(reads, 0);
  const empty = createReferenceSourcePropositionProvider({ readCurrent: options.readCurrent });
  assert.deepEqual((await empty.build(ref, consent)).modelRequests, zero); assert.equal(reads, 0);
  assert.equal((await p.loadForQuestion(disclosed.context)).status, 'held'); assert.equal(m.calls(), 0);
  await assert.rejects(createCurrentSourcePropositionReader(f.store)(ref), /active_publication_binding_unavailable/u);
  pass('创建/无独立consent/无model/缓存缺失均0请求，无epoch reader不伪造发布身份');

  options.readCurrent = async () => assert.fail('Late reader replacement');
  const built = await p.build(ref, consent); assert.ok(built.status === 'ready', JSON.stringify(built));
  assert.equal(built.reused, false); assert.equal(built.retention, 'ephemeral'); assert.equal(m.calls(), 2);
  const retainedAudit = copy(built.proof.review);
  built.proof.review.anchors[0].decision = 'reject'; built.bundle.anchors[0].text = 'late mutation';
  const reused = await p.build(ref, consent); assert.ok(reused.status === 'ready');
  assert.equal(reused.reused, true); assert.deepEqual(reused.modelRequests, zero); assert.equal(m.calls(), 2);
  assert.deepEqual(reused.proof.review, retainedAudit);
  pass('独立draft+review最多2次；同版本复用0次，返回对象迟改不污染缓存');

  const loaded = await p.loadForQuestion(disclosed.context); assert.ok(loaded.status === 'ready', JSON.stringify(loaded));
  assert.equal(loaded.bundle.version, 2); assert.equal(loaded.bundle.reviewBasis.questionSpecificReview, 'not_performed');
  assert.deepEqual(loaded.proof.sources[0].review, retainedAudit);
  assert.ok(loaded.bundle.anchors.some(a => a.nodeId === 'N2' && a.text === '本次合成包裹会进入二号通道' && a.parent.text.includes('所以')));
  assert.ok(!loaded.bundle.anchors.some(a => a.nodeId === 'N4'));
  assert.equal((await validateReviewedReferencePropositions(disclosed.context, loaded.bundle, loaded.proof)).status, 'ready');
  assert.equal(m.calls(), 2);
  pass('仅题前required闭包投影，混合父句选真实结论子坐标，v2保留原源审核而不虚构本题审核');

  const altered = copy(loaded.bundle); altered.reviewBasis.questionSpecificReview = 'performed' as never;
  assert.equal((await validateReviewedReferencePropositions(disclosed.context, altered, loaded.proof)).status, 'held');
  snapshot!.binding.epoch++; snapshot!.binding.publicationId = 'synthetic-memory-republication';
  assert.equal((await p.loadForQuestion(disclosed.context)).status, 'held'); assert.equal(m.calls(), 2);
  snapshot!.binding.epoch--; snapshot!.binding.publicationId = 'synthetic-memory-publication';
  assert.equal((await p.loadForQuestion(disclosed.context)).status, 'held');
  assert.ok((await p.build(ref, consent)).status === 'ready'); assert.equal(m.calls(), 4);
  pass('审核basis篡改held；源同hash重发布也使缓存失效，观察到A→B→A不能复活旧缓存');

  p.revoke(); assert.equal((await p.loadForQuestion(disclosed.context)).status, 'held'); assert.equal(m.calls(), 4);
  const restart = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(snapshot), model: m.api });
  assert.equal((await restart.loadForQuestion(disclosed.context)).status, 'held'); assert.equal(m.calls(), 4);
  snapshot = null; assert.equal((await restart.build(ref, consent)).status, 'held'); assert.equal(m.calls(), 4);
  pass('revoke/restart/未发布源不自动重建、不进入模型或生产写入');

  snapshot = { input: copy(f.inputs.get(ref.entityId)!), result: copy(f.results.get(ref.entityId)!),
    binding: { publicationId: 'synthetic-change', epoch: 1, resultHash: f.results.get(ref.entityId)!.resultHash,
      structureHash: f.results.get(ref.entityId)!.authority.structureHash } };
  let changingCalls = 0;
  const changing = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(snapshot), model: {
    draft: async context => { changingCalls++; const output = await draftFor(context); snapshot!.binding.epoch++; return output; },
    review: async () => { changingCalls++; assert.fail('Changed source cannot be reviewed'); },
  } });
  const changed = await changing.build(ref, consent); assert.equal(changed.status, 'held');
  assert.equal(changed.modelRequests.total, 1); assert.equal(changingCalls, 1);
  assert.equal((await changing.loadForQuestion(disclosed.context)).status, 'held');
  pass('首个请求后源发生变化，第二请求前held，不缓存迟到结果');

  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  let blockedCalls = 0;
  const revocable = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(snapshot), model: {
    draft: async context => { blockedCalls++; enter(); await blocked; return draftFor(context); },
    review: async () => assert.fail('Revoked source cannot advance'),
  } });
  const pending = revocable.build(ref, consent); await entered;
  const duplicate = await revocable.build(ref, consent); assert.equal(duplicate.status, 'held'); assert.deepEqual(duplicate.modelRequests, zero);
  revocable.revoke(); release(); const stopped = await pending; assert.equal(stopped.status, 'held'); assert.equal(blockedCalls, 1);
  assert.equal((await revocable.loadForQuestion(disclosed.context)).status, 'held');
  pass('同源inflight不重复付费；构建中revoke中断，迟到模型结果不复活缓存');

  let reviewEnter!: () => void, reviewRelease!: () => void;
  const reviewEntered = new Promise<void>(resolve => { reviewEnter = resolve; }), reviewBlocked = new Promise<void>(resolve => { reviewRelease = resolve; });
  const reviewRevocable = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(snapshot), model: {
    draft: draftFor, review: async input => { reviewEnter(); await reviewBlocked; return vote(input); },
  } });
  const reviewing = reviewRevocable.build(ref, consent); await reviewEntered; reviewRevocable.revoke(); reviewRelease();
  const cancelledReview = await reviewing; assert.equal(cancelledReview.status, 'held'); assert.equal(cancelledReview.modelRequests.total, 2);
  assert.equal((await reviewRevocable.loadForQuestion(disclosed.context)).status, 'held');
  pass('独立审核等待中revoke，已发2请求如实计数，但迟到票不得缓存');

  const capped = createReferenceSourcePropositionProvider({ readTimeoutMs: 1000, readCurrent: async () => new Promise(() => {}), model: m.api });
  const jobs = Array.from({ length: SOURCE_PROPOSITION_PROVIDER_LIMITS.pending }, (_, index) => capped.build({ ...ref, entityId: `capacity-${index}` }, consent));
  const overflow = await capped.build({ ...ref, entityId: 'capacity-overflow' }, consent);
  assert.equal(overflow.status, 'held'); assert.ok(overflow.status === 'held'); assert.deepEqual(overflow.reasons, ['source_build_capacity']);
  assert.deepEqual(overflow.modelRequests, zero); capped.revoke();
  assert.ok((await Promise.all(jobs)).every(reply => reply.status === 'held' && reply.modelRequests.total === 0));
  const timed = createReferenceSourcePropositionProvider({ readTimeoutMs: 2, readCurrent: async () => new Promise(() => {}), model: m.api });
  assert.equal((await timed.build(ref, consent)).status, 'held');
  pass('8个不同源inflight上限及bounded源读取超时在模型调用前生效');

  let adapterCalls = 0;
  const config: ArgumentReferenceModelConfig = { fingerprint: 'synthetic-only', providerLabel: 'mock', modelName: 'mock', isRemote: false,
    provider: { apiType: 'ollama', baseUrl: 'http://localhost:1', apiKey: '', models: ['mock'], selectedModel: 'mock' } };
  const savedModel = createSavedSourcePropositionModel(config, { invoke: async (actual, request, signal) => {
    adapterCalls++; assert.equal(actual.modelName, 'mock'); assert.ok(signal instanceof AbortSignal);
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
    const wire = JSON.parse(request.userInput);
    return JSON.stringify(request.stage === 'extract' ? await draftFor(wire.reference) : vote(wire));
  } });
  config.modelName = 'late-change'; assert.equal(adapterCalls, 0);
  const savedProvider = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(snapshot), model: savedModel });
  assert.equal((await savedProvider.build(ref, consent)).status, 'ready'); assert.equal(adapterCalls, 2);
  pass('真实host adapter桥创建0调用，不读取配置；显式构建才发送2个冻结配置mock request');

  // Real persisted source/admission/projection and owner-bound receipts, in a
  // wholly synthetic temporary vault. Source audit cache itself stays ephemeral.
  const roots: ArgumentProjectionRoots = { dataRoot: temporary, vaultRoot: path.join(temporary, 'vault'), userStateDir: path.join(temporary, 'user-state') };
  const baseNote = (id: string, title: string, content: string, noteType: 'project' | 'knowledge'): NoteItem => ({ id, title, content, noteType,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] });
  const project = baseNote('provider-project', '合成项目', '纯合成。', 'project');
  const note = { ...baseNote('provider-knowledge', '合成回环就绪', '回环就绪是设备可以开始训练的状态。\n\n只有本次设备已供电且自检通过时才适用。', 'knowledge'), parentId: project.id };
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, [project, note]);
  const envs = createArgumentProjectionEnvironmentRegistry(() => roots), owner = 103;
  const environment = await envs.getEnvironment(owner, { kind: 'learning-note', noteId: project.id }); assert.ok(environment.status === 'available');
  const sourceRef = { kind: 'knowledge-note' as const, entityId: note.id };
  const live = await envs.withEnvironment(owner, environment.environmentId, async (runtime, captured, scope) => {
    const sourceScope = createArgumentProjectionSourceScope(scope, sourceRef);
    await withRagSourceTransaction(Object.values(captured), async () => {
      const base = await readSavedArgumentProjectionSource({ ...captured, scope: sourceScope }, sourceRef); assert.ok(base);
      await runtime.admission.record(base, { reviewId: 'synthetic-provider-admission', policyVersion: 'synthetic-provider-policy', decision: 'eligible',
        evidence: [base.quotes[0].evidence], checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
        reason: 'Synthetic test admission.', reviewedAt: '2026-10-07T02:00:00.000Z' });
    });
    const input = await runtime.host.withSource(sourceRef, async input => copy(input)); assert.ok(input);
    const ids = ['回环就绪是', '已供电且自检通过'].map(text => input.quotes.find(q => q.evidence.quote.includes(text))!.quoteId);
    const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId, nodes: [{ id: 'N1', role: 'definition', quoteIds: [ids[0]] }, { id: 'N2', role: 'condition', quoteIds: [ids[1]] }],
      relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: ids }] };
    const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)), result = await finalizeArgumentProjectionBuild(input, draft, review);
    assert.equal((await runtime.store.publish({ publicationId: 'synthetic-provider-host-pub', result, proof: { input, draft, review }, expectedActiveHash: null })).status, 'published');
    return { readCurrent: createCurrentSourcePropositionReader(runtime.store), republish: () => runtime.store.publish({
      publicationId: 'synthetic-provider-host-repub', result, proof: { input, draft, review }, expectedActiveHash: result.authority.structureHash }) };
  });
  assert.ok(live); const hostSnapshot = await live.readCurrent(sourceRef); assert.ok(hostSnapshot);
  assert.equal(hostSnapshot.binding.publicationId, 'synthetic-provider-host-pub'); assert.ok(hostSnapshot.binding.epoch >= 1);
  pass('真实临时host回读已审核published proof，返回实际publicationId/epoch而非自报hash');

  const hostModel = model(), hostProvider = createReferenceSourcePropositionProvider({ readCurrent: live.readCurrent, model: hostModel.api });
  const audit = await hostProvider.build(sourceRef, consent); assert.ok(audit.status === 'ready', JSON.stringify(audit)); assert.equal(hostModel.calls(), 2);
  const questions = createArgumentQuestionRuntime(envs, { preparePropositions: hostProvider.preparePropositions });
  const assessment = freezeReviewAssessment('definition', [note.title]), catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
  const meaning = catalog.candidates.find(q => q.quote.includes('回环就绪是'))!, condition = catalog.candidates.find(q => q.quote.includes('已供电且自检通过'))!;
  const rubric = freezeReviewReferenceRubric(`concept_meaning=${meaning.candidateId};concept_boundary=${condition.candidateId}`, assessment, catalog);
  const selectors = (id: string) => ({ questionMessageId: id, knowledgeTargets: [note.title], assessment, referenceRubric: rubric });
  const receipt1 = await questions.prepare(owner, environment.environmentId, selectors('source-provider-question-1'));
  const receipt2 = await questions.prepare(owner, environment.environmentId, selectors('source-provider-question-2'));
  assert.equal(receipt1.status, 'fixed'); assert.equal(receipt2.status, 'fixed');
  const first = await questions.readPropositions(owner, environment.environmentId, receipt1), second = await questions.readPropositions(owner, environment.environmentId, receipt2);
  assert.ok(first.status === 'ready', JSON.stringify(first)); assert.ok(second.status === 'ready', JSON.stringify(second));
  assert.equal(first.bundle.version, 2); assert.equal(second.bundle.version, 2); assert.notEqual(first.bundle.contextHash, second.bundle.contextHash);
  assert.ok(first.bundle.version === 2 && second.bundle.version === 2);
  assert.deepEqual(first.bundle.reviewBasis.sourceBundleHashes, second.bundle.reviewBasis.sourceBundleHashes);
  assert.equal(first.bundle.reviewBasis.questionSpecificReview, 'not_performed'); assert.equal(hostModel.calls(), 2);
  assert.ok(!JSON.stringify(first).includes('canonicalText') && !JSON.stringify(first).includes(roots.vaultRoot));
  assert.equal((await questions.readPropositions(owner + 1, environment.environmentId, receipt1)).status, 'held');
  pass('两道真实owner题前receipt复用同一源审核，仅机械绑定新question/context；题前新增0模型请求、IPC不含私有proof/原文全库');

  const api: ReviewArgumentQuestionApi = { getEnvironment: async () => environment,
    freezeQuestion: async (_env, original) => questions.prepare(owner, environment.environmentId, original),
    verifyQuestion: async (_env, receipt) => questions.verify(owner, environment.environmentId, receipt),
    readQuestion: async (_env, receipt) => questions.read(owner, environment.environmentId, receipt),
    readQuestionPropositions: async (_env, receipt) => questions.readPropositions(owner, environment.environmentId, receipt) };
  const client = createReviewArgumentQuestionClient(project.id, 'synthetic-provider-session', () => api);
  let answerCalls = 0;
  const answerModel = createFrozenPropositionReferenceModel(async request => {
    answerCalls++; const wire = JSON.parse(request.userInput);
    if (answerCalls === 1) return { content: JSON.stringify({ version: 1, packetId: wire.packetId, requirements: [], edges: [], claims: [
      { id: 'A1', role: 'definition', quote: '回环就绪是设备可以开始训练的状态' }, { id: 'A2', role: 'condition', quote: '只有本次设备已供电且自检通过时才适用' }] }) };
    const input = wire as FrozenPropositionReferenceInput;
    return { content: JSON.stringify({ version: 5, evaluationId: input.evaluationId, contractHash: input.contractHash, bundleHash: input.bundleHash,
      items: input.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported', scope: 'same',
        matches: item.requiredNodeIds.map(nodeId => { const node = frame.nodes.find(n => n.id === nodeId)!;
          return { claimId: node.role === 'definition' ? 'user/A1' : 'user/A2', propositionId: node.propositions[0].id }; }) }))) }) };
  });
  const answer: ReviewComparisonAnswer = { activityId: 'synthetic-provider-answer', questionText: '什么是回环就绪？',
    evidence: { messageId: 'synthetic-provider-answer-1', answer: note.content, hintLevel: 0, targetKnowledgeNames: [note.title],
      questionIntent: { version: 1, questionMessageId: 'source-provider-question-1', knowledgeTargets: [note.title], assessment, referenceRubric: rubric, referenceStructure: receipt1 } } };
  const result = await evaluateFrozenPropositionReviewReferenceShadow(answer, { readReferencePropositions: client.readReferencePropositions }, answerModel);
  assert.equal(result.result.status, 'reviewed', JSON.stringify(result.result)); assert.equal(result.result.frames[0].status, 'covered');
  assert.equal(hostModel.calls(), 2); assert.equal(answerCalls, 2); assert.equal(result.result.scoreWrite, 'disabled'); assert.equal(result.result.cognitionWrite, 'disabled');
  assert.equal(result.result.semanticTruth, 'not_certified');
  pass('真实source provider→question runtime→client→v5两次mock answer请求→原host gate完整联验，源审核与回答核对计数分开，未写分/认知');

  assert.equal((await live.republish()).status, 'published');
  const republished = await live.readCurrent(sourceRef); assert.ok(republished);
  assert.equal(republished.binding.resultHash, hostSnapshot.binding.resultHash);
  assert.equal(republished.binding.structureHash, hostSnapshot.binding.structureHash);
  assert.notEqual(republished.binding.publicationId, hostSnapshot.binding.publicationId);
  assert.equal((await hostProvider.loadForQuestion(first.context)).status, 'held');
  const receipt3 = await questions.prepare(owner, environment.environmentId, selectors('source-provider-question-3'));
  assert.equal((await questions.readPropositions(owner, environment.environmentId, receipt3)).status, 'held');
  assert.equal(hostModel.calls(), 2);
  // Existing question contracts do NOT yet bind publicationId/epoch. Their
  // retained, same-content proof stays independently validated, not auto-revoked.
  assert.equal((await questions.readPropositions(owner, environment.environmentId, receipt1)).status, 'ready');
  pass('真实同hash重发布令新题源缓存失效且0请求；不虚称旧题凭据已含publication epoch');

  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, [project, { ...note, content: note.content.replace('开始训练', '开始合成训练'), updatedAt: '2026-10-07T03:00:00.000Z' }]);
  assert.equal(await live.readCurrent(sourceRef), null);
  assert.equal((await hostProvider.loadForQuestion(first.context)).status, 'held');
  assert.equal((await questions.readPropositions(owner, environment.environmentId, receipt1)).status, 'held');
  assert.equal(hostModel.calls(), 2); assert.equal(answerCalls, 2);
  pass('真实源变更撤销active projection/cache/旧receipt，不复用或补跑模型');

  const capacitySources = new Map<string, CurrentSourcePropositionSnapshot>(), capacityModel = model();
  const full = createReferenceSourcePropositionProvider({ readCurrent: async ref => copy(capacitySources.get(ref.entityId) ?? null), model: capacityModel.api });
  for (let index = 0; index <= SOURCE_PROPOSITION_PROVIDER_LIMITS.entries; index++) {
    const entityId = `synthetic-cache-capacity-${index}`, original = hostSnapshot.input;
    const input = await prepareArgumentProjectionBuild({ source: { ...original.source, entityId }, canonicalText: original.canonicalText,
      hierarchy: original.hierarchy, chunks: original.chunks, sourceQualification: original.sourceQualification,
      scope: { ...original.scope, allowedNoteIds: [entityId] } });
    const ids = ['回环就绪是', '已供电且自检通过'].map(text => input.quotes.find(q => q.evidence.quote.includes(text))!.quoteId);
    const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId, nodes: [{ id: 'N1', role: 'definition', quoteIds: [ids[0]] }, { id: 'N2', role: 'condition', quoteIds: [ids[1]] }],
      relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: ids }] };
    const result = await finalizeArgumentProjectionBuild(input, draft, fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)));
    capacitySources.set(entityId, { input, result, binding: { publicationId: `synthetic-capacity-pub-${index}`, epoch: 1, resultHash: result.resultHash, structureHash: result.authority.structureHash } });
    const reply = await full.build({ kind: 'knowledge-note', entityId }, consent);
    if (index < SOURCE_PROPOSITION_PROVIDER_LIMITS.entries) assert.equal(reply.status, 'ready', JSON.stringify(reply));
    else { assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_cache_capacity']); assert.deepEqual(reply.modelRequests, zero); }
  }
  assert.equal(capacityModel.calls(), SOURCE_PROPOSITION_PROVIDER_LIMITS.entries * 2);
  pass('64项cache已满时第65项在付费前held，精确proof体积仍在末端检查');

  const corruptModel = model();
  const corruptStorage = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(hostSnapshot), model: corruptModel.api,
    storage: { read: async () => { throw new Error('source_proposition_store_invalid_ledger'); },
      publish: async () => assert.fail('Corrupt storage must not be overwritten automatically') } });
  const corrupt = await corruptStorage.build(sourceRef, consent);
  assert.ok(corrupt.status === 'held'); assert.deepEqual(corrupt.reasons, ['source_storage_unavailable']);
  assert.deepEqual(corrupt.modelRequests, zero); assert.equal(corruptModel.calls(), 0);
  assert.equal((await corruptStorage.loadForQuestion(first.context)).status, 'held'); assert.equal(corruptModel.calls(), 0);
  pass('损坏持久资产在模型前held为storage不可用，普通题前读取不自动覆盖/补建');

  for (const throws of [false, true]) {
    const failureModel = model();
    const failure = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(hostSnapshot), model: failureModel.api,
      storage: { read: async () => null, publish: async () => {
        if (throws) throw new Error('source_proposition_store_write_failed');
        return { status: 'held', reasons: ['synthetic_storage_unavailable'] };
      } } });
    const reply = await failure.build(sourceRef, consent);
    assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_storage_unavailable']);
    assert.equal(reply.modelRequests.total, 2); assert.equal(failureModel.calls(), 2);
    assert.equal((await failure.loadForQuestion(first.context)).status, 'held'); assert.equal(failureModel.calls(), 2);
    pass(`${throws ? '抛错' : 'held'}的持久提交如实保留已发2请求，不留ready缓存或题前隐式重试`);
  }

  for (const stop of ['timeout', 'revoke'] as const) {
    let storageEnter!: () => void, storageRelease!: () => void, settled!: () => void, commits = 0;
    const storageEntered = new Promise<void>(resolve => { storageEnter = resolve; });
    const storageBlocked = new Promise<void>(resolve => { storageRelease = resolve; });
    const storageSettled = new Promise<void>(resolve => { settled = resolve; });
    const lateModel = model();
    const late = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(hostSnapshot), model: lateModel.api,
      readTimeoutMs: 25, storage: { read: async () => null, publish: async (_ref, _binding, proof, guard) => {
        storageEnter(); await storageBlocked;
        try { guard!(); commits++; return { status: 'stored', bundleHash: proof.bundle.bundleHash, retention: 'persistent' }; }
        catch (error) { assert.match(String(error), /source_provider_(aborted|revoked)/u); return { status: 'held', reasons: ['expired_write'] }; }
        finally { settled(); }
        // A real store must run the guard before committing; it is now revoked.
      } } });
    const writing = late.build(sourceRef, consent); await storageEntered;
    if (stop === 'revoke') late.revoke();
    const reply = await writing; assert.ok(reply.status === 'held'); assert.equal(reply.modelRequests.total, 2);
    assert.deepEqual(reply.reasons, [stop === 'timeout' ? 'source_provider_timeout' : 'source_provider_aborted']);
    storageRelease(); await storageSettled; assert.equal(commits, 0); assert.equal(lateModel.calls(), 2);
    assert.equal((await late.loadForQuestion(first.context)).status, 'held');
    pass(`持久写等待期间${stop}，迟到提交guard已撤销，不复活ready缓存`);
  }

  let readEnter!: () => void, readRelease!: () => void, readSettle!: () => void, lateReadWrites = 0;
  const readEntered = new Promise<void>(resolve => { readEnter = resolve; });
  const readBlocked = new Promise<void>(resolve => { readRelease = resolve; });
  const readSettled = new Promise<void>(resolve => { readSettle = resolve; });
  const lateRead = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(hostSnapshot), readTimeoutMs: 25,
    storage: { read: async (_ref, guard) => {
      readEnter(); await readBlocked;
      try { guard!(); lateReadWrites++; return null; }
      catch (error) { assert.match(String(error), /source_provider_aborted/u); return null; }
      finally { readSettle(); }
    }, publish: async () => assert.fail('Question read must not build') } });
  const lateLoading = lateRead.loadForQuestion(first.context); await readEntered;
  assert.equal((await lateLoading).status, 'held'); readRelease(); await readSettled;
  assert.equal(lateReadWrites, 0);
  pass('独立题前helper读取超时也撤销本次guard，不依赖外层revoke阻止迟到派生写');

  let publication = copy(hostSnapshot);
  const changedAfterCommitModel = model();
  const changedAfterCommit = createReferenceSourcePropositionProvider({ readCurrent: async () => copy(publication), model: changedAfterCommitModel.api,
    storage: { read: async () => null, publish: async (_ref, _binding, proof, guard) => {
      guard!(); publication.binding.epoch++; publication.binding.publicationId = 'synthetic-after-persistent-commit';
      return { status: 'stored', bundleHash: proof.bundle.bundleHash, retention: 'persistent' };
    } } });
  const changedCommitted = await changedAfterCommit.build(sourceRef, consent);
  assert.ok(changedCommitted.status === 'held'); assert.deepEqual(changedCommitted.reasons, ['source_snapshot_changed']);
  assert.equal(changedCommitted.modelRequests.total, 2); assert.equal(changedAfterCommitModel.calls(), 2);
  assert.equal((await changedAfterCommit.loadForQuestion(first.context)).status, 'held');
  pass('持久rename返回后真实publication变更不报ready，不宣称已提交文件被回滚');
  console.log(`Reference source proposition provider: ${checks} check groups passed (offline, synthetic votes only).`);
} finally {
  globalThis.fetch = fetchBefore;
  // Only the exact mkdtemp fixture path is removed; no workspace/vault root.
  await fs.rm(temporary, { recursive: true, force: true });
}
