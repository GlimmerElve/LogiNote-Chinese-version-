import assert from 'node:assert/strict';
import type { SceneInteractionPack, ScenePackAuthoringCatalog, ScenePackDescription } from '../src/types/sceneInteractionPack';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { createS2Scene, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { buildS2PublicDesign, type S2PublicDesignOptions } from '../src/services/scene/sceneS2PublicDesign';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas, type S2PublicComponentDescription } from '../src/services/scene/sceneS2PublicAuthoring';
import { projectS2AgentComponents, S2_AGENT_COMPONENT_RULES } from '../src/services/scene/sceneS2AgentCatalog';
import { S2DesignJsonError } from '../src/services/scene/sceneS2Design';

globalThis.fetch = async () => assert.fail('Public builder checks prohibit network, actual models and user material reads');
const privateMarkers = ['internalEcho', 'PRIVATE_INTERNAL_TEXT', 'PRIVATE_FIXED_PARAM', 'PRIVATE_RUNTIME_CONFIGURATION', 'InternalEcho', 'PRIVATE_GUIDE', 'PRIVATE_AGENT_INSTRUCTIONS', 'UI_ONLY_GROUP'];
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'public-builder-tools', version: '1.0.0', label: '本地内部实现', meaning: 'PRIVATE_GUIDE',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [{ id: 'public-builder-tools.mode', version: 1, meaning: '公开处理方式', schema: { kind: 'string', maxLength: 16, enum: ['fast', 'slow'] } }],
  capabilities: [{ id: 'internalEcho', kind: 'transform', meaning: 'PRIVATE_GUIDE', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
    inputs: [
      { id: 'text', label: '待处理原文', meaning: '原样提供文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false },
      { id: 'mode', label: '方式', meaning: '处理方式', type: { id: 'public-builder-tools.mode', version: 1 }, required: false, multiple: false },
      { id: 'secret', label: '内部固定设置', meaning: 'PRIVATE_GUIDE', type: { id: 'core.text', version: 1 }, required: false, multiple: false },
    ], outputs: [{ id: 'text', label: '返回文字', meaning: '完整文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }],
};
const native: ScenePackAuthoringCatalog['components'][number] = { id: 'note', label: '文字块', purpose: '填写原始文字', group: { id: 'native', label: 'UI_ONLY_GROUP' },
  implementation: { kind: 'content', blockType: { id: 'text', label: '文字块', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] } },
  inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' } };
const echo: ScenePackAuthoringCatalog['components'][number] = { id: 'echo', label: '回声块', purpose: '处理输入并返回原文',
  implementation: { kind: 'capability', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'internalEcho' },
  inputs: ['text'], outputs: ['text'], parameters: ['mode'], defaults: { mode: 'fast', secret: 'PRIVATE_FIXED_PARAM' } };
const policy: S2CanvasDefinition['instructions'] = { understanding: '按目标理解公开画布', planning: '由用户决定是否运行', response: '报告真实观察' };
const manual: ScenePackDescription = { purpose: '公开搭建测试', components: [], combinations: ['PRIVATE_GUIDE'], operations: [],
  builder: { assemble: 'PRIVATE_GUIDE', repair: 'PRIVATE_GUIDE' }, assistant: { instructions: 'PRIVATE_AGENT_INSTRUCTIONS', defaultAllowedOperations: [] } };
const internal: NonNullable<ScenePackAuthoringCatalog['internal']> = {
  blockTypes: [], document: { nodes: [], edges: [], execution: { version: 1, nodes: [{
    id: 'InternalEcho', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'internalEcho', position: { x: 1400, y: 600 },
    bindings: { text: { kind: 'literal', value: 'PRIVATE_INTERNAL_TEXT' }, secret: { kind: 'literal', value: 'PRIVATE_RUNTIME_CONFIGURATION' } },
  }], links: [] } },
};
let runtimes = 0, executions = 0, descriptions = 0;
function install(name: string, components = [native, echo]) {
  const raw: SceneInteractionPack = { manifest: { protocolVersion: 1, id: `public-builder-${name}`, version: '1.0.0', name: '公开搭建测试', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
    capabilities: [structuredClone(plugin)], authoring: { version: 1, components: structuredClone(components), internal: structuredClone(internal) },
    describe() { descriptions++; return structuredClone(manual); }, validate: () => [],
    createRuntime() { runtimes++; assert.fail('Builder never starts package runtime'); },
    executeLocal: async () => { executions++; assert.fail('Builder never executes a component'); },
  };
  const checked = readSceneInteractionPack(raw); installSceneInteractionCapabilities(checked); sceneInteractionPacks.register(checked);
  return sceneInteractionPacks.resolve({ id: checked.manifest.id, version: checked.manifest.version });
}
const pack = install('two');
const current = compileS2PublicCanvas(pack, { version: 1, nodes: [], connections: [] }, { goal: '搭建公开文字与回声链路', instructions: policy }).definition;
const sources = { task: '添加文字并连接回声块，可按需要与助手交流。', subject: '公开搭建', currentGoal: current.goal, currentPolicy: 'PRIVATE_AGENT_INSTRUCTIONS', knowledgePointTitles: [] };
const canvas = (): S2PublicCanvas => ({ version: 1, nodes: [
  { id: 'TextOne', componentId: 'note', label: '文字块', position: { x: 0, y: 0 }, values: { content: '原始文字 $& {{literal}}' } },
  { id: 'EchoOne', componentId: 'echo', label: '回声块', position: { x: 350, y: 0 }, values: { mode: 'slow' } },
], connections: [{ source: { nodeId: 'TextOne', portId: 'content' }, target: { nodeId: 'EchoOne', portId: 'text' } }] });
const envelope = () => ({ canvas: canvas(), instructions: { understanding: '理解当前原文', planning: '按需帮助，不代用户运行', response: '简短回答' } });
function publicOnly(value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of privateMarkers) assert(!text.includes(marker), `Private implementation must not enter the Agent context: ${marker}`);
  for (const field of ['pluginCatalog', 'packageGuide', 'builderPolicy', 'blueprintIndex', 'blueprintInterfaces', 'blockTypes', 'pluginId', 'pluginVersion', 'capabilityId', 'implementation'])
    assert(!text.includes(`"${field}"`), `The public builder context must not expose ${field}`);
}
function compactContext(data: Record<string, unknown>, selectedIds: string[], unreadIds?: string[], sourcePack = pack, sourceCurrent = current) {
  publicOnly(data);
  for (const field of ['readState', 'modelCallsRemaining', 'contextReadsRemaining'])
    assert(!Object.hasOwn(data, field), `${field} remains in local builder state`);
  assert.deepEqual(data.sources, { task: sources.task, subject: sources.subject, currentGoal: sources.currentGoal, knowledgePointTitles: sources.knowledgePointTitles });
  assert.deepEqual(data.current, projectS2PublicCanvas(sourcePack, sourceCurrent, sourceCurrent.initial), 'Every independent compose/review/repair request retains the current public canvas');
  const catalog = publicS2Catalog(sourcePack).components;
  const details = data.components as any[];
  assert.deepEqual(details.map(item => item.id), selectedIds, 'Every request includes all selected interfaces, including previously read ones');
  if (unreadIds?.length) {
    assert.deepEqual(data.publicComponentIndex, unreadIds.map(id => {
      const { label, purpose } = catalog.find(item => item.id === id)!;
      return { id, label, purpose };
    }));
  } else assert(!Object.hasOwn(data, 'publicComponentIndex'), 'The full index is not repeated once all details are read or further reads are unavailable');
  for (const detail of details) {
    const declared = catalog.find(item => item.id === detail.id)!;
    assert.deepEqual(Object.keys(detail).sort(), ['id', 'inputs', 'label', 'outputs', 'parameters', 'purpose']);
    assert.equal(detail.label, declared.label); assert.equal(detail.purpose, declared.purpose);
    for (const field of ['parameters', 'inputs', 'outputs'] as const) {
      assert(Array.isArray(detail[field]), `${field} remains explicit even when empty`);
      assert.deepEqual(detail[field].map((item: any) => item.id), declared[field].map(item => item.id));
      for (const item of detail[field]) {
        const original = declared[field].find(port => port.id === item.id)!;
        if (Object.hasOwn(item, 'label')) assert.equal(item.label, original.label);
        else assert.equal(original.label, original.id, 'Only labels identical to IDs may be omitted');
        if (field === 'parameters') {
          assert(!Object.hasOwn(item, 'type'), 'The editable value schema replaces the redundant parameter type reference');
          const parameter = original as typeof declared.parameters[number];
          if (parameter.field) {
            assert.deepEqual(item.field, parameter.field, 'Native parameters retain the complete field validation rules');
            assert(!Object.hasOwn(item, 'schema'), 'Native field rules replace the approximate duplicate schema');
          } else assert.deepEqual(item.schema, parameter.schema);
          for (const key of ['required', 'allowBlank', 'default', 'meaning', 'typeMeaning'] as const) {
            assert.equal(Object.hasOwn(item, key), Object.hasOwn(original, key), `${detail.id}.${item.id}.${key} presence is preserved`);
            if (Object.hasOwn(original, key)) assert.deepEqual(item[key], (original as any)[key]);
          }
        } else {
          const port = original as typeof declared.inputs[number];
          assert.equal(item.type, `${port.type.id}@${port.type.version}`, 'Connection types retain exact semantic identity and version');
          assert.equal(item.meaning, port.meaning); assert.equal(item.required, port.required); assert.equal(item.multiple, port.multiple);
        }
      }
    }
  }
}
function simpleCall(records: Array<{ prompt: string; data: Record<string, unknown>; tokens: number }>): S2PublicDesignOptions['call'] {
  return async (prompt, data, tokens) => {
    publicOnly(data); records.push({ prompt, data: structuredClone(data), tokens });
    if (data.authoringPhase === 'select') {
      assert.deepEqual((data.publicComponentIndex as any[]).map(item => item.id), ['note', 'echo']);
      for (const item of data.publicComponentIndex as any[]) assert.deepEqual(Object.keys(item).sort(), ['id', 'label', 'purpose']);
      assert(!(data.publicComponentIndex as any[]).some(item => Object.hasOwn(item, 'parameters') || Object.hasOwn(item, 'inputs')));
      return { componentIds: ['note', 'echo'] };
    }
    assert(prompt.includes(S2_AGENT_COMPONENT_RULES), 'Independent composition requests explain editable values, ports and omitted labels');
    compactContext(data, ['note', 'echo']);
    const details = data.components as any[];
    assert.deepEqual(details.map(component => component.id), ['note', 'echo']);
    assert.equal(details[1].parameters[0].id, 'mode'); assert.deepEqual(details[1].parameters[0].schema.enum, ['fast', 'slow']);
    assert.equal(details[1].parameters[0].meaning, '处理方式', 'Parameter meanings remain readable after redundant metadata is removed');
    assert(!details[1].parameters.some((parameter: any) => parameter.id === 'secret'));
    return envelope();
  };
}
// The projection works for any public package declaration, without component-ID
// special cases or truthiness filtering of editable limits and default values.
const declaredRules: S2PublicComponentDescription[] = [{ id: 'generic', label: '通用组件', purpose: '验证公开值限制', group: { id: 'ui', label: 'UI_ONLY_GROUP' },
  parameters: [
    { id: 'zero', label: 'zero', type: { id: 'generic.number', version: 8 }, meaning: '零也是有效默认值', typeMeaning: '有界整数', schema: { kind: 'number', integer: true, minimum: 0, maximum: 3 }, required: false, allowBlank: false, default: 0 },
    { id: 'flag', label: '开关', type: { id: 'generic.boolean', version: 2 }, schema: { kind: 'boolean' }, required: false, default: false },
    { id: 'nothing', label: 'nothing', type: { id: 'generic.json', version: 4 }, schema: { kind: 'json', maxDepth: 2, maxEntries: 5, maxBytes: 128 }, required: false, default: null },
    { id: 'text', label: 'text', type: { id: 'core.text', version: 1 }, schema: { kind: 'string', maxLength: 8, enum: ['', 'x'] }, required: false, default: '' },
    { id: 'nativeNumber', label: '原生数值', type: { id: 'core.number', version: 1 }, schema: { kind: 'number', integer: false, minimum: 0, maximum: 1 }, field: { kind: 'number', required: false, min: 0, max: 1, integer: false, serializedMaxLength: 6000 }, required: false, allowBlank: true, default: 0 },
    { id: 'nested', label: '嵌套值', type: { id: 'generic.object', version: 5 }, schema: { kind: 'object', required: ['items'], fields: { items: { kind: 'array', maxItems: 2, item: { kind: 'string', maxLength: 1, enum: ['x'] } } } }, required: true },
  ], inputs: [{ id: 'data', label: 'data', meaning: '精确类型连接', type: { id: 'generic.payload', version: 9 }, required: false, multiple: false }], outputs: [] }];
const declaredBefore = JSON.stringify(declaredRules);
const [projectedRules] = projectS2AgentComponents(declaredRules);
assert.deepEqual(Object.keys(projectedRules).sort(), ['id', 'inputs', 'label', 'outputs', 'parameters', 'purpose']);
assert.deepEqual(projectedRules.parameters.slice(0, 4).map(item => item.default), [0, false, null, '']);
for (const [index, original] of declaredRules[0].parameters.entries()) {
  const projected = projectedRules.parameters[index];
  assert(!Object.hasOwn(projected, 'type'));
  if (original.field) { assert.deepEqual(projected.field, original.field); assert(!Object.hasOwn(projected, 'schema')); }
  else assert.deepEqual(projected.schema, original.schema);
  for (const key of ['required', 'allowBlank', 'default', 'meaning', 'typeMeaning'] as const) {
    assert.equal(Object.hasOwn(projected, key), Object.hasOwn(original, key));
    if (Object.hasOwn(original, key)) assert.deepEqual(projected[key], original[key]);
  }
  assert.equal(Object.hasOwn(projected, 'label'), original.label !== original.id);
}
assert.deepEqual(projectedRules.inputs, [{ id: 'data', meaning: '精确类型连接', type: 'generic.payload@9', required: false, multiple: false }]);
assert.deepEqual(projectedRules.outputs, []);
assert.equal(JSON.stringify(declaredRules), declaredBefore, 'Context projection never mutates package declarations');
const before = JSON.stringify({ current, sources, catalog: pack.authoring });
for (const disclosure of ['progressive', 'complete'] as const) {
  const records: Array<{ prompt: string; data: Record<string, unknown>; tokens: number }> = [];
  const result = await buildS2PublicDesign({ pack, current, sources, disclosure, call: simpleCall(records) });
  assert.equal(records.length, 2); assert.equal(records[0].tokens, 4096); assert.equal(records[1].tokens, 16384);
  assert.deepEqual(result.initial.execution!.nodes.find(node => node.id === 'InternalEcho'), internal.document.execution!.nodes[0]);
  assert.equal(result.initial.nodes[0].values.content, '原始文字 $& {{literal}}');
  assert.equal(result.initial.execution!.nodes.find(node => node.id === 'EchoOne')!.bindings.secret.kind, 'literal');
  assert.equal((result.initial.execution!.nodes.find(node => node.id === 'EchoOne')!.bindings.secret as any).value, 'PRIVATE_FIXED_PARAM');
  assert.deepEqual(projectS2PublicCanvas(pack, result, result.initial), canvas());
}
assert.equal(JSON.stringify({ current, sources, catalog: pack.authoring }), before, 'All builder inputs remain unchanged');

// The real terminal invocation adapter must preserve the public boundary in both
// historical disclosure settings, not merely in direct helper tests.
for (const disclosure of ['progressive', 'complete'] as const) {
  const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: sources.subject, knowledgePoints: [], interactionPack: { id: pack.manifest.id, version: pack.manifest.version } });
  scene.canvasWorkspace = current; scene.task = sources.task;
  let calls = 0;
  const result = await designS2Canvas(scene, { disclosure, invoke: async request => {
    calls++; const data = JSON.parse(request.userInput); publicOnly(data);
    assert(request.skipMemoryInjection && request.skipProfileInjection);
    for (const marker of privateMarkers) assert(!request.systemPromptOverride!.includes(marker));
    return { content: JSON.stringify(data.authoringPhase === 'select' ? { componentIds: ['note', 'echo'] } : envelope()), diagnostics: { finishReason: 'stop' } };
  } });
  assert.equal(calls, 2); assert.equal(result.initial.execution!.nodes.find(node => node.id === 'InternalEcho')!.bindings.text.kind, 'literal');
}

const nativePack = install('native', [native]);
const nativeCurrent = compileS2PublicCanvas(nativePack, { version: 1, nodes: [], connections: [] }, { goal: '只填写文字', instructions: policy }).definition;
let nativeCalls = 0;
const nativeResult = await buildS2PublicDesign({ pack: nativePack, current: nativeCurrent, sources, call: async (_prompt, data) => {
  nativeCalls++; publicOnly(data);
  return data.authoringPhase === 'select' ? { componentIds: ['note'] } : { canvas: { version: 1, nodes: [canvas().nodes[0]], connections: [] } };
} });
assert.equal(nativeCalls, 2, 'Native text is a public component even with no public execution capabilities');
assert.equal(nativeResult.initial.nodes[0].values.content, '原始文字 $& {{literal}}');

const closedPack = install('closed', []), closedCurrent = compileS2PublicCanvas(closedPack, { version: 1, nodes: [], connections: [] }, { goal: '完整包直接使用', instructions: policy }).definition;
let closedCalls = 0;
assert.deepEqual(await buildS2PublicDesign({ pack: closedPack, current: closedCurrent, sources, call: async () => { closedCalls++; assert.fail('Closed directory must never invoke a builder Agent'); } }), closedCurrent);
assert.equal(closedCalls, 0);
const closedScene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '无公开组件', knowledgePoints: [],
  interactionPack: { id: closedPack.manifest.id, version: closedPack.manifest.version } });
