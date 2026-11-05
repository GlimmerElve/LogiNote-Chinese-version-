import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import type { S2Document } from '../src/types/sceneS2';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { readS2ModelTestParameters, S2ModelTestSession, type S2ModelTestParameterInput } from '../src/services/scene/sceneS2ModelTest';
import { supportsS2ThinkingControl } from '../src/services/scene/sceneS2ModelTransport';
import { readS2ContextTrial } from '../src/services/scene/sceneS2ArtifactAccess';

const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic parameter test forbids network'); };
const hosts: S2PluginHost[] = [], sessions: S2ModelTestSession[] = [];
const model = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
function document(parameters: S2ModelTestParameterInput = {}): S2Document {
  return { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'request', ...model, position: { x: 0, y: 0 },
    bindings: { prompt: { kind: 'literal', value: ' 任意用户原文 {{literal}}\n' }, input: { kind: 'literal', value: ' 独立材料\n' },
      ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { kind: 'literal', value }])) } }], links: [] } };
}
function setup(supportsThinking = false, completionTokens = 10) {
  const requests: LlmCallRequest[] = [], host = new S2PluginHost('parameter-scene', [model]); hosts.push(host);
  const session = new S2ModelTestSession({ sceneId: 'parameter-scene', runId: host.runId, resourceId: 'SyntheticParameterModel', providerId: 'synthetic',
    providerLabel: '合成参数服务', model: 'fixed-synthetic-model', supportsThinking,
    limits: { maxRequests: 3, maxOutputTokens: 512, maxReservedOutputTokens: 1536 }, invoke: async request => {
      requests.push(structuredClone(request)); return { content: '  原始模型返回\n', diagnostics: { finishReason: 'stop' }, usage: { promptTokens: 12, completionTokens } };
    } }); sessions.push(session); host.approveModelTestSession(session); return { host, session, requests };
}
async function wait(host: S2PluginHost) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const current = host.waitingModelTests()[0]; if (current) return current;
    if (['failed', 'cancelled', 'succeeded'].includes(host.workflowHistory().at(-1)?.status ?? '')) assert.fail('Expected parameter confirmation wait');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Synthetic parameter wait did not settle');
}
try {
  // Match the already implemented llmService transport gate, not URL resemblance
  // or unsupported model-name guessing. This helper never loads configuration.
  for (const [baseUrl, expected] of [['https://api.deepseek.com/v1', true], ['https://deepseek.com/v1', true], ['https://DEEPSEEK.COM', true],
    ['https://deepseek.com.attacker.invalid', false], ['https://notdeepseek.com', false], ['invalid-url', false]] as const) {
    assert.equal(supportsS2ThinkingControl({ apiType: 'openai-compatible', baseUrl }), expected);
  }
  assert.equal(supportsS2ThinkingControl({ apiType: 'anthropic', baseUrl: 'https://api.deepseek.com' }), false);
  assert.deepEqual(readS2ModelTestParameters({}, 512, false), { maxOutputTokens: 512 });
  for (const bad of [{ maxOutputTokens: 255 }, { maxOutputTokens: 513 }, { maxOutputTokens: 256.5 }, { maxOutputTokens: '256' },
    { temperature: -0.01 }, { temperature: 2.01 }, { temperature: NaN }, { temperature: Infinity }, { temperature: '0' },
    { thinkingMode: 'auto' }, { thinkingMode: false }, { temperature: undefined }, { unknown: 1 }]) {
    assert.throws(() => readS2ModelTestParameters(bad, 512, true));
  }
  assert.throws(() => readS2ModelTestParameters({ thinkingMode: 'disabled' }, 512, false), /未明确支持/);
  assert.deepEqual(readS2ModelTestParameters({ maxOutputTokens: 256, temperature: 0, thinkingMode: 'enabled' }, 512, true),
    { maxOutputTokens: 256, temperature: 0, thinkingMode: 'enabled' });
  assert.throws(() => readS2ModelTestParameters(Object.defineProperty({}, 'temperature', { enumerable: true, get() { assert.fail('Parameter getters cannot run'); } }), 512, true));
  const bounded = new S2ModelTestSession({ sceneId: 'parameter-scene', runId: 'budget-preview', resourceId: 'SyntheticContextBudget', providerId: 'synthetic', providerLabel: '合成', model: 'fixed',
    contextWindowTokens: 4096, limits: { maxRequests: 1, maxOutputTokens: 2048, maxReservedOutputTokens: 2048 }, invoke: async () => assert.fail('Context preview cannot send') }); sessions.push(bounded);
  assert.throws(() => bounded.preview('中'.repeat(2000)), /上下文|预算|context/);
  const fitted = bounded.preview('中'.repeat(2000), '', [], { maxOutputTokens: 256 });
  assert.equal(fitted.contextBudget!.outputReserveTokens, 256); assert.equal(fitted.reservationOutputTokens, 2048);

  const identity = setup(true), identitySignal = new AbortController().signal;
  const invocation = { protocolVersion: 1 as const, id: 'ParameterIdentity', sceneId: 'parameter-scene', runId: identity.host.runId, nodeId: 'request', revision: 0,
    ...model, idempotencyKey: 'ParameterIdentityKey', inputs: { prompt: ['prompt-id'], temperature: ['temperature-id'], thinkingMode: ['thinking-id'] } };
  const values = { prompt: ['原文'], temperature: [0], thinkingMode: ['disabled'] };
  assert.equal((await identity.session.execute(invocation, values, identitySignal)).status, 'succeeded');
  assert.equal((await identity.session.execute(structuredClone(invocation), structuredClone(values), identitySignal)).status, 'succeeded');
  assert.equal(identity.requests.length, 1, 'Identical parameter confirmation remains idempotent');
  assert.throws(() => identity.session.execute(invocation, { ...values, temperature: [0.1] }, identitySignal), /幂等键|更换/);
  assert.throws(() => identity.session.execute({ ...invocation, inputs: { ...invocation.inputs, thinkingMode: ['another-thinking-id'] } }, values, identitySignal), /幂等键|更换/);
  assert.equal(identity.requests.length, 1); assert.equal(identity.session.summary().usedRequests, 1);

  const normal = setup(); normal.host.setDocument(document());
  const normalJob = normal.host.enqueueWorkflow(['request']), normalWait = await wait(normal.host);
  assert.deepEqual(normalWait.parameters, { maxOutputTokens: 512 }); assert.equal(normalWait.reservationOutputTokens, 512);
  normal.host.confirmModelTest(normalJob.id, normalWait.id, true); assert.equal((await normalJob.completion).status, 'succeeded');
  assert.equal(normal.requests[0].maxTokensOverride, 512); assert.equal(normal.requests[0].temperatureOverride, undefined); assert.equal(normal.requests[0].thinkingMode, undefined);
  assert.deepEqual(normal.session.summary().records[0].parameters, normalWait.parameters);

  const explicit = setup(true); explicit.host.setDocument(document({ maxOutputTokens: 256, temperature: 0, thinkingMode: 'disabled' }));
  const job = explicit.host.enqueueWorkflow(['request']), preview = await wait(explicit.host);
  assert.equal(explicit.requests.length, 0); assert.equal(explicit.session.summary().usedRequests, 0);
  assert.deepEqual(preview.parameters, { maxOutputTokens: 256, temperature: 0, thinkingMode: 'disabled' });
  assert.equal(preview.maxOutputTokens, 256); assert.equal(preview.reservationOutputTokens, 512, 'Smaller node requests do not relax the authorized conservative ledger');
  preview.parameters.temperature = 1; assert.equal(explicit.host.waitingModelTests()[0].parameters.temperature, 0, 'Preview clones never change request authority');
  explicit.host.confirmModelTest(job.id, preview.id, true); assert.equal((await job.completion).status, 'succeeded');
  assert.throws(() => explicit.host.confirmModelTest(job.id, preview.id, true));
  assert.equal(explicit.requests.length, 1); assert.equal(explicit.requests[0].maxTokensOverride, 256);
  assert.equal(explicit.requests[0].temperatureOverride, 0); assert.equal(explicit.requests[0].thinkingMode, 'disabled');
  assert.equal(explicit.requests[0].systemPromptOverride, ' 任意用户原文 {{literal}}\n'); assert.equal(explicit.requests[0].userInput, ' 独立材料\n');
  assert.equal(explicit.session.summary().reservedOutputTokens, 512);
  assert.deepEqual(explicit.session.summary().records[0].parameters, { maxOutputTokens: 256, temperature: 0, thinkingMode: 'disabled' });
  const context = explicit.host.prepare('request', { goal: '合成参数分析', understanding: '只读', planning: '不执行', response: '如实说明' }, '解释参数');
  const archived = readS2ContextTrial(context, context.trialIndex[0].id);
  assert.equal(archived.model!.maxOutputTokens, 256); assert.equal(archived.model!.reservationOutputTokens, 512);
  assert.deepEqual(archived.model!.parameters, { maxOutputTokens: 256, temperature: 0, thinkingMode: 'disabled' });

  for (const parameters of [{ maxOutputTokens: 513 }, { maxOutputTokens: 256.5 }, { temperature: 2.1 }, { thinkingMode: 'enabled' }] as S2ModelTestParameterInput[]) {
    const rejected = setup(); rejected.host.setDocument(document(parameters));
    assert.equal((await rejected.host.enqueueWorkflow(['request']).completion).status, 'failed');
    assert.equal(rejected.host.waitingModelTests().length, 0); assert.equal(rejected.requests.length, 0);
    assert.equal(rejected.session.summary().usedRequests, 0); assert.equal(rejected.session.summary().reservedOutputTokens, 0);
  }
  const changed = setup(true); changed.host.setDocument(document({ maxOutputTokens: 256, temperature: 0.2 }));
  const oldJob = changed.host.enqueueWorkflow(['request']), oldWait = await wait(changed.host);
  changed.host.setDocument(document({ maxOutputTokens: 256, temperature: 0.3 }));
  assert.equal((await oldJob.completion).status, 'cancelled'); assert.throws(() => changed.host.confirmModelTest(oldJob.id, oldWait.id, true));
  assert.equal(changed.requests.length, 0); assert.equal(changed.session.summary().usedRequests, 0);
  const freshJob = changed.host.enqueueWorkflow(['request']), freshWait = await wait(changed.host);
  assert.equal(freshWait.parameters.temperature, 0.3);
  changed.host.confirmModelTest(freshJob.id, freshWait.id, true); assert.equal((await freshJob.completion).status, 'succeeded');
  assert.equal(changed.requests[0].temperatureOverride, 0.3);

  const overuse = setup(true, 257); overuse.host.setDocument(document({ maxOutputTokens: 256 }));
  const overJob = overuse.host.enqueueWorkflow(['request']), overWait = await wait(overuse.host);
  overuse.host.confirmModelTest(overJob.id, overWait.id, true); assert.equal((await overJob.completion).status, 'failed');
  assert.equal(overuse.session.summary().active, false, 'Usage is checked against actual requested output, not the larger approval ceiling');
  assert.equal(overuse.session.summary().records[0].output, '  原始模型返回\n'); assert.equal(overuse.session.summary().reservedOutputTokens, 512);
  assert.equal(network, 0);
  console.log('S2 model parameters passed: exact optional port types, unchanged defaults, fixed transport thinking gate, finite temperature and integer authorized output, actual previews/records/requests, cap-based conservative reservations, no-spend invalid settings, confirmation expiry on edits, actual-output overusage closes permission while preserving text. Synthetic transport only; no model/config/network.');
} finally { hosts.forEach(host => host.close()); sessions.forEach(session => session.close()); globalThis.fetch = priorFetch; }
