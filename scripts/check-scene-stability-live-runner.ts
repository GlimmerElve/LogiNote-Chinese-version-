import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { runSceneStabilityValidation } from './scene-stability-live-runner';
import type { SceneSemanticLimits } from './scene-semantic-live-runner';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Stability runner checks must stay offline');
const limits: SceneSemanticLimits = { maxCalls: 24, maxOutputTokensTotal: 48000, maxOutputTokensPerCall: 3072, maxInputChars: 48000, timeoutMs: 360000, requestTimeoutMs: 45000 };
function mock(options: { repairOnce?: boolean; expectedTurns?: number; judgeUnmetCase?: string } = {}) {
  let source = '', count = 0, repaired = false;
  return { count: () => count, invoke: async (request: LlmCallRequest): Promise<LlmCallResponse> => {
    count++; assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.thinkingMode, 'disabled'); assert.ok(request.maxTokensOverride! <= 3072);
    let data: any; try { data = JSON.parse(request.userInput); } catch { /* Actual responder context is text. */ }
    const result = (value: unknown) => ({ content: JSON.stringify(value), usage: { promptTokens: 10, completionTokens: 20 }, diagnostics: { finishReason: 'stop' } });
    if (data?.phase === 'stability-judge') {
      assert.equal(data.actualInteractiveTurns, options.expectedTurns || 8); assert.equal(data.syntheticAnsweredHistoryRounds, 20);
      return result({ checks: data.cases.map((item: any) => ({ id: item.id, verdict: item.id === options.judgeUnmetCase ? 'unmet' : 'met', evidence: item.actualEvidence.slice(0, 25), reason: 'Offline mock judge, not semantic proof.' })) });
    }
    if (data?.phase === 'understand') {
      assert.equal(request.maxTokensOverride, 1536); source = data.latestUserInput.sourceId;
      const policy = source === 'stability-policy-and-harder-user', local = source === 'stability-local-explanation-user';
      const end = source === 'stability-summary-end-user';
      return result({ action: end ? 'finish' : data.latestInputKind === 'response' ? 'advance' : 'respond',
        understanding: understandingFixture(source, data.latestUserInput.text, {
          intent: end ? 'end' : data.latestInputKind === 'response' ? 'answer' : local ? 'follow-up' : 'conversation',
          ...(policy ? { teaching: { policyUpdates: [{ id: 'conditional-feedback', action: 'set', scope: 'session',
            instruction: '答对简短、错答解释、主动追问可讲。后续题至少两步比例推理。',
            rules: [{ when: 'correct', correctness: 'immediate', explanation: 'on-request', responseStyle: 'brief-confirmation' },
              { when: 'incorrect', correctness: 'immediate', explanation: 'immediate', responseStyle: 'explanation' },
              { when: 'on-request', explanation: 'immediate', responseStyle: 'explanation' }],
            source: { sourceMessageId: source, quote: data.latestUserInput.text } }] } }
            : local ? { teaching: { explanationRequested: true, focus: { action: 'focus', interactionId: 'mock-q1' } } } : {}),
        }) });
    }
    assert.equal(request.workflow, 'scene-general-turn'); assert.equal(request.maxTokensOverride, 2048);
    if (options.repairOnce && !repaired && source === 'stability-policy-and-harder-user') {
      repaired = true;
      return result({ content: '不合法地新建第二题。', interaction: { id: 'illegal-extra', type: 'single-choice', assessment: 'objective', required: true,
        options: [{ id: 'x', label: '1' }, { id: 'y', label: '2' }] }, evaluation: { interactionId: 'illegal-extra', type: 'single-choice', correctId: 'x', explanation: '1。' } });
    }
    const index = source === 'stability-answer-before-policy-user' ? 1 : source === 'stability-correct-before-compaction-user' ? 2
      : source === 'stability-correct-after-compaction-user' ? 3 : source === 'stability-wrong-after-compaction-user' ? 4 : 0;
    if (index) {
      const id = 'mock-q' + index, harder = index === 2;
      return result({ content: (index === 1 ? '答错了，40×60%=24人。' : index === 4 ? '答错了，先用总人数乘比例，50×40%=20人。' : '答对了。')
        + (harder ? '新题：50人中60%参加社团，其中三分之一参加书法，参加书法有多少人？' : '新题：50人中40%选择科普，多少人？'),
        interaction: { id, type: 'single-choice', required: true, assessment: 'objective', options: [{ id: 'ten', label: '10人' }, { id: 'twenty', label: '20人' }, { id: 'thirty', label: '30人' }] },
        evaluation: { interactionId: id, type: 'single-choice', correctId: harder ? 'ten' : 'twenty', explanation: harder ? '50×60%÷3=10人。' : '50×40%=20人。' } });
    }
    return result({ content: source === 'stability-policy-and-harder-user' ? '明白，答对简短确认、答错仍解释，追问时讲解，当前题保留，下一题两步比例。'
      : source === 'stability-local-explanation-user' ? '刚才已答题中50×40%=20人，比例的分母是50人。当前待答题保留。'
      : source === 'stability-hint-after-compaction-user' ? '先区分总人数与所求部分，再列比例乘法，暂不计算。'
      : '总结比例与分母，本次到这里结束。' });
  } };
}
const clean = mock();
const report = await runSceneStabilityValidation({ limits, invoke: clean.invoke });
assert.equal(report.stopped, undefined, JSON.stringify(report.cases.map(item => ({ id: item.id, checks: item.checks }))));
assert.equal(report.passed, true);
assert.equal(report.actualInteractiveTurns, 8); assert.equal(report.syntheticAnsweredHistoryRounds, 20);
assert.equal(report.budget.dispatchAttempts, 17); assert.equal(clean.count(), 17);
assert.equal(report.budget.reservedOutputTokens, 31744);
assert.equal(report.compactionEvidence?.outsideLast12Messages, true);
assert.equal(report.compactionEvidence?.actualUnderstandRequestCarriesProtectedSource, true);
assert.equal(report.compactionEvidence?.actualRespondRequestCarriesProtectedSource, true);
assert.equal(report.protocolAttemptDiagnostics.filter(item => item.value.outcome === 'accepted').length, 16);
assert.equal(report.receipts.filter(item => item.phase === 'stability-judge').length, 1);
assert.match(report.boundary, /不是20轮真实对话/);
const focusLimits = { ...limits, maxCalls: 13, maxOutputTokensTotal: 27520 };
const focusMock = mock({ expectedTurns: 5 });
const focus = await runSceneStabilityValidation({ limits: focusLimits, profile: 'focus', invoke: focusMock.invoke });
assert.equal(focus.stopped, undefined); assert.equal(focus.passed, true);
assert.equal(focus.suite, 'stability-focus'); assert.equal(focus.requiredActualTurns, 5); assert.equal(focus.profile, 'focused-continuation');
assert.equal(focus.actualInteractiveTurns, 5); assert.equal(focus.syntheticAnsweredHistoryRounds, 20);
assert.equal(focus.budget.dispatchAttempts, 11); assert.equal(focus.budget.reservedOutputTokens, 20992);
assert.deepEqual(focus.cases.map(item => item.id), ['policy-and-harder', 'correct-before-compaction', 'correct-after-compaction', 'wrong-after-compaction', 'summary-end']);
assert.match(focus.boundary, /不等于完整8回合套件/);
assert.equal(focus.compactionEvidence?.actualUnderstandRequestCarriesProtectedSource, true);
const focusRepair = await runSceneStabilityValidation({ limits: focusLimits, profile: 'focus', invoke: mock({ expectedTurns: 5, repairOnce: true }).invoke });
assert.equal(focusRepair.passed, true); assert.equal(focusRepair.budget.dispatchAttempts, 12);
const judgedWrong = await runSceneStabilityValidation({ limits: focusLimits, profile: 'focus', invoke: mock({ expectedTurns: 5, judgeUnmetCase: 'correct-before-compaction' }).invoke });
assert.equal(judgedWrong.stopped, undefined); assert.equal(judgedWrong.passed, false, 'judge math/key failure cannot be beautified into pass');
await assert.rejects(runSceneStabilityValidation({ limits, profile: 'focus', invoke: mock({ expectedTurns: 5 }).invoke }), /Invalid stability validation limit/);

