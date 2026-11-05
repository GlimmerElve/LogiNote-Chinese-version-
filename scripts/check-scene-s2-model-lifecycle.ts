import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';

// Only synthetic injected transport. Install guards before loading production modules.
const previousFetch = globalThis.fetch, globals = ['window', 'localStorage', 'sessionStorage', 'electronAPI'] as const;
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let forbiddenIo = 0;
const deny = () => { forbiddenIo++; throw new Error('S2 model lifecycle test forbids real IO'); };
globalThis.fetch = async () => deny();
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, get: deny });
const hosts: Array<{ close(): void }> = [], sessions: Array<{ close(): void }> = [];
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('Synthetic lifecycle state did not settle');
}
async function complete<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic lifecycle completion deadline')), 2500); })]); }
  finally { clearTimeout(timer); }
}
try {
  const { S2ModelTestSession } = await import('../src/services/scene/sceneS2ModelTest');
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const sceneId = 'SyntheticLifecycleScene';
  const binding = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const plugins = [binding('model-test', 'generate'), binding('text-template', 'render'), binding('json-check', 'validate'), binding('human-input', 'text')];
  const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
  const node = (id: string, pluginId: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, ...binding(pluginId, capabilityId), position: { x: 0, y: 0 }, bindings });
  const link = (source: string, output: string, target: string, input: string) => ({ source: { nodeId: source, portId: output }, target: { nodeId: target, portId: input } });
  const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
    node('compose', 'text-template', 'render', { template: literal('合成测试 {{role}}'), variables: literal({ role: '只做协议验证' }) }),
    node('modelA', 'model-test', 'generate'), node('modelB', 'model-test', 'generate'),
    node('checkA', 'json-check', 'validate'), node('checkB', 'json-check', 'validate'),
    node('independent', 'json-check', 'validate', { text: literal('{}') }),
    node('human', 'human-input', 'text', { prompt: literal('请提交合成JSON原文；与模型授权无关') }), node('humanCheck', 'json-check', 'validate'),
  ], links: [link('compose', 'text', 'modelA', 'prompt'), link('compose', 'text', 'modelB', 'prompt'),
    link('modelA', 'text', 'checkA', 'text'), link('modelB', 'text', 'checkB', 'text'), link('human', 'text', 'humanCheck', 'text')] } };
  const make = (invoke: (request: LlmCallRequest, options: { signal: AbortSignal }) => Promise<LlmCallResponse> = async () => ({ content: '{}', diagnostics: { finishReason: 'stop' } })) => {
    const host = new S2PluginHost(sceneId, plugins); hosts.push(host); host.setDocument(document);
    const session = new S2ModelTestSession({ sceneId, runId: host.runId, resourceId: 'SyntheticLifecycleResource', providerId: 'synthetic', providerLabel: 'Synthetic lifecycle provider', model: 'synthetic',
      limits: { maxRequests: 4, maxReservedOutputTokens: 2048, maxOutputTokens: 512 }, invoke });
    sessions.push(session); host.approveModelTestSession(session); return { host, session };
  };
  const state = (host: InstanceType<typeof S2PluginHost>, runId: string, nodeId: string) => host.workflowHistory().find(run => run.id === runId)!.nodes.find(node => node.nodeId === nodeId)!;
  const assertNoModelOutput = (host: InstanceType<typeof S2PluginHost>) => {
    for (const execution of host.history().filter(item => item.request.pluginId === 'model-test')) {
      assert.notEqual(execution.receipt.status, 'succeeded'); assert.deepEqual(execution.artifacts, []);
    }
  };

  // Closing a waiting-only session is synchronous, even without a call finally.
  // Both model branches stop, but their independent local and human siblings survive.
  let waitingDispatches = 0;
  const waiting = make(async () => { waitingDispatches++; return { content: '{}', diagnostics: { finishReason: 'stop' } }; });
  const mixed = waiting.host.enqueueWorkflow(['checkA', 'checkB', 'independent', 'humanCheck']);
  await until(() => waiting.host.waitingModelTests().length === 2 && waiting.host.waitingHumanInputs().length === 1);
  const oldWaits = waiting.host.waitingModelTests(), human = waiting.host.waitingHumanInputs()[0], beforeCloseCalls = waiting.host.history().length;
  let closeEvents = 0, detachedEvents = 0, lateEvents = 0;
  waiting.session.subscribeClosed(() => { throw new Error('Synthetic broken observer'); });
  waiting.session.subscribeClosed(reason => { closeEvents++; reason.message = 'mutated observer copy'; waiting.session.close(); });
  const detach = waiting.session.subscribeClosed(() => { detachedEvents++; }); detach();
  waiting.session.close();
  assert.equal(waiting.host.waitingModelTests().length, 0);
  assert.equal(closeEvents, 1); assert.equal(detachedEvents, 0);
  let lateReason: ReturnType<typeof waiting.session.summary>['closure'];
  waiting.session.subscribeClosed(reason => { lateEvents++; lateReason = structuredClone(reason); });
  assert.equal(lateEvents, 1); assert.equal(lateReason?.code, 'MODEL_TEST_CLOSED'); assert.ok(!lateReason?.message.includes('mutated'));
  for (const wait of oldWaits) assert.throws(() => waiting.host.confirmModelTest(mixed.id, wait.id, true), /失效/);
  await until(() => state(waiting.host, mixed.id, 'checkA').status === 'blocked' && state(waiting.host, mixed.id, 'checkB').status === 'blocked');
  assert.equal(waiting.host.workflowHistory().find(run => run.id === mixed.id)!.status, 'waiting', 'Only the genuine independent human input remains waiting');
  assert.equal(waiting.host.waitingHumanInputs()[0].id, human.id);
  assert.equal(state(waiting.host, mixed.id, 'independent').status, 'succeeded');
  waiting.host.submitHumanInput(mixed.id, human.id, '{"synthetic":true}');
  const mixedDone = await complete(mixed.completion); assert.equal(mixedDone.status, 'failed');
  assert.equal(state(waiting.host, mixed.id, 'humanCheck').status, 'succeeded');
  assert.equal(state(waiting.host, mixed.id, 'compose').status, 'succeeded');
  assert.ok(state(waiting.host, mixed.id, 'modelA').error!.includes('授权已关闭'));
  assert.equal(waiting.host.history().length, beforeCloseCalls + 1, 'Only the explicitly answered human downstream check is new; model/upstream are never replayed');
  assert.equal(waitingDispatches, 0); assert.equal(waiting.session.summary().usedRequests, 0);
  const stable = JSON.stringify(waiting.host.workflowHistory()); waiting.session.close(); waiting.host.revokeModelTests(); waiting.host.revokeModelTests();
  assert.equal(JSON.stringify(waiting.host.workflowHistory()), stable); assert.equal(closeEvents, 1);
  assert.equal((await complete(waiting.host.enqueueWorkflow(['independent']).completion)).status, 'succeeded');
  assert.throws(() => waiting.host.enqueueWorkflow(['checkA']), /授权|模型/);
  assert.throws(() => waiting.host.approveModelTestSession(waiting.session), /替换|重置/);

  // One over-limit result closes the session and all other queued model waits.
  // Preserve the provider's failure and usage; finish unrelated local work normally.
  let releaseExcess!: (response: LlmCallResponse) => void, excessDispatches = 0;
  const excessive = make(async () => { excessDispatches++; return await new Promise(resolve => { releaseExcess = resolve; }); });
  const first = excessive.host.enqueueWorkflow(['checkA', 'independent']), second = excessive.host.enqueueWorkflow(['checkB']);
  await until(() => excessive.host.waitingModelTests().length === 2);
  const firstWait = excessive.host.waitingModelTests().find(wait => wait.workflowId === first.id)!;
  const secondWait = excessive.host.waitingModelTests().find(wait => wait.workflowId === second.id)!;
  excessive.host.confirmModelTest(first.id, firstWait.id, true);
  await until(() => excessDispatches === 1);
  const local = excessive.host.enqueueWorkflow(['independent']);
  releaseExcess({ content: '{"synthetic":"over limit"}', usage: { promptTokens: 10, completionTokens: 513 }, diagnostics: { finishReason: 'stop' } });
  const [firstDone, secondDone, localDone] = await Promise.all([complete(first.completion), complete(second.completion), complete(local.completion)]);
  assert.equal(firstDone.status, 'failed'); assert.equal(secondDone.status, 'failed'); assert.equal(localDone.status, 'succeeded');
  assert.equal(excessive.host.waitingModelTests().length, 0); assert.equal(excessDispatches, 1);
  assert.throws(() => excessive.host.confirmModelTest(second.id, secondWait.id, true), /失效/);
  assert.equal(state(excessive.host, first.id, 'checkA').status, 'blocked'); assert.equal(state(excessive.host, second.id, 'checkB').status, 'blocked');
  assert.ok(state(excessive.host, first.id, 'modelA').error!.includes('超过本次请求上限'));
  assert.ok(state(excessive.host, second.id, 'modelB').error!.includes('超过本次请求上限'));
  const excessSummary = excessive.session.summary();
  assert.equal(excessSummary.active, false); assert.equal(excessSummary.closure?.code, 'MODEL_TEST_USAGE_EXCEEDED');
  assert.equal(excessSummary.usedRequests, 1); assert.equal(excessSummary.reservedOutputTokens, 512);
  assert.equal(excessSummary.records[0].usage?.completionTokens, 513); assert.equal(excessSummary.records[0].status, 'failed');
  assert.equal(excessive.host.history().filter(item => item.request.nodeId === 'compose').length, 1, 'Closure and resumption do not replay the cached/completed upstream');
  assertNoModelOutput(excessive.host);
  excessive.host.revokeModelTests(); excessive.session.close(); assert.deepEqual(excessive.session.summary(), excessSummary, 'Repeated revoke cannot replace the first usage error or refund reservations');

  // Confirmed but not yet dispatched: the one-use approval is retired before
  // the queued segment can send anything, and all dependent tasks terminate.
  let preDispatches = 0;
  const pre = make(async () => { preDispatches++; return { content: '{}', diagnostics: { finishReason: 'stop' } }; });
  const preJob = pre.host.enqueueWorkflow(['checkA']); await until(() => pre.host.waitingModelTests().length === 1);
  const preWait = pre.host.waitingModelTests()[0]; pre.host.confirmModelTest(preJob.id, preWait.id, true); pre.session.close();
  assert.equal((await complete(preJob.completion)).status, 'failed'); assert.equal(preDispatches, 0); assert.equal(pre.session.summary().usedRequests, 0);

  // In-flight close: retain charged reservation and cancellation record; an
  // adapter ignoring AbortSignal cannot publish a late success.
  let lateResponse!: (response: LlmCallResponse) => void, inFlightDispatches = 0;
  const flight = make(async (_request, { signal }) => {
    inFlightDispatches++; assert.equal(signal.aborted, false); return await new Promise(resolve => { lateResponse = resolve; });
  });
  const flightJob = flight.host.enqueueWorkflow(['checkA']); await until(() => flight.host.waitingModelTests().length === 1);
  flight.host.confirmModelTest(flightJob.id, flight.host.waitingModelTests()[0].id, true); await until(() => inFlightDispatches === 1);
  flight.host.revokeModelTests(); assert.equal((await complete(flightJob.completion)).status, 'failed');
  const ledgerBeforeLate = JSON.stringify(flight.host.history()); lateResponse({ content: '{"late":true}', diagnostics: { finishReason: 'stop' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(flight.host.history()), ledgerBeforeLate); assertNoModelOutput(flight.host);
  assert.equal(flight.session.summary().usedRequests, 1); assert.equal(flight.session.summary().reservedOutputTokens, 512);
  assert.equal(flight.session.summary().records[0].status, 'cancelled'); assert.equal(flight.session.summary().records[0].outputComplete, false);

  // Host teardown unsubscribes before closing the session. No callback may
  // enqueue another segment or turn an ended run into a live model wait.
  const ended = make(), endedJob = ended.host.enqueueWorkflow(['checkA']);
  await until(() => ended.host.waitingModelTests().length === 1); ended.host.close();
  assert.equal((await complete(endedJob.completion)).status, 'cancelled');
  const endedHistory = JSON.stringify(ended.host.workflowHistory()); ended.session.close();
  await Promise.resolve(); assert.equal(JSON.stringify(ended.host.workflowHistory()), endedHistory); assert.equal(ended.host.waitingModelTests().length, 0);
  assert.equal(forbiddenIo, 0);
  console.log('S2 model lifecycle passed: synchronous once-only close observation with immutable first cause, broken/unsubscribed/late listener isolation; direct close and provider overusage retire all model waits/approvals, block only dependencies, preserve independent local/human branches and exact reservations; pre-dispatch close sends nothing, in-flight close rejects late success, no replay/reset/refund, ended-host teardown never reschedules. Synthetic injected IO only; not live-model or browser acceptance.');
} finally {
  hosts.forEach(host => host.close()); sessions.forEach(session => session.close()); globalThis.fetch = previousFetch;
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
}
