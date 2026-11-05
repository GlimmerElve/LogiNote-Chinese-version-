import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SceneInteractionPack, ScenePackCanvasPolicy } from '../src/types/sceneInteractionPack';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readScenePackCanvasPolicy, ScenePackCanvasPolicyError, type ScenePackCanvasPolicyOptions } from '../src/services/scene/scenePackCanvasPolicy';
import { readSceneInteractionPack, readScenePackViewPolicy, ScenePackProtocolError } from '../src/services/scene/sceneInteractionPackProtocol';

globalThis.fetch = async () => assert.fail('Canvas policy validation must not run models, read user sources, or access the network');
const manifest = (id: string): S2PluginManifest => ({ protocolVersion: 1, id, version: '1.0.0', label: '开发者组件', meaning: '任意开发者业务',
  dependencies: [], dataTypes: [{ id: `${id}.value`, version: 1, meaning: '本包数值', schema: { kind: 'number', integer: false, minimum: -10, maximum: 10 } }],
  capabilities: ['process', 'show', 'editor'].map(capabilityId => ({ id: capabilityId, kind: capabilityId === 'editor' ? 'editor' : capabilityId === 'show' ? 'renderer' : 'transform',
    meaning: '独立组件能力', inputs: [{ id: 'value', label: '值', meaning: '输入值', type: { id: `${id}.value`, version: 1 }, required: true, multiple: false }],
    outputs: [{ id: 'result', label: '结果', meaning: '输出值', type: { id: `${id}.value`, version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 })),
});
const own = manifest('custom-numeric'), shared = manifest('shared-values');
const ref = (capabilityId = 'process', pluginId = own.id, pluginVersion = '1.0.0') => ({ pluginId, pluginVersion, capabilityId });
const policy: ScenePackCanvasPolicy = { contentEditing: 'double-click', openSettingsOnSelect: false, contentSettings: 'hide',
  addMenu: { contentLabel: '自定义学习内容', groups: [
    { id: 'numeric-steps', label: '数值组件', capabilities: [ref()] },
    { id: 'view-values', label: '结果展示', capabilities: [ref('show', shared.id)] },
  ], otherCapabilities: 'hide' } };
const original = JSON.stringify({ own, shared, policy });
const options = { capabilities: [own], sharedCapabilities: [shared] };
const checked = readScenePackCanvasPolicy(policy, options);
assert.deepEqual(checked, policy);
assert.equal(JSON.stringify({ own, shared, policy }), original);
checked.addMenu!.groups[0].capabilities[0].capabilityId = 'mutated-return';
checked.addMenu!.groups[0].label = 'changed';
assert.equal(JSON.stringify({ own, shared, policy }), original, 'Metadata returns are detached from package and capability declarations');
assert.deepEqual(readScenePackCanvasPolicy({}, options), {});
for (const editing of ['panel', 'inline', 'double-click'] as const)
  assert.equal(readScenePackCanvasPolicy({ contentEditing: editing }, options).contentEditing, editing);
for (const executionUi of ['panel', 'inline'] as const)
  assert.deepEqual(readScenePackCanvasPolicy({ executionUi }, options), { executionUi });
assert.deepEqual(readScenePackCanvasPolicy({ addMenu: { groups: [] } }, options), { addMenu: { groups: [] } }, 'Omitted menu visibility does not add a hidden default');

function denied(code: string, path: string, raw: unknown, scope: ScenePackCanvasPolicyOptions = options) {
  assert.throws(() => readScenePackCanvasPolicy(raw, scope), (error: unknown) => {
    assert(error instanceof ScenePackCanvasPolicyError); assert.equal(error.code, code);
    assert(error.path.startsWith(path), `${error.path} must begin with ${path}`); return true;
  });
}
const oneGroup = (references: unknown[]) => ({ addMenu: { groups: [{ id: 'group', label: '任意分类', capabilities: references }] } });
const defaultsPath = '/canvas/addMenu/groups/0/capabilities/0/defaults';
const preset = oneGroup([{ ...ref(), defaults: { value: 0 } }]);
const presetSource = JSON.stringify(preset), presetResult = readScenePackCanvasPolicy(preset, options);
assert.deepEqual(presetResult.addMenu!.groups[0].capabilities[0].defaults, { value: 0 }, 'Literal presets preserve zero values');
presetResult.addMenu!.groups[0].capabilities[0].defaults!.value = 1;
assert.equal(JSON.stringify(preset), presetSource, 'Preset snapshots do not mutate the source declaration');
assert.deepEqual(readScenePackCanvasPolicy(oneGroup([{ ...ref(), defaults: {} }]), options).addMenu!.groups[0].capabilities[0].defaults, {});
const deferredRef = ref('process', 'unresolved-shared');
const literalJson = { value: { empty: '', zero: 0, disabled: false, absent: null, parts: ['角色：', '任务：', '输出要求：'],
  data: { kind: 'field', nodeId: 'literal-data', fieldId: 'not-a-reference' } } };
const literalOriginal = JSON.stringify(literalJson);
const deferred = readScenePackCanvasPolicy(oneGroup([{ ...deferredRef, defaults: literalJson }]), { capabilities: [own] });
assert.deepEqual(deferred.addMenu!.groups[0].capabilities[0].defaults, literalJson, 'Native JSON remains literal data, including binding-shaped business data');
(deferred.addMenu!.groups[0].capabilities[0].defaults!.value as { parts: string[] }).parts.push('修改返回值');
assert.equal(JSON.stringify(literalJson), literalOriginal, 'Nested preset arrays and objects are deeply detached');
denied('PACK_CONTRACT_REFERENCE', defaultsPath + '/result', oneGroup([{ ...ref(), defaults: { result: 1 } }]));
denied('PACK_CONTRACT_REFERENCE', defaultsPath + '/invented', oneGroup([{ ...ref('show', shared.id), defaults: { invented: 1 } }]));
denied('PACK_CONTRACT_FIELD', '/canvas/addMenu/groups/0/capabilities/0', oneGroup([{ ...ref(), bindings: { value: { kind: 'field', nodeId: 'x', fieldId: 'x' } } }]));
denied('PACK_CONTRACT_DUPLICATE', '/canvas/addMenu/groups/0/capabilities/1', oneGroup([{ ...ref(), defaults: { value: 0 } }, { ...ref(), defaults: { value: 1 } }]));
denied('PACK_CONTRACT_DUPLICATE', '/canvas/addMenu/groups/1/capabilities/0', { addMenu: { groups: [
  { id: 'a', label: '甲', capabilities: [{ ...ref(), defaults: { value: 0 } }] },
  { id: 'b', label: '乙', capabilities: [{ ...ref(), defaults: { value: 1 } }] },
] } });
const sharedV2 = structuredClone(shared); sharedV2.version = '2.0.0';
sharedV2.capabilities.forEach(capability => { capability.inputs[0].id = 'second'; });
const versionedOptions = { capabilities: [own], sharedCapabilities: [shared, sharedV2] };
assert.doesNotThrow(() => readScenePackCanvasPolicy(oneGroup([{ ...ref('process', shared.id, '2.0.0'), defaults: { second: 2 } }]), versionedOptions));
denied('PACK_CONTRACT_REFERENCE', defaultsPath + '/value', oneGroup([{ ...ref('process', shared.id, '2.0.0'), defaults: { value: 2 } }]), versionedOptions);
const sixteenDefaults = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`port${index}`, index]));
assert.doesNotThrow(() => readScenePackCanvasPolicy(oneGroup([{ ...deferredRef, defaults: sixteenDefaults }]), { capabilities: [own] }));
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...deferredRef, defaults: { ...sixteenDefaults, extra: 1 } }]), { capabilities: [own] });
const exactBytes = { value: 'x'.repeat(16384 - '{"value":""}'.length) };
assert.equal(new TextEncoder().encode(JSON.stringify(exactBytes)).byteLength, 16384);
assert.doesNotThrow(() => readScenePackCanvasPolicy(oneGroup([{ ...ref(), defaults: exactBytes }]), options));
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: exactBytes.value + 'x' } }]));
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: '字'.repeat(5460) } }]));
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: '\\'.repeat(8200) } }]));
denied('PACK_CONTRACT_LIMIT', '/canvas', oneGroup([{ ...ref(), defaults: exactBytes }, { ...ref('show'), defaults: exactBytes }]));
let tooDeep: unknown = 0; for (let index = 0; index < 9; index++) tooDeep = [tooDeep];
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: tooDeep } }]));
denied('PACK_CONTRACT_LIMIT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: Array(2048).fill(0) } }]));
const circular: Record<string, unknown> = {}; circular.self = circular;
denied('PACK_CONTRACT_DATA', defaultsPath, oneGroup([{ ...ref(), defaults: { value: circular } }]));
for (const invalid of [undefined, null, [], new Date(), 1, 'preset'])
  denied('PACK_CONTRACT_OBJECT', defaultsPath, oneGroup([{ ...ref(), defaults: invalid }]));
for (const invalid of [undefined, () => 1, Symbol('value'), BigInt(1), Number.NaN, Number.POSITIVE_INFINITY])
  denied('PACK_CONTRACT_DATA', defaultsPath, oneGroup([{ ...ref(), defaults: { value: invalid } }]));
denied('PACK_CONTRACT_OBJECT', defaultsPath, oneGroup([{ ...ref(), defaults: { value: new Date() } }]));
denied('PACK_CONTRACT_FIELD', defaultsPath, oneGroup([{ ...ref(), defaults: JSON.parse('{"value":{"__proto__":1}}') }]));
denied('PACK_CONTRACT_REFERENCE', defaultsPath, oneGroup([{ ...ref(), defaults: JSON.parse('{"constructor":1}') }]));
denied('PACK_CONTRACT_FIELD', defaultsPath, oneGroup([{ ...ref(), defaults: { value: Array(1) } }]));
denied('PACK_CONTRACT_FIELD', defaultsPath, oneGroup([{ ...ref(), defaults: { value: Object.defineProperty({}, 'hidden', { value: 1 }) } }]));
denied('PACK_CONTRACT_FIELD', defaultsPath, oneGroup([{ ...ref(), defaults: { value: { [Symbol('hidden')]: 1 } } }]));
denied('PACK_CONTRACT_DATA', '/canvas/contentEditing', { contentEditing: 'business-specific' });
denied('PACK_CONTRACT_DATA', '/canvas/executionUi', { executionUi: 'business-specific' });
denied('PACK_CONTRACT_DATA', '/canvas/executionUi', { executionUi: true });
denied('PACK_CONTRACT_DATA', '/canvas/openSettingsOnSelect', { openSettingsOnSelect: 'false' });
denied('PACK_CONTRACT_DATA', '/canvas/contentSettings', { contentSettings: 'automatic' });
denied('PACK_CONTRACT_DATA', '/canvas/contentEditing', { contentSettings: 'hide' });
denied('PACK_CONTRACT_DATA', '/canvas/contentEditing', { contentSettings: 'hide', contentEditing: 'panel' });
for (const contentEditing of ['inline', 'double-click'] as const)
  assert.doesNotThrow(() => readScenePackCanvasPolicy({ contentSettings: 'hide', contentEditing }, options), 'A hidden content panel retains an explicit node editor');
denied('PACK_CONTRACT_DATA', '/canvas/addMenu/otherCapabilities', { addMenu: { groups: [], otherCapabilities: false } });
denied('PACK_CONTRACT_FIELD', '/canvas', { permission: 'model-call' });
denied('PACK_CONTRACT_FIELD', '/canvas/addMenu/groups', { addMenu: {} });
denied('PACK_CONTRACT_FIELD', '/canvas/addMenu', { addMenu: { groups: [], run() {} } });
denied('PACK_CONTRACT_OBJECT', '/canvas', []);
denied('PACK_CONTRACT_OBJECT', '/canvas', new Date());
denied('PACK_CONTRACT_LIMIT', '/canvas/addMenu/contentLabel', { addMenu: { groups: [], contentLabel: 'x'.repeat(121) } });
denied('PACK_CONTRACT_DATA', '/canvas/addMenu/groups/0/label', { addMenu: { groups: [{ id: 'group', label: ' ', capabilities: [] }] } });
denied('PACK_CONTRACT_DUPLICATE', '/canvas/addMenu/groups/1/id', { addMenu: { groups: [{ id: 'same', label: '甲', capabilities: [] }, { id: 'same', label: '乙', capabilities: [] }] } });
denied('PACK_CONTRACT_LIMIT', '/canvas/addMenu/groups', { addMenu: { groups: Array.from({ length: 9 }, (_, index) => ({ id: `g${index}`, label: '分类', capabilities: [] })) } });
denied('PACK_CONTRACT_DUPLICATE', '/canvas/addMenu/groups/0/capabilities/1', oneGroup([ref(), ref()]));
denied('PACK_CONTRACT_DUPLICATE', '/canvas/addMenu/groups/1/capabilities/0', { addMenu: { groups: [
  { id: 'a', label: '甲', capabilities: [ref()] }, { id: 'b', label: '乙', capabilities: [ref()] },
] } });
for (const bad of [ref('editor'), ref('invented'), ref('process', own.id, '2.0.0'), ref('process', 'other-package'),
  ref('process', own.id, 'latest'), { ...ref(), permission: 'model-call' }])
  assert.throws(() => readScenePackCanvasPolicy(oneGroup([bad]), options));
const permissive = { capabilities: [own] };
assert.doesNotThrow(() => readScenePackCanvasPolicy(oneGroup([ref('process', 'unresolved-shared')]), permissive), 'Without a shared catalogue, unknown external declarations remain structurally checked like existing help metadata');
assert.throws(() => readScenePackCanvasPolicy(oneGroup([ref('process', 'constructor')]), permissive), /合法插件标识/);
denied('PACK_CONTRACT_REFERENCE', '/canvas/addMenu/groups/0/capabilities/0', oneGroup([ref('editor')]), permissive);
denied('PACK_CONTRACT_REFERENCE', '/canvas/addMenu/groups/0/capabilities/0', oneGroup([ref('process', own.id, '2.0.0')]), permissive);
const staleOwn = { ...structuredClone(own), capabilities: [] };
assert.doesNotThrow(() => readScenePackCanvasPolicy(oneGroup([ref()]), { capabilities: [own], sharedCapabilities: [staleOwn] }), 'Owned declarations take precedence over a previously installed same-identity snapshot');

const manyRefs = Array.from({ length: 65 }, (_, index) => ref('process', `unresolved-${index}`));
denied('PACK_CONTRACT_LIMIT', '/canvas/addMenu/groups', { addMenu: { groups: [
  { id: 'a', label: '甲', capabilities: manyRefs.slice(0, 64) }, { id: 'b', label: '乙', capabilities: manyRefs.slice(64) },
] } }, permissive);
let getterCalls = 0;
const getter = { enumerable: true, get() { getterCalls++; throw new Error('Metadata getter must never execute'); } };
assert.throws(() => readScenePackCanvasPolicy(Object.defineProperty({}, 'contentEditing', getter), options));
const getterRef = Object.defineProperty({ pluginId: own.id, pluginVersion: '1.0.0' }, 'capabilityId', getter);
assert.throws(() => readScenePackCanvasPolicy(oneGroup([getterRef]), options));
const sparse = Array(1); assert.throws(() => readScenePackCanvasPolicy({ addMenu: { groups: sparse } }, options));
const accessorArray = [ref()]; Object.defineProperty(accessorArray, '0', getter);
assert.throws(() => readScenePackCanvasPolicy(oneGroup(accessorArray), options));
assert.throws(() => readScenePackCanvasPolicy(oneGroup([Object.defineProperty(ref(), 'defaults', getter)]), options));
assert.throws(() => readScenePackCanvasPolicy(oneGroup([{ ...ref(), defaults: Object.defineProperty({}, 'value', getter) }]), options));
assert.throws(() => readScenePackCanvasPolicy(oneGroup([{ ...ref(), defaults: { value: Object.defineProperty({}, 'nested', getter) } }]), options));
const presetAccessorArray = [1]; Object.defineProperty(presetAccessorArray, '0', getter);
assert.throws(() => readScenePackCanvasPolicy(oneGroup([{ ...ref(), defaults: { value: presetAccessorArray } }]), options));
assert.equal(getterCalls, 0);

const displayCapability = own.capabilities.find(capability => capability.id === 'process')!;
const displaySource = { inputLabels: { value: '开发者入口' }, showResult: false, resourceInputInView: false };
const displaySnapshot = JSON.stringify(displaySource), displayPolicy = readScenePackViewPolicy(displaySource, displayCapability);
assert.deepEqual(displayPolicy, displaySource);
displayPolicy.inputLabels!.value = '只修改返回快照';
assert.equal(JSON.stringify(displaySource), displaySnapshot, 'View label projection does not mutate developer metadata');
assert.deepEqual(readScenePackViewPolicy({}, displayCapability), {}, 'Omitted display policies retain the old generic behavior');
assert.deepEqual(readScenePackViewPolicy({ inputLabels: undefined, showResult: undefined, resourceInputInView: undefined }, displayCapability), {});
for (const showResult of [false, true]) assert.deepEqual(readScenePackViewPolicy({ showResult }, displayCapability), { showResult });
for (const resourceInputInView of [false, true]) assert.deepEqual(readScenePackViewPolicy({ resourceInputInView }, displayCapability), { resourceInputInView });
function deniedView(code: string, path: string, raw: unknown) {
  assert.throws(() => readScenePackViewPolicy(raw, displayCapability), (error: unknown) => {
    assert(error instanceof ScenePackProtocolError); assert.equal(error.code, code);
    assert(error.path.startsWith(path), `${error.path} must begin with ${path}`); return true;
  });
}
deniedView('PACK_CONTRACT_REFERENCE', '/viewPolicy/inputLabels/result', { inputLabels: { result: '输出不能冒充输入' } });
deniedView('PACK_CONTRACT_REFERENCE', '/viewPolicy/inputLabels/invented', { inputLabels: { invented: '未知端口' } });
for (const label of ['', '   ', 1, false, {}, '\u0000']) deniedView('PACK_CONTRACT_DATA', '/viewPolicy/inputLabels/value', { inputLabels: { value: label } });
deniedView('PACK_CONTRACT_LIMIT', '/viewPolicy/inputLabels/value', { inputLabels: { value: 'x'.repeat(121) } });
deniedView('PACK_CONTRACT_LIMIT', '/viewPolicy/inputLabels', { inputLabels: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`port${index}`, '入口'])) });
deniedView('PACK_CONTRACT_OBJECT', '/viewPolicy/inputLabels', { inputLabels: [] });
for (const showResult of [null, 0, 1, 'false', [], {}, () => true]) deniedView('PACK_CONTRACT_DATA', '/viewPolicy/showResult', { showResult });
for (const resourceInputInView of [null, 0, 1, 'false', [], {}, () => true]) deniedView('PACK_CONTRACT_DATA', '/viewPolicy/resourceInputInView', { resourceInputInView });
deniedView('PACK_CONTRACT_FIELD', '/viewPolicy/showResult', Object.defineProperty({}, 'showResult', getter));
deniedView('PACK_CONTRACT_FIELD', '/viewPolicy/resourceInputInView', Object.defineProperty({}, 'resourceInputInView', getter));
deniedView('PACK_CONTRACT_FIELD', '/viewPolicy/inputLabels', Object.defineProperty({}, 'inputLabels', getter));
deniedView('PACK_CONTRACT_FIELD', '/viewPolicy/inputLabels/value', { inputLabels: Object.defineProperty({}, 'value', getter) });
assert.equal(getterCalls, 0, 'Dynamic labels and result visibility cannot execute metadata accessors');

