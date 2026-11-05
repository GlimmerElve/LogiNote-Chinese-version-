import assert from 'node:assert/strict';
import { createSceneLiveDispatchBudget } from './scene-semantic-live-budget';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { runSceneSemanticValidation, type SceneSemanticLimits } from './scene-semantic-live-runner';
import { understandingFixture } from './scene-semantic-fixture';
globalThis.fetch = async () => assert.fail('Runner checks cannot use a network');
const limits: SceneSemanticLimits = { maxCalls: 24, maxOutputTokensTotal: 48000, maxOutputTokensPerCall: 3072, maxInputChars: 48000, timeoutMs: 360000, requestTimeoutMs: 45000 };
let calls = 0, currentSource = '';
const invoke = async (request: LlmCallRequest): Promise<LlmCallResponse> => {
  calls++; assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  assert.ok(request.maxTokensOverride! <= 3072); assert.ok(JSON.stringify(request).length <= 48000);
  let data: any; try { data = JSON.parse(request.userInput); } catch { /* Responder context is plain text. */ }
  const usage = { promptTokens: 10, completionTokens: 20 }, result = (value: unknown) => ({ usage, content: JSON.stringify(value) });
  if (data?.phase === 'semantic-judge') return result({ checks: data.cases.map((c: any) => ({ id: c.id, verdict: 'met', evidence: c.actualEvidence.slice(0, 30), reason: 'Mock judge only.' })) });
  if (data?.phase === 'understand') {
    currentSource = data.latestUserInput.sourceId;
    return result({ action: data.latestInputKind === 'response' ? 'advance' : 'respond', understanding: understandingFixture(currentSource, data.latestUserInput.text, {
      intent: currentSource.startsWith('summary-end-') ? 'end' : data.latestInputKind === 'response' ? 'answer' : 'help',
      informationGaps: currentSource.startsWith('answer-') ? [{ id: 'ratio', kind: 'reference-material', description: 'Read synthetic ratio data' }] : [],
    }) });
  }
  if (data?.phase === 'plan') return result({ action: 'advance', toolRequests: [{ id: 'knowledge-notes', query: '比例', needId: 'ratio', reason: 'Synthetic reference' }] });
  if (currentSource === 'answer-user-0' || currentSource === 'next-harder-user-1') {
    const harder = currentSource.startsWith('next-harder'), id = harder ? 'harder-next' : 'normal-next';
    return result({ content: harder ? '答对了。50人中60%选择A，其中三分之一选择B。同时选择A和B有多少人？'
      : 'A不正确，应选B，40×60%=24人。新题50人中40%选择科普，多少人？',
      interaction: { id, type: 'single-choice', assessment: 'objective', required: true, options: [{ id: 'a', label: '10人' }, { id: 'b', label: '20人' }] },
      evaluation: { interactionId: id, type: 'single-choice', correctId: harder ? 'a' : 'b' } });
  }
  return result({ content: currentSource.startsWith('hint-') ? '先列总人数与比例的乘法，暂不求值。'
    : currentSource.startsWith('correction-') ? '占60%表示每100人中60人属于这一部分，不代表提交答案。'
    : currentSource.startsWith('next-harder-') ? '保留本题，下一题综合子群比例。' : '总结比例与分母关系，现在结束。' });
};
const full = await runSceneSemanticValidation({ invoke, limits });
assert.equal(full.stopped, undefined); assert.equal(full.passed, true); assert.equal(full.cases.length, 5);
assert.equal(full.cases.reduce((n,c) => n + c.steps.length, 0), 6);
assert.equal(full.budget.dispatchAttempts, calls); assert.equal(full.budget.reportedCompletionTokens, calls * 20);
assert.equal(full.budget.reservedOutputTokens, full.receipts.reduce((n,r) => n + r.maxOutputTokens, 0));
assert.ok(full.budget.reservedOutputTokens > full.budget.reportedCompletionTokens);
assert.equal(full.receipts.filter(r => r.phase === 'semantic-judge').length, 1);
let counted = 0;
const one = await runSceneSemanticValidation({ limits: { ...limits, maxCalls: 1 }, invoke: async r => { counted++; return invoke(r); } });
assert.equal(one.stopped, 'request-or-output-budget'); assert.equal(counted, 1);
for (const restricted of [{ ...limits, maxOutputTokensTotal: 3071 }, { ...limits, maxInputChars: 64 }]) {
  const zero = await runSceneSemanticValidation({ limits: restricted, invoke: async () => assert.fail('No dispatch allowed') });
  assert.ok(zero.stopped); assert.equal(zero.budget.dispatchAttempts, 0);
}
let failed = 0;
const transport = await runSceneSemanticValidation({ limits, invoke: async () => { failed++; throw new Error('HTTP 401 synthetic-private-key'); } });
assert.equal(failed, 1); assert.equal(transport.stopped, 'model-dispatch-failed'); assert.doesNotMatch(JSON.stringify(transport), /synthetic-private-key/);
const timed = await runSceneSemanticValidation({ limits: { ...limits, requestTimeoutMs: 5, timeoutMs: 50 },
  invoke: async (_r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })) });
assert.equal(timed.stopped, 'request-timeout'); assert.equal(timed.budget.dispatchAttempts, 1);
const abort = new AbortController(); abort.abort();
assert.equal((await runSceneSemanticValidation({ limits, signal: abort.signal, invoke: async () => assert.fail('Cancelled') })).budget.dispatchAttempts, 0);
await assert.rejects(runSceneSemanticValidation({ limits: { ...limits, maxCalls: 25 }, invoke }), /Invalid/);
console.log('Scene semantic runner offline checks passed: actual controller plumbing, six turns/five cases, one judge, immutable reservations, pre-dispatch caps, transport stop and abort. Not live semantic accuracy.');

const networkBudget = createSceneLiveDispatchBudget({ maxCalls: 18, maxOutputTokensTotal: 35712, maxOutputTokensPerCall: 3072 }, { calls: 6, outputTokensReserved: 12288 });
networkBudget.reserve('ipc',1536);networkBudget.reserve('http',1536);networkBudget.reserve('http',1536);
assert.deepEqual(networkBudget.snapshot().approvalUsage,{calls:8,outputTokensReserved:15360},'unexpected extra HTTP request consumes continuation authorization');
const oneNetwork = createSceneLiveDispatchBudget({ maxCalls:1,maxOutputTokensTotal:3072,maxOutputTokensPerCall:3072 });
oneNetwork.reserve('ipc',3072);oneNetwork.reserve('http',3072);
assert.throws(()=>oneNetwork.reserve('http',3072),/BUDGET/);
assert.equal(oneNetwork.snapshot().fetchCalls,1);
assert.throws(()=>createSceneLiveDispatchBudget(limits,{calls:1,outputTokensReserved:0}),/APPROVAL/);