const repairMock = mock({ repairOnce: true });
const repaired = await runSceneStabilityValidation({ limits, invoke: repairMock.invoke });
assert.equal(repaired.stopped, undefined); assert.equal(repaired.passed, true);
assert.equal(repaired.budget.dispatchAttempts, 18);
assert.ok(repaired.protocolAttemptDiagnostics.some(item => item.turnId === 'policy-and-harder' && item.value.outcome === 'repairing' && item.value.issues.length > 0));
assert.ok(repaired.attemptDiagnostics.some(item => item.turnId === 'policy-and-harder' && item.attempt === 2 && item.repair));
const tinyMock = mock();
const capped = await runSceneStabilityValidation({ limits: { ...limits, maxCalls: 1 }, invoke: tinyMock.invoke });
assert.equal(capped.stopped, 'request-or-output-budget'); assert.equal(tinyMock.count(), 1);
assert.equal(capped.budget.reservedOutputTokens, 1536);
let failed = 0;
const stopped = await runSceneStabilityValidation({ limits, invoke: async () => { failed++; throw new Error('HTTP synthetic-secret'); } });
assert.equal(failed, 1); assert.equal(stopped.stopped, 'model-dispatch-failed'); assert.doesNotMatch(JSON.stringify(stopped), /synthetic-secret/);
await assert.rejects(runSceneStabilityValidation({ limits: { ...limits, maxCalls: 25 }, invoke: mock().invoke }), /Invalid stability/);
console.log('Scene stability runner offline checks passed: full 8-turn and focused 5-turn profiles + 20 synthetic answered history rounds, protected conditional policy, local control state, independent mock judge, repair diagnostics, immutable full24/48000 and focus13/27520 caps. No live semantic claim.');
