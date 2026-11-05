import assert from 'node:assert/strict';
import type { SceneInteractionPack, SceneInteractionPackDefinition, ScenePackConfig } from '../src/types/sceneInteractionPack';
import type { S2BlockType, S2Document } from '../src/types/sceneS2';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { applyS2Commands, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { assertS2PublicEdit, compileS2PublicCanvas, findS2PublicComponent, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';

// Real native parsers and the public compiler; no package execution or synthetic
// replacement of the authorization functions exercised here.
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Public authoring must not call networks, providers or user resources');
let executions = 0, runtimes = 0;
const content: S2BlockType = { id: 'text', label: '本包内容', fields: [
  { id: 'content', label: '正文', kind: 'multiline' }, { id: 'secret', label: '内部固定字段', kind: 'multiline' },
] };
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'public-boundary-test', version: '1.0.0', label: '完整本地实现', meaning: '完整实现必须保留',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: ['process', 'hidden', 'many'].map(capabilityId => ({ id: capabilityId, kind: 'transform', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
    meaning: capabilityId === 'hidden' ? 'PRIVATE_HIDDEN_IMPLEMENTATION' : '公开处理实现',
    inputs: ['text', 'secret'].map(id => ({ id, label: id, meaning: '输入原文', type: { id: 'core.text', version: 1 }, required: id === 'text', multiple: id === 'text' && capabilityId === 'many' })),
    outputs: ['text', 'privateResult'].map(id => ({ id, label: id, meaning: '输出原文', type: { id: 'core.text', version: 1 }, required: id === 'text', multiple: false })),
  })) };
const ref = (capabilityId: string) => ({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId });
const internal: S2Document = { nodes: [
  { id: 'InternalText', type: 'text', label: 'PRIVATE_INTERNAL_TEXT', position: { x: -400, y: 0 }, values: { content: 'PRIVATE_INTERNAL_BODY', secret: 'PRIVATE_SECRET_BODY' } },
  { id: 'InternalOther', type: 'text', position: { x: -400, y: 200 }, values: { content: 'PRIVATE_OTHER_BODY', secret: 'PRIVATE_SECRET_BODY' } },
], edges: [{ id: 'InternalRelation', source: 'InternalText', target: 'InternalOther', label: 'PRIVATE_INTERNAL_RELATION' }], execution: { version: 1, nodes: [
  { id: 'InternalSameType', ...ref('process'), position: { x: -100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'InternalText', fieldId: 'content' }, secret: { kind: 'literal', value: 'FIXED_SECRET' } } },
  { id: 'InternalHidden', ...ref('hidden'), position: { x: 200, y: 0 }, bindings: { secret: { kind: 'literal', value: 'PRIVATE_HIDDEN_SECRET' } } },
], links: [{ source: { nodeId: 'InternalSameType', portId: 'text' }, target: { nodeId: 'InternalHidden', portId: 'text' } }] },
  groups: [{ id: 'InternalGroup', label: '内部组', nodeIds: ['InternalText', 'InternalOther'], collapsed: true }],
};
const definition: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'public-boundary-pack', version: '1.0.0', name: '公开修改边界测试', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [plugin],
  authoring: { version: 1, components: [
    { id: 'content', label: '可编辑正文', purpose: '只公开正文参数和正文来源', implementation: { kind: 'content', blockType: content }, inputs: [], outputs: ['content'], parameters: ['content'], defaults: { secret: 'FIXED_CONTENT' } },
    { id: 'processor', label: '公开处理', purpose: '原文处理', implementation: { kind: 'capability', ...ref('process') }, inputs: ['text'], outputs: ['text'], parameters: ['text'], defaults: { secret: 'FIXED_SECRET' } },
  ], internal: { blockTypes: [content], document: internal } },
  validate: () => [], executeLocal: async () => { executions++; assert.fail('Authoring must not execute package code'); },
  createRuntime: (_config, services) => { runtimes++; return { updateConfig: config => services.applyConfig(config), dispatch: () => undefined, run: (targets, notify, options) => services.run(targets, notify, options), dispose() {} }; },
};
const logical: S2PublicCanvas = { version: 1, nodes: [
  { id: 'UserText', componentId: 'content', position: { x: 0, y: 0 }, values: { content: '完整用户原文 $& {{literal}}' } },
  { id: 'UserProcessor', componentId: 'processor', position: { x: 300, y: 0 } },
], connections: [{ source: { nodeId: 'UserText', portId: 'content' }, target: { nodeId: 'UserProcessor', portId: 'text' } }] };
function changed(config: ScenePackConfig, mutate: (copy: ScenePackConfig) => void) { const copy = structuredClone(config); mutate(copy); return copy; }
function rejected(config: ScenePackConfig, mutate: (copy: ScenePackConfig) => void, reason?: RegExp) {
  const before = JSON.stringify(config); assert.throws(() => assertS2PublicEdit(pack, config, changed(config, mutate)), reason); assert.equal(JSON.stringify(config), before);
}
let pack: SceneInteractionPack;
try {
  pack = readSceneInteractionPack(definition); sceneInteractionPacks.register(pack); installSceneInteractionCapabilities(pack);
  const frozenInternal = JSON.stringify(pack.authoring!.internal), registryManifest = JSON.stringify(pack.capabilities);
  const catalog = publicS2Catalog(pack)!;
  assert.deepEqual(catalog.components.map(component => component.id), ['content', 'processor']);
  const exposed = JSON.stringify(catalog);
  for (const hidden of ['implementation', 'pluginId', 'PRIVATE_', 'FIXED_SECRET', 'secret', 'privateResult', 'public-boundary-test', 'InternalSameType']) assert.ok(!exposed.includes(hidden), hidden);
  assert.equal(catalog.components[1].parameters[0].schema.kind, 'string'); assert.deepEqual(catalog.components[1].inputs.map(port => port.id), ['text']);
  catalog.components[0].parameters.length = 0; assert.equal(publicS2Catalog(pack)!.components[0].parameters.length, 1, 'A caller cannot mutate the registered catalogue');
  const compiled = compileS2PublicCanvas(pack, logical, { goal: '只通过公开目录搭建' }), before = JSON.stringify(compiled);
  assert.equal(compiled.document.nodes.find(node => node.id === 'UserText')!.values.secret, 'FIXED_CONTENT');
  assert.deepEqual(compiled.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.text, { kind: 'field', nodeId: 'UserText', fieldId: 'content' });
  assert.ok(compiled.definition.plugins!.some(item => item.capabilityId === 'hidden'), 'Full local runtime implementations are retained');
  assert.deepEqual(compiled.document.nodes.filter(node => node.id.startsWith('Internal')), internal.nodes);
  assertS2PublicEdit(pack, compiled, compiled);
  const projection = projectS2PublicCanvas(pack, compiled.definition, compiled.document);
  assert.equal(projection.nodes.length, 2); assert.equal(projection.connections.length, 1);
  for (const hidden of ['Internal', 'PRIVATE_', 'pluginId', 'implementation', 'secret']) assert.ok(!JSON.stringify(projection).includes(hidden));
  assert.deepEqual(compileS2PublicCanvas(pack, projection, { goal: compiled.definition.goal }).document, compiled.document);
  assert.equal(findS2PublicComponent(pack, compiled.document.execution!.nodes.find(node => node.id === 'InternalSameType')!), undefined, 'Same native type does not make an internal instance public');
  assert.equal(findS2PublicComponent(pack, compiled.document.execution!.nodes.find(node => node.id === 'UserProcessor')!)!.id, 'processor');

  // The same guard is independent of whether a UI, an Agent command batch, raw
  // JSON import, package view, or history restoration produced the next graph.
  for (const origin of ['user', 'agent', 'import', 'package-view', 'history']) {
    rejected(compiled, copy => { copy.document.nodes.find(node => node.id === 'InternalText')!.values.content = origin; }, /PUBLIC_INTERNAL_IMMUTABLE/);
    rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'InternalSameType')!.position.x++; }, /PUBLIC_INTERNAL_IMMUTABLE/);
  }
  rejected(compiled, copy => { copy.document.execution!.nodes = copy.document.execution!.nodes.filter(node => node.id !== 'InternalHidden'); });
  rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'InternalSameType')!.capabilityId = 'hidden'; });
  rejected(compiled, copy => { copy.document.execution!.nodes.push({ ...structuredClone(internal.execution!.nodes[1]), id: 'NewHidden' }); }, /PUBLIC_COMPONENT_PRIVATE/);
  rejected(compiled, copy => { copy.document.nodes.find(node => node.id === 'UserText')!.values.secret = 'MUTATED'; }, /PUBLIC_COMPONENT_PRIVATE|PUBLIC_PARAMETER_PRIVATE/);
  rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.secret = { kind: 'literal', value: 'MUTATED' }; });
  rejected(compiled, copy => { delete copy.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.secret; });
  rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.text = { kind: 'field', nodeId: 'UserText', fieldId: 'secret' }; }, /PUBLIC_PORT_PRIVATE|PUBLIC_COMPONENT_PRIVATE/);
  rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.text = { kind: 'field', nodeId: 'InternalText', fieldId: 'content' }; }, /PUBLIC_PORT_PRIVATE/);
  rejected(compiled, copy => { copy.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.when = { nodeId: 'InternalSameType', portId: 'text', pointer: '', equals: 'x', match: true }; });
  rejected(compiled, copy => { copy.document.edges[0].label = 'replace internal'; }, /PUBLIC_INTERNAL_IMMUTABLE/);
  rejected(compiled, copy => { copy.document.execution!.links = []; }, /PUBLIC_INTERNAL_IMMUTABLE/);
  rejected(compiled, copy => { copy.document.groups![0].collapsed = false; }, /PUBLIC_INTERNAL_IMMUTABLE/);
  rejected(compiled, copy => { copy.document.groups!.push({ id: 'OuterGroup', label: '篡改归属', nodeIds: ['InternalSameType'], collapsed: false }); }, /PUBLIC_INTERNAL_IMMUTABLE/);
  rejected(compiled, copy => { copy.definition.blockTypes[0].fields[0].maxLength = 4; });
  rejected(compiled, copy => { copy.definition.plugins!.push({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' }); });
  rejected(compiled, copy => { copy.definition.initial.nodes.find(node => node.id === 'InternalText')!.values.content = 'wash ownership through initial'; }, /PUBLIC_INTERNAL_IMMUTABLE/);
  rejected(compiled, copy => { (copy.document.nodes.find(node => node.id === 'InternalText')! as any).componentId = 'content'; });
  const labels = changed(compiled, copy => { copy.definition.blockTypes[0].label = '场景显示名'; copy.definition.blockTypes[0].fields[0].label = '场景字段名'; });
  assertS2PublicEdit(pack, compiled, labels);
  const editable = changed(compiled, copy => { const node = copy.document.nodes.find(node => node.id === 'UserText')!; node.values.content = '新的正文'; node.position.x = 120; node.label = '任务资料'; });
  assertS2PublicEdit(pack, compiled, editable);
  for (const commands of [
    [{ op: 'batch-nodes', action: { kind: 'move', nodeIds: ['InternalSameType', 'UserProcessor'], delta: { x: 80, y: 0 } } }],
    [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['InternalSameType'] } }],
    [{ op: 'batch-nodes', action: { kind: 'delete', nodeIds: ['InternalSameType', 'InternalHidden', 'InternalText', 'InternalOther'] } }],
    [{ op: 'update-execution-node', id: 'InternalSameType', bindings: { text: { kind: 'literal', value: 'replaced by guessing the internal id' } } }],
  ]) {
    assert.throws(() => applyS2Commands(compiled.definition, compiled.document, commands, compiled.definition.initial,
      { id: pack.manifest.id, version: pack.manifest.version }), /PUBLIC_INTERNAL_IMMUTABLE|包内实例/);
    assert.equal(JSON.stringify(compiled), before, 'Rejected native Agent batches do not publish partial changes');
  }
  const expected = { id: 'Expectation', label: '已有预期', expectation: '保留原判断条件', method: 'semantic', required: false, target: { nodeId: 'UserProcessor', portId: 'text' } };
  const withBusiness: ScenePackConfig = { ...compiled, definition: readS2Definition({ ...compiled.definition, criteria: [expected], business: {
    version: 1, purpose: '已有业务参照', knowledge: [], workflow: [{ id: 'Process', goal: '处理公开原文', actor: 'tool', capabilities: [ref('process')], input: '原文', output: '原文' }],
    completion: { mode: 'execution', reference: compiled.document, targetNodeIds: ['UserProcessor'], coverage: [{ requirementId: 'Goal', stepIds: ['Process'], nodeIds: ['UserProcessor'] }] }, criteria: [expected],
  } }) };
  assertS2PublicEdit(pack, withBusiness, withBusiness);
  rejected(withBusiness, copy => { copy.definition.business!.completion.reference.execution!.nodes.find(node => node.id === 'InternalSameType')!.bindings.text = { kind: 'literal', value: 'mutating a second hidden native graph' }; }, /PUBLIC_DEFINITION_PRIVATE/);
  rejected(withBusiness, copy => { delete copy.definition.business; }, /PUBLIC_DEFINITION_PRIVATE/);
  rejected(withBusiness, copy => { copy.definition.criteria![0].expectation = 'another evaluation'; }, /PUBLIC_DEFINITION_PRIVATE/);

  const logicalBefore = JSON.stringify(logical);
  for (const malformed of [
    { ...logical, nodes: [{ ...logical.nodes[0], id: 'InternalText' }] },
    { ...logical, nodes: [{ ...logical.nodes[0], componentId: 'hidden' }] },
    { ...logical, nodes: [{ ...logical.nodes[0], values: { secret: 'MUTATED' } }] },
    { ...logical, nodes: [{ ...logical.nodes[1], implementation: ref('hidden') }] },
    { ...logical, connections: [{ source: { nodeId: 'UserText', portId: 'secret' }, target: { nodeId: 'UserProcessor', portId: 'text' } }] },
    { ...logical, connections: [...logical.connections, ...logical.connections] },
    { ...logical, nodes: [{ ...logical.nodes[0], componentId: 'public-boundary-test' }] },
  ]) assert.throws(() => compileS2PublicCanvas(pack, malformed, { goal: '非法公开配置' }));
  let getterCalls = 0;
  const hostile = Object.defineProperty({ ...logical }, 'nodes', { enumerable: true, get() { getterCalls++; return logical.nodes; } });
  assert.throws(() => compileS2PublicCanvas(pack, hostile, { goal: '访问器拒绝' })); assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(logical), logicalBefore); assert.equal(JSON.stringify(compiled), before);

  // One typed interface supports native controls, explicit fallbacks and real
  // multi-value data ports without introducing an implicit conversion node.
  const manyPack: SceneInteractionPack = { ...pack, authoring: { ...pack.authoring!, components: [
    ...pack.authoring!.components,
    { id: 'many', label: '多路处理', purpose: '合并多份同类型原文', implementation: { kind: 'capability', ...ref('many') }, inputs: ['text'], outputs: ['text'], parameters: ['text'], defaults: { secret: 'FIXED_SECRET' } },
    { id: 'fallback', label: '公开输入固定缺省', purpose: '公开连线替换开发者缺省，不开放其他literal编辑', implementation: { kind: 'capability', ...ref('process') }, inputs: ['text'], outputs: ['text'], parameters: [], defaults: { text: 'FALLBACK', secret: 'FIXED_SECRET' } },
    { id: 'native-controls', label: '通用原生字段', purpose: '原生数字、布尔、JSON', implementation: { kind: 'content', blockType: { id: 'native', label: '原生控件', fields: [
      { id: 'count', label: '数量', kind: 'number', min: 0, max: 10, integer: true }, { id: 'enabled', label: '启用', kind: 'boolean' }, { id: 'record', label: '原生JSON', kind: 'json' },
    ] } }, inputs: [], outputs: ['count', 'enabled', 'record'], parameters: ['count', 'enabled', 'record'] },
  ] } };
  const manyLogical: S2PublicCanvas = { version: 1, nodes: [
    { id: 'First', componentId: 'processor', position: { x: 0, y: 0 }, values: { text: 'FIRST' } },
    { id: 'Second', componentId: 'processor', position: { x: 0, y: 200 }, values: { text: 'SECOND' } },
    { id: 'Many', componentId: 'many', position: { x: 400, y: 0 }, values: { text: 'LOCAL' } },
    { id: 'Controls', componentId: 'native-controls', position: { x: 0, y: 400 }, values: { count: 4, enabled: false, record: { empty: null, exact: '$&' } } },
  ], connections: [
    { source: { nodeId: 'First', portId: 'text' }, target: { nodeId: 'Many', portId: 'text' } },
    { source: { nodeId: 'Second', portId: 'text' }, target: { nodeId: 'Many', portId: 'text' } },
  ] };
  const many = compileS2PublicCanvas(manyPack, manyLogical, { goal: '通用多路和原生字段' });
  assert.equal(many.document.execution!.links.filter(link => link.target.nodeId === 'Many').length, 2);
  assert.deepEqual(projectS2PublicCanvas(manyPack, many.definition, many.document).nodes.find(node => node.id === 'Controls')!.values,
    { count: 4, enabled: false, record: { empty: null, exact: '$&' } });
  assert.deepEqual(compileS2PublicCanvas(manyPack, projectS2PublicCanvas(manyPack, many.definition, many.document), { goal: many.definition.goal }).document, many.document);
  const malformedNumber = structuredClone(manyLogical); malformedNumber.nodes.find(node => node.id === 'Controls')!.values!.count = 1.5;
  assert.throws(() => compileS2PublicCanvas(manyPack, malformedNumber, { goal: '拒绝非法原生值' }), /整数/);
  const fallbackLogical: S2PublicCanvas = { ...logical, nodes: [logical.nodes[0], { ...logical.nodes[1], componentId: 'fallback' }] };
  const fallback = compileS2PublicCanvas(manyPack, fallbackLogical, { goal: '开发者缺省只由显式公开线替换' });
  assert.deepEqual(fallback.document.execution!.nodes.find(node => node.id === 'UserProcessor')!.bindings.text, { kind: 'field', nodeId: 'UserText', fieldId: 'content' });
  const conflicting = structuredClone(logical); conflicting.nodes[1].values = { text: '不能静默覆盖手填值' };
  assert.throws(() => compileS2PublicCanvas(pack, conflicting, { goal: '单路冲突' }), /PUBLIC_INPUT_CONFLICT/);
  const cycle: S2PublicCanvas = { version: 1, nodes: [manyLogical.nodes[0], manyLogical.nodes[1]].map(node => ({ ...node, values: {} })), connections: [
    { source: { nodeId: 'First', portId: 'text' }, target: { nodeId: 'Second', portId: 'text' } },
    { source: { nodeId: 'Second', portId: 'text' }, target: { nodeId: 'First', portId: 'text' } },
  ] };
  assert.throws(() => compileS2PublicCanvas(pack, cycle, { goal: '数据循环拒绝' }), /CYCLE|循环/);
  const blankNative = compileS2PublicCanvas(manyPack, { version: 1, nodes: [{ id: 'BlankControls', componentId: 'native-controls', position: { x: 0, y: 0 }, values: {} }], connections: [] }, { goal: '空原生草稿' });
  assert.deepEqual(compileS2PublicCanvas(manyPack, projectS2PublicCanvas(manyPack, blankNative.definition, blankNative.document), { goal: blankNative.definition.goal }).document, blankNative.document);

  const fixedLogical = structuredClone(logical); fixedLogical.nodes[0].readOnly = true;
  const fixed = compileS2PublicCanvas(pack, fixedLogical, { goal: '固定公开内容实例' });
  const fixedProjection = projectS2PublicCanvas(pack, fixed.definition, fixed.document);
  assert.equal(fixedProjection.nodes[0].readOnly, true);
  assert.deepEqual(compileS2PublicCanvas(pack, fixedProjection, { goal: fixed.definition.goal }).document, fixed.document);
  rejected(fixed, copy => { copy.document.nodes.find(node => node.id === 'UserText')!.readOnly = false; }, /只读/);

  const closed: SceneInteractionPack = { ...pack, authoring: { ...pack.authoring!, components: [] } };
  assert.deepEqual(publicS2Catalog(closed), { version: 1, components: [] });
  const whole = compileS2PublicCanvas(closed, { version: 1, nodes: [], connections: [] }, { goal: '整体使用封闭包' });
  assert.deepEqual(whole.document, internal); assert.deepEqual(projectS2PublicCanvas(closed, whole.definition, whole.document), { version: 1, nodes: [], connections: [] });
  assert.throws(() => compileS2PublicCanvas(closed, logical, { goal: '空目录不回退全部能力' }));
  const empty: SceneInteractionPack = { ...pack, authoring: { version: 1, components: [] } };
  const blank = compileS2PublicCanvas(empty, { version: 1, nodes: [], connections: [] }, { goal: '公开零组件' });
  assert.throws(() => assertS2PublicEdit(empty, blank, changed(blank, copy => { copy.document.nodes.push({ id: 'SneakyText', type: 'text', position: { x: 0, y: 0 }, values: { content: 'cannot use grammar placeholder to gain a public component' } }); })), /PUBLIC_COMPONENT_PRIVATE/);
  const { authoring: _authoring, ...legacy } = pack;
  assert.equal(publicS2Catalog(legacy), undefined); assert.doesNotThrow(() => assertS2PublicEdit(legacy, compiled, editable));
  assert.throws(() => compileS2PublicCanvas(legacy, logical, { goal: '必须显式使用旧接口' }), /PUBLIC_LEGACY/);
  assert.equal(JSON.stringify(pack.authoring!.internal), frozenInternal); assert.equal(JSON.stringify(pack.capabilities), registryManifest);
  assert.equal(executions, 0); assert.equal(runtimes, 0);
  console.log('S2 public authoring passed: one logical catalogue/compiler/projection, exact native type and parameter validation, internal same-type instance and graph ownership, public-only literal/port edits, all replacement origins, closed empty directories without capability fallback, explicit legacy omission, readonly roundtrips, hostile JSON rejection and immutable snapshots. No package runtime, model, network or user-resource calls.');
} finally { globalThis.fetch = priorFetch; }
