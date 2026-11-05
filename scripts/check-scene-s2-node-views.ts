import assert from 'node:assert/strict';
import { activate } from './fixtures/s2-arithmetic-pack';
import { readSceneInteractionPack, readScenePackViewPolicy } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { scenePackNodeDoubleClick } from '../src/components/scene/ScenePackView';
import { s2WorkflowAnchorKey, type S2WorkflowNodeData } from '../src/components/scene/S2WorkflowNodeView';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog } from '../src/services/scene/sceneS2PublicAuthoring';
import type { ScenePackViewContext } from '../src/types/sceneInteractionPack';

globalThis.fetch = async () => assert.fail('Node-view contract checks forbid network');
const raw = activate({ editor: {} as any, ui: { react: {} } }), capability = raw.capabilities[0].capabilities[0];
let calls = 0;
raw.views = { 'arithmetic/sum': { node: () => { calls++; return null; }, onDoubleClick: () => { calls++; },
  policy: () => { calls++; return { inputAnchors: { a: { side: 'bottom', offset: 0.2 } }, outputAnchors: { text: { side: 'top' } } }; } } };
raw.authoring = { version: 1, components: [{ id: 'sum', label: '求和', purpose: '按两个数值计算', implementation: { kind: 'capability', pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' },
  inputs: ['a', 'b'], outputs: ['text'], parameters: ['a', 'b'] }] };
const pack = readSceneInteractionPack(raw);
assert.equal(calls, 0, 'Registration must not probe node rendering, gesture or policy callbacks');
assert.equal(typeof pack.views!['arithmetic/sum'].node, 'function');
for (const name of ['node', 'onDoubleClick'] as const) assert.throws(() => readSceneInteractionPack({ ...raw, views: { 'arithmetic/sum': { [name]: {} } } }), /PACK_CONTRACT_FUNCTION/);
const valid = readScenePackViewPolicy({ inputAnchors: { a: { side: 'bottom', offset: 0 }, b: { side: 'right', offset: 1 } }, outputAnchors: { text: { side: 'top' } } }, capability);
assert.equal(valid.inputAnchors!.a.offset, 0); assert.equal(valid.outputAnchors!.text.side, 'top');
assert.deepEqual(readScenePackViewPolicy({ genericSettings: true, showStatus: false, interactionInputInView: true }, capability), { genericSettings: true, showStatus: false, interactionInputInView: true });
for (const policy of [
  { inputAnchors: { invented: { side: 'top' } } }, { outputAnchors: { a: { side: 'top' } } },
  ...['diagonal', '', undefined].map(side => ({ inputAnchors: { a: { side } } })),
  ...[-1, 1.01, Infinity, NaN, '0.5'].map(offset => ({ inputAnchors: { a: { side: 'bottom', offset } } })),
  { inputAnchors: { a: { side: 'bottom', style: {} } } },
  { genericSettings: 'true' }, { showStatus: 0 }, { interactionInputInView: 'true' },
]) assert.throws(() => readScenePackViewPolicy(policy, capability), /PACK_CONTRACT_/);
const getter = Object.defineProperty({}, 'a', { enumerable: true, get: () => assert.fail('Do not call layout accessors') });
assert.throws(() => readScenePackViewPolicy({ inputAnchors: getter }, capability), /PACK_CONTRACT_FIELD/);
installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const reference = { id: pack.manifest.id, version: pack.manifest.version };
let guards = 0;
const context = { node: { pluginId: 'arithmetic', capabilityId: 'sum' }, active: true, editable: true, guard() { guards++; } } as unknown as ScenePackViewContext;
const gesture = scenePackNodeDoubleClick(reference, context)!;
gesture(); assert.equal(calls, 1); assert.equal(guards, 1);
context.editable = false; assert.throws(gesture, /不可编辑/); assert.equal(calls, 1);
context.editable = true; context.active = false; assert.throws(gesture, /不可编辑/); assert.equal(calls, 1);
context.active = true; context.guard = () => { throw new Error('STALE'); }; assert.throws(gesture, /STALE/); assert.equal(calls, 1);
assert.equal(scenePackNodeDoubleClick(null, context), undefined);
const canvas = { version: 1, nodes: [{ id: 'sum', componentId: 'sum', position: { x: 0, y: 0 }, values: { a: 2, b: 3 } }], connections: [] };
const config = compileS2PublicCanvas(pack, canvas, { goal: '本地视图不进入公开配置' });
const projection = projectS2PublicCanvas(pack, config.definition, config.document);
assert.deepEqual(projection.nodes[0].values, { a: 2, b: 3 });
const restored = compileS2PublicCanvas(pack, projection, { goal: config.definition.goal });
assert.deepEqual(projectS2PublicCanvas(pack, restored.definition, restored.document), projection, 'Saved business configuration roundtrips independently of local view code');
const serialized = JSON.stringify([publicS2Catalog(pack), projection, pack.describe()]);
for (const key of ['inputAnchors', 'outputAnchors', 'onDoubleClick', 'nodeView', 'styles', 'genericSettings', 'showStatus', 'interactionInputInView']) assert(!serialized.includes(key), key);
for (const field of ['style', 'node', 'nodeView', 'inputAnchors', 'outputAnchors', 'onDoubleClick', 'genericSettings', 'showStatus', 'interactionInputInView']) {
  assert.throws(() => compileS2PublicCanvas(pack, { ...canvas, nodes: [{ ...canvas.nodes[0], [field]: {} }] }, { goal: '禁止Agent指定本地视图' }), /PUBLIC_FIELD/);
  assert.throws(() => compileS2PublicCanvas(pack, { ...canvas, nodes: [{ ...canvas.nodes[0], values: { a: 2, b: 3, [field]: {} } }] }, { goal: '禁止通过业务值绕过' }), /PUBLIC_FIELD/);
}
const data = { capability, status: 'idle', title: '求和', artifacts: [], viewPolicy: {} } as S2WorkflowNodeData;
const original = s2WorkflowAnchorKey(data);
data.viewPolicy = { inputAnchors: { a: { side: 'bottom' } } }; assert.notEqual(s2WorkflowAnchorKey(data), original);
const moved = s2WorkflowAnchorKey(data); data.viewPolicy.inputAnchors!.a.offset = 0.7; assert.notEqual(s2WorkflowAnchorKey(data), moved);
console.log('Local node-view contract passed: inert registration, strict real-port geometry, guarded gestures, Agent projection exclusion and injection rejection, layout-only handle refresh.');
