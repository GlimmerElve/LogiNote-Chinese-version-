import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2AgentReply, S2Document } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2ConversationMemory } from '../src/services/scene/sceneS2Memory';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { S2_BUSINESS_VALIDATION_CASE } from './scene-s2-business-validation';
import { prepareS2HostResultSource, runS2HostResultValidation } from './scene-s2-host-result-validation';

globalThis.fetch = async () => assert.fail('Offline synthetic source/host only; no credentials, model, notes or profile');
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
function fixture() {
  const base = createS2Scene(S2_BUSINESS_VALIDATION_CASE.request).canvasWorkspace!;
  const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const plugins = [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')];
  const initial: S2Document = { nodes: [{ id: 'input', type: 'text', position: { x: 0, y: 0 },
    values: { content: '[{"name":"示例甲","score":80},{"name":"","score":120}]' } }], edges: [], execution: { version: 1, nodes: [
    { id: 'parse', ...cap('parse-json'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'input', fieldId: 'content' } } },
    { id: 'rows', ...cap('to-table'), position: { x: 200, y: 0 }, bindings: {} },
    { id: 'view', ...cap('table', 'structured-view'), position: { x: 300, y: 0 }, bindings: {} },
  ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'rows', portId: 'value' } }] } };
  const commands: S2AgentReply['commands'] = [{ op: 'connect-ports', link: { source: { nodeId: 'rows', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } } }];
  const seed = { ...base, plugins, initial }, complete = applyS2Commands(seed, initial, commands);
  const business = syntheticS2Business(seed);
  business.workflow = [{ id: 'Local', goal: 'Local parse to table', actor: 'tool', capabilities: plugins, input: 'Synthetic records', output: 'Unchanged table' }];
  business.completion = { mode: 'execution', reference: complete, targetNodeIds: ['view'],
    coverage: [{ requirementId: 'SyntheticRequirement', stepIds: ['Local'], nodeIds: ['parse', 'rows', 'view'] }] };
  const definition = readS2Definition({ ...seed, business }, { requireBusiness: true });
  const oldRunId = 'old-synthetic-run', memory = new S2ConversationMemory('synthetic-scene', oldRunId), steps: any[] = [], requests: LlmCallRequest[] = [];
  const request = (input: unknown): LlmCallRequest => ({ providerId: '', model: '', workflow: 'agent-scene-setup',
    skipMemoryInjection: true, skipProfileInjection: true, userInput: JSON.stringify(input) });
  for (const [index, query] of S2_BUSINESS_VALIDATION_CASE.queries.entries()) {
    const before = index === 5 ? complete : initial;
    const result: S2AgentReply = { understanding: 'Synthetic accepted user response', plan: 'Protocol fixture',
      reply: '这是已接受的合成用户回应，仅用于恢复测试，不是模型语义质量或整链路通过的证据。', commands: index === 4 ? commands : [],
      ...(index === 5 ? { executionRequest: { targetNodeIds: ['view'], reason: 'Synthetic prior confirmation' } } : {}) };
    const update = index === 0 ? { set: [{ id: 'preserve', kind: 'constraint', text: '保留提示约束', quote: '不要给完整答案', nodeIds: ['input'] }] } : undefined;
    const frame = memory.begin('synthetic-scene', oldRunId, query, 'user', before);
    memory.stage(result, frame, memory.propose(frame, update)); assert(memory.accept(result));
    requests.push(request({ stage: 'turn-understand', origin: 'user', query }), request({ stage: 'turn-act', origin: 'user', query, intent: { memoryUpdate: update } }));
    steps.push({ query, origin: 'user', before, after: index === 4 || index === 5 ? complete : initial, result,
      hostFrame: { sceneId: 'synthetic-scene', runId: oldRunId, revision: 1, event: { kind: 'user-message', id: `user-${index}` } },
      memoryVersionBefore: index, memoryVersionAfter: index + 1 });
  }
  requests.push(request({ stage: 'turn-understand', origin: 'host-event', hostEvent: { kind: 'workflow-completed', workflowRunId: 'old-workflow' },
    triggeredExecution: { available: true, workflowRunId: 'old-workflow', workflow: { status: 'succeeded', targets: ['view'] } }, workingMemory: memory.context(complete) }));
  return { report: { kind: 'production-ui-handlers-real-controllers', caseId: 'business-chain', profile: 'business-chain',
    buildAccepted: true, passed: false, browserTested: false, stopped: 'ui-chain-stage-failed', definition, steps },
    definition, editConfirmed: { document: complete }, requests };
}

