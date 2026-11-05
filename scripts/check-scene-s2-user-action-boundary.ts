import assert from 'node:assert/strict';
import type { SceneInteractionPack, ScenePackHostServices, ScenePackRun } from '../src/types/sceneInteractionPack';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { enqueueSceneInteractionUserWorkflow, enqueueSceneInteractionWorkflow, closeSceneInteractionHost } from '../src/services/scene/sceneInteractionHostServices';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';

// Exercise the real package-validation/runtime/service/Host/session chain. Only
// the transport is synthetic; no fixture rewrites the production authority path.
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Bounded user actions forbid real model/network calls');
const hosts: S2PluginHost[] = [], sessions: S2ModelTestSession[] = [];
let sequence = 0;
const model = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
const modelManifest = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' }).capabilities.find(item => item.id === model.pluginId)!;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(done: () => boolean) { for (let i = 0; i < 400; i++) { if (done()) return; await tick(); } assert.fail('Synthetic boundary check did not settle'); }
type Hooks = { construct?: (services: ScenePackHostServices) => void; run?: (services: ScenePackHostServices, targets?: string[]) => ScenePackRun; invalid?: boolean; result?: boolean };
function fixture(hooks: Hooks = {}, grant = true) {
  const id = `synthetic-action-boundary-${++sequence}`, reference = { id, version: '1.0.0' };
  let validation = 0, construction = 0, runtimeRuns = 0, sends = 0, services!: ScenePackHostServices;
  const sent: string[] = [];
  const pack: SceneInteractionPack = {
    manifest: { ...reference, name: '合成用户动作边界', protocolVersion: 1, paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution', 'model'] },
    capabilities: [structuredClone(modelManifest)],
    describe: () => ({ purpose: '本地合成执行边界', components: [], combinations: [], operations: [], builder: { assemble: '搭建', repair: '修复' }, assistant: { instructions: '协作', defaultAllowedOperations: [] } }),
    validate: config => { validation++; assert.equal(config.definition.goal, id); return hooks.invalid ? [{ path: '/definition', message: 'SYNTHETIC_PACKAGE_REJECTION' }] : []; },
    executeLocal: async () => assert.fail('Model actions must use the terminal session bridge'),
    createRuntime: (_config, value) => {
      construction++; services = value; hooks.construct?.(value);
      return { updateConfig: config => value.applyConfig(config), dispatch: () => undefined,
        run: (targets, notify, options) => { runtimeRuns++; return hooks.run ? hooks.run(value, targets) : value.run(targets, notify, options); }, dispose: () => {} };
    },
  };
  sceneInteractionPacks.register(pack);
  const view = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
  const definition = readS2Definition({ version: 1, goal: id, instructions: { understanding: '理解', planning: '搭建', response: '返回' },
    blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] }], plugins: [model, ...(hooks.result ? [view] : [])],
    initial: { nodes: [], edges: [], execution: { version: 1, nodes: [
      ...['A', 'B'].map(name => ({ id: name, ...model, position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal' as const, value: `EXACT_${name}` } } })),
      ...(hooks.result ? [{ id: 'View', ...view, position: { x: 1, y: 1 }, bindings: {} }] : []),
    ], links: hooks.result ? [{ source: { nodeId: 'A', portId: 'text' }, target: { nodeId: 'View', portId: 'text' } }] : [] } } });
  const host = new S2PluginHost(id, definition); hosts.push(host); host.setDocument(definition.initial);
  if (grant) { const session = new S2ModelTestSession({ sceneId: id, runId: host.runId, resourceId: `resource-${id}`, providerId: 'synthetic', providerLabel: '合成服务', model: 'synthetic',
    limits: { maxRequests: 10, maxOutputTokens: 512, maxReservedOutputTokens: 5120 },
    invoke: async request => { sends++; sent.push(request.systemPromptOverride!); return { content: `SYNTHETIC_${sends}`, diagnostics: { finishReason: 'stop' } }; } }); sessions.push(session); host.approveModelTestSession(session); }
  const config = { definition, document: definition.initial };
  return { host, config, reference, counts: () => ({ validation, construction, runtimeRuns, sends }), sent, services: () => services,
    direct: (targets = ['A']) => enqueueSceneInteractionUserWorkflow(host, config, reference, targets) };
}
async function decline(value: ReturnType<typeof fixture>, job?: ScenePackRun) {
  await until(() => value.host.waitingModelTests().some(wait => !job || wait.workflowId === job.id));
  const wait = value.host.waitingModelTests().find(wait => !job || wait.workflowId === job.id)!; value.host.confirmModelTest(wait.workflowId, wait.id, false);
}
try {
  const direct = fixture(), job = direct.direct();
  await until(() => direct.host.workflowHistory().at(-1)?.status === 'succeeded'); await job.completion;
  assert.deepEqual(direct.counts(), { validation: 1, construction: 1, runtimeRuns: 1, sends: 1 }); assert.deepEqual(direct.sent, ['EXACT_A']); assert.deepEqual(direct.host.waitingModelTests(), []);
  assert.equal((direct.services() as any).enqueueWorkflow, undefined); assert.equal((direct.services() as any).approveModelTestSession, undefined);

  const rendered = fixture({ result: true, run: (service, targets) => service.run([...targets!, 'View']) });
  const renderedJob = await rendered.direct().completion as any;
  assert.equal(renderedJob.status, 'succeeded'); assert.deepEqual(rendered.sent, ['EXACT_A']);
  assert.equal(renderedJob.nodes.find((node: any) => node.nodeId === 'View').status, 'displayed', 'Appending a connected pure renderer preserves the one-shot click and displays the actual result');
  const extraModel = fixture({ run: service => service.run(['A', 'B']) });
  const extraModelJob = extraModel.direct(); await decline(extraModel); await decline(extraModel); await extraModelJob.completion;
  assert.deepEqual(extraModel.sent, [], 'Appending a second model must never inherit a click intended for A');

  const rejected = fixture({ invalid: true }); assert.throws(() => rejected.direct(), /SYNTHETIC_PACKAGE_REJECTION/);
  assert.deepEqual(rejected.counts(), { validation: 1, construction: 0, runtimeRuns: 0, sends: 0 }); assert.deepEqual(rejected.host.workflowHistory(), []);
  const missingGrant = fixture({}, false); assert.throws(() => missingGrant.direct(), /单独批准/); assert.equal(missingGrant.counts().sends, 0);

  const forged = fixture();
  const ordinary = enqueueSceneInteractionWorkflow(forged.host, forged.config, forged.reference, ['A'], undefined, { force: true, modelConfirmation: 'user-action' } as any);
  await decline(forged); await ordinary.completion; assert.equal(forged.counts().sends, 0, 'Package JavaScript options cannot opt in');
  const foreignService = forged.services().run(['B'], undefined, { modelConfirmation: 'user-action' } as any);
  await decline(forged); await foreignService.completion; assert.equal(forged.counts().sends, 0);
  const plain = fixture();
  const unbound = enqueueSceneInteractionWorkflow(plain.host, plain.config, null, ['A'], undefined, { modelConfirmation: 'user-action' } as any);
  await decline(plain); await unbound.completion; assert.equal(plain.counts().sends, 0, 'An unbound ordinary canvas also rejects extra mode options');

  let constructorJob!: ScenePackRun;
  const constructor = fixture({ construct: service => { constructorJob = service.run(['A']); } });
  const constructorDirect = constructor.direct(); await decline(constructor); await constructorJob.completion; await constructorDirect.completion;
  assert.deepEqual(constructor.sent, ['EXACT_A'], 'Construction cannot inherit direct authority; only the selected runtime scheduling call sends');

  let otherJob!: ScenePackRun, repeatedJob!: ScenePackRun, asynchronousJob!: ScenePackRun;
  const extras = fixture({ run: (service, targets) => {
    otherJob = service.run(['B']); const selected = service.run(targets);
    repeatedJob = service.run(targets); queueMicrotask(() => { asynchronousJob = service.run(['A']); }); return selected;
  } });
  const selected = extras.direct(); await decline(extras, otherJob); await otherJob.completion; await selected.completion;
  await decline(extras, repeatedJob); await repeatedJob.completion; await until(() => !!asynchronousJob); await decline(extras, asynchronousJob); await asynchronousJob.completion;
  assert.deepEqual(extras.sent, ['EXACT_A']); assert.equal(extras.host.workflowHistory().length, 4);

  let asynchronousConstructorJob!: ScenePackRun;
  const asyncConstructor = fixture({ construct: service => { queueMicrotask(() => { asynchronousConstructorJob = service.run(['B']); }); } });
  await asyncConstructor.direct().completion; await until(() => !!asynchronousConstructorJob); await decline(asyncConstructor); await asynchronousConstructorJob.completion;
  assert.deepEqual(asyncConstructor.sent, ['EXACT_A']);

  let hooksRun = 0;
  const malformedTargets: unknown[] = [Object.assign(['B'], { toJSON() { hooksRun++; return ['A']; } }),
    Object.assign(['B'], { [Symbol.iterator]: function* () { hooksRun++; yield 'A'; } }), ['A', 'A'], ['A', , 'B'], Object.create(['A'])];
  const getterArray = ['B']; Object.defineProperty(getterArray, '0', { enumerable: true, get() { hooksRun++; return 'A'; } }); malformedTargets.push(getterArray);
  for (const bad of malformedTargets) {
    const value = fixture({ run: service => service.run(bad as string[]) });
    assert.throws(() => value.direct(), /运行目标/); assert.equal(value.counts().sends, 0); assert.deepEqual(value.host.workflowHistory(), []);
    assert.throws(() => value.direct(bad as string[]), /运行目标/);
  }
  assert.equal(hooksRun, 0, 'Target validation never invokes attacker getters/toJSON/iterators');
  const mutated = fixture({ run: (service, targets) => { const selected = service.run(targets); targets![0] = 'B'; return selected; } });
  await mutated.direct().completion; assert.deepEqual(mutated.sent, ['EXACT_A'], 'Scheduling uses a detached exact target snapshot');
  console.log('S2 bounded user action passed: actual package validation/runtime preserved, one matching synchronous schedule only, constructor/async/extra/foreign-target/default/Agent-style and unbound options stay confirmation-gated, hostile target descriptors and spoofing rejected without callbacks, exact target snapshot and missing session protected. Synthetic transport only.');
} finally { hosts.forEach(closeSceneInteractionHost); sessions.forEach(session => session.close()); globalThis.fetch = priorFetch; }
