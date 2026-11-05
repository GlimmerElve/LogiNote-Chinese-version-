import assert from 'node:assert/strict';
import { build } from 'esbuild';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import type { SceneInteractionPack } from '../src/types/sceneInteractionPack';
import type { S2PluginCapability, S2PluginInvocation, S2PluginManifest, S2PluginPort } from '../src/types/sceneS2Plugin';
import { isS2ModelSessionCapability, S2_MODEL_SESSION_BRIDGE } from '../src/services/scene/sceneS2ModelBridge';
import { installSceneInteractionCapabilities, isInstalledS2ModelSession, s2BuiltinPluginInstallation, s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';
import { snapshotS2AssistantContext } from '../src/services/scene/sceneS2AssistantSnapshot';
import { readS2ContextArtifact, readS2ContextTrial } from '../src/services/scene/sceneS2ArtifactAccess';
import { ScenePackProtocolError } from '../src/services/scene/sceneInteractionPackProtocol';

// Run in a fresh process with --no-scene-pack-bootstrap: neither this fixture nor the
// registry/session/host needs prompt-lab's manifests, runtime, UI or policies.
globalThis.fetch = async () => assert.fail('Generic model bridge forbids real model/network calls');
const audited = await build({ entryPoints: ['src/services/scene/sceneS2PluginRegistry.ts', 'src/services/scene/sceneS2ModelTest.ts'],
  outdir: 'output/no-write-model-audit', bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true, logLevel: 'silent' });
assert.deepEqual(Object.keys(audited.metafile!.inputs).filter(file => /interaction-packs|sceneS2TextTemplate/.test(file)), [],
  'Production registry and model-session dependency graphs must contain no business package implementation');
const registry = s2BuiltinPluginRegistry();
assert(!registry.catalog().some(plugin => ['text-template', 'model-test'].includes(plugin.id)), 'Business manifests must not be builtin registrations');
const port = (id: string, type: string, required: boolean): S2PluginPort => ({ id, label: id, meaning: '通用宿主接口数据',
  type: { id: type, version: 1 }, required, multiple: false });
const model: S2PluginCapability = { id: 'respond', kind: 'action', meaning: '独立交互包的通用模型响应',
  inputs: [port('prompt', 'core.text', true), port('input', 'core.text', false), port('image', 'core.image', false),
    port('maxOutputTokens', 'core.number', false), port('temperature', 'core.number', false), port('thinkingMode', 'core.text', false)],
  outputs: [port('text', 'core.text', true)], effect: 'external', permissions: ['model-call'], confirmation: 'per-call', retry: 'manual-only', timeoutMs: 120000 };
const manifest: S2PluginManifest = { protocolVersion: 1, id: 'independent-response', version: '2.3.4', label: '独立模型交互', meaning: '无提示词实验包依赖的合成验收',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [model,
    { id: 'identity', kind: 'transform', meaning: '原样传递完整文本', inputs: [port('text', 'core.text', true)], outputs: [port('text', 'core.text', true)],
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }] };
let localCalls = 0;
const pack: SceneInteractionPack = {
  manifest: { id: 'independent-model-pack', version: '1.0.0', protocolVersion: 1, name: '独立模型包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution', 'model'] },
  capabilities: [manifest],
  describe: () => ({ purpose: '合成通用模型桥验收', components: [], combinations: [], operations: [],
    builder: { assemble: '使用已装配接口', repair: '修复当前画布' }, assistant: { instructions: '按用户要求协作', defaultAllowedOperations: [] } }),
  validate: () => [],
  createRuntime: (_config, host) => ({ updateConfig: config => host.applyConfig(config), dispatch: () => undefined,
    run: (...args) => host.run(...args), dispose: () => host.close() }),
  executeLocal: async (call, inputs) => {
    assert.equal(call.capabilityId, 'identity', 'External model calls never execute package local code'); localCalls++;
    return { status: 'succeeded', outputs: { text: [{ protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'core.text', version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, revision: call.revision, nodeId: call.nodeId, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value: inputs.text[0] } }] } };
  },
};
assert.equal(isS2ModelSessionCapability(model), true); assert.equal(S2_MODEL_SESSION_BRIDGE.protocolVersion, 1);
const originalCatalog = registry.catalog();
const denied = (mutate: (value: SceneInteractionPack) => void) => {
  const candidate = { ...pack, manifest: structuredClone(pack.manifest), capabilities: structuredClone(pack.capabilities) };
  candidate.capabilities[0].id = 'rejected-model'; mutate(candidate);
  assert.throws(() => installSceneInteractionCapabilities(candidate), error =>
    error instanceof ScenePackProtocolError
      ? error.code === 'PACK_CONTRACT_CAPABILITY' && error.path.startsWith('/capabilities/0/')
      : error instanceof Error && /model-session@1|不兼容|字段|类型/.test(error.message));
  assert.deepEqual(registry.catalog(), originalCatalog, 'Registration is atomic, including valid siblings of an invalid model bridge');
};
denied(value => { value.manifest.requiredServices = ['execution']; });
for (const mutate of [
  (value: S2PluginCapability) => { value.permissions.push('network'); },
  (value: S2PluginCapability) => { value.confirmation = 'none'; },
  (value: S2PluginCapability) => { value.retry = 'same-idempotency-key'; },
  (value: S2PluginCapability) => { value.timeoutMs = 119999; },
  (value: S2PluginCapability) => { value.inputs.pop(); },
  (value: S2PluginCapability) => { value.inputs[0].required = false; },
  (value: S2PluginCapability) => { value.inputs[0].multiple = true; },
  (value: S2PluginCapability) => { value.inputs[0].type.version = 2; },
  (value: S2PluginCapability) => { value.outputs[0].required = false; },
  (value: S2PluginCapability) => { value.outputs.push(port('extra', 'core.text', true)); },
]) denied(value => mutate(value.capabilities[0].capabilities[0]));
installSceneInteractionCapabilities(pack);
const modelRef = { pluginId: manifest.id, pluginVersion: manifest.version, capabilityId: model.id };
assert.deepEqual(s2BuiltinPluginInstallation().descriptor(modelRef), { kind: 'model', bridge: S2_MODEL_SESSION_BRIDGE.implementation });
assert.equal(isInstalledS2ModelSession(modelRef), true);
assert.equal(isInstalledS2ModelSession({ ...modelRef, pluginVersion: '9.9.9' }), false);
assert(!registry.catalog().some(plugin => ['text-template', 'model-test'].includes(plugin.id)));
const identityRef = { ...modelRef, capabilityId: 'identity' }, displayRef = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
const definition: S2CanvasDefinition = { version: 1, goal: '任意ID交互包使用通用模型会话', instructions: { understanding: '理解', planning: '核对', response: '显示原文' },
  blockTypes: [{ id: 'text', label: '通用内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }], plugins: [identityRef, modelRef, displayRef],
  initial: { nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: '独立包的完整系统文本 {{raw}}' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'local', ...identityRef, position: { x: 200, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'source', fieldId: 'content' } } },
      { id: 'respond', ...modelRef, position: { x: 400, y: 0 }, bindings: { input: { kind: 'literal', value: '独立包的完整用户文本 $&' } } },
      { id: 'afterA', ...identityRef, position: { x: 600, y: 0 }, bindings: {} },
      { id: 'afterB', ...identityRef, position: { x: 800, y: 0 }, bindings: {} },
      { id: 'show', ...displayRef, position: { x: 1000, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'local', portId: 'text' }, target: { nodeId: 'respond', portId: 'prompt' } },
      { source: { nodeId: 'respond', portId: 'text' }, target: { nodeId: 'afterA', portId: 'text' } },
      { source: { nodeId: 'afterA', portId: 'text' }, target: { nodeId: 'afterB', portId: 'text' } },
      { source: { nodeId: 'afterB', portId: 'text' }, target: { nodeId: 'show', portId: 'text' } }] } } };