async function run(invalidReview = false, abortReview = false) {
  const source = prepareS2HostResultSource(fixture()); let calls = 0;
  const controller = new AbortController();
  const result = await runS2HostResultValidation({ source, signal: controller.signal, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') {
      assert.equal(input.memoryWritable, false); assert.equal(input.workingMemory.version, 6);
      return response({ understanding: 'Read actual host results', desiredOutcome: 'Explain only', actions: ['reply'], constraints: [], questions: [],
        memoryUpdate: { retire: [{ id: 'preserve', quote: 'Synthetic host result', reason: 'Host cannot release user constraints' }] } });
    }
    if (input.stage === 'turn-act') return response({ understanding: 'Host result only', plan: 'Read-only interpretation',
      reply: '本次真实本地解析、转换和只读展示保留了两条原始记录；这不证明姓名分数业务合格，也不是整场景通过。没有改图或再次运行。', commands: [] });
    assert.equal(input.phase, 's2-host-result-independent-review');
    assert(input.evidenceCatalogue.every((entry: { origin: string }) => entry.origin === 'host-event'));
    if (abortReview) controller.abort();
    return response({ checks: [{ id: 'consent-and-local-results', verdict: 'met',
      evidenceId: invalidReview ? 'invented-evidence' : input.evidenceCatalogue[0].id, reason: 'Synthetic judge, not real semantic acceptance' }] });
  } });
  assert.equal(calls, 3); assert.equal(result.passed, false); assert.equal(result.buildAccepted, false);
  assert.equal(result.browserTested, false); assert.equal(result.wholeChainTested, false);
  assert.equal(result.workflows.length, 1); assert.equal(result.receipts.length, 2);
  assert.equal(result.localChecks.userMemoryUnchanged, true); assert.equal(result.localChecks.noEditOrExecutionProposal, true);
  assert.equal(result.hostResultSubsetPassed, !invalidReview && !abortReview);
  if (abortReview) assert.equal(result.stopped, 'cancelled', 'A late valid judge response cannot certify a cancelled run');
  await assert.rejects(() => runS2HostResultValidation({ source, invoke: async () => assert.fail('One-use source cannot dispatch') }));
}
await run(); await run(true); await run(false, true);
const badTarget = fixture(); badTarget.report.steps[5].result.executionRequest.targetNodeIds = ['parse'];
assert.throws(() => prepareS2HostResultSource(badTarget));
const changedSource = fixture(); changedSource.editConfirmed.document.nodes[0].values.content = '[{"name":"modified"}]';
assert.throws(() => prepareS2HostResultSource(changedSource));
const forgedMemory = fixture();
const event = JSON.parse(forgedMemory.requests.at(-1)!.userInput); event.workingMemory.records[0].text = 'Forged state';
forgedMemory.requests.at(-1)!.userInput = JSON.stringify(event);
assert.throws(() => prepareS2HostResultSource(forgedMemory));
console.log('S2 host-result diagnostic passed: source-bound public-API memory reconstruction, exact prior edit/target, fresh real local host execution, two read-only production stages plus one source-bound judge, unchanged memory/document/tools, one-use preflight and strict subset-only report. Offline synthetic IO, NOT real-model or whole-chain acceptance.');