closedScene.canvasWorkspace = closedCurrent;
assert.deepEqual(await designS2Canvas(closedScene, { disclosure: 'complete', invoke: async () => { closedCalls++; assert.fail('A closed package never invokes the terminal builder transport'); } }), closedCurrent);
assert.equal(closedCalls, 0);

// Follow-up discovery lists only unread components, then retains all selected
// interfaces in the independent request that follows the bounded second read.
const incrementalPack = install('three', [native, echo, { ...native, id: 'spare' }]);
const incrementalCurrent = compileS2PublicCanvas(incrementalPack, { version: 1, nodes: [], connections: [] }, { goal: current.goal, instructions: policy }).definition;
let incrementalCalls = 0;
await buildS2PublicDesign({ pack: incrementalPack, current: incrementalCurrent, sources, call: async (prompt, data) => {
  incrementalCalls++; publicOnly(data);
  if (data.authoringPhase === 'select') return { componentIds: ['note'] };
  assert(prompt.includes(S2_AGENT_COMPONENT_RULES));
  if (incrementalCalls === 2) { compactContext(data, ['note'], ['echo', 'spare'], incrementalPack, incrementalCurrent); return { read: { componentIds: ['echo'] } }; }
  compactContext(data, ['note', 'echo'], undefined, incrementalPack, incrementalCurrent);
  assert(!Object.hasOwn(data, 'publicComponentIndex'), 'Unread spare components stay local once the read allowance is consumed');
  return envelope();
} });
assert.equal(incrementalCalls, 3);

