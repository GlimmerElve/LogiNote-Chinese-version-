import assert from 'node:assert/strict';
import { runS2AgentValidation, readS2ValidationJudge, S2_VALIDATION_CHECKS, S2ValidationStop } from './scene-s2-agent-validation';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { createS2ExactReplay } from './scene-s2-exact-replay';
import { syntheticS2Business } from './fixtures/s2-business-model';

globalThis.fetch = async () => assert.fail('Offline validation cannot use real models or external sources');
const capability = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const definition: S2CanvasDefinition = readS2Definition({ version: 1, goal: '合成练习',
  instructions: { understanding: '先理解需求', planning: '按需协作', response: '先提示，不自动执行；不混淆语法与业务' },
  blockTypes: [{ id: 'note', label: '文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [capability('parse-json'), capability('to-table'), capability('table', 'structured-view')],
  initial: { nodes: [{ id: 'input', type: 'note', position: { x: 0, y: 0 }, values: { content: '[{"name":"","score":120}]' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'parse', ...capability('parse-json'), position: { x: 300, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'input', fieldId: 'content' } } },
      { id: 'table', ...capability('to-table'), position: { x: 600, y: 0 }, bindings: {} },
      { id: 'view', ...capability('table', 'structured-view'), position: { x: 900, y: 0 }, bindings: {} },
    ], links: [] } } });
let turn = 0, calls = 0; const artifacts = new Map<string, any>();
const report = await runS2AgentValidation({ onArtifact: async (name, value) => { artifacts.set(name, structuredClone(value)); }, invoke: async request => {
  calls++; const input = JSON.parse(request.userInput);
  assert(request.skipMemoryInjection && request.skipProfileInjection);
  let value: unknown;
  if (input.stage === 'understand') {
    assert.equal(input.pluginCatalog, undefined);
    value = { goal: '合成练习', requirements: [{ id: 'exercise', description: '不完整画布', source: 'task', quote: '不完整的画布' }],
      userRole: '学习者', agentRole: '教练', assumptions: [], openQuestions: [], delivery: { initial: '合成初稿', deferred: '后续补齐练习', source: 'task', quote: '不完整的画布' } };
  } else if (input.stage === 'assemble') value = { ...definition, business: syntheticS2Business(definition, input.designBrief) };
  else if (input.stage === 'review') value = { verdict: 'accept', factChecks: [], coverage: [{ requirementId: 'exercise', status: 'covered', evidencePaths: ['/initial/execution'], reason: '合成路径检查' }], feedback: '合成通过' };
  else if (input.stage === 'turn-understand') {
    turn++; assert.equal(input.current.nodes.find((n: any) => n.id.startsWith('learner_design')).values.content.includes('超过100'), true);
    if (turn === 5) {
      assert.ok(input.evidenceIndex.workflows.some((run: any) => run.status === 'succeeded'));
      assert.equal(input.observations.length, 2, 'Result interpretation sees real local plugin observations');
    }
    value = { understanding: '合成意图', desiredOutcome: '协议验证', actions: ['reply', ...(turn === 3 ? ['edit'] : []), ...(turn === 4 ? ['execute'] : [])], constraints: [], questions: [] };
  } else if (input.stage === 'turn-act') value = { understanding: '合成摘要', plan: '合成行动', reply: `合成回应${turn}`, commands: turn === 3 ? [
    { op: 'add-node', node: { id: 'advice', type: 'note', position: { x: 100, y: 500 }, values: { content: '业务规则需另行审阅，不是JSON语法' } } },
    { op: 'connect-ports', link: { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } } },
    { op: 'connect-ports', link: { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } } },
  ] : [], ...(turn === 4 ? { executionRequest: { targetNodeIds: ['view'], reason: '只展示局部' } } : {}) };
  else if (input.stage === 'turn-proposal-review') value = { verdict: 'accept', reason: 'Synthetic proposal review, not semantic accuracy evidence', evidence: [{ sourceId: 'query', quote: input.sources.find((s: any) => s.id === 'query').text.slice(0, 500) }] };
  else {
    assert.equal(input.phase, 's2-independent-review');
    assert.equal(input.transcript.includes('displayed'), true, 'Review sees actual local host execution');
    value = { checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met', evidence: '合成回应1', reason: 'Only a synthetic judge schema test, not semantic proof' })) };
  }
  return { content: JSON.stringify(value) };
} });
assert.equal(calls, 15); assert.equal(turn, 5); assert.equal(report.passed, true); assert.equal(report.steps.length, 5);
assert.equal(artifacts.get('turn-4').toolCallsAfter, 0, 'Agent proposal is not execution');
assert.equal(report.receipts.length, 2, 'Only parse and table conversion execute after separate driver confirmation');
assert.equal(report.steps[4].toolCallsBefore, 2); assert.equal(report.steps[4].toolCallsAfter, 2, 'Interpreting execution is not an automatic rerun');
assert.equal(report.localChecks.confirmedWorkflowSucceeded, true);
assert.equal((report.workflows[0] as any).nodes.at(-1).status, 'displayed');
assert.equal((artifacts.get('definition') as S2CanvasDefinition).initial.execution!.links.length, 0, 'No injected answer graph replaces model draft');
// Even an overconfident semantic judge cannot turn a failed local run into a passed closed loop.
let negativeTurn = 0;
const broken = structuredClone(definition); broken.initial.nodes[0].values.content = '{bad}';
const failed = await runS2AgentValidation({ invoke: async request => {
  const input = JSON.parse(request.userInput); let value: unknown;
  if (input.stage === 'understand') value = { goal: '合成练习', requirements: [{ id: 'exercise', description: '不完整画布', source: 'task', quote: '不完整的画布' }],
    userRole: '学习者', agentRole: '教练', assumptions: [], openQuestions: [], delivery: { initial: '合成初稿', deferred: '后续补齐练习', source: 'task', quote: '不完整的画布' } };
  else if (input.stage === 'assemble') value = { ...broken, business: syntheticS2Business(broken, input.designBrief) };
  else if (input.stage === 'review') value = { verdict: 'accept', factChecks: [], coverage: [{ requirementId: 'exercise', status: 'covered', evidencePaths: ['/initial/execution'], reason: 'Synthetic only' }], feedback: 'Synthetic only' };
  else if (input.stage === 'turn-understand') {
    negativeTurn++; value = { understanding: '合成意图', desiredOutcome: '检查失败不能被掩盖',
      actions: ['reply', ...(negativeTurn === 3 ? ['edit'] : []), ...(negativeTurn === 4 ? ['execute'] : [])], constraints: [], questions: [] };
  } else if (input.stage === 'turn-act') value = { ...report.steps[negativeTurn - 1].result, reply: 'negative synthetic response' };
  else if (input.stage === 'turn-proposal-review') value = { verdict: 'accept', reason: 'Synthetic only', evidence: [{ sourceId: 'query', quote: '现在请你协作' }] };
  else value = { checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met', evidence: 'negative synthetic response', reason: 'Deliberately overconfident synthetic judge' })) };
  return { content: JSON.stringify(value) };
} });
assert.equal(failed.stopped, undefined); assert.equal(failed.localChecks.confirmedWorkflowSucceeded, false);
assert.equal(failed.passed, false); assert.equal((failed.workflows[0] as any).status, 'failed');
assert.equal(failed.steps.length, 5); assert.equal(failed.receipts.length, 1, 'Failed parser does not run downstream transforms');
assert.equal(failed.steps[4].toolCallsBefore, 1); assert.equal(failed.steps[4].toolCallsAfter, 1, 'Result explanation does not retry failed execution');
let isolatedTurn = 0;
const isolated = await runS2AgentValidation({ unacceptedModelDraft: definition, invoke: async request => {
  const input = JSON.parse(request.userInput);
  assert.ok(!['understand', 'assemble', 'review'].includes(input.stage), 'Isolated diagnostics must not pretend to have built/accepted this draft');
  const value = input.stage === 'turn-understand' ? (++isolatedTurn, { understanding: '合成意图', desiredOutcome: '隔离互动测试',
    actions: ['reply', ...(isolatedTurn === 3 ? ['edit'] : []), ...(isolatedTurn === 4 ? ['execute'] : [])], constraints: [], questions: [] })
    : input.stage === 'turn-act' ? report.steps[isolatedTurn - 1].result
      : input.stage === 'turn-proposal-review' ? { verdict: 'accept', reason: 'Synthetic only', evidence: [{ sourceId: 'query', quote: '现在请你协作' }] }
      : { checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met', evidence: '合成回应1', reason: 'Synthetic isolated test' })) };
  return { content: JSON.stringify(value) };
} });
assert.equal(isolated.buildAccepted, false); assert.equal(isolated.interactionPassed, true);
assert.equal(isolated.passed, false, 'Even successful isolated interaction is not full builder acceptance');

const replayRequest = { providerId: '', model: '', workflow: 'agent-scene-setup' as const, userInput: '{"query":"synthetic"}',
  systemPromptOverride: 'synthetic prompt', maxTokensOverride: 1024, skipMemoryInjection: true, skipProfileInjection: true };
const paidEntries = [1, 2].map(() => ({ request: structuredClone(replayRequest), response: { content: '{"reply":"paid synthetic output"}' } }));
const exactReplay = createS2ExactReplay(paidEntries);
paidEntries[0].response.content = 'changed externally';
for (const mismatch of [{ ...replayRequest, userInput: '{"query":"changed"}' }, { ...replayRequest, maxTokensOverride: 2048 },
  { ...replayRequest, systemPromptOverride: 'changed policy' }]) assert.throws(() => exactReplay.take(mismatch), /MISMATCH/);
assert.equal(exactReplay.consumed, 0, 'No consumption or dispatch fallback after a changed request');
const firstReplay = exactReplay.take(replayRequest); assert.equal(firstReplay.content, '{"reply":"paid synthetic output"}');
firstReplay.content = 'changed returned copy'; assert.equal(exactReplay.take(replayRequest).content, '{"reply":"paid synthetic output"}');
assert.throws(() => exactReplay.take(replayRequest), /EXHAUSTED/);
for (const raw of [{ checks: [] }, { checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met', evidence: 'fabricated', reason: 'bad' })) },
  { checks: S2_VALIDATION_CHECKS.map(() => ({ id: S2_VALIDATION_CHECKS[0], verdict: 'met', evidence: 'original', reason: 'duplicate' })) }]) {
  assert.throws(() => readS2ValidationJudge(raw, 'original'));
}
const businessChecks = ['knowledge-on-demand', 'grounded-assessment'];
const businessJudge = { checks: businessChecks.map(id => ({ id, verdict: 'met', evidence: 'actual response', reason: 'Synthetic catalogue parser check only' })) };
assert.equal(readS2ValidationJudge(businessJudge, 'actual response', businessChecks).length, 2);
assert.throws(() => readS2ValidationJudge(businessJudge, 'actual response'), /coverage/,
  'A different case cannot silently replace the original catalogue');
for (const catalogue of [[], ['duplicate', 'duplicate'], ['prototype.key'], Array.from({ length: 17 }, (_, index) => `check-${index}`)]) {
  assert.throws(() => readS2ValidationJudge(businessJudge, 'actual response', catalogue), /catalogue/);
}
let abortedCalls = 0; const controller = new AbortController(); controller.abort();
const stopped = await runS2AgentValidation({ signal: controller.signal, invoke: async () => { abortedCalls++; assert.fail('Aborted'); } });
assert.equal(stopped.stopped, 'cancelled'); assert.equal(abortedCalls, 0);
const budgetStop = await runS2AgentValidation({ invoke: async () => { throw new S2ValidationStop('approval-budget-exhausted'); } });
assert.equal(budgetStop.stopped, 'approval-budget-exhausted'); assert.equal(budgetStop.passed, false);
assert.equal(budgetStop.judge, undefined, 'A pre-dispatch budget stop is not a failed or passed semantic judge');
console.log('S2 agent validation runner passed: production build/turn controllers, generated vocabulary user edit, hint/analogy/collaboration/run handoffs, separate confirmation and actual local execution, grounded independent-judge schema, raw staged artifacts, abort. Synthetic model decisions only, NOT semantic acceptance.');
