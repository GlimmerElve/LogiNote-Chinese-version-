import assert from 'node:assert/strict';
import type { S2Json, S2PluginInvocation, S2PluginManifest } from '../src/types/sceneS2Plugin';
import { S2PluginInstallation, type S2PluginPackage } from '../src/services/scene/sceneS2PluginInstallation';

const originalFetch = globalThis.fetch;
let forbiddenIo = 0, calls = 0;
globalThis.fetch = async () => { forbiddenIo++; throw new Error('Installation checks forbid network'); };
try {
  const manifest: S2PluginManifest = {
    protocolVersion: 1, id: 'synthetic', version: '1.0.0', label: '合成本地能力', meaning: '只用于离线契约检查', dependencies: [],
    dataTypes: [{ id: 'synthetic.value', version: 1, meaning: '合成JSON', schema: { kind: 'json', maxDepth: 8, maxEntries: 2048, maxBytes: 24000 } }],
    capabilities: ['first', 'second'].map(id => ({ id, kind: 'transform', meaning: '合成本地转换',
      inputs: [{ id: 'value', label: '输入', meaning: '完整输入', type: { id: 'synthetic.value', version: 1 }, required: true, multiple: false }],
      outputs: [{ id: 'value', label: '输出', meaning: '完整输出', type: { id: 'synthetic.value', version: 1 }, required: true, multiple: false }],
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 })),
  };
  const makePackage = (): S2PluginPackage => ({ manifest: structuredClone(manifest), implementations: {
    first: { kind: 'local', execute: async (call, inputs, signal) => { calls++; assert.equal(signal.aborted, false); call.id = 'Changed'; inputs.value[0] = { changed: true }; return { deliberatelyUnvalidated: true }; } },
    second: { kind: 'local', execute: async () => { calls++; return 'second exact handler'; } },
  } });
  const ref = { pluginId: 'synthetic', pluginVersion: '1.0.0', capabilityId: 'first' };
  const call = (changes: Partial<S2PluginInvocation> = {}): S2PluginInvocation => ({ protocolVersion: 1, id: 'Invocation', sceneId: 'Scene', runId: 'Run', nodeId: 'Node', revision: 0,
    ...ref, idempotencyKey: 'Key', inputs: { value: ['Artifact'] }, ...changes });
  const controller = new AbortController();
  const input: Record<string, S2Json[]> = { value: [{ values: [0, false, null], missingPreserved: {} }] };
  const source = makePackage(), installation = new S2PluginInstallation([source]);
  assert.equal(calls, 0, 'Constructing and advertising a package cannot invoke its code');
  assert.deepEqual(installation.descriptor(ref), { kind: 'local' });
  assert.equal(JSON.stringify(installation.descriptor(ref)).includes('execute'), false, 'Public descriptors never serialize functions');
  source.manifest.capabilities[0].meaning = 'Changed after registration';
  source.implementations.first = { kind: 'local', execute: async () => { throw new Error('Replacement must not be used'); } };
  assert.equal(installation.registry.capability(ref).meaning, '合成本地转换', 'Manifest source mutation is isolated');
  const catalogue = installation.registry.catalog(); catalogue[0].capabilities[0].outputs.length = 0;
  assert.equal(installation.registry.capability(ref).outputs.length, 1, 'Catalogue is a copy');
  const invocation = call(), originalInvocation = structuredClone(invocation), originalInput = structuredClone(input);
  assert.deepEqual(await installation.execute(invocation, input, controller.signal), { deliberatelyUnvalidated: true }, 'The installation is a dispatcher, not a fake outcome validator');
  assert.deepEqual(invocation, originalInvocation); assert.deepEqual(input, originalInput, 'Adapter mutations cannot modify host inputs');
  assert.equal(await installation.execute(call({ capabilityId: 'second' }), input, controller.signal), 'second exact handler');
  assert.equal(calls, 2);
  for (const changes of [{ pluginId: 'unknown' }, { pluginVersion: '1.0.1' }, { capabilityId: 'unknown' }]) {
    assert.throws(() => installation.descriptor({ ...ref, ...changes }));
    await assert.rejects(() => installation.execute(call(changes), input, controller.signal));
  }
  controller.abort(); await assert.rejects(() => installation.execute(call(), input, controller.signal), /取消/);
  assert.equal(calls, 2, 'Unknown identity and pre-abort dispatch nothing');
  const active = new AbortController();
  const rejection = (change: (value: S2PluginPackage) => void) => { const value = makePackage(); change(value); assert.throws(() => new S2PluginInstallation([value])); };
  rejection(value => { delete value.implementations.first; });
  rejection(value => { value.implementations.unknown = { kind: 'local', execute: async () => null }; });
  rejection(value => { delete value.implementations.first; value.implementations.unknown = { kind: 'local', execute: async () => null }; });
  rejection(value => { value.manifest.capabilities.push(structuredClone(value.manifest.capabilities[0])); });
  assert.throws(() => new S2PluginInstallation([makePackage(), makePackage()]), 'Duplicate package version cannot overwrite an adapter');
  for (const kind of ['editor', 'renderer', 'action', 'human'] as const) rejection(value => { value.manifest.capabilities[0].kind = kind; });
  rejection(value => { value.manifest.capabilities[0].effect = 'read'; });
  rejection(value => { value.manifest.capabilities[0].effect = 'external'; value.manifest.capabilities[0].permissions = ['network']; value.manifest.capabilities[0].confirmation = 'per-call'; });
  rejection(value => { value.implementations.first = { kind: 'host', bridge: 'arbitrary' } as any; });
  rejection(value => { value.implementations.first = { kind: 'local', execute: 'handler.js' } as any; });
  rejection(value => { (value.implementations.first as any).bridge = 'network'; });
  rejection(value => { (value as any).url = 'https://example.invalid/plugin.js'; });
  rejection(value => { value.manifest.capabilities = new Array(1); });
  rejection(value => { (value.manifest.capabilities as any).extra = true; });
  rejection(value => { Object.defineProperty(value.manifest, 'hidden', { value: true }); });
  rejection(value => { (value.implementations as any)[Symbol('hidden')] = { kind: 'local', execute: async () => null }; });
  rejection(value => { value.implementations = Object.create(value.implementations); });
  rejection(value => { value.manifest.dependencies = Object.assign([], { unknown: true }); });
  rejection(value => { value.manifest.meaning = (() => 'bad') as any; });
  let getterCalls = 0;
  for (const path of ['package', 'manifest', 'implementation', 'handler', 'array']) rejection(value => {
    const getter = { enumerable: true, get: () => { getterCalls++; throw new Error('Getter must not run'); } };
    if (path === 'package') Object.defineProperty(value, 'manifest', getter);
    if (path === 'manifest') Object.defineProperty(value.manifest, 'meaning', getter);
    if (path === 'implementation') Object.defineProperty(value.implementations, 'first', getter);
    if (path === 'handler') Object.defineProperty(value.implementations.first, 'execute', getter);
    if (path === 'array') Object.defineProperty(value.manifest.capabilities, '0', getter);
  });
  const getterRef = { ...ref }; Object.defineProperty(getterRef, 'pluginId', { enumerable: true, get: () => { getterCalls++; return 'synthetic'; } });
  assert.throws(() => installation.descriptor(getterRef));
  await assert.rejects(() => installation.execute({ ...call(), inputs: Object.defineProperty({}, 'value', { enumerable: true, get: () => { getterCalls++; return []; } }) }, input, active.signal));
  assert.equal(getterCalls, 0, 'Neither registration nor dispatch executes data accessors');
  assert.equal(calls, 2);
  const validator = makePackage(); validator.manifest.capabilities[0].kind = 'validator'; new S2PluginInstallation([validator]);
  assert.equal(calls, 2, 'Validator registration remains declaration-only');
  const multi = makePackage(); multi.manifest.capabilities[0].inputs[0].multiple = true;
  multi.implementations.first = { kind: 'local', execute: async (_call, inputs) => inputs.value.length };
  const many = { value: Array.from({ length: 32 }, () => Array.from({ length: 1024 }, () => 0)) };
  assert.equal(await new S2PluginInstallation([multi]).execute(call({ inputs: { value: Array.from({ length: 32 }, (_, i) => `Artifact${i}`) } }), many, active.signal), 32,
    'A registration traversal budget must not reject many individually valid complete input artifacts');

  // Exercise every currently installed host-owned descriptor without invoking any real adapter.
  const { s2BuiltinPluginInstallation } = await import('../src/services/scene/sceneS2PluginRegistry');
  const builtin = s2BuiltinPluginInstallation();
  const builtinPackages = (): S2PluginPackage[] => builtin.registry.catalog().map(manifest => ({ manifest, implementations: Object.fromEntries(manifest.capabilities.map(cap => {
    const descriptor = builtin.descriptor({ pluginId: manifest.id, pluginVersion: manifest.version, capabilityId: cap.id });
    return [cap.id, descriptor.kind === 'local' ? { kind: 'local', execute: async () => { throw new Error('No builtin handler runs in installation checks'); } } : descriptor];
  })) }));
  const registered = new S2PluginInstallation(builtinPackages());
  for (const pkg of builtinPackages()) for (const capability of pkg.manifest.capabilities) {
    const binding = { pluginId: pkg.manifest.id, pluginVersion: pkg.manifest.version, capabilityId: capability.id };
    const descriptor = registered.descriptor(binding);
    if (descriptor.kind !== 'local') await assert.rejects(() => registered.execute(call(binding), input, active.signal), /专属控件/);
    const copied = registered.descriptor(binding); (copied as any).kind = 'bad';
    assert.deepEqual(registered.descriptor(binding), descriptor, 'Public descriptor mutation cannot alter registration');
  }
  const badBuiltin = (pluginId: string, capabilityId: string, modify: (pkg: S2PluginPackage, index: number) => void) => {
    const packages = builtinPackages(), pkg = packages.find(pkg => pkg.manifest.id === pluginId)!;
    modify(pkg, pkg.manifest.capabilities.findIndex(cap => cap.id === capabilityId));
    assert.throws(() => new S2PluginInstallation(packages), `Must reject incompatible ${pluginId}/${capabilityId}`);
  };
  badBuiltin('core', 'text', pkg => { pkg.implementations.text = { kind: 'editor', control: 'multiline' }; });
  badBuiltin('core', 'text', pkg => { pkg.implementations.text = { kind: 'editor', control: ['text'] } as any; });
  badBuiltin('core', 'text', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].multiple = true; });
  badBuiltin('core', 'text', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].required = false; });
  badBuiltin('core', 'text', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].type = { id: 'core.number', version: 1 }; });
  badBuiltin('core', 'text', (pkg, i) => { pkg.manifest.capabilities[i].inputs = [structuredClone(pkg.manifest.capabilities[i].outputs[0])]; });
  badBuiltin('structured-view', 'json-tree', pkg => { pkg.implementations['json-tree'] = { kind: 'renderer', view: 'table', portId: 'value' }; });
  badBuiltin('structured-view', 'json-tree', pkg => { pkg.implementations['json-tree'] = { kind: 'renderer', view: 'json-tree', portId: 'unknown' }; });
  badBuiltin('structured-view', 'json-tree', (pkg, i) => { pkg.manifest.capabilities[i].inputs[0].multiple = true; });
  badBuiltin('structured-view', 'json-tree', (pkg, i) => { pkg.manifest.capabilities[i].inputs[0].required = false; });
  badBuiltin('structured-view', 'json-tree', (pkg, i) => { pkg.manifest.capabilities[i].outputs = [structuredClone(pkg.manifest.capabilities[i].inputs[0])]; });
  badBuiltin('structured-view', 'json-tree', pkg => { pkg.implementations['json-tree'] = { kind: 'renderer', view: 'html', portId: 'value' } as any; });
  badBuiltin('structured-view', 'json-tree', pkg => { pkg.implementations['json-tree'] = { kind: 'renderer', view: ['json-tree'], portId: 'value' } as any; });
  badBuiltin('human-input', 'text', pkg => { pkg.implementations.text = { kind: 'human', control: 'json' }; });
  badBuiltin('human-input', 'text', pkg => { pkg.implementations.text = { kind: 'human', control: ['text'] } as any; });
  badBuiltin('human-input', 'json', (pkg, i) => { pkg.manifest.capabilities[i].inputs[1].required = true; });
  badBuiltin('human-input', 'confirm', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].id = 'accepted'; });
  badBuiltin('human-input', 'confirm', (pkg, i) => { pkg.manifest.capabilities[i].retry = 'same-idempotency-key'; });
  badBuiltin('human-input', 'text', pkg => { pkg.manifest.version = '1.0.1'; });
  const modelRelease = builtinPackages();
  modelRelease.find(pkg => pkg.manifest.id === 'model-test')!.manifest.version = '1.0.1';
  const upgradedModel = new S2PluginInstallation(modelRelease);
  assert.equal(upgradedModel.descriptor({ pluginId: 'model-test', pluginVersion: '1.0.1', capabilityId: 'generate' }).kind, 'model',
    'A model-session ABI is independent of business release IDs; the new exact release must be explicitly installed');
  assert.throws(() => upgradedModel.descriptor({ pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' }),
    'Bridge compatibility cannot guess or fall back across exact release versions');
  badBuiltin('model-test', 'generate', pkg => { pkg.implementations.generate = { kind: 'model', bridge: 'network' } as any; });
  badBuiltin('model-test', 'generate', (pkg, i) => { pkg.manifest.capabilities[i].confirmation = 'per-run'; });
  badBuiltin('model-test', 'generate', (pkg, i) => { pkg.manifest.capabilities[i].permissions.push('network'); });
  badBuiltin('model-test', 'generate', (pkg, i) => { pkg.manifest.capabilities[i].inputs[1].required = true; });
  badBuiltin('model-test', 'generate', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].multiple = true; });
  badBuiltin('local-material', 'read-text', pkg => { pkg.implementations['read-text'] = { kind: 'resource', bridge: 'arbitrary-file' } as any; });
  badBuiltin('local-material', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].permissions = ['notes-read']; });
  badBuiltin('local-material', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].effect = 'pure'; });
  badBuiltin('local-material', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].confirmation = 'none'; });
  badBuiltin('local-material', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].inputs[0].multiple = true; });
  badBuiltin('local-material', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].outputs[0].type.id = 'core.number'; });
  badBuiltin('local-material', 'read-text', pkg => { pkg.manifest.version = '1.0.1'; });
  badBuiltin('project-notes', 'read-text', pkg => { pkg.implementations['read-text'] = { kind: 'resource', bridge: 'selected-text-file' }; });
  badBuiltin('project-notes', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].permissions = ['file-read']; });
  badBuiltin('project-notes', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].confirmation = 'none'; });
  badBuiltin('project-notes', 'read-text', (pkg, i) => { pkg.manifest.capabilities[i].inputs[0].multiple = true; });
  badBuiltin('project-notes', 'read-text', pkg => { pkg.manifest.version = '1.0.1'; });
  const renamed = builtinPackages(), model = renamed.find(pkg => pkg.manifest.id === 'model-test')!;
  model.manifest.id = 'synthetic-model';
  assert.equal(new S2PluginInstallation(renamed).descriptor({ pluginId: 'synthetic-model', pluginVersion: model.manifest.version, capabilityId: 'generate' }).kind, 'model',
    'Trusted installation binds an arbitrary business ID only to the same closed model-session ABI; runtime approval and per-call confirmation remain separate');
  const otherRenderer = builtinPackages(), view = otherRenderer.find(pkg => pkg.manifest.id === 'structured-view')!;
  view.manifest.id = 'synthetic-view'; new S2PluginInstallation(otherRenderer);
  assert.equal(calls, 2); assert.equal(forbiddenIo, 0);
  console.log('S2 installation contract passed: atomic complete bindings, native snapshots, exact dispatch, closed host bridges and compatible readonly views; no network or model calls.');
} finally { globalThis.fetch = originalFetch; }