for (const bad of ['component', 'port', 'parameter', 'unread', 'native-envelope'] as const) {
  let calls = 0;
  await assert.rejects(() => buildS2PublicDesign({ pack, current, sources, call: async (_prompt, data) => {
    calls++; publicOnly(data);
    if (data.authoringPhase === 'select') return { componentIds: bad === 'component' ? ['hidden-component'] : bad === 'unread' ? ['note'] : ['note', 'echo'] };
    const value: any = envelope();
    if (bad === 'port') value.canvas.connections[0].target.portId = 'secret';
    if (bad === 'parameter') value.canvas.nodes[1].values.secret = 'injected';
    if (bad === 'native-envelope') value.plugins = [{ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'echo' }];
    return value;
  } }), /公开|未知|读取|字段/);
  assert(calls <= 4);
}

// Neither format repair nor an explicit optional review reintroduces the native
// scene or full package manual into the next request.
let repaired = 0;
await buildS2PublicDesign({ pack, current, sources, call: async (prompt, data) => {
  repaired++; publicOnly(data);
  if (data.authoringPhase === 'select') return { componentIds: ['note', 'echo'] };
  assert(prompt.includes(S2_AGENT_COMPONENT_RULES));
  compactContext(data, ['note', 'echo']);
  if (repaired === 2) throw new S2DesignJsonError('{"canvas":');
  assert(Object.hasOwn(data, 'formatRepair')); return envelope();
} });
assert.equal(repaired, 3);
let reviewCalls = 0;
await buildS2PublicDesign({ pack, current, sources, review: true, call: async (prompt, data) => {
  reviewCalls++; publicOnly(data);
  if (data.authoringPhase !== 'select') { assert(prompt.includes(S2_AGENT_COMPONENT_RULES)); compactContext(data, ['note', 'echo']); }
  return data.authoringPhase === 'select' ? { componentIds: ['note', 'echo'] } : data.authoringPhase === 'review' ? { approved: true } : envelope();
} });
assert.equal(reviewCalls, 3, 'Design review is explicit rather than an automatic request for every build');

