import assert from 'node:assert/strict';
import { createS2Scene, designS2Canvas as designS2CanvasImplementation, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { createS2BlueprintDesign } from '../src/services/scene/sceneS2BlueprintDesign';
import { createS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2RuntimePluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { s2CanvasContext } from '../src/services/scene/sceneS2Context';
import { buildS2Design } from '../src/services/scene/sceneS2Design';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { withS2DesignContext } from './fixtures/s2-design-context';
// This suite isolates legacy complete-context blueprint expansion and the existing call ceiling.
const designS2Canvas = (...[scene, options]: Parameters<typeof designS2CanvasImplementation>) => designS2CanvasImplementation(scene, { ...options, review: true, disclosure: 'complete' });

// The rich legacy dual-graph repair cases require a declared provider capacity.
// This in-memory fixture never reads or changes the user's settings.
await withS2DesignContext(131072, async () => {

const definition = readS2Definition(browserDefinition), plugins = definition.plugins!;
const child = wrapS2CanvasComposite(definition.initial, plugins, ['parse'], '读取材料');
const parent = wrapS2CanvasComposite(child.document, plugins, ['parse', 'rows'], '整理材料');
const metadata = { id: 'records-blueprint', version: '1.0.0', label: '可复用资料整理', description: '将文本解析并整理为表格，不评价业务内容。' };
const design = createS2CompositeDesign(parent.document, plugins, parent.id, metadata);
const secret = 'SYNTHETIC_UNUSED_LIBRARY_TEXT', privateSource = structuredClone(parent.document);
privateSource.execution!.nodes[0].bindings.text = { kind: 'literal', value: `[{"name":"${secret}"}]` };
const unused = createS2CompositeDesign(privateSource, plugins, parent.id, { ...metadata, id: 'private-blueprint' });
const library = [design, unused], adapter = createS2BlueprintDesign(library), original = JSON.stringify(library);
const inputId = design.blueprint.inputs[0].id, outputId = design.blueprint.outputs[0].id;
const request = (scope: 'initial' | 'reference', alias = 'Records') => ({ scope, alias, id: metadata.id, version: metadata.version,
  bindings: { [inputId]: { kind: 'field', nodeId: scope === 'initial' ? 'input' : 'Privateinput', fieldId: 'content' } } });
function draft() {
  const value: any = structuredClone(definition);
  value.initial.execution = { version: 1, nodes: value.initial.execution.nodes.filter((node: any) => node.id === 'view'),
    links: [{ source: { nodeId: 'Records', portId: outputId }, target: { nodeId: 'view', portId: 'table' } }] };
  value.business.completion.reference.execution = { version: 1, nodes: value.business.completion.reference.execution.nodes.filter((node: any) => node.id === 'Privateview'),
    links: [{ source: { nodeId: 'Records', portId: outputId }, target: { nodeId: 'Privateview', portId: 'table' } }] };
  value.business.completion.targetNodeIds = ['Records', 'Privateview'];
  value.business.completion.coverage[0].nodeIds = ['Records', 'Privateview'];
  value.business.criteria.push({ id: 'Result', label: '生成表格', expectation: '仅评价当前真实表格产物', method: 'semantic', required: false, target: { nodeId: 'Records', portId: outputId } });
  value.blueprintInstances = [request('initial'), request('reference')];
  return value;
}
assert.ok(!JSON.stringify(adapter.index).includes(secret));
const interfaces = adapter.read({ blueprintRead: [{ id: metadata.id, version: metadata.version }, { id: unused.blueprint.id, version: '1.0.0' }] });
assert.ok(interfaces.complete); assert.ok(!JSON.stringify(interfaces).includes(secret)); assert.ok(!JSON.stringify(interfaces).includes('targets'));
assert.throws(() => adapter.read({ blueprintRead: [] }));
assert.throws(() => adapter.read({ blueprintRead: [{ id: metadata.id, version: 'latest' }] }));
assert.throws(() => adapter.read({ blueprintRead: [{ id: metadata.id, version: '1.0.0' }, { id: metadata.id, version: '1.0.0' }] }));
assert.throws(() => adapter.read({ blueprintRead: [{ id: metadata.id, version: '1.0.0' }], grant: true }));
let gets = 0; const hostile: any = {}; Object.defineProperty(hostile, 'blueprintInstances', { enumerable: true, get: () => { gets++; return []; } });
assert.throws(() => adapter.compile(hostile)); assert.equal(gets, 0);
const raw = draft(), before = JSON.stringify(raw);
const compiled = readS2Definition(adapter.compile(raw), { requireBusiness: true });
assert.equal(JSON.stringify(raw), before); assert.equal(JSON.stringify(library), original);
assert.deepEqual(adapter.compile(raw), adapter.compile(raw), 'The same per-build alias has stable IDs through validation and repair');
assert.equal(compiled.initial.composites!.length, 2); assert.equal(compiled.business!.completion.reference.composites!.length, 2);
assert.ok(compiled.initial.execution!.nodes.every(node => !compiled.business!.completion.reference.execution!.nodes.some(other => other.id === node.id)));
assert.equal(compiled.business!.completion.coverage[0].nodeIds.length, 3);
assert.equal(compiled.business!.criteria.at(-1)!.target!.portId, 'table');
assert.ok(!JSON.stringify(compiled).includes(secret)); assert.ok(!('blueprintInstances' in compiled));
assert.ok(!JSON.stringify(compiled.initial).includes('Privateinput')); assert.equal(compiled.initial.execution!.nodes.length, 3);
for (const mutate of [
  (value: any) => { value.plugins = []; },
  (value: any) => { value.blueprintInstances[0].id = 'outside-library'; },
  (value: any) => { value.blueprintInstances[0].scope = 'global'; },
  (value: any) => { value.blueprintInstances[0].alias = 'input'; },
  (value: any) => { value.blueprintInstances[0].grant = true; },
  (value: any) => { value.blueprintInstances = null; },
  (value: any) => { value.blueprintInstances[0].bindings = null; },
  (value: any) => { value.initial.execution = null; },
  (value: any) => { value.initial.execution.version = 2; },
  (value: any) => { value.initial.execution.grant = true; },
  (value: any) => { value.initial.execution.nodes = null; },
  (value: any) => { value.initial.execution.links = null; },
  (value: any) => { value.blueprintInstances[0].bindings = { fake: { kind: 'literal', value: '' } }; },
  (value: any) => { value.initial.execution.links[0].source.portId = 'fake'; },
  (value: any) => { value.initial.execution.links[0].target.portId = 'value'; },
  (value: any) => { value.blueprintInstances[0].bindings[inputId].fieldId = 'missing'; },
  (value: any) => { value.blueprintInstances.push(value.blueprintInstances[0]); },
  (value: any) => { value.initial.blueprints = library; },
  (value: any) => { value.business.completion.reference.blueprints = library; },
  (value: any) => { value.blueprintInstances[1].bindings = {}; },
  (value: any) => { value.blueprintInstances[0].alias = 'OnlyInitial'; },
]) { const invalid = draft(); mutate(invalid); assert.throws(() => readS2Definition(adapter.compile(invalid), { requireBusiness: true })); }
const linked = draft(); linked.initial.execution.nodes.push({ id: 'inputProducer', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render', position: { x: 0, y: 0 }, bindings: { template: { kind: 'field', nodeId: 'input', fieldId: 'content' }, variables: { kind: 'literal', value: {} } } });
linked.plugins.push({ pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' });
linked.blueprintInstances[0].bindings = {};
linked.initial.execution.links.push({ source: { nodeId: 'inputProducer', portId: 'text' }, target: { nodeId: 'Records', portId: inputId } });
assert.equal(readS2Definition(adapter.compile(linked), { requireBusiness: true }).initial.execution!.links.length, 3);

const fanout = structuredClone(design);
fanout.blueprint.id = 'fanout'; fanout.blueprint.plugins = plugins.slice(0, 1);
fanout.blueprint.workflow = { version: 1, nodes: ['one', 'two'].map(id => ({ id, ...plugins[0], position: { x: 0, y: 0 }, bindings: {} })), links: [] };
fanout.blueprint.inputs[0].targets = ['one', 'two'].map(nodeId => ({ nodeId, portId: 'text' }));
fanout.blueprint.outputs = ['one', 'two'].map(nodeId => ({ id: nodeId, label: nodeId, type: { id: 'structured-data.value', version: 1 }, required: true, multiple: false, source: { nodeId, portId: 'value' } }));
fanout.composites = [{ id: fanout.rootId, label: '并列读取', nodeIds: ['one', 'two'] }];
function plain(instances: unknown[], selected = plugins): any {
  const { business: _, ...base } = structuredClone(definition);
  return { ...base, plugins: selected, initial: { nodes: definition.initial.nodes, edges: [], execution: { version: 1, nodes: [], links: [] } }, blueprintInstances: instances };
}
const fanoutAdapter = createS2BlueprintDesign([fanout]);
const fan = plain([{ ...request('initial', 'Readers'), id: 'fanout', bindings: {} }], [plugins[0], linked.plugins.at(-1)]);
fan.initial.execution.nodes.push(linked.initial.execution.nodes.at(-1));
fan.initial.execution.links.push({ source: { nodeId: 'inputProducer', portId: 'text' }, target: { nodeId: 'Readers', portId: inputId } });
const fanResult = readS2Definition(fanoutAdapter.compile(fan)); assert.equal(fanResult.initial.execution!.links.length, 2);
const guarded = plain([{ ...request('initial', 'Readers'), id: 'fanout', bindings: { [inputId]: { kind: 'literal', value: '{"go":true}' } } }]);
guarded.initial.execution.nodes.push({ id: 'guarded', ...plugins[0], position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } },
  when: { nodeId: 'Readers', portId: 'one', pointer: '/go', equals: true, match: true } });
assert.notEqual(readS2Definition(fanoutAdapter.compile(guarded)).initial.execution!.nodes[0].when!.nodeId, 'Readers');
const crowded = plain([request('initial')]); crowded.initial.execution.nodes = Array.from({ length: 39 }, (_, i) => ({ id: `old${i}`, ...plugins[0], position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } } }));
assert.throws(() => readS2Definition(adapter.compile(crowded)), /40/);
const native = structuredClone(design), stringify = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'stringify' };
native.blueprint.id = 'native-values'; native.blueprint.plugins = [stringify];
native.blueprint.workflow = { version: 1, nodes: [{ id: 'convert', ...stringify, position: { x: 0, y: 0 }, bindings: {} }], links: [] };
native.blueprint.inputs = []; native.blueprint.parameters = [{ id: 'value', label: '原生值', type: { id: 'structured-data.value', version: 1 }, target: { nodeId: 'convert', portId: 'value' }, defaultValue: false }];
native.blueprint.outputs = [{ id: 'text', label: '完整文本', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'convert', portId: 'text' } }];
native.composites = [{ id: native.rootId, label: '原生值转换', nodeIds: ['convert'] }];
const nativeAdapter = createS2BlueprintDesign([native]);
assert.equal((nativeAdapter.read({ blueprintRead: [{ id: native.blueprint.id, version: '1.0.0' }] }).interfaces[0].parameters[0] as any).hasDefault, true);
assert.ok(!JSON.stringify(nativeAdapter.index).includes('defaultValue'));
for (const value of [false, 0, null, '']) {
  const result = readS2Definition(nativeAdapter.compile(plain([{ scope: 'initial', alias: 'Native', id: 'native-values', version: '1.0.0', parameters: { value } }], [stringify])));
  assert.deepEqual((result.initial.execution!.nodes[0].bindings.value as any).value, value);
}
const large = structuredClone(fanout);
large.blueprint.workflow.nodes = Array.from({ length: 16 }, (_, i) => ({ id: `large${i}`, ...plugins[0], position: { x: 0, y: 0 }, bindings: {} }));
large.blueprint.description = '完整说明'.repeat(200);
large.blueprint.inputs = large.blueprint.workflow.nodes.map(node => ({ id: node.id, label: '完整材料名称'.repeat(12), type: { id: 'core.text', version: 1 }, required: true, multiple: false, targets: [{ nodeId: node.id, portId: 'text' }] }));
large.blueprint.outputs = large.blueprint.workflow.nodes.map(node => ({ id: node.id, label: '完整输出名称'.repeat(12), type: { id: 'structured-data.value', version: 1 }, required: true, multiple: false, source: { nodeId: node.id, portId: 'value' } }));
large.composites[0].nodeIds = large.blueprint.workflow.nodes.map(node => node.id);
const largeLibrary = Array.from({ length: 3 }, (_, i) => ({ ...large, blueprint: { ...large.blueprint, version: `1.0.${i}` } })), largeAdapter = createS2BlueprintDesign(largeLibrary);
assert.ok(largeAdapter.index.every(item => 'interfaceDetailsOmitted' in item));
assert.equal(largeAdapter.read({ blueprintRead: [{ id: 'fanout', version: '1.0.0' }] }).interfaces[0].inputs.length, 16);
assert.throws(() => largeAdapter.read({ blueprintRead: largeLibrary.map(({ blueprint }) => ({ id: blueprint.id, version: blueprint.version })) }), /12000/);
const largeCandidate = plain([]);
largeCandidate.initial.nodes = Array.from({ length: 12 }, (_, i) => ({ id: `content${i}`, type: 'note', position: { x: 0, y: 0 }, values: { content: 'x'.repeat(4900) } }));
largeCandidate.business = syntheticS2Business(definition);
largeCandidate.business.knowledge = Array.from({ length: 8 }, (_, i) => ({ id: `knowledge${i}`, title: '合成知识', content: 'x'.repeat(2000) }));
largeCandidate.business.completion.reference.nodes = largeCandidate.initial.nodes.map((node: any) => ({ ...node, id: `ref${node.id}` }));
largeCandidate.business.completion.targetNodeIds = ['refcontent0']; largeCandidate.business.completion.coverage[0].nodeIds = ['refcontent0'];
assert.ok(JSON.stringify(largeCandidate).length > 128000);
assert.equal(readS2Definition(adapter.compile(largeCandidate), { requireBusiness: true }).initial.nodes.length, 12, 'A full two-document design must not inherit the smaller single-blueprint byte ceiling');

const scene = { ...createS2Scene(browserRequest), canvasWorkspace: { ...definition, initial: { ...parent.document, blueprints: library } } };
const oldFetch = globalThis.fetch; let network = 0; globalThis.fetch = async () => { network++; throw new Error('No real IO'); };
const host = new S2PluginHost('blueprint-build-synthetic', plugins);
try {
  for (const withRead of [false, true]) {
    let stages: string[] = [], assemblies = 0, seenReview: any;
    const redesigned = await designS2Canvas(scene, { invoke: async request => {
      const data = JSON.parse(request.userInput); stages.push(data.stage);
      assert.ok(!request.userInput.includes(secret));
      if (data.stage === 'understand') { assert.equal(data.pluginCatalog, undefined); assert.equal(data.blueprintIndex, undefined); assert.ok(!request.systemPromptOverride!.includes('blueprintInstances')); }
      if (data.stage === 'assemble') {
        assemblies++; assert.ok(data.blueprintIndex); assert.ok(request.systemPromptOverride!.includes('blueprintInstances'));
        if (withRead && assemblies === 1) return { content: JSON.stringify({ blueprintRead: [{ id: metadata.id, version: metadata.version }] }) };
        if (withRead) assert.ok(data.blueprintInterfaces.complete);
        return { content: JSON.stringify(draft()) };
      }
      if (data.stage === 'review') { seenReview = data.candidate; assert.equal(data.candidate.blueprintInstances, undefined); assert.equal(data.candidate.initial.blueprints, undefined); }
      return s2DesignFixtureResponse(request, definition);
    } });
    assert.deepEqual(stages, withRead ? ['understand', 'assemble', 'assemble', 'review'] : ['understand', 'assemble', 'review']);
    assert.deepEqual(redesigned.initial.blueprints, library); assert.deepEqual(seenReview.initial.execution, redesigned.initial.execution);
    assert.deepEqual(s2RuntimePluginCatalog(redesigned.plugins!).plugins.map(plugin => plugin.id).sort(), ['core', 'structured-data', 'structured-view'].sort());
    host.setDocument(redesigned.initial);
    const run = await host.enqueueWorkflow(['view']).completion; assert.equal(run.status, 'succeeded');
    assert.equal(run.nodes.length, 3); assert.equal(host.currentArtifact(run.nodes.find(node => node.nodeId === 'view')!.artifactIds[0]).complete, true);
    assert.ok(!JSON.stringify(s2CanvasContext(redesigned.initial, null, [])).includes(secret));
  }
  let calls = 0;
  await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
    calls++; const data = JSON.parse(request.userInput);
    return data.stage === 'assemble' ? { content: JSON.stringify({ blueprintRead: [{ id: metadata.id, version: metadata.version }] }) } : s2DesignFixtureResponse(request, definition);
  } }), /只允许读取一次/); assert.equal(calls, 3);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(() => designS2Canvas(scene, { signal: controller.signal, invoke: async request => {
    calls++; if (JSON.parse(request.userInput).stage === 'assemble') controller.abort(); return s2DesignFixtureResponse(request, definition);
  } }), /停止/); assert.equal(calls, 2);
  for (const failure of ['truncated', 'transport']) {
    calls = 0; let rounds = 0;
    await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
      calls++; const data = JSON.parse(request.userInput);
      if (data.stage !== 'assemble') return s2DesignFixtureResponse(request, definition);
      rounds++; if (rounds === 1) return { content: JSON.stringify({ blueprintRead: [{ id: metadata.id, version: metadata.version }] }) };
      if (failure === 'transport') throw new Error('Synthetic transport failure');
      return { content: JSON.stringify(draft()), diagnostics: { finishReason: 'length' } } as any;
    } }), failure === 'transport' ? /transport/ : /截断/); assert.equal(calls, 3);
  }
  let repairCalls = 0;
  const repaired = await designS2Canvas(scene, { invoke: async request => {
    const data = JSON.parse(request.userInput); repairCalls++;
    if (data.stage === 'assemble') {
      const value = draft(); if (!data.feedback) value.plugins = [];
      else assert.equal(data.feedback.kind, 'protocol');
      return { content: JSON.stringify(value) };
    }
    return s2DesignFixtureResponse(request, definition);
  } }); assert.equal(repairCalls, 4); assert.equal(repaired.initial.composites!.length, 2);
  let reviews = 0, semanticRepairTotalTokens = 0; calls = 0;
  const semanticRepair = await designS2Canvas(scene, { invoke: async request => {
    calls++; const data = JSON.parse(request.userInput);
    if (data.stage === 'assemble') {
      const value = draft(); if (data.feedback) {
        const budget = fitSceneContextBudget(request, { provider: { contextWindowTokens: 131072 } }).diagnostics!; semanticRepairTotalTokens = budget.estimatedTotalTokens;
        assert.ok(semanticRepairTotalTokens <= budget.contextWindowTokens);
        assert.equal(budget.droppedHistoryMessages, 0); assert.deepEqual(budget.omittedContextIds, []);
        assert.deepEqual(data.current.initial.nodes, definition.initial.nodes);
        assert.equal(data.previousCandidate.initial.execution.nodes.length, 3);
        assert.equal(data.repairContext.protocolFacts.dataFlow.length, 3);
        assert.equal(request.maxTokensOverride, 16384);
        assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), 'Blueprint semantic repair retains the common canvas declaration contract');
        assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'));
        assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'));
        value.instructions.response += ' 合成修复完成。';
      }
      return { content: JSON.stringify(value) };
    }
    if (data.stage === 'review' && ++reviews === 1) return { content: JSON.stringify({ verdict: 'revise', factChecks: [], feedback: '合成场景策略需修复', coverage: [{ requirementId: 'r1', status: 'missing', evidencePaths: ['/instructions/response'], evidenceQuotes: [{ path: '/instructions/response', quote: definition.instructions.response }], reason: '合成语义修复测试' }] }) };
    return s2DesignFixtureResponse(request, definition);
  } }); assert.equal(calls, 5); assert.ok(semanticRepair.instructions.response.includes('合成修复完成'));
  console.log(`S2 rich blueprint semantic repair estimate: ${semanticRepairTotalTokens}/131072 tokens, complete input and unchanged output/safety reserves.`);
  calls = 0; let assembled = 0;
  // Check the orchestrator cap directly; the normal context governor may correctly refuse rich repair inputs earlier.
  await assert.rejects(() => buildS2Design({ review: true, sources: { task: scene.task, subject: scene.meta.subject, currentGoal: definition.goal, currentPolicy: JSON.stringify(definition.instructions), knowledgePointTitles: [] },
    current: definition, pluginCatalog: {}, blueprints: createS2BlueprintDesign(library), readDefinition: raw => readS2Definition(raw, { requireBusiness: true }), call: async (_prompt, input) => {
    calls++; const data = input as any;
    if (data.stage === 'assemble') {
      assembled++;
      if (assembled === 1) return { blueprintRead: [{ id: metadata.id, version: '1.0.0' }] };
      const value = draft(); if (assembled === 2) value.plugins = [];
      return value;
    }
    if (data.stage === 'review') return { verdict: 'revise', factChecks: [], feedback: '合成语义缺口', coverage: [{ requirementId: 'r1', status: 'missing', evidencePaths: ['/instructions/response'], evidenceQuotes: [{ path: '/instructions/response', quote: definition.instructions.response }], reason: '合成测试要求重新装配' }] };
    return JSON.parse(s2DesignFixtureResponse({ userInput: JSON.stringify(data) } as any, definition).content);
  } }), /6次请求上限/); assert.equal(calls, 6);
  // Library discovery is optional; no selection still keeps the normal 3-stage builder and the original library.
  calls = 0; const declined = await designS2Canvas(scene, { invoke: async request => { calls++; return s2DesignFixtureResponse(request, definition); } });
  assert.equal(calls, 3); assert.deepEqual(declined.initial.blueprints, library); assert.equal(declined.initial.composites, undefined);
  assert.equal(network, 0); assert.equal(JSON.stringify(scene.canvasWorkspace.initial.blueprints), original);
  console.log('S2 builder blueprint selection passed: semantic-first private-free discovery, optional complete interface recall, exact-version/permission validation, stable public-alias expansion in separate initial/reference namespaces, actual local Host execution, full-candidate review, bounded repair/abort/repeated-read guards and preserved immutable library. Synthetic only; not browser/live-model/global-library/upgrade acceptance.');
} finally { host.close(); globalThis.fetch = oldFetch; }
});
