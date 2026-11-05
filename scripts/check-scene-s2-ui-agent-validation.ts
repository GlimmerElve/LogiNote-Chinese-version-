import assert from 'node:assert/strict';
import { runS2UiAgentValidation, s2ValidationLearnerField } from './scene-s2-ui-agent-validation';
import { s2TaskCase, S2_TASK_CASES } from './scene-s2-task-cases';
import { S2_VALIDATION_CHECKS, S2ValidationStop } from './scene-s2-agent-validation';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
globalThis.fetch = async () => assert.fail('Offline only');
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const draft = readS2Definition({ version: 1, goal: 'Synthetic protocol exercise', instructions: { understanding: '理解', planning: '计划', response: '回应' },
  blockTypes: [{ id: 'note', label: '合成文本', fields: [{ id: 'content', label: '合成内容', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('to-table')], initial: {
    nodes: [{ id: 'input', type: 'note', position: { x: 0, y: 0 }, values: { content: '[{"score":120}]' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'parse', ...cap('parse-json'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'input', fieldId: 'content' } } },
      { id: 'table', ...cap('to-table'), position: { x: 200, y: 0 }, bindings: {} },
    ], links: [] } } });
async function run(failExecution = false, unrequestedEdit = false, mode?: 'rich-field' | 'human' | 'unexpected-human') {
  let calls = 0, turn = 0;
  const current = structuredClone(draft);
  if (mode === 'rich-field') {
    current.blockTypes.unshift({ id: 'numeric', label: '数值设置', fields: [{ id: 'amount', label: '数量', kind: 'number' }] });
    Object.assign(current.blockTypes[1].fields[0], { required: true, maxLength: 6000 });
  }
  if (mode === 'human' || mode === 'unexpected-human') {
    current.plugins!.push(cap('confirm', 'human-input'), cap('render', 'text-template'));
    current.initial.execution!.nodes.push(
      { id: 'confirm', ...cap('confirm', 'human-input'), position: { x: 0, y: 600 }, bindings: { prompt: { kind: 'literal', value: '合成用户确认：是否继续？' } } },
      ...[true, false].map(approved => ({ id: approved ? 'accepted' : 'declined', ...cap('render', 'text-template'), position: { x: 200, y: approved ? 600 : 800 },
        bindings: { template: { kind: 'literal' as const, value: approved ? '合成同意路径' : '合成拒绝路径' }, variables: { kind: 'literal' as const, value: {} } },
        when: { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: true, match: approved } })),
    );
  }
  const result = await runS2UiAgentValidation({ disclosure: 'complete', invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); let value: unknown;
    if (mode === 'rich-field' && input.stage === 'assemble') current.business = syntheticS2Business(draft, input.designBrief);
    if (['understand', 'assemble', 'review'].includes(input.stage)) return s2DesignFixtureResponse(request,
      failExecution ? { ...current, initial: { ...current.initial, nodes: [{ ...current.initial.nodes[0], values: { content: 'not json' } }] } } : current);
    if (input.stage === 'turn-understand') {
      turn++; if (turn === 5) { assert.equal(input.origin, 'host-event'); assert.ok(input.currentExecution.latestWorkflow); }
      value = { understanding: '合成理解', desiredOutcome: '协议测试', actions: ['reply', ...(turn === 3 || unrequestedEdit && turn === 1 ? ['edit'] : []), ...(turn === 4 ? ['execute'] : [])], constraints: [], questions: [] };
    } else if (input.stage === 'turn-act') value = { understanding: '合成理解', plan: '合成计划', reply: `合成回应${turn}：这是用于核对真实组件处理协议的离线样例，不证明模型的语义理解质量。`, commands: unrequestedEdit && turn === 1 ? [
      { op: 'add-node', node: { id: 'unrequested', type: 'note', position: { x: 0, y: 400 }, values: { content: '不应在提示轮提出的修改' } } },
    ] : turn === 3 ? [
      { op: 'add-node', node: { id: 'advice', type: 'note', position: { x: 0, y: 300 }, values: { content: '合成建议' } } },
      { op: 'connect-ports', link: { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } } },
    ] : [], ...(turn === 4 ? { executionRequest: { targetNodeIds: mode === 'human' || mode === 'unexpected-human' ? ['table', 'accepted', 'declined'] : ['table'], reason: '局部运行' } } : {}) };
    else if (input.stage === 'turn-proposal-review') value = { verdict: 'accept', reason: 'Synthetic only', evidence: [{ sourceId: 'query', quote: input.sources.find((source: { id: string }) => source.id === 'query').text.slice(0, 120) }] };
    else { assert.equal(input.phase, 's2-ui-independent-review'); value = { checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met',
      evidenceId: input.evidenceCatalogue.find((entry: { checkIds: string[] }) => entry.checkIds.includes(id))?.id,
      reason: 'Synthetic only, not semantic quality' })) }; }
    return { content: JSON.stringify(value) };
  }, ...(mode === 'human' ? { validationCase: s2TaskCase('human-branch') } : {}) });
  return { result, calls, turn };
}
const good = await run(); assert.equal(good.calls, 15); assert.equal(good.turn, 5); assert.equal(good.result.passed, true, JSON.stringify({ failure: good.result.failure, checks: good.result.localChecks }));
assert.equal(good.result.browserTested, false); assert.equal(good.result.steps[4].origin, 'host-event');
assert.equal(good.result.receipts.length, 2); assert.equal(good.result.localChecks.previewHasNoExecutionHost, true);
assert.equal(good.result.localChecks.awaitingUserConfirmation, true); assert.equal(good.result.localChecks.uiFinished, true);
assert.equal(good.result.judgeCalls, 1); assert.equal(good.result.reviewSchemaVersion, 2);
assert.equal(good.result.buildPreviewPassed, true, 'Full-chain report must retain actual successful preview evidence');
const rich = await run(false, false, 'rich-field'); assert.equal(rich.result.passed, true, JSON.stringify({ failure: rich.result.failure, checks: rich.result.localChecks }));
assert.equal(s2ValidationLearnerField(rich.result.definition!).type.id, 'note', 'Generated numeric first block is not a text box');
assert.equal(rich.result.userDocument!.nodes.at(-1)!.type, 'note');
assert.throws(() => s2ValidationLearnerField({ ...draft, blockTypes: [{ id: 'numeric', label: '数量', fields: [{ id: 'amount', label: '数值', kind: 'number' }] }] }), /No text field/);
for (const [id, testCase] of Object.entries(S2_TASK_CASES)) {
  assert.equal(s2TaskCase(id), testCase); assert.equal(testCase.request.sceneSkill, 'S2');
  assert.deepEqual(testCase.request.knowledgePoints, []); assert.equal(testCase.queries.length, 4);
  assert(!('initial' in testCase), 'Natural-language tasks must not inject a finished canvas');
}
assert.throws(() => s2TaskCase('unknown'), /Unknown/);
const human = await run(false, false, 'human');
assert.equal(human.result.passed, true, JSON.stringify({ failure: human.result.failure, checks: human.result.localChecks, stopped: human.result.stopped })); assert.equal(human.result.humanActions.length, 1); assert.equal(human.result.humanActions[0].approved, false);
assert.equal((human.result.workflows[0] as any).nodes.find((node: any) => node.nodeId === 'accepted').status, 'skipped');
assert.equal((human.result.workflows[0] as any).nodes.find((node: any) => node.nodeId === 'declined').status, 'succeeded');
const unexpectedWait = await run(false, false, 'unexpected-human');
assert.equal(unexpectedWait.result.passed, false); assert.equal(unexpectedWait.result.humanActions.length, 0, 'Never invent an answer to an undeclared wait');
for (const key of ['hostEventMatchesConfirmedRun', 'hostEventTriggeredExecutionAvailable', 'hostAnalysisHasNoWritableMemory', 'sameConversationMemoryThroughout',
  'uiAcceptedMemoryInOrder', 'historyInActualTurnOrder', 'uiClosedConversationMemory']) assert.equal(good.result.localChecks[key], true, key);
