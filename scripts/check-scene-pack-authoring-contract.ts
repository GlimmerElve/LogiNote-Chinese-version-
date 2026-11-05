import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition, ScenePackAuthoringCatalog, ScenePackPublicComponent } from '../src/types/sceneInteractionPack';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readScenePackAuthoringCatalog, ScenePackAuthoringCatalogError } from '../src/services/scene/scenePackAuthoringCatalog';
import { readSceneInteractionPack, ScenePackProtocolError } from '../src/services/scene/sceneInteractionPackProtocol';
import { promptLabAuthoring } from '../src/interaction-packs/prompt-lab/authoring';

globalThis.fetch = async () => assert.fail('Public interface validation performs no network/model/resource IO');
let executions = 0, getterCalls = 0;
const own: S2PluginManifest = { protocolVersion: 1, id: 'public-tools', version: '1.0.0', label: '独立开发者运算', meaning: '本地完整运行目录', dependencies: [],
  dataTypes: [{ id: 'public-tools.number', version: 1, meaning: '有界数值', schema: { kind: 'number', integer: false, minimum: -100, maximum: 100 } }],
  capabilities: ['process', 'private', 'editor'].map(id => ({ id, kind: id === 'editor' ? 'editor' : 'transform', meaning: '本地数值处理',
    inputs: ['amount', 'factor'].map(id => ({ id, label: id, meaning: id, type: { id: 'public-tools.number', version: 1 }, required: true, multiple: false })),
    outputs: [{ id: 'value', label: '计算值', meaning: '输出数值', type: { id: 'public-tools.number', version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 })) };
const shared: S2PluginManifest = { ...structuredClone(own), id: 'shared-tools', capabilities: [structuredClone(own.capabilities[0])] };
const scope = { capabilities: [own], sharedCapabilities: [shared] };
const content: ScenePackPublicComponent = { id: 'note', label: '文字内容', purpose: '承载可编辑文字', group: { id: 'content', label: '内容' },
  implementation: { kind: 'content', blockType: { id: 'text', label: '文字', fields: [{ id: 'content', label: '内容', kind: 'multiline', maxLength: 100 }] } },
  inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' } };
const process: ScenePackPublicComponent = { id: 'multiply', label: '乘法', purpose: '处理公开数值', group: { id: 'processes', label: '计算' },
  implementation: { kind: 'capability', pluginId: 'public-tools', pluginVersion: '1.0.0', capabilityId: 'process' },
  inputs: ['amount'], outputs: ['value'], parameters: ['amount'], defaults: { factor: 2 } };
const catalog = (): ScenePackAuthoringCatalog => ({ version: 1, components: [structuredClone(content), structuredClone(process)],
  internal: { blockTypes: [structuredClone(content.implementation.kind === 'content' ? content.implementation.blockType : assert.fail())],
    document: { nodes: [{ id: 'fixed', type: 'text', position: { x: 0, y: 0 }, values: { content: '内部同型块' } }], edges: [], execution: { version: 1,
      nodes: [{ id: 'privateSameType', pluginId: 'public-tools', pluginVersion: '1.0.0', capabilityId: 'process', position: { x: 100, y: 0 }, bindings: { factor: { kind: 'literal', value: 3 } } }], links: [] } } } });
function denied(code: string, path: string, raw: unknown) {
  assert.throws(() => readScenePackAuthoringCatalog(raw, scope), (error: unknown) => {
    assert(error instanceof ScenePackAuthoringCatalogError); assert.equal(error.code, code); assert(error.path.startsWith(path), `${error.path} not under ${path}`); return true;
  });
}
function changed(change: (value: any) => void) { const value = catalog(); change(value); return value; }

assert.deepEqual(readScenePackAuthoringCatalog({ version: 1, components: [] }, scope), { version: 1, components: [] }, 'Empty is an explicit closed directory');
const original = catalog(), before = structuredClone(original), checked = readScenePackAuthoringCatalog(original, scope);
assert.deepEqual(checked, original); assert.deepEqual(original, before);
original.components[0].parameters.length = 0; original.internal!.document.nodes[0].values.content = '改写调用者对象';
assert.deepEqual(checked.components[0].parameters, ['content']); assert.equal(checked.internal!.document.nodes[0].values.content, '内部同型块');
assert.equal(checked.components.filter(component => component.implementation.kind === 'capability').length, 1);
assert.equal(checked.internal!.document.execution!.nodes[0].id, 'privateSameType', 'The trusted internal instance remains separate, even when its type is public');
assert.deepEqual(checked.components[1].defaults, { factor: 2 }, 'A nonpublic parameter may have a package-fixed default');

denied('PACK_CONTRACT_VERSION', '/authoring/version', { version: 2, components: [] });
denied('PACK_CONTRACT_FIELD', '/authoring', { version: 1, components: [], allowEverything: true });
denied('PACK_CONTRACT_FIELD', '/authoring/components/0', changed(value => { value.components[0].grant = 'edit-private'; }));
denied('PACK_CONTRACT_DUPLICATE', '/authoring/components', changed(value => { value.components.push(structuredClone(value.components[0])); }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation', changed(value => { value.components[1].implementation.pluginVersion = '2.0.0'; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation/pluginVersion', changed(value => { value.components[1].implementation.pluginVersion = '^1.0.0'; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation', changed(value => { value.components[1].implementation.capabilityId = 'missing'; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation', changed(value => { value.components[1].implementation.capabilityId = 'editor'; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation', changed(value => { value.components[1].implementation.pluginId = 'outside-package'; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/0/inputs', changed(value => { value.components[0].inputs = ['content']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/0/outputs', changed(value => { value.components[0].outputs = ['missing']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/inputs', changed(value => { value.components[1].inputs = ['missing']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/outputs', changed(value => { value.components[1].outputs = ['amount']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/parameters', changed(value => { value.components[1].parameters = ['value']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/defaults', changed(value => { value.components[1].defaults = { value: 3 }; }));
denied('PACK_CONTRACT_DUPLICATE', '/authoring/components/1/parameters', changed(value => { value.components[1].parameters = ['amount', 'amount']; }));
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/group', changed(value => { value.components[1].group = { id: 'content', label: '另一标签' }; }));
denied('PACK_CONTRACT_DATA', '/authoring/components/0/implementation/blockType/fields', changed(value => { value.components[0].implementation.blockType.fields[0].kind = 'code-execution'; }));
denied('PACK_CONTRACT_FIELD', '/authoring/internal/document', changed(value => { value.internal.document.grant = 'owned'; }));
denied('PACK_CONTRACT_DATA', '/authoring/internal/document/nodes', changed(value => { value.internal.document.nodes = {}; }));
denied('PACK_CONTRACT_VERSION', '/authoring/internal/document/execution/version', changed(value => { value.internal.document.execution.version = 2; }));
denied('PACK_CONTRACT_LIMIT', '/authoring/components', { version: 1, components: Array.from({ length: 65 }, (_, i) => ({ ...content, id: `note${i}` })) });
const accessor = catalog(); Object.defineProperty(accessor.components[0], 'purpose', { enumerable: true, get() { getterCalls++; return '不可执行'; } });
denied('PACK_CONTRACT_FIELD', '/authoring/components/0/purpose', accessor);
const iterable = catalog(); Object.defineProperty(iterable.components, Symbol.iterator, { value() { getterCalls++; return []; } });
denied('PACK_CONTRACT_FIELD', '/authoring/components', iterable);
const sparse = catalog(); delete (sparse.components as any)[0]; denied('PACK_CONTRACT_FIELD', '/authoring/components', sparse);
const cyclic = catalog(); cyclic.components[0].defaults = { cyclic: cyclic as any }; denied('PACK_CONTRACT_DATA', '/authoring', cyclic);
denied('PACK_CONTRACT_DATA', '/authoring/components/0/defaults/content', changed(value => { value.components[0].defaults.content = Infinity; }));
assert.equal(getterCalls, 0);

const sharedCatalog = changed(value => { value.components[1].implementation.pluginId = 'shared-tools'; });
assert.equal(readScenePackAuthoringCatalog(sharedCatalog, scope).components[1].implementation.kind, 'capability');
assert.doesNotThrow(() => readScenePackAuthoringCatalog(sharedCatalog, { capabilities: [own] }), 'Unresolved shared mappings are checked strictly at installation with the actual shared scope');
denied('PACK_CONTRACT_REFERENCE', '/authoring/components/1/implementation', changed(value => { value.components[1].implementation.pluginId = 'shared-tools'; value.components[1].implementation.pluginVersion = '2.0.0'; }));

const entry = (): SceneInteractionPackDefinition => ({ manifest: { protocolVersion: 1, id: 'public-machine', version: '1.0.0', name: '纯手动公开组件包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [structuredClone(own)], authoring: catalog(),
  validate() { executions++; return []; }, createRuntime() { executions++; assert.fail('Never probe runtime during interface validation'); },
  async executeLocal() { executions++; assert.fail('Never execute a package during interface validation'); } });
const normalized = readSceneInteractionPack(entry(), scope);
assert.equal(normalized.describe().purpose, '纯手动公开组件包'); assert.deepEqual(normalized.describe().components.map(component => component.id), ['note', 'multiply']);
assert.deepEqual(normalized.describe().operations, []); assert.deepEqual(normalized.describe().assistant.defaultAllowedOperations, []);
const manual = normalized.describe(); manual.components.length = 0; assert.equal(normalized.describe().components.length, 2);
assert.equal(readSceneInteractionPack({ ...entry(), authoring: { version: 1, components: [] } }, scope).describe().components.length, 0);
assert.throws(() => readSceneInteractionPack({ ...entry(), authoring: undefined }, scope), (error: unknown) => error instanceof ScenePackProtocolError && error.code === 'PACK_CONTRACT_FUNCTION' && error.path === '/describe');
assert.throws(() => readSceneInteractionPack({ ...entry(), describe: true }, scope), (error: unknown) => error instanceof ScenePackProtocolError && error.path === '/describe');
assert.throws(() => readSceneInteractionPack({ ...entry(), authoring: { version: 1, components: [], modelGrant: true } }, scope), (error: unknown) => error instanceof ScenePackProtocolError && error.path === '/authoring');
assert.equal(executions, 0);

assert.deepEqual(promptLabAuthoring.components.map(component => component.id), ['content', 'compose', 'model-test', 'result', 'material-text', 'material-file', 'material-image']);
assert.equal(new Set(promptLabAuthoring.components.map(component => component.group!.id)).size, 5);
assert.ok(!promptLabAuthoring.components.some(component => component.implementation.kind === 'capability' && ['bind', 'render'].includes(component.implementation.capabilityId)));
console.log('Public authoring contract passed: closed empty directory, detached logical types/native content/exact capabilities and ports, fixed defaults, separate same-type internal baseline, strict bounded/accessor-free metadata, shared installation checks, optional Agent manual normalization and seven prompt variants in five groups. No package execution/model/network.');
