import assert from 'node:assert/strict';
import { argumentProjectionBuildFixture, fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput,
  finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { prepareSourcePropositionContext, validateSourcePropositions, SOURCE_PROPOSITION_LIMITS,
  type SourcePropositionContext, type SourcePropositionDraft, type SourcePropositionReviewInput,
  type SourcePropositionReview } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { buildSourcePropositionSelectionParentChoices, SOURCE_PROPOSITION_SELECTION_PROTOCOL,
  type SourcePropositionSelection, type SourcePropositionSelectionParentChoice } from '../src/services/reviewComparison/sourcePropositionSelection.ts';
import { buildSourcePropositions, createSourcePropositionBuildModel, SOURCE_PROPOSITION_DRAFT_PROMPT,
  SOURCE_PROPOSITION_SELECTION_PROMPT, SOURCE_PROPOSITION_REVIEW_PROMPT, SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT,
  type SourcePropositionBuildDiagnostic, type SourcePropositionBuildOptions,
  type SourcePropositionBuildModelOptions } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import type { NoteItem } from '../src/types.ts';

// Actual explicit factory + source builder, with fixed synthetic response votes.
// No private configuration, real vault, provider, network or production writes.
// Passing these checks establishes protocol plumbing, not extraction accuracy.
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Selection build checks forbid network');
const clone = <T>(value: T): T => structuredClone(value);
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
type BuildReply = Awaited<ReturnType<typeof buildSourcePropositions>>;
function counts(reply: BuildReply, draft: number, review: number) {
  assert.deepEqual(reply.modelRequests, { draft, review, total: draft + review, limit: 2 });
}
function selected(wire: { contextHash: string; parentChoices: SourcePropositionSelectionParentChoice[] }): SourcePropositionSelection {
  const seen = new Set<string>();
  return { version: 2, protocol: SOURCE_PROPOSITION_SELECTION_PROTOCOL, contextHash: wire.contextHash,
    anchors: wire.parentChoices.filter(row => {
      if (seen.has(row.nodeId)) return false; seen.add(row.nodeId); return true;
    }).map(row => ({ parentChoiceId: row.parentChoiceId, text: row.text })) };
}
function votes(input: SourcePropositionReviewInput): SourcePropositionReview {
  return { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: input.reviewId,
    contextHash: input.contextHash, draftHash: input.draftHash,
    anchors: input.draft.anchors.map(row => ({ id: row.id, decision: 'accept', roleSupported: true,
      completeMeaning: true, scopePreserved: true, reason: 'Synthetic fixed review vote; not semantic accuracy evidence.' })) };
}
function legacyDraft(context: SourcePropositionContext, contextHash: string): SourcePropositionDraft {
  const seen = new Set<string>();
  return { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash,
    anchors: buildSourcePropositionSelectionParentChoices(context).filter(row => {
      if (seen.has(row.nodeId)) return false; seen.add(row.nodeId); return true;
    }).map((row, index) => {
      const parent = context.quotes.find(parent => parent.quoteId === row.quoteId)!;
      return { id: `P${index + 1}`, nodeId: row.nodeId, quoteId: row.quoteId,
        start: parent.evidence.start, end: parent.evidence.end, text: row.text };
    }) };
}
function mock(options: { editSelection?: (value: SourcePropositionSelection) => void;
  editReview?: (value: SourcePropositionReview) => void; legacyInV2?: boolean } = {}) {
  const requests: ArgumentProjectionModelRequest[] = [], signals: (AbortSignal | undefined)[] = [];
  const model = createSourcePropositionBuildModel(async (request, signal) => {
    requests.push(clone(request)); signals.push(signal);
    const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') {
      if (options.legacyInV2) return JSON.stringify(legacyDraft(wire.reference, wire.contextHash));
      const value = selected(wire); options.editSelection?.(value); return JSON.stringify(value);
    }
    const value = votes(wire); options.editReview?.(value); return JSON.stringify(value);
  }, { draftProtocol: 'owned-parent-text-v2' });
  return { model, requests, signals };
}
async function repeatedFixture(text: string, copies = 1) {
  const note: NoteItem = { id: 'selection-build-synthetic-source', title: '合成源级命题选择', noteType: 'knowledge', content: text,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
  const rootScopeId = 'selection-build-synthetic-root', scope = { scopeId: 'selection-build-synthetic-scope', rootScopeId,
    corpus: 'reference' as const, allowedSourceKinds: ['knowledge-note' as const], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] };
  const base = await adaptSavedKnowledgeNote({ note, rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    scope, chunks: base.chunks, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-selection-build', evidence: [base.quotes[0].evidence] } });
  const parents = input.quotes.map(row => row.quoteId);
  const nodes: ArgumentProjectionDraft['nodes'] = Array.from({ length: copies }, (_unused, index) => ({ id: `N${index + 1}`, role: 'fact', quoteIds: [...parents] }));
  const scopes: ArgumentProjectionDraft['scopes'] = [];
  for (let index = 0; index < nodes.length; index += 16) {
    const subset = nodes.slice(index, index + 16);
    scopes.push({ id: `S${scopes.length + 1}`, seedNodeId: subset[0].id, task: 'fact', requiredNodeIds: subset.map(row => row.id),
      requiredRelationIds: [], requiredGroupIds: [], quoteIds: [input.quotes.find(row => row.completeSentence)!.quoteId] });
  }
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId, nodes, relations: [], groups: [], scopes };
  const result = await finalizeArgumentProjectionBuild(input, draft, fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)));
  assert.equal(result.status, 'reviewed_complete');
  return { input, result, context: await prepareSourcePropositionContext(input, result) };
}
try {
  const fixture = await argumentProjectionBuildFixture(), input = fixture.input;
  const result = await finalizeArgumentProjectionBuild(input, fixture.draft, fixture.review);
  const context = await prepareSourcePropositionContext(input, result), savedInput = clone(input), savedResult = clone(result);
  const good = mock(); assert.equal(good.requests.length, 0);
  const reply = await buildSourcePropositions(input, result, good.model);
  assert.ok(reply.status === 'ready', JSON.stringify(reply)); counts(reply, 1, 1); assert.equal(good.requests.length, 2);
  assert.deepEqual(good.requests.map(row => row.stage), ['extract', 'review']);
  assert.equal(good.requests[0].systemPrompt, SOURCE_PROPOSITION_SELECTION_PROMPT);
  assert.equal(good.requests[1].systemPrompt, SOURCE_PROPOSITION_REVIEW_PROMPT);
  const draftWire = JSON.parse(good.requests[0].userInput), reviewWire = JSON.parse(good.requests[1].userInput);
  assert.equal(draftWire.version, 2); assert.equal(draftWire.protocol, 'review-source-proposition-selection-input-v2');
  assert.equal(draftWire.contextHash, await argumentContextHash(context));
  assert.deepEqual(draftWire.reference, context); assert.deepEqual(draftWire.parentChoices, buildSourcePropositionSelectionParentChoices(context));
  assert.equal(reviewWire.version, 1); assert.equal(reviewWire.protocol, 'review-source-proposition-review-input-v1');
  assert.equal(reviewWire.draft.version, 1); assert.equal(reviewWire.draft.protocol, 'review-source-proposition-draft-v1');
  assert.deepEqual(reviewWire.draft, reply.proof.draft); assert.deepEqual(reviewWire.reference, context);
  assert.ok(!Object.hasOwn(reviewWire, 'parentChoices') && !Object.hasOwn(reply.proof.draft, 'parentChoiceId'));
  assert.deepEqual(reply.proof.review, votes(reviewWire));
  for (const [index, anchor] of reply.proof.draft.anchors.entries()) {
    assert.equal(anchor.id, `P${index + 1}`); assert.equal(context.canonicalText.slice(anchor.start, anchor.end), anchor.text);
  }
  assert.equal((await validateSourcePropositions(input, result, reply.bundle, { draft: reply.proof.draft, review: reply.proof.review })).status, 'ready');
  for (const request of good.requests) {
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
    const wire = JSON.parse(request.userInput);
    assert.ok(!['answer', 'question', 'profile', 'personal'].some(key => Object.hasOwn(wire, key)));
  }
  assert.ok(good.signals.every(signal => signal instanceof AbortSignal));
  assert.deepEqual(input, savedInput); assert.deepEqual(result, savedResult);
  assert.equal(reply.bundle.writes, 'disabled'); assert.equal(reply.bundle.semanticTruth, 'not_certified');
  pass('实际显式v2工厂0初始化→2 mock dispatch→机械canonical v1→原独立review/proof，原source与写入边界不变');

  const legacy = mock({ legacyInV2: true }), draftDiagnostics: SourcePropositionBuildDiagnostic[] = [];
  const legacyReply = await buildSourcePropositions(input, result, legacy.model, { onDiagnostic: value => {
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.modelRequests)); draftDiagnostics.push(clone(value));
  } });
  assert.ok(legacyReply.status === 'held'); assert.deepEqual(legacyReply.reasons, ['source_proposition_draft_invalid']);
  counts(legacyReply, 1, 0); assert.equal(legacy.requests.length, 1);
  assert.deepEqual(draftDiagnostics, [{ stage: 'draft_protocol', code: 'source_proposition_draft_invalid',
    modelRequests: { draft: 1, review: 0, total: 1, limit: 2 } }]);
  pass('显式v2收到旧v1只1次真实caller并held draft_invalid，无legacy fallback或审核/重试');

  for (const editSelection of [
    (value: SourcePropositionSelection) => { value.anchors.pop(); },
    (value: SourcePropositionSelection) => { value.anchors[0].parentChoiceId = 'PC9999'; },
    (value: SourcePropositionSelection) => { value.anchors.push(clone(value.anchors[0])); },
    (value: SourcePropositionSelection) => { value.contextHash = 'a'.repeat(64); },
    (value: SourcePropositionSelection) => { (value.anchors[0] as unknown as Record<string, unknown>).nodeId = 'N999'; },
  ]) {
    const candidate = mock({ editSelection }), out = await buildSourcePropositions(input, result, candidate.model);
    assert.ok(out.status === 'held'); assert.deepEqual(out.reasons, ['source_proposition_draft_invalid']);
    counts(out, 1, 0); assert.equal(candidate.requests.length, 1);
  }
  pass('漏节点/未知PC/重复候选/错context hash/额外归属字段在第二caller前held，不补数据');

  const repeated = await repeatedFixture('合成父句含蓝印又含蓝印，只用于检验歧义。');
  const ambiguous = mock({ editSelection: value => { value.anchors[0].text = '蓝印'; } });
  const ambiguousReply = await buildSourcePropositions(repeated.input, repeated.result, ambiguous.model);
  assert.ok(ambiguousReply.status === 'held'); assert.deepEqual(ambiguousReply.reasons, ['source_proposition_draft_invalid']);
  counts(ambiguousReply, 1, 0); assert.equal(ambiguous.requests.length, 1);
  pass('同父原话重复出现无法唯一定位：只1caller held，不猜第一处或让模型回填坐标');

  for (const decision of ['unknown', 'reject'] as const) {
    const candidate = mock({ editReview: value => { value.anchors[0].decision = decision; } });
    const diagnostics: SourcePropositionBuildDiagnostic[] = [];
    const out = await buildSourcePropositions(input, result, candidate.model, { onDiagnostic: value => { diagnostics.push(clone(value)); } });
    assert.ok(out.status === 'held'); assert.deepEqual(out.reasons, ['source_proposition_review_held']);
    counts(out, 1, 1); assert.equal(candidate.requests.length, 2);
    assert.deepEqual(diagnostics, [{ stage: 'review_protocol', code: 'source_proposition_review_held',
      modelRequests: { draft: 1, review: 1, total: 2, limit: 2 } }]);
  }
  const malformedReview = mock({ editReview: value => { (value as unknown as Record<string, unknown>).parentChoices = []; } });
  const malformedOut = await buildSourcePropositions(input, result, malformedReview.model);
  assert.ok(malformedOut.status === 'held'); assert.deepEqual(malformedOut.reasons, ['source_proposition_review_held']); counts(malformedOut, 1, 1);
  pass('v2候选机械合法不默认通过：原review unknown/reject/额外字段仍2caller整体held');

  let observed = 0;
  const brokenObserver = mock({ legacyInV2: true });
  const observerReply = await buildSourcePropositions(input, result, brokenObserver.model, { onDiagnostic: () => {
    observed++; throw new Error('OBSERVER_PRIVATE_SECRET');
  } });
  assert.deepEqual(observerReply, legacyReply); assert.equal(observed, 1); assert.equal(brokenObserver.requests.length, 1);
  assert.ok(!JSON.stringify(observerReply).includes('SECRET'));
  pass('host-only诊断v2解码为draft_protocol、审核held为review_protocol；observer抛错不改held或计数、不泄露raw');

  let legacyCalls = 0;
  const defaultFactory = createSourcePropositionBuildModel(async request => {
    legacyCalls++; const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') { assert.equal(request.systemPrompt, SOURCE_PROPOSITION_DRAFT_PROMPT);
      assert.ok(!Object.hasOwn(wire, 'parentChoices')); return JSON.stringify(legacyDraft(wire.reference, wire.contextHash)); }
    return JSON.stringify(votes(wire));
  });
  const defaultReply = await buildSourcePropositions(input, result, defaultFactory);
  assert.equal(defaultReply.status, 'ready'); counts(defaultReply, 1, 1); assert.equal(legacyCalls, 2);
  assert.throws(() => createSourcePropositionBuildModel(async () => '{}', { draftProtocol: 'auto' } as unknown as SourcePropositionBuildModelOptions), /source_proposition_protocol_invalid/u);
  pass('默认legacy工厂仍使用原请求/原protocol且2caller可用，非法模式不自动选择回退');

  const large = await repeatedFixture(`合成头部${'甲'.repeat(62)}，${'乙'.repeat(62)}，${'丙'.repeat(62)}。`, 64);
  const menu = buildSourcePropositionSelectionParentChoices(large.context);
  assert.ok(menu.length > 96); assert.ok(JSON.stringify(large.context).length <= SOURCE_PROPOSITION_LIMITS.context);
  const oversizedBody = { version: 2, protocol: 'review-source-proposition-selection-input-v2', contextHash: await argumentContextHash(large.context),
    parentChoices: menu, reference: large.context };
  assert.ok(SOURCE_PROPOSITION_SELECTION_PROMPT.length + JSON.stringify(oversizedBody).length > SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT);
  const over = mock();
  assert.throws(() => over.model.prepareDraft!(large.context, oversizedBody.contextHash), /source_proposition_request_budget/u);
  assert.equal(over.requests.length, 0);
  const overReply = await buildSourcePropositions(large.input, large.result, over.model);
  assert.ok(overReply.status === 'held'); assert.deepEqual(overReply.reasons, ['source_proposition_request_invalid']);
  counts(overReply, 0, 0); assert.equal(over.requests.length, 0);
  pass('真实完整context+完整owned菜单超96k：同步预检抛budget，实际builder held且0caller/0计数，不截前缀');

  for (const when of [1, 2, 3]) {
    const candidate = mock(); let reads = 0;
    const out = await buildSourcePropositions(input, result, candidate.model, { assertCurrent: async () => {
      if (++reads === when) throw new Error('PRIVATE_HOST_PATH_SECRET');
    } });
    assert.ok(out.status === 'held'); assert.deepEqual(out.reasons, ['source_proposition_source_changed']);
    counts(out, when === 1 ? 0 : 1, when === 3 ? 1 : 0); assert.equal(candidate.requests.length, when - 1);
    assert.ok(!JSON.stringify(out).includes('SECRET'));
  }
  pass('host前/中/后回核失败按0/1/2次真实dispatch held，无stale ready、路径泄露或重试');

  let capturedCalls = 0, lateCalls = 0, reads = 0;
  let selectedRaw: SourcePropositionSelection | undefined, reviewedRaw: SourcePropositionReview | undefined;
  const options: SourcePropositionBuildModelOptions = { draftProtocol: 'owned-parent-text-v2' };
  const capturedFactory = createSourcePropositionBuildModel(async request => {
    capturedCalls++; const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') { selectedRaw = selected(wire); return selectedRaw; }
    reviewedRaw = votes(wire); return reviewedRaw;
  }, options);
  options.draftProtocol = 'legacy-v1';
  const mutableInput = clone(input), mutableResult = clone(result);
  const builderOptions: SourcePropositionBuildOptions = { assertCurrent: async () => {
    if (++reads === 1) {
      mutableInput.canonicalText = '迟改原文'; mutableResult.status = 'reviewed_partial';
      capturedFactory.draft = async () => { lateCalls++; throw new Error('LATE_CALLER_SECRET'); };
      capturedFactory.review = async () => { lateCalls++; throw new Error('LATE_CALLER_SECRET'); };
      capturedFactory.prepareDraft = () => { lateCalls++; throw new Error('LATE_HOOK_SECRET'); };
      capturedFactory.prepareReview = () => { lateCalls++; throw new Error('LATE_HOOK_SECRET'); };
      builderOptions.assertCurrent = async () => { lateCalls++; throw new Error('LATE_HOST_SECRET'); };
      builderOptions.timeoutMs = 1;
    }
    if (reads === 2) selectedRaw!.anchors[0].text = '迟改模型选择';
    if (reads === 3) reviewedRaw!.anchors[0].decision = 'unknown';
  } };
  const capturedOut = await buildSourcePropositions(mutableInput, mutableResult, capturedFactory, builderOptions);
  assert.ok(capturedOut.status === 'ready', JSON.stringify(capturedOut)); counts(capturedOut, 1, 1);
  assert.equal(capturedCalls, 2); assert.equal(lateCalls, 0); assert.equal(reads, 3);
  assert.deepEqual(capturedOut.proof.input, savedInput); assert.deepEqual(capturedOut.proof.result, savedResult);
  assert.notEqual(capturedOut.proof.draft.anchors[0].text, '迟改模型选择'); assert.equal(capturedOut.proof.review.anchors[0].decision, 'accept');
  pass('首await前捕获input/result/model hooks/options，工厂mode先固定；选择与审核proof隔离迟改');

  const beforeAbort = new AbortController(); beforeAbort.abort();
  const never = mock(), preAborted = await buildSourcePropositions(input, result, never.model, { signal: beforeAbort.signal });
  assert.ok(preAborted.status === 'held'); assert.deepEqual(preAborted.reasons, ['source_proposition_aborted']); counts(preAborted, 0, 0);
  assert.equal(never.requests.length, 0);
  const cancel = new AbortController(); let cancelledCalls = 0, forwarded: AbortSignal | undefined;
  let resolveLate!: (value: SourcePropositionSelection) => void, lateSelection: SourcePropositionSelection | undefined;
  const cancellable = createSourcePropositionBuildModel(async (request, signal) => {
    cancelledCalls++; assert.equal(request.stage, 'extract'); forwarded = signal;
    lateSelection = selected(JSON.parse(request.userInput)); cancel.abort();
    return new Promise<SourcePropositionSelection>(resolve => { resolveLate = resolve; });
  }, { draftProtocol: 'owned-parent-text-v2' });
  const cancelled = await buildSourcePropositions(input, result, cancellable, { signal: cancel.signal });
  assert.ok(cancelled.status === 'held'); assert.deepEqual(cancelled.reasons, ['source_proposition_aborted']); counts(cancelled, 1, 0);
  assert.equal(forwarded?.aborted, true); resolveLate(lateSelection!);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelledCalls, 1);
  pass('预取消0caller；draft等待中取消转发signal，迟到合法选择不触发review或ready');

  let timeoutCalls = 0, timeoutSignal: AbortSignal | undefined;
  const timed = createSourcePropositionBuildModel(async (_request, signal) => {
    timeoutCalls++; timeoutSignal = signal; return new Promise(() => {});
  }, { draftProtocol: 'owned-parent-text-v2' });
  const timedReply = await buildSourcePropositions(input, result, timed, { timeoutMs: 2 });
  assert.ok(timedReply.status === 'held'); assert.deepEqual(timedReply.reasons, ['source_proposition_timeout']);
  counts(timedReply, 1, 0); assert.equal(timeoutCalls, 1); assert.equal(timeoutSignal?.aborted, true);
  pass('v2实际caller超时只有1次尝试，受控held并取消signal，不补发或进入审核');

  let exceptionCalls = 0;
  const exception = createSourcePropositionBuildModel(async () => { exceptionCalls++; throw new Error('MODEL_RESPONSE_PRIVATE_SECRET'); },
    { draftProtocol: 'owned-parent-text-v2' });
  const transportDiagnostics: SourcePropositionBuildDiagnostic[] = [];
  const exceptionReply = await buildSourcePropositions(input, result, exception, { onDiagnostic: value => { transportDiagnostics.push(clone(value)); } });
  assert.ok(exceptionReply.status === 'held'); assert.deepEqual(exceptionReply.reasons, ['source_proposition_model_unavailable']);
  counts(exceptionReply, 1, 0); assert.equal(exceptionCalls, 1); assert.ok(!JSON.stringify(exceptionReply).includes('SECRET'));
  assert.deepEqual(transportDiagnostics, [{ stage: 'draft_model', code: 'source_proposition_model_unavailable',
    modelRequests: { draft: 1, review: 0, total: 1, limit: 2 } }]);
  pass('真实caller异常不同于v2解码失败，受控model_unavailable，不暴露响应内容或重试');
  console.log(`PASS ${groups} source proposition selection build groups; fixed synthetic votes, 0 network, `
    + '0 private configuration or real vault reads, no model improvement or production write claim.');
} finally { globalThis.fetch = oldFetch; }
