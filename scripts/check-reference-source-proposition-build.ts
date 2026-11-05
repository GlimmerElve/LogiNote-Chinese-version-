import assert from 'node:assert/strict';
import vm from 'node:vm';
import { argumentProjectionBuildFixture } from './argument-projection-build-fixture.ts';
import { finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareSourcePropositionContext, validateSourcePropositions, SOURCE_PROPOSITION_LIMITS,
  type SourcePropositionContext, type SourcePropositionDraft, type SourcePropositionReviewInput,
  type SourcePropositionReview } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { buildSourcePropositions, createSourcePropositionBuildModel, SOURCE_PROPOSITION_DRAFT_PROMPT,
  SOURCE_PROPOSITION_REVIEW_PROMPT, SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT,
  type SourcePropositionBuildModel, type SourcePropositionBuildOptions } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import type { ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Source proposition build checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const clone = <T>(value: T): T => structuredClone(value);
function count(reply: Awaited<ReturnType<typeof buildSourcePropositions>>, draft: number, review: number) {
  assert.deepEqual(reply.modelRequests, { draft, review, total: draft + review, limit: 2 });
}
async function draftFor(context: SourcePropositionContext): Promise<SourcePropositionDraft> {
  // Fixture author chooses original node evidence, not production lexical or
  // semantic extraction. Test votes measure contract plumbing, not accuracy.
  return { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
    anchors: context.projection.nodes.map((node, index) => {
      const span = node.evidence[0], quote = context.quotes.find(quote => quote.evidence.start <= span.start && quote.evidence.end >= span.end
        && quote.evidence.sentenceId === span.sentenceId && quote.evidence.quote.slice(span.start - quote.evidence.start, span.end - quote.evidence.start) === span.quote)!;
      assert.ok(quote);
      return { id: `P${index + 1}`, nodeId: node.id, quoteId: quote.quoteId, start: span.start, end: span.end, text: span.quote };
    }) };
}
function reviewFor(input: SourcePropositionReviewInput): SourcePropositionReview {
  return { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: input.reviewId,
    contextHash: input.contextHash, draftHash: input.draftHash,
    anchors: input.draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept', roleSupported: true,
      completeMeaning: true, scopePreserved: true, reason: 'Synthetic fixed independent-request test vote, not semantic accuracy.' })) };
}
function model(changeDraft?: (draft: SourcePropositionDraft) => void, changeReview?: (review: SourcePropositionReview) => void) {
  let calls = 0;
  const api: SourcePropositionBuildModel = {
    draft: async context => { calls++; const draft = await draftFor(context); changeDraft?.(draft); return draft; },
    review: async input => { calls++; const review = reviewFor(input); changeReview?.(review); return review; },
  };
  return { api, calls: () => calls };
}
try {
  const fixture = await argumentProjectionBuildFixture();
  const input = fixture.input, result = await finalizeArgumentProjectionBuild(input, fixture.draft, fixture.review);
  assert.equal(result.status, 'reviewed_complete');
  const beforeInput = clone(input), beforeResult = clone(result);
  const context = await prepareSourcePropositionContext(input, result);
  let factoryCalls = 0;
  const requests: ArgumentProjectionModelRequest[] = [], requestSignals: (AbortSignal | undefined)[] = [];
  const factory = createSourcePropositionBuildModel(async (request, signal) => {
    factoryCalls++; requests.push(clone(request)); requestSignals.push(signal);
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
    const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') {
      assert.equal(wire.contextHash, await argumentContextHash(wire.reference));
      assert.deepEqual(wire.reference, context);
      return JSON.stringify(await draftFor(wire.reference));
    }
    assert.equal(request.stage, 'review');
    const reviewInput = wire as SourcePropositionReviewInput;
    assert.deepEqual(reviewInput.reference, context);
    assert.ok(!Object.hasOwn(reviewInput, 'review') && !Object.hasOwn(reviewInput.draft, 'review'));
    return JSON.stringify(reviewFor(reviewInput));
  });
  assert.equal(factoryCalls, 0);
  pass('纯source context准备和显式factory创建均0调用，不读配置/vault/网络');

  let currentReads = 0;
  const built = await buildSourcePropositions(input, result, factory, { assertCurrent: async () => { currentReads++; } });
  assert.equal(built.status, 'ready', JSON.stringify(built)); assert.ok(built.status === 'ready');
  count(built, 1, 1); assert.equal(factoryCalls, 2); assert.equal(currentReads, 3);
  assert.deepEqual(requests.map(request => request.stage), ['extract', 'review']);
  assert.equal(requests[0].systemPrompt, SOURCE_PROPOSITION_DRAFT_PROMPT); assert.equal(requests[1].systemPrompt, SOURCE_PROPOSITION_REVIEW_PROMPT);
  assert.ok(requestSignals.every(signal => signal instanceof AbortSignal));
  assert.equal(built.bundle.semanticTruth, 'not_certified'); assert.equal(built.bundle.writes, 'disabled');
  assert.deepEqual(input, beforeInput); assert.deepEqual(result, beforeResult);
  assert.equal((await validateSourcePropositions(input, result, built.bundle, { draft: built.proof.draft, review: built.proof.review })).status, 'ready');
  for (const wire of requests.map(request => JSON.parse(request.userInput))) {
    assert.equal(Object.hasOwn(wire, 'answer'), false); assert.equal(Object.hasOwn(wire, 'question'), false);
    assert.equal(Object.hasOwn(wire, 'profile'), false); assert.equal(Object.hasOwn(wire, 'personal'), false);
  }
  pass('真实prompt/request双调用→原坐标严格准备→独立审核→proof重建，前中后三次host回核且不改原输出');

  const absent = await buildSourcePropositions(input, result);
  assert.ok(absent.status === 'held');
  assert.deepEqual(absent.reasons, ['explicit_source_proposition_model_required']); count(absent, 0, 0);
  assert.throws(() => createSourcePropositionBuildModel(undefined as never), /source_proposition_caller_required/u);
  pass('无显式model/caller不自动选择LLM，空入口0请求');

  for (const mutate of [
    (draft: SourcePropositionDraft) => { draft.anchors[0].start++; draft.anchors[0].end++; },
    (draft: SourcePropositionDraft) => { draft.contextHash = 'a'.repeat(64); },
    (draft: SourcePropositionDraft) => { draft.anchors[0].quoteId = 'Q999'; },
    (draft: SourcePropositionDraft) => { draft.anchors[0].text = '不是原话'; },
    (draft: SourcePropositionDraft) => { draft.anchors.pop(); },
    (draft: SourcePropositionDraft) => { (draft as any).selfReview = true; },
  ]) {
    const candidate = model(mutate), reply = await buildSourcePropositions(input, result, candidate.api);
    assert.equal(reply.status, 'held'); count(reply, 1, 0); assert.equal(candidate.calls(), 1);
  }
  pass('错坐标/binding/Q/改写/漏节点/额外字段在第二请求前held，不修稿或重试');

  for (const decision of ['reject', 'unknown'] as const) {
    const candidate = model(undefined, review => { review.anchors[0].decision = decision; });
    const reply = await buildSourcePropositions(input, result, candidate.api);
    assert.equal(reply.status, 'held'); count(reply, 1, 1); assert.equal(candidate.calls(), 2);
  }
  for (const field of ['roleSupported', 'completeMeaning', 'scopePreserved'] as const) {
    const candidate = model(undefined, review => { review.anchors[0][field] = false; });
    const reply = await buildSourcePropositions(input, result, candidate.api);
    assert.equal(reply.status, 'held'); count(reply, 1, 1);
  }
  pass('任一独立审核reject/unknown/必要flag false整体held，不静默删除候选');

  for (const mutate of [
    (review: SourcePropositionReview) => { review.reviewId = 'unrelated-review'; },
    (review: SourcePropositionReview) => { review.draftHash = 'b'.repeat(64); },
    (review: SourcePropositionReview) => { review.contextHash = 'c'.repeat(64); },
    (review: SourcePropositionReview) => { review.anchors.pop(); },
    (review: SourcePropositionReview) => { (review as any).score = 100; },
    (review: SourcePropositionReview) => { Object.defineProperty(review, 'hiddenApproval', { value: true }); },
  ]) {
    const candidate = model(undefined, mutate), reply = await buildSourcePropositions(input, result, candidate.api);
    assert.equal(reply.status, 'held'); count(reply, 1, 1);
  }
  pass('审核ID/hash/漏票/多余字段/hidden字段严格held，clone不擦除原closed协议违规');

  for (const raw of ['```json\n{}\n```', '{"unfinished":', ' '.repeat(SOURCE_PROPOSITION_LIMITS.draft + 1)]) {
    let calls = 0;
    const candidate: SourcePropositionBuildModel = { draft: async () => { calls++; return raw; }, review: async () => { calls++; assert.fail('Must not retry or review bad JSON'); } };
    const reply = await buildSourcePropositions(input, result, candidate);
    assert.equal(reply.status, 'held'); count(reply, 1, 0); assert.equal(calls, 1);
  }
  pass('raw JSON不修复Markdown/截断/超预算响应，不做第二调用');

  for (const when of [1, 2, 3]) {
    const candidate = model(); let reads = 0;
    const reply = await buildSourcePropositions(input, result, candidate.api, { assertCurrent: async () => {
      if (++reads === when) throw new Error('SOURCE_PATH_SECRET');
    } });
    assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_proposition_source_changed']);
    count(reply, when === 1 ? 0 : 1, when === 3 ? 1 : 0);
    assert.equal(candidate.calls(), when - 1); assert.ok(!JSON.stringify(reply).includes('SECRET'));
  }
  pass('host调用前/中/后独立源回核任一失败均held，禁止stale ready及异常路径文本外泄');

  const aborted = new AbortController(); aborted.abort();
  const never = model(), abortedReply = await buildSourcePropositions(input, result, never.api, { signal: aborted.signal });
  assert.ok(abortedReply.status === 'held');
  assert.deepEqual(abortedReply.reasons, ['source_proposition_aborted']); count(abortedReply, 0, 0); assert.equal(never.calls(), 0);
  pass('预先取消0请求，不触发source/model准备');

  const controller = new AbortController(); let forwarded: AbortSignal | undefined;
  const cancelModel: SourcePropositionBuildModel = { draft: async (_, signal) => {
    forwarded = signal; controller.abort(); return new Promise(() => {});
  }, review: async () => assert.fail('Cancelled draft cannot trigger review') };
  const cancelledReply = await buildSourcePropositions(input, result, cancelModel, { signal: controller.signal });
  assert.ok(cancelledReply.status === 'held');
  assert.deepEqual(cancelledReply.reasons, ['source_proposition_aborted']); count(cancelledReply, 1, 0); assert.equal(forwarded?.aborted, true);
  pass('stage等待中取消转发AbortSignal，仅1次尝试、无review/迟到写入');

  let timeoutSignal: AbortSignal | undefined;
  const timed: SourcePropositionBuildModel = { draft: async (_, signal) => { timeoutSignal = signal; return new Promise(() => {}); },
    review: async () => assert.fail('Timeout cannot trigger review') };
  const timedReply = await buildSourcePropositions(input, result, timed, { timeoutMs: 2 });
  assert.ok(timedReply.status === 'held');
  assert.deepEqual(timedReply.reasons, ['source_proposition_timeout']); count(timedReply, 1, 0); assert.equal(timeoutSignal?.aborted, true);
  const timedCurrent = model(), currentTimedReply = await buildSourcePropositions(input, result, timedCurrent.api,
    { readTimeoutMs: 2, assertCurrent: async () => new Promise(() => {}) });
  assert.ok(currentTimedReply.status === 'held');
  assert.deepEqual(currentTimedReply.reasons, ['source_proposition_timeout']); count(currentTimedReply, 0, 0); assert.equal(timedCurrent.calls(), 0);
  pass('模型和assertCurrent分别bounded timeout，不因宿主读取挂起而无限阻塞');

  let retainedContext: SourcePropositionContext | undefined, rawReturnedDraft: SourcePropositionDraft | undefined, rawReturnedReview: SourcePropositionReview | undefined;
  let mutableDraftCalls = 0, replacementCalls = 0;
  const changing: SourcePropositionBuildModel = { draft: async value => {
    mutableDraftCalls++; retainedContext = value; rawReturnedDraft = await draftFor(value); return rawReturnedDraft;
  }, review: async value => {
    rawReturnedReview = reviewFor(value); return rawReturnedReview;
  } };
  let mutationReads = 0;
  const mutableInput = clone(input), mutableResult = clone(result);
  const changingOptions: SourcePropositionBuildOptions = { timeoutMs: 30000, assertCurrent: async () => {
    if (++mutationReads === 1) {
      mutableInput.canonicalText = 'Caller迟改'; mutableResult.status = 'reviewed_partial';
      changing.draft = async () => { replacementCalls++; throw new Error('late method'); };
      changing.review = async () => { replacementCalls++; throw new Error('late method'); };
      changingOptions.assertCurrent = async () => { throw new Error('late checker'); };
      changingOptions.timeoutMs = 1;
    }
    if (mutationReads === 2) {
      retainedContext!.canonicalText = 'Model迟改context'; rawReturnedDraft!.anchors[0].text = 'Model迟改draft';
    }
    if (mutationReads === 3) rawReturnedReview!.anchors[0].decision = 'reject';
  } };
  const capturedReply = await buildSourcePropositions(mutableInput, mutableResult, changing, changingOptions);
  assert.equal(capturedReply.status, 'ready'); assert.ok(capturedReply.status === 'ready');
  assert.equal(mutableDraftCalls, 1); assert.equal(replacementCalls, 0); assert.equal(mutationReads, 3); count(capturedReply, 1, 1);
  assert.deepEqual(capturedReply.proof.input, beforeInput); assert.deepEqual(capturedReply.proof.result, beforeResult);
  assert.notEqual(capturedReply.proof.draft.anchors[0].text, 'Model迟改draft');
  assert.equal(capturedReply.proof.review.anchors[0].decision, 'accept');
  pass('首await前固定input/result/model/options；传给model及保存proof快照隔离迟改');

  for (const stage of ['draft', 'review'] as const) {
    const candidate: SourcePropositionBuildModel = { draft: async value => {
      if (stage === 'draft') throw new Error('MODEL_SECRET_TEXT'); return draftFor(value);
    }, review: async () => { throw new Error('MODEL_SECRET_TEXT'); } };
    const reply = await buildSourcePropositions(input, result, candidate);
    assert.equal(reply.status, 'held'); assert.ok(!JSON.stringify(reply).includes('SECRET'));
    count(reply, 1, stage === 'review' ? 1 : 0);
  }
  pass('显式caller/模型异常仅受控reason，不泄露prompt/path/key/model文本，不重试');

  const poisoned = clone(input); (poisoned as any).questionText = '不可带入题目';
  const poisonedModel = model(), poisonedReply = await buildSourcePropositions(poisoned, result, poisonedModel.api);
  assert.equal(poisonedReply.status, 'held'); count(poisonedReply, 0, 0); assert.equal(poisonedModel.calls(), 0);
  const oversizedModel = model(), oversized = clone(input); oversized.canonicalText = '甲'.repeat(SOURCE_PROPOSITION_LIMITS.context + 1);
  const oversizedReply = await buildSourcePropositions(oversized, result, oversizedModel.api);
  assert.equal(oversizedReply.status, 'held'); count(oversizedReply, 0, 0); assert.equal(oversizedModel.calls(), 0);
  pass('题目额外字段/整包超限在模型前held，不截前缀或污染source-only输入');

  // These deliberately minimal DTOs probe transport budget only; they are NOT
  // semantic/source proofs. A valid pipeline input is independently tested below.
  let budgetCalls = 0;
  const budgetFactory = createSourcePropositionBuildModel(async request => {
    budgetCalls++; assert.ok(request.systemPrompt.length + request.userInput.length <= SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT);
    return '{}';
  });
  const reviewProbe = { reviewId: 'synthetic-budget-probe', padding: '' };
  const overhead = JSON.stringify(reviewProbe).length;
  reviewProbe.padding = '甲'.repeat(SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT - SOURCE_PROPOSITION_REVIEW_PROMPT.length - overhead);
  assert.equal(SOURCE_PROPOSITION_REVIEW_PROMPT.length + JSON.stringify(reviewProbe).length, SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT);
  const exactRequest = budgetFactory.prepareReview!(reviewProbe as unknown as SourcePropositionReviewInput);
  assert.equal(budgetCalls, 0); await exactRequest.dispatch(); assert.equal(budgetCalls, 1);
  assert.throws(() => exactRequest.dispatch(), /source_proposition_already_dispatched/u); assert.equal(budgetCalls, 1);
  reviewProbe.padding += '甲';
  assert.throws(() => budgetFactory.prepareReview!(reviewProbe as unknown as SourcePropositionReviewInput), /source_proposition_request_budget/u);
  reviewProbe.padding = '甲'.repeat(SOURCE_PROPOSITION_LIMITS.reviewInput - overhead);
  assert.equal(JSON.stringify(reviewProbe).length, SOURCE_PROPOSITION_LIMITS.reviewInput);
  assert.throws(() => budgetFactory.prepareReview!(reviewProbe as unknown as SourcePropositionReviewInput), /source_proposition_request_budget/u);
  const cyclicProbe: Record<string, unknown> = { reviewId: 'synthetic-cycle-probe' }; cyclicProbe.self = cyclicProbe;
  assert.throws(() => budgetFactory.prepareReview!(cyclicProbe as unknown as SourcePropositionReviewInput));
  assert.equal(budgetCalls, 1);
  pass('system+user恰好整包上限可发一次，+1/仅user达reviewInput上限/循环序列化均0新增调用，不截断');

  for (const stage of ['draft', 'review'] as const) {
    let actualCalls = 0;
    const stagedFactory = createSourcePropositionBuildModel(async request => {
      actualCalls++;
      const wire = JSON.parse(request.userInput);
      return request.stage === 'extract' ? draftFor(wire.reference) : reviewFor(wire);
    });
    const candidate: SourcePropositionBuildModel = { ...stagedFactory };
    if (stage === 'draft') candidate.prepareDraft = (source, hash) => stagedFactory.prepareDraft!(
      { ...source, padding: '甲'.repeat(SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT) } as SourcePropositionContext, hash);
    else candidate.prepareReview = reviewInput => stagedFactory.prepareReview!(
      { ...reviewInput, padding: '甲'.repeat(SOURCE_PROPOSITION_MODEL_REQUEST_LIMIT) } as SourcePropositionReviewInput);
    const reply = await buildSourcePropositions(input, result, candidate);
    assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_proposition_request_invalid']);
    count(reply, stage === 'draft' ? 0 : 1, 0); assert.equal(actualCalls, stage === 'draft' ? 0 : 1);
  }
  let serializationCalls = 0;
  const serializationFactory = createSourcePropositionBuildModel(async request => {
    serializationCalls++; return draftFor(JSON.parse(request.userInput).reference);
  });
  const serializationReply = await buildSourcePropositions(input, result, { ...serializationFactory,
    prepareReview: value => { const cycle = { ...value } as SourcePropositionReviewInput & { cycle?: unknown }; cycle.cycle = cycle;
      return serializationFactory.prepareReview!(cycle); } });
  assert.ok(serializationReply.status === 'held'); assert.deepEqual(serializationReply.reasons, ['source_proposition_request_invalid']);
  count(serializationReply, 1, 0); assert.equal(serializationCalls, 1);
  pass('真实pipeline预检预算/序列化失败不计虚构draft/review，实际caller数量与modelRequests一致');

  for (const stage of ['draft', 'review'] as const) for (const foreign of [
    () => undefined, () => ({}), () => () => ({}), () => Promise.resolve({}), () => Promise.reject(new Error('ASYNC_SECRET')),
  ]) {
    const candidate = model();
    if (stage === 'draft') candidate.api.prepareDraft = foreign as SourcePropositionBuildModel['prepareDraft'];
    else candidate.api.prepareReview = foreign as SourcePropositionBuildModel['prepareReview'];
    const reply = await buildSourcePropositions(input, result, candidate.api);
    assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_proposition_request_invalid']);
    count(reply, stage === 'draft' ? 0 : 1, 0); assert.equal(candidate.calls(), stage === 'draft' ? 0 : 1);
    assert.ok(!JSON.stringify(reply).includes('SECRET'));
  }
  pass('同步preflight拒Promise/函数/陌生对象/空返回，不等待隐藏异步或计虚构请求');

  const unhandled: unknown[] = [], observe = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    for (const stage of ['draft', 'review'] as const) {
      const candidate = model();
      const foreign = () => {
        const promise = vm.runInNewContext('Promise.reject(new Error("CROSS_REALM_SECRET"))');
        assert.equal(promise instanceof Promise, false); return promise;
      };
      if (stage === 'draft') candidate.api.prepareDraft = foreign;
      else candidate.api.prepareReview = foreign;
      const reply = await buildSourcePropositions(input, result, candidate.api);
      assert.ok(reply.status === 'held'); assert.deepEqual(reply.reasons, ['source_proposition_request_invalid']);
      count(reply, stage === 'draft' ? 0 : 1, 0);
    }
    let thenReads = 0;
    const candidate = model(); candidate.api.prepareDraft = (() => Object.defineProperty({}, 'then', {
      get: () => { thenReads++; throw new Error('THENABLE_SECRET'); },
    })) as unknown as SourcePropositionBuildModel['prepareDraft'];
    assert.equal((await buildSourcePropositions(input, result, candidate.api)).status, 'held');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(thenReads, 0); assert.equal(unhandled.length, 0); assert.equal(candidate.calls(), 0);
  } finally { process.off('unhandledRejection', observe); }
  pass('跨realm拒绝Promise仍held且无未处理拒绝，不执行陌生thenable getter或伪计请求');

  let capturedFactoryCalls = 0, replacedHooks = 0;
  const capturedFactory = createSourcePropositionBuildModel(async request => {
    capturedFactoryCalls++;
    const wire = JSON.parse(request.userInput);
    return request.stage === 'extract' ? draftFor(wire.reference) : reviewFor(wire);
  });
  const capturedHooksReply = await buildSourcePropositions(input, result, capturedFactory, { assertCurrent: async () => {
    capturedFactory.prepareDraft = () => { replacedHooks++; throw new Error('LATE_SECRET'); };
    capturedFactory.prepareReview = () => { replacedHooks++; throw new Error('LATE_SECRET'); };
  } });
  assert.equal(capturedHooksReply.status, 'ready'); count(capturedHooksReply, 1, 1);
  assert.equal(capturedFactoryCalls, 2); assert.equal(replacedHooks, 0);
  pass('prepare hooks也在首await前捕获，host中途替换不能改换预检/dispatch');

  console.log(`PASS ${checks} source proposition build groups; synthetic protocol witnesses and 2-call mock factory only; 0 network, 0 real data, 0 production writes`);
} finally { globalThis.fetch = previousFetch; }
