import assert from 'node:assert/strict';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { runS2TargetedValidation, readS2TargetedJudge, S2_TARGETED_CHECKS } from './scene-s2-targeted-validation';
import { S2ValidationStop } from './scene-s2-agent-validation';
globalThis.fetch = async () => assert.fail('Offline only');
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const draft = readS2Definition({ version: 1, goal: '合成目标', instructions: { understanding: '理解', planning: '计划', response: '回应' },
  blockTypes: [{ id: 'note', label: '文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')], initial: {
    nodes: [{ id: 'input', type: 'note', position: { x: 0, y: 0 }, values: { content: '[{"score":120}]' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'parse', ...cap('parse-json'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'input', fieldId: 'content' } } },
      { id: 'table', ...cap('to-table'), position: { x: 200, y: 0 }, bindings: {} },
      { id: 'view', ...cap('table', 'structured-view'), position: { x: 300, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } }] } } });
let turns = 0, calls = 0;
const result = await runS2TargetedValidation({ unacceptedModelDraft: draft, invoke: async request => {
  calls++; const input = JSON.parse(request.userInput); let value: unknown;
  if (input.stage === 'turn-understand') { turns++;
    if (turns === 2) {
      assert.ok(input.currentWiring.connectedInputs.includes('view.table <- table.table'));
      assert.equal(input.currentExecution.latestWorkflow.nodes.some((n: any) => n.nodeId === 'view'), false);
    }
    value = { understanding: '合成理解', desiredOutcome: '协议验证', actions: ['reply', ...(turns !== 2 ? ['edit'] : [])], constraints: [], questions: [] };
  } else if (input.stage === 'turn-act') value = { understanding: '合成理解', plan: '合成计划', reply: '合成回应', commands: turns === 2 ? [] : turns === 1 ? [
    { op: 'add-node', node: { id: 'advice', type: 'note', position: { x: 100, y: 200 }, values: { content: '合成建议' } } },
  ] : [{ op: 'connect-ports', link: { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } } }] };
  else if (input.stage === 'turn-proposal-review') value = { verdict: 'accept', reason: 'Synthetic schema test, not semantic evidence', evidence: [{ sourceId: 'query', quote: input.sources.find((s: any) => s.id === 'query').text.slice(0, 20) }] };
  else { assert.equal(input.phase, 's2-targeted-independent-review'); assert.ok(input.transcript.includes('explicit-synthetic-user-edit-and-confirmation'));
    value = { checks: S2_TARGETED_CHECKS.map(id => ({ id, verdict: 'met', evidence: '合成回应', reason: 'Synthetic only' })) }; }
  return { content: JSON.stringify(value) };
} });
assert.equal(calls, 9); assert.equal(turns, 3); assert.equal(result.targetedPassed, true);
assert.equal(result.passed, false); assert.equal(result.buildAccepted, false, 'Targeted success is NOT builder/full acceptance');
assert.equal(result.cases[0].applied, false); assert.equal(draft.initial.execution!.links.length, 1);
let reviewOnlyCalls = 0;
const repairedReview = await runS2TargetedValidation({ unacceptedModelDraft: draft,
  reviewOnlyReport: { ...result, stopped: 'targeted-review-failed' }, invoke: async request => {
    reviewOnlyCalls++; const input = JSON.parse(request.userInput);
    assert.equal(input.phase, 's2-targeted-independent-review', 'Do not redispatch any participant turn or local run');
    return { content: JSON.stringify({ checks: S2_TARGETED_CHECKS.map(id => ({ id, verdict: 'met', evidence: '合成回应', reason: 'Synthetic only' })) }) };
  } });
assert.equal(reviewOnlyCalls, 1); assert.equal(repairedReview.targetedPassed, true); assert.equal(repairedReview.passed, false);
assert.deepEqual(repairedReview.cases, result.cases);
let reviewedPartial = false;
const partial = await runS2TargetedValidation({ unacceptedModelDraft: draft, invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.phase !== 's2-targeted-independent-review') throw new S2ValidationStop('approval-budget-exhausted');
  reviewedPartial = true;
  return { content: JSON.stringify({ checks: S2_TARGETED_CHECKS.map(id => ({ id, verdict: 'uncertain', evidence: 'approval-budget-exhausted', reason: 'No participant evidence' })) }) };
} });
assert.equal(reviewedPartial, true); assert.equal(partial.targetedPassed, false); assert.equal(partial.stopped, 'approval-budget-exhausted');
assert.throws(() => readS2TargetedJudge({ checks: S2_TARGETED_CHECKS.map(id => ({ id, verdict: 'met', evidence: 'invented', reason: 'bad' })) }, 'real'));
console.log('S2 targeted validation protocol passed (synthetic only; no semantic accuracy claim)');
