/** Fully synthetic paid-ledger fixtures; no settings, credentials, source files or network. */
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { createS2Scene, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { prepareS2TaskReplay } from './scene-s2-task-replay';
import { s2TaskCase } from './scene-s2-task-cases';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';

globalThis.fetch = async () => assert.fail('Offline task replay preflight only');
const task = s2TaskCase('human-branch'), scene = createS2Scene(task.request);
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const draft: S2CanvasDefinition = { ...scene.canvasWorkspace!, plugins: [cap('human-input', 'confirm'), cap('text-template', 'render')],
  initial: { ...scene.canvasWorkspace!.initial, execution: { version: 1, nodes: [
    { id: 'confirm', ...cap('human-input', 'confirm'), position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '合成用户确认' } } },
    { id: 'output', ...cap('text-template', 'render'), position: { x: 100, y: 0 }, bindings: { variables: { kind: 'literal', value: {} } } },
  ], links: [{ source: { nodeId: 'confirm', portId: 'decision' }, target: { nodeId: 'output', portId: 'template' } }] } } };
const requests: LlmCallRequest[] = [], responses: LlmCallResponse[] = [];
await assert.rejects(() => designS2Canvas(scene, { review: true, invoke: async request => {
  const input = JSON.parse(request.userInput);
  requests.push(structuredClone(request));
  const response = input.feedback ? { content: JSON.stringify({ repair: { operations: [{ op: 'replace', path: '/goal', value: '仍然类型错误的合成修复' }] } }) }
    : s2DesignFixtureResponse(request, draft);
  const complete = { ...response, diagnostics: { finishReason: 'stop' } } as LlmCallResponse;
  responses.push(complete); return complete;
} }), /类型|端口/);
assert.equal(requests.length, 3);
const provider = { id: 'synthetic', model: 'synthetic-model', origin: 'https://synthetic.invalid' };
const prior = { calls: 10, outputTokensReserved: 33792 }, reserved = requests.reduce((sum, request) => sum + request.maxTokensOverride!, 0);
const usage = { calls: prior.calls + 3, outputTokensReserved: prior.outputTokensReserved + reserved };
const counters = { ipc: { calls: 0, tokens: 0 }, http: { calls: 0, tokens: 0 } }, dispatch: any[] = [];
for (const request of requests) for (const kind of ['ipc', 'http'] as const) {
  counters[kind].calls++; counters[kind].tokens += request.maxTokensOverride!;
  dispatch.push({ kind, tokens: request.maxTokensOverride, usage: { calls: prior.calls + Math.max(counters.ipc.calls, counters.http.calls),
    outputTokensReserved: prior.outputTokensReserved + Math.max(counters.ipc.tokens, counters.http.tokens) } });
}
const fixture = { task, provider, requests, responses, dispatch, inheritedUsage: usage,
  manifest: { kind: 's2-real-agent-validation', profile: 'ui-chain', taskCaseId: task.id, taskBuildPreviewOnly: true,
    syntheticOnly: true, productionWrites: 0, provider, approval: { maxCalls: 24, reservedOutputTokens: 48000 }, prior,
    resumedSameApprovalPaidPrefix: false },
  report: { profile: 'ui-chain', taskCaseId: task.id, caseId: task.id, taskBuildPreviewOnly: true, productionWrites: 0, provider,
    execution: 'real-provider', replayedExactPaidRequests: 0, automaticTransportRetries: 0, buildAccepted: false, buildPreviewPassed: false,
    interactionPassed: false, passed: false, browserTested: false, stopped: 'build-stage-failed', judgeCalls: 0,
    steps: [], workflows: [], receipts: [], humanActions: [], approvalUsage: usage,
    dispatchAudit: { ipc: { calls: 3, tokens: reserved }, http: { calls: 3, tokens: reserved } } } };
const original = JSON.stringify(fixture), result = await prepareS2TaskReplay(fixture);
assert.equal(JSON.stringify(fixture), original);
assert.deepEqual(result.entries, requests.slice(0, 2).map((request, index) => ({ request, response: responses[index] })));
assert.equal(result.preflight.prefixRequestsVerified, 2); assert.equal(result.preflight.freshBuildTested, false);
assert.equal(result.preflight.wholeChainTested, false); assert.equal(result.preflight.browserTested, false);
assert.deepEqual(result.preflight.connectionIssuePaths, ['/initial/execution/links/0']);
result.entries[0].request.userInput = '{}'; assert.equal(JSON.stringify(fixture), original, 'Replay results are detached from paid source records');
const redundantCloser = structuredClone(fixture); redundantCloser.responses[1].content += '}';
const recovered = await prepareS2TaskReplay(redundantCloser);
assert.equal(recovered.entries[1].response.content, redundantCloser.responses[1].content, 'Use existing production parsing without rewriting paid response bytes');