const host = new S2PluginHost('independent-model-scene', definition); host.setDocument(definition.initial);
let sends = 0;
const session = new S2ModelTestSession({ sceneId: 'independent-model-scene', runId: host.runId, resourceId: 'independent-model-resource', providerId: 'synthetic', providerLabel: '合成传输', model: 'synthetic',
  limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 },
  invoke: async request => { sends++; assert.equal(request.systemPromptOverride, '独立包的完整系统文本 {{raw}}');
    assert.equal(request.userInput, '独立包的完整用户文本 $&'); return { content: '独立模型原始返回', diagnostics: { finishReason: 'stop' } }; } });
try {
  for (const reason of ['authorization-missing', 'authorization-closed', 'budget-exhausted', 'user-declined']) {
    const issue = s2RuntimeIssue(definition, definition.initial, 'respond', { kind: 'model-request', reason });
    assert.equal(issue?.kind, 'model-request'); assert.deepEqual(issue.nodeIds, ['respond']);
    assert.equal(s2RuntimeIssue(definition, definition.initial, 'local', { kind: 'model-request', reason }), null,
      'Pure capabilities cannot acquire model diagnostics by claiming the same business plugin ID');
  }
  assert.equal(s2RuntimeIssue(definition, definition.initial, 'respond', { kind: 'model-request', reason: 'unknown' }), null);
  assert.equal(s2RuntimeIssue(definition, definition.initial, 'respond', { kind: 'model-request', reason: 'budget-exhausted', text: 'forged body' }), null);
  assert.throws(() => host.enqueueWorkflow(['show']), /批准|预算/); assert.equal(sends, 0);
  host.approveModelTestSession(session);
  const waitForModel = async () => {
    for (let i = 0; i < 100 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const wait = host.waitingModelTests()[0]; assert(wait); return wait;
  };
  const declined = host.enqueueWorkflow(['show']), declinedWait = await waitForModel();
  assert.equal(sends, 0); host.confirmModelTest(declined.id, declinedWait.id, false);
  assert.notEqual((await declined.completion).status, 'succeeded'); assert.equal(session.summary().usedRequests, 0);
  const job = host.enqueueWorkflow(['show']), wait = await waitForModel();
  assert.equal(wait.prompt, '独立包的完整系统文本 {{raw}}'); assert.equal(wait.input, '独立包的完整用户文本 $&');
  assert.equal(sends, 0); assert.equal(session.summary().usedRequests, 0);
  const frame = host.prepare('source', { goal: definition.goal, ...definition.instructions }, '不得绕过确认');
  await assert.rejects(host.execute({ nodeId: 'respond', ...modelRef, inputs: { prompt: [frame.bindings[0].artifactId] }, reason: '越过图确认' }, frame.frame, 'direct-denied'), /须通过执行图|不能单次调用|确认/);
  assert.equal(sends, 0); assert.equal(session.summary().usedRequests, 0);
  host.confirmModelTest(job.id, wait.id, true);
  const completed = await job.completion; assert.equal(completed.status, 'succeeded'); assert.equal(sends, 1);
  const shown = completed.nodes.find(node => node.nodeId === 'show')!;
  assert.equal((host.currentArtifact(shown.artifactIds[0]).payload as any).value, '独立模型原始返回');
  assert.equal(localCalls, 3, 'The upstream pure sibling is reused, with two later local calls; model replies never enter the pure cache');
  const prepared = host.prepare(null, { goal: definition.goal, ...definition.instructions }, '只读分析原始模型结果');
  prepared.frame.event = { id: 'GenericModelCompleted', kind: 'workflow-completed', workflowRunId: completed.id };
  const evidenceLifetime = new AbortController(), pinned = snapshotS2AssistantContext(prepared, evidenceLifetime.signal);
  const modelNode = completed.nodes.find(node => node.nodeId === 'respond')!, tailA = completed.nodes.find(node => node.nodeId === 'afterA')!;
  assert.equal(readS2ContextTrial(pinned, modelNode.invocationId!).capability.pluginId, manifest.id,
    'Any installed model bridge receives priority in the bounded two-trial assistant evidence pool, ahead of later local calls');
  assert.equal(readS2ContextArtifact(pinned, modelNode.artifactIds[0]).text, '独立模型原始返回');
  assert.throws(() => readS2ContextTrial(pinned, tailA.invocationId!), /未提供该完整试验档案/,
    'Evidence limits remain bounded instead of copying all later calls');
  evidenceLifetime.abort(); assert.throws(() => readS2ContextArtifact(pinned, modelNode.artifactIds[0]), /已关闭或结束/);
  const direct: S2PluginInvocation = { protocolVersion: 1, id: 'forged-call', sceneId: 'independent-model-scene', runId: host.runId, revision: 1,
    nodeId: 'respond', ...identityRef, idempotencyKey: 'forged-call', inputs: { prompt: ['prompt-artifact'] } };
  assert.throws(() => session.execute(direct, { prompt: ['不得借用纯能力发模型请求'] }, new AbortController().signal), /没有已安装的model-session@1/);
  const exhausted = host.enqueueWorkflow(['show']);
  assert.notEqual((await exhausted.completion).status, 'succeeded'); assert.equal(sends, 1, 'Budget exhaustion cannot send or reserve another model call');
  assert.equal(session.summary().reservedOutputTokens, 512);
  console.log('Generic model-session@1 passed without prompt packages: empty business registry, arbitrary capability ID/version, explicit model service + closed ABI negotiation, atomic unsafe-contract rejection, local siblings, model authorization/confirmation/decline/budget/direct-call guards, generic runtime diagnostics, bounded assistant evidence priority and lifetime, and exact raw response through the real host. Synthetic transport only.');
} finally { host.close(); session.close(); }
