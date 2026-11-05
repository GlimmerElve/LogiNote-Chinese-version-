// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { applyS2Commands, createS2Scene, designS2Canvas, exportS2Subgraph, exportS2Workspace, importS2Workspace, interactS2Canvas, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { createS2CompositeDesign, readS2CompositeDesign, readS2CompositeLibrary, addS2CompositeDesign, removeS2CompositeDesign, instantiateS2CompositeDesign, exportS2CompositeDesign, importS2CompositeDesign, s2CompositeLibraryIndex } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite, s2CompositePath } from '../src/services/scene/sceneS2CompositeCanvas';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import { s2CanvasContext } from '../src/services/scene/sceneS2Context';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { harness } from './scene-s2-ui-harness';

const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic blueprint library only'); };
const definition = readS2Definition(browserDefinition), plugins = definition.plugins;
const child = wrapS2CanvasComposite(definition.initial, plugins, ['parse'], '读取材料'), child2 = wrapS2CanvasComposite(child.document, plugins, ['rows'], '整理材料');
const parent = wrapS2CanvasComposite(child2.document, plugins, ['parse', 'rows'], '处理记录'), source = readS2Document(parent.document, definition);
const metadata = { id: 'blueprint-records', version: '1.0.0', label: '可复用记录', description: '合成的读取与整理，材料重新提供' };
const design = createS2CompositeDesign(source, plugins, parent.id, metadata), key = design.blueprint.inputs[0].id;
assert.equal(design.composites.length, 3); assert.ok(!JSON.stringify(design).includes('我的原文')); assert.ok(!JSON.stringify(design).includes('kind":"field'));
assert.deepEqual(importS2CompositeDesign(exportS2CompositeDesign(design)), design);
let gets = 0; const hostile = { ...design }; Object.defineProperty(hostile, 'blueprint', { enumerable: true, get: () => { gets++; return design.blueprint; } });
for (const value of [hostile, { ...design, grant: true }, { ...design, composites: [] }, { ...design, rootId: child.id }, { ...design, blueprint: { ...design.blueprint, version: 'latest' } }, { ...design, blueprint: { ...design.blueprint, plugins: [] } }]) assert.throws(() => readS2CompositeDesign(value));
assert.equal(gets, 0); assert.throws(() => createS2CompositeDesign(source, plugins, parent.id, { ...metadata, workflow: {} } as any));
const library = readS2Document(addS2CompositeDesign(source, design), definition), original = JSON.stringify(library);
assert.equal(JSON.stringify(addS2CompositeDesign(library, design)), original, 'Exact duplicate publication is idempotent');
assert.throws(() => addS2CompositeDesign(library, { ...design, blueprint: { ...design.blueprint, description: '不同内容' } }), /新版本/);
assert.throws(() => readS2CompositeLibrary([design, design]), /重复/);
assert.throws(() => readS2CompositeLibrary(Array.from({ length: 9 }, (_, i) => ({ ...design, blueprint: { ...design.blueprint, version: `1.0.${i}` } }))), /8个/);
const literal = structuredClone(source); literal.execution!.nodes[0].bindings.text = { kind: 'literal', value: '[{"name":"SYNTHETIC_PRIVATE_DEFAULT"}]' };
const v2 = createS2CompositeDesign(literal, plugins, parent.id, { ...metadata, version: '2.0.0' }), withV2 = readS2Document(addS2CompositeDesign(library, v2), definition);
assert.equal(withV2.blueprints!.length, 2); assert.equal(library.blueprints!.length, 1);
assert.ok(!JSON.stringify(s2CanvasContext(withV2, null, [])).includes('SYNTHETIC_PRIVATE_DEFAULT'));
assert.equal((s2CanvasContext(withV2, null, []) as any).blueprintBodiesOmitted, true);
const fullIndex = s2CompositeLibraryIndex(withV2); assert.equal(fullIndex[0].version, '1.0.0');
const largeIndex = s2CompositeLibraryIndex({ ...source, blueprints: Array.from({ length: 8 }, (_, i) => ({ ...design, blueprint: { ...design.blueprint, version: `1.0.${i}`, description: 'x'.repeat(1000) } })) });
assert.ok(JSON.stringify(largeIndex).length <= 6000); assert.ok(largeIndex.every(item => 'interfaceDetailsOmitted' in item));
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, withV2)).initial.blueprints, withV2.blueprints);
assert.equal(JSON.parse(exportS2Subgraph(definition, withV2, ['parse', 'rows'])).definition.initial.blueprints, undefined, 'Subgraph export does not leak a separate private library');
const { business: _business, ...plainDefinition } = definition;
const inertDefinition = { ...plainDefinition, plugins: [], initial: { nodes: [], edges: [], blueprints: [design] } };
assert.equal(readS2Definition(inertDefinition).initial.blueprints!.length, 1, 'Inert storage does not require selecting its capabilities');
assert.throws(() => instantiateS2CompositeDesign(inertDefinition.initial, [], metadata.id, metadata.version), /范围外/);
assert.throws(() => instantiateS2CompositeDesign(library, plugins, metadata.id, 'latest'), /精确/);
const first = instantiateS2CompositeDesign(library, plugins, metadata.id, metadata.version, { inputs: { [key]: '[{"name":"甲","score":0}]' } });
const firstDoc = readS2Document(first.document, definition), second = instantiateS2CompositeDesign(firstDoc, plugins, metadata.id, metadata.version, { inputs: { [key]: '[{"name":"乙","score":95}]' } });
const secondDoc = readS2Document(second.document, definition);
assert.ok(first.nodeIds.every(id => !second.nodeIds.includes(id))); assert.equal(secondDoc.composites!.length, 9);
assert.equal(s2CompositePath(secondDoc, secondDoc.composites!.find(item => item.parentId === second.id)!.id).length, 2);
const provenance = secondDoc.composites!.find(item => item.id === first.id)!.blueprint!;
assert.equal(provenance.id, metadata.id); assert.equal(provenance.version, metadata.version);
assert.deepEqual(provenance.mapping!.nodes.map(item => item.id).sort(), [...first.nodeIds].sort());
assert.equal(provenance.mapping!.composites.find(item => item.localId === design.rootId)!.id, first.id);
assert.equal(JSON.stringify(library), original); assert.deepEqual(s2SemanticDocument(removeS2CompositeDesign(firstDoc, metadata.id, metadata.version)), s2SemanticDocument(firstDoc));
const stable = { op: 'instantiate-blueprint', id: metadata.id, version: metadata.version, instanceKey: crypto.randomUUID() };
assert.deepEqual(applyS2Commands(definition, library, [stable]), applyS2Commands(definition, library, [stable]));
assert.throws(() => applyS2Commands(definition, applyS2Commands(definition, library, [stable]), [stable]), /重复|标识/);
assert.throws(() => applyS2Commands(definition, library, [{ ...stable, instanceKey: 'bad' }]), /标识/);
const host = new S2PluginHost('synthetic-library', plugins!), uis: ReturnType<typeof harness>[] = [];
try {
  host.setDocument(secondDoc);
  for (const [instance, name] of [[first, '甲'], [second, '乙']] as const) {
    const run = await host.enqueueWorkflow(instance.nodeIds).completion; assert.equal(run.status, 'succeeded');
    const artifact = host.currentArtifact(run.nodes.find(node => secondDoc.execution!.nodes.find(item => item.id === node.nodeId)?.capabilityId === 'to-table')!.artifactIds[0]);
    assert.ok(JSON.stringify(artifact).includes(name));
  }
  assert.equal(host.remainingCalls, 60);
  const scene = { ...createS2Scene(browserRequest), canvasWorkspace: { ...definition, initial: withV2 } };
  const redesigned = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
    assert.ok(!request.userInput.includes('SYNTHETIC_PRIVATE_DEFAULT')); return s2DesignFixtureResponse(request, { ...definition, initial: source });
  } });
  assert.deepEqual(redesigned.initial.blueprints, withV2.blueprints);
  let reviewed: any;
  const reply = await interactS2Canvas(scene, withV2, '添加一份可复用记录的1.0.0版，先给方案，不运行。', null, [], { invoke: async request => {
    assert.ok(!request.userInput.includes('SYNTHETIC_PRIVATE_DEFAULT'));
    const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') { assert.equal(input.pluginCatalog, undefined); assert.ok(input.current.blueprintIndex); return { content: JSON.stringify({ understanding: '添加副本提案', desiredOutcome: '等待确认', actions: ['reply', 'edit'], constraints: ['不运行'], questions: [], evaluation: 'advice' }) }; }
    if (input.stage === 'turn-act') { assert.ok(request.systemPromptOverride?.includes('instantiate-blueprint')); return { content: JSON.stringify({ understanding: '复用1.0.0', plan: '只添加设计', reply: '添加副本需确认，材料重新选用。', commands: [{ op: 'instantiate-blueprint', id: metadata.id, version: metadata.version }] }) }; }
    reviewed = input.after; const query = input.sources.find((item: any) => item.id === 'query');
    return { content: JSON.stringify({ verdict: 'accept', reason: '合成审查，仅核对提案', evidence: [{ sourceId: query.id, quote: query.text }] }) };
  } });
  assert.equal(reply.commands[0].op, 'instantiate-blueprint');
  const proposed = applyS2Commands(definition, withV2, reply.commands);
  assert.deepEqual(reviewed, s2CanvasContext(proposed, null, proposed.execution!.nodes.filter(node => !withV2.execution!.nodes.some(item => item.id === node.id)).map(node => node.id)), 'Review and later application use the exact same allocated node IDs');
  assert.equal(reply.executionRequest, undefined);

  let live!: S2PluginHost; const ui = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: { ...scene, canvasWorkspace: { ...definition, initial: source } }, onHost: value => { live = value; } }); uis.push(ui);
  await ui.openConversationSession();
  ui.labelControl('蓝图名称', 'input').props.onChange({ target: { value: '可复用记录' } }); ui.render();
  ui.button('预览将保存的蓝图').props.onClick(); ui.render(); const staleSave = ui.button('确认保存蓝图版本').props.onClick;
  ui.labelControl('用途说明', 'textarea').props.onChange({ target: { value: '新的合成用途' } }); ui.render(); staleSave(); ui.render(); assert.equal(ui.text().includes('可复用蓝图库（0 / 8）'), true);
  ui.button('预览将保存的蓝图').props.onClick(); ui.render(); ui.button('确认保存蓝图版本').props.onClick(); ui.render();
  assert.ok(ui.text().includes('可复用蓝图库（1 / 8）')); assert.equal(live.history().length, 0);
  const before = new Set(ui.flow().props.nodes.filter((node: any) => node.type === 'execution').map((node: any) => node.id));
  const oldAdd = ui.button('添加到当前画布（不运行）').props.onClick; oldAdd(); ui.render(); oldAdd(); ui.render();
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'execution' && !before.has(node.id)).length, 2, 'One stale click cannot create a second instance');
  ui.button('添加到当前画布（不运行）').props.onClick(); ui.render(); assert.equal(live.history().length, 0); assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 3);
  const newParse = ui.flow().props.nodes.find((node: any) => node.type === 'execution' && !before.has(node.id) && node.data.node.capabilityId === 'parse-json');
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: newParse.id } }); ui.render();
  ui.labelControl('为文本内容选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['field', 'input', 'content']) } }); ui.render();
  ui.button('返回上级画布').props.onClick(); ui.render(); ui.viewContext(newParse.id).execution!.run([newParse.id, ...ui.flow().props.nodes.filter((node: any) => node.type === 'execution' && !before.has(node.id) && node.data.node.capabilityId === 'to-table').slice(0, 1).map((node: any) => node.id)]);
  for (let i = 0; i < 100 && live.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(live.workflowHistory().at(-1)?.status, 'succeeded'); assert.equal(live.remainingCalls, 62);
  ui.button('保存场景').props.onClick();
  for (let i = 0; i < 100 && !ui.saved.length; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(ui.saved[0].canvasWorkspace.initial.blueprints.length, 1); assert.ok(!JSON.stringify(ui.saved[0]).includes('availableArtifactIds'));
  const oldRemove = ui.button('从库中移除此版本（保留实例）').props.onClick; oldRemove(); ui.render(); assert.ok(ui.text().includes('可复用蓝图库（0 / 8）')); assert.equal(live.remainingCalls, 62);
  ui.keyShortcut('undo'); ui.render(); assert.ok(ui.text().includes('可复用蓝图库（1 / 8）'));
  const beforeDispose = JSON.stringify(ui.flow().props.nodes); ui.dispose(); oldRemove(); assert.throws(() => ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ui.flow().props.nodes), beforeDispose); assert.equal(ui.modelCalls(), 1);
  assert.equal(network, 0);
  console.log('S2 blueprint library passed: immutable exact releases, bounded complete nested designs, strict inert/permission split and no imported authority, private/default-free context index and builder preservation, independent native instances with actual local results, stable source-bound reviewed IDs, production preview/save/add/bind/run/template/remove/undo/end and stale guards. Synthetic offline only; not browser/live-model/global-library/upgrade acceptance.');
} finally { host.close(); uis.forEach(ui => ui.dispose()); globalThis.fetch = previous; }