const fixedPublic = canvas(); fixedPublic.nodes[0].readOnly = true;
const fixedCurrent = compileS2PublicCanvas(pack, fixedPublic, { goal: current.goal, instructions: policy }).definition;
const fixedBefore = JSON.stringify(fixedCurrent);
for (const alteration of ['delete', 'change', 'unlock'] as const) {
  await assert.rejects(() => buildS2PublicDesign({ pack, current: fixedCurrent, sources, call: async (_prompt, data) => {
    if (data.authoringPhase === 'select') return { componentIds: ['note', 'echo'] };
    const value = structuredClone(fixedPublic);
    if (alteration === 'delete') { value.nodes = value.nodes.slice(1); value.connections = []; }
    if (alteration === 'change') value.nodes[0].values!.content = 'changed';
    if (alteration === 'unlock') delete value.nodes[0].readOnly;
    return { canvas: value };
  } }), /固定原文|只读/);
}
assert.equal(JSON.stringify(fixedCurrent), fixedBefore);

const metadataCurrent = compileS2PublicCanvas(pack, canvas(), { goal: current.goal, instructions: policy }).definition;
metadataCurrent.criteria = [{ id: 'PreservedExpectation', label: '已有预期', expectation: 'PRIVATE_METADATA_EXPECTATION', method: 'advisory', required: false }];
const metadataResult = await buildS2PublicDesign({ pack, current: metadataCurrent, sources, call: async (_prompt, data) => {
  publicOnly(data); assert(!JSON.stringify(data).includes('PRIVATE_METADATA_EXPECTATION'));
  return data.authoringPhase === 'select' ? { componentIds: ['note', 'echo'] } : envelope();
} });
assert.deepEqual(metadataResult.criteria, metadataCurrent.criteria, 'Existing assessment metadata remains local and unchanged');