let runtimeCalls = 0;
const pack: SceneInteractionPack = { manifest: { protocolVersion: 1, id: 'arbitrary-canvas-package', version: '1.0.0', name: '开发者画布声明', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [own], describe: () => ({ purpose: '开发者自由设计画布', components: [], combinations: [], operations: [],
    builder: { assemble: '按需搭建', repair: '按需修复' }, assistant: { instructions: '按需协作', defaultAllowedOperations: [] } }),
  validate: () => [], createRuntime() { runtimeCalls++; throw new Error('Never run'); }, executeLocal: async () => { runtimeCalls++; throw new Error('Never execute'); },
};
const old = readSceneInteractionPack(pack);
assert.equal(old.canvas, undefined); assert(!Object.hasOwn(old, 'canvas'), 'Legacy packages retain their omitted policy and terminal defaults');
const loaded = readSceneInteractionPack({ ...pack, canvas: policy }, { sharedCapabilities: [shared] });
assert.deepEqual(loaded.canvas, policy);
assert.deepEqual(loaded.capabilities, old.capabilities, 'Presentation policy cannot grant or remove executable capabilities');
const loadedPreset = readSceneInteractionPack({ ...pack, canvas: preset }, { sharedCapabilities: [shared] });
assert.deepEqual(loadedPreset.canvas!.addMenu!.groups[0].capabilities[0].defaults, { value: 0 });
assert.deepEqual(loadedPreset.capabilities, old.capabilities, 'Menu defaults do not install or authorize capabilities');
loadedPreset.canvas!.addMenu!.groups[0].capabilities[0].defaults!.value = 9;
assert.equal(JSON.stringify(preset), presetSource);
assert.equal(runtimeCalls, 0);
loaded.canvas!.addMenu!.groups[0].label = '仅改返回值';
assert.equal(JSON.stringify({ own, shared, policy }), original);
assert.throws(() => readSceneInteractionPack({ ...pack, canvas: oneGroup([ref('editor')]) }, { sharedCapabilities: [shared] }),
  error => error instanceof ScenePackProtocolError && error.code === 'PACK_CONTRACT_REFERENCE' && error.path.startsWith('/canvas/'));
assert.throws(() => readSceneInteractionPack({ ...pack, canvas: { contentSettings: 'hide', contentEditing: 'panel' } }, { sharedCapabilities: [shared] }),
  error => error instanceof ScenePackProtocolError && error.code === 'PACK_CONTRACT_DATA' && error.path === '/canvas/contentEditing');
assert.throws(() => readSceneInteractionPack(Object.defineProperty({ ...pack }, 'canvas', getter)),
  error => error instanceof ScenePackProtocolError && error.code === 'PACK_CONTRACT_FIELD');
assert.equal(getterCalls, 0);
const moduleSource = readFileSync('src/services/scene/scenePackCanvasPolicy.ts', 'utf8');
assert(!/^import(?! type)/mu.test(moduleSource), 'Canvas metadata reader must stay free of runtime/registry imports');
assert(!/prompt-lab|text-template|model-test/u.test(moduleSource), 'Every developer package uses the same declarative interface');
console.log('Scene package canvas policy passed: backward-compatible editing/menu/display choices, exact owned/shared capability and input references, bounded native literal presets, checked input labels/result visibility, no binding/authorization expansion, accessor-free dense JSON and immutable snapshots. Offline only.');