const failed = await run(true); assert.equal(failed.result.passed, false); assert.equal(failed.result.localChecks.confirmedWorkflowSucceeded, false,
  'Overconfident independent model must not override an actual local execution failure');
const unsolicited = await run(false, true);
assert.equal(unsolicited.result.localChecks.turn1NoUnrequestedEditProposal, false);
assert.equal(unsolicited.result.localChecks.turn1NoAutomaticEdit, true, 'Proposal remains unapplied until confirmation');
assert.equal(unsolicited.result.passed, false, 'An overconfident judge cannot excuse an unrequested edit proposal during hint-only discussion');
let reviews = 0;
const stopped = await runS2UiAgentValidation({ disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.phase !== 's2-ui-independent-review') throw new S2ValidationStop('approval-budget-exhausted');
  reviews++; return { content: JSON.stringify({ checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'uncertain', evidence: 'approval-budget-exhausted', reason: 'Not tested' })) }) };
} });
assert.equal(reviews, 0, 'No accepted artifact: downstream stays untested and no judge fabricates evidence');
assert.equal(stopped.buildAccepted, false); assert.equal(stopped.passed, false);
assert.equal(stopped.stopped, 'approval-budget-exhausted');
console.log('S2 UI-Agent chain protocol passed: fresh staged design, generated vocabulary user edit, actual preview/start/confirm/end handlers, real local host and host-event result handoff, failed execution cannot pass, partial review. Synthetic model decisions; NOT browser or real-model acceptance.');
// Keep the source-bound review regression in the existing umbrella S2 command.
await import('./check-scene-s2-ui-evidence');
await import('./check-scene-s2-host-result-validation');
await import('./check-scene-s2-host-result-live-safety');
await import('./check-scene-s2-task-replay');