// A pure business-structure failure can reuse the same two paid stages too.
// It still must hit the real current validator, not a supplied diagnostic or accepted graph.
const structuralFixture = structuredClone(fixture);
structuralFixture.requests = []; structuralFixture.responses = [];
await assert.rejects(() => designS2Canvas(scene, { review: true, invoke: async request => {
  structuralFixture.requests.push(structuredClone(request));
  const input = JSON.parse(request.userInput);
  const reply = input.feedback ? { content: JSON.stringify({ repair: { operations: [{ op: 'replace', path: '/goal', value: 'Still incomplete' }] } }) }
    : s2DesignFixtureResponse(request, scene.canvasWorkspace!);
  if (input.stage === 'assemble' && !input.feedback) {
    const candidate = JSON.parse(reply.content); candidate.business.completion.coverage = []; reply.content = JSON.stringify(candidate);
  }
  const response = { ...reply, diagnostics: { finishReason: 'stop' } } as LlmCallResponse;
  structuralFixture.responses.push(response); return response;
} }), /覆盖|业务步骤/);
assert.equal(structuralFixture.requests.length, 3);
const structuralReplay = await prepareS2TaskReplay(structuralFixture);
assert.deepEqual(structuralReplay.preflight.connectionIssuePaths, []);
assert.ok(structuralReplay.preflight.businessIssuePaths.includes('/business/completion/coverage'));
assert.equal(structuralReplay.preflight.freshBuildTested, false);

const noDiagnostic = structuredClone(fixture);
noDiagnostic.requests = []; noDiagnostic.responses = [];
await assert.rejects(() => designS2Canvas(scene, { review: true, invoke: async request => {
  noDiagnostic.requests.push(structuredClone(request));
  const input = JSON.parse(request.userInput), reply = s2DesignFixtureResponse(request, scene.canvasWorkspace!);
  if (input.stage === 'assemble') {
    const candidate = JSON.parse(reply.content); candidate.initial.plugins = []; reply.content = JSON.stringify(candidate);
  }
  const response = { ...reply, diagnostics: { finishReason: 'stop' } } as LlmCallResponse;
  noDiagnostic.responses.push(response); return response;
} }), /plugins/);
await assert.rejects(() => prepareS2TaskReplay(noDiagnostic), /actual current connection or business structural diagnostic/);

const mutations: Array<(value: typeof fixture) => void> = [
  value => { value.manifest.syntheticOnly = false; }, value => { value.manifest.productionWrites = 1; },
  value => { value.report.productionWrites = 1; }, value => { value.report.passed = true; },
  value => { value.report.buildAccepted = true; }, value => { value.report.interactionPassed = true; },
  value => { value.report.browserTested = true; }, value => { value.manifest.taskBuildPreviewOnly = false; },
  value => { value.report.taskCaseId = 'structured-display'; }, value => { value.manifest.provider = { ...value.manifest.provider, model: 'foreign' }; },
  value => { value.report.replayedExactPaidRequests = 2; }, value => { value.manifest.resumedSameApprovalPaidPrefix = true; },
  value => { value.report.automaticTransportRetries = 1; }, value => { value.report.stopped = 'transport-failed'; },
  value => { value.inheritedUsage.outputTokensReserved++; }, value => { value.manifest.approval.reservedOutputTokens++; },
  value => { value.requests[2].maxTokensOverride = 6144; }, value => { value.responses[1].diagnostics!.finishReason = 'length'; },
  value => { value.dispatch.pop(); }, value => { value.dispatch[0].tokens++; },
  value => { value.dispatch[1].usage.calls--; }, value => { value.report.dispatchAudit.ipc.tokens--; },
  value => { value.requests[0].skipProfileInjection = false; },
  value => { value.task.request.extraHints += '\n改成另一个任务'; },
  value => { value.requests[0].systemPromptOverride += '\n篡改已付费原请求'; },
];
for (const [index, mutate] of mutations.entries()) {
  const changed = structuredClone(fixture); mutate(changed);
  await assert.rejects(() => prepareS2TaskReplay(changed), `Changed scope/provenance/budget/context ${index} must fail without a real dispatch`);
}
const outputShort = structuredClone(fixture), outputDelta = 48000 - 3500 - usage.outputTokensReserved;
outputShort.manifest.prior.outputTokensReserved += outputDelta;
outputShort.report.approvalUsage.outputTokensReserved += outputDelta;
outputShort.dispatch.forEach(row => { row.usage.outputTokensReserved += outputDelta; });
await assert.rejects(() => prepareS2TaskReplay(outputShort), /Need room/, 'Unused request count cannot replace the missing output reservation for repair plus independent review');
console.log(`S2 task replay preflight passed: ${mutations.length} source/scope/budget/request tamper rejections, exact paid prefix through real builder, current local connection diagnostic, immutable original and no accepted/handwritten substitute. Offline only; no model or browser acceptance.`);