let truncatedCalls = 0;
const truncatedScene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '截断必须拒绝', knowledgePoints: [],
  interactionPack: { id: pack.manifest.id, version: pack.manifest.version } });
truncatedScene.canvasWorkspace = current;
await assert.rejects(() => designS2Canvas(truncatedScene, { invoke: async () => {
  truncatedCalls++; return { content: JSON.stringify({ componentIds: ['note'] }), diagnostics: { finishReason: 'length' } };
} }), /截断/);
assert.equal(truncatedCalls, 1, 'The production transport rejects truncation without formatting or semantic retries');

const controller = new AbortController(); let abortedCalls = 0;
await assert.rejects(() => buildS2PublicDesign({ pack, current, sources, signal: controller.signal, call: async () => {
  abortedCalls++; controller.abort(); return { componentIds: ['note'] };
} }), /停止/);
assert.equal(abortedCalls, 1);
let transportCalls = 0;
await assert.rejects(() => buildS2PublicDesign({ pack, current, sources, call: async () => { transportCalls++; throw new Error('synthetic transport failure'); } }), /transport failure/);
assert.equal(transportCalls, 1, 'Transport failures do not silently retry');
let accessors = 0;
await assert.rejects(() => buildS2PublicDesign({ pack, current, sources, call: async () => Object.defineProperty({}, 'componentIds', { enumerable: true, get() { accessors++; return ['note']; } }) }), /访问器/);
assert.equal(accessors, 0);
assert.equal(runtimes, 0); assert.equal(executions, 0); assert(descriptions > 0);
console.log('S2 public builder passed: shared component IDs and compact selected interfaces with complete editable rules, exact versioned connection types and zero/false/null/empty defaults, index-only discovery and unread-only follow-up, native text and closed packages, independent compose/repair/review context, internal boundary and fixed-instance protection, local read budgets, immutable sources and abort/truncation/transport/accessor guards. Synthetic replies only; no runtime, model, network or user materials.');
