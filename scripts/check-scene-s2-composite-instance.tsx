import assert from 'node:assert/strict';
import { inspectS2CompositeInstance } from '../src/services/scene/sceneS2CompositeInstance';
import { createS2CompositeDesign, instantiateS2CompositeDesign, removeS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite, unwrapS2CanvasComposite, moveS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { mutateS2Batch } from '../src/services/scene/sceneS2Layout';
import { createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph } from '../src/services/scene/sceneS2Canvas';
import { s2CanvasContext } from '../src/services/scene/sceneS2Context';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

const definition = readS2Definition(browserDefinition), plugins = definition.plugins!;
const child = wrapS2CanvasComposite(definition.initial, plugins, ['parse'], '读取材料');
const root = wrapS2CanvasComposite(child.document, plugins, ['parse', 'rows'], '原始处理');
const metadata = { id: 'records', version: '1.0.0', label: '独立处理', description: '合成实例差异检查' };
const design = createS2CompositeDesign(root.document, plugins, root.id, metadata);
const library = readS2Document({ ...root.document, blueprints: [design] }, definition);
const instance = instantiateS2CompositeDesign(library, plugins, metadata.id, metadata.version, { position: { x: 250, y: 120 }, inputs: { [design.blueprint.inputs[0].id]: '[{"name":"PRIVATE_INPUT","score":0}]' } });
const document = readS2Document(instance.document, definition), original = JSON.stringify(document);
const source = document.composites!.find(item => item.id === instance.id)!.blueprint!;
const nodeId = (localId: string) => source.mapping!.nodes.find(entry => entry.localId === localId)!.id;
const shellId = (localId: string) => source.mapping!.composites.find(entry => entry.localId === localId)!.id;
const inspect = (value: unknown = document) => inspectS2CompositeInstance(value, definition, instance.id);
const compared = (value: unknown = document) => { const report = inspect(value); if (report.status !== 'compared') throw new Error(report.reason); return report; };
const clean = compared();
assert.equal(clean.structuralDifferences, false); assert.equal(clean.relativeLayoutChanged, false);
assert.equal(clean.materials[0].targets[0], '已填写内容'); assert.equal(clean.applied, false); assert.equal(clean.migrationSupported, false);
assert.ok(!JSON.stringify(clean).includes('PRIVATE_INPUT')); assert.equal(JSON.stringify(document), original);
const reorder = structuredClone(document); reorder.execution!.nodes.reverse(); reorder.composites!.reverse(); reorder.composites!.forEach(item => item.nodeIds.reverse());
assert.deepEqual(compared(reorder), clean, 'No guessing by node/shell/member array position');
const legacy = structuredClone(document); delete legacy.composites!.find(item => item.id === instance.id)!.blueprint!.mapping;
assert.equal(inspect(legacy).status, 'unavailable'); assert.ok(inspect(legacy).note.includes('不证明历史来源真实性'));
assert.equal(inspect(removeS2CompositeDesign(document, metadata.id, metadata.version)).status, 'unavailable');
const foreign = structuredClone(document); foreign.composites!.find(item => item.id === instance.id)!.blueprint!.mapping!.nodes[0].localId = 'unknown';
assert.equal(inspect(foreign).status, 'unavailable');
const wrongRoot = structuredClone(document); wrongRoot.composites!.find(item => item.id === instance.id)!.blueprint!.mapping!.composites.find(item => item.localId === design.rootId)!.id = root.id;
assert.equal(inspect(wrongRoot).status, 'unavailable');
const swapped = structuredClone(document), swappedMap = swapped.composites!.find(item => item.id === instance.id)!.blueprint!.mapping!.nodes;
[swappedMap[0].id, swappedMap[1].id] = [swappedMap[1].id, swappedMap[0].id];
assert.equal(compared(swapped).structuralDifferences, true, 'A plausible map is not proof of unchanged actual capabilities');
let gets = 0;
const hostile = { ...document }; Object.defineProperty(hostile, 'execution', { enumerable: true, get: () => { gets++; return document.execution; } });
assert.throws(() => inspect(hostile)); assert.equal(gets, 0);
for (const corrupt of [
  (map: any) => { map.granted = true; },
  (map: any) => { map.nodes.push(map.nodes[0]); },
  (map: any) => { map.nodes[0].execute = true; },
  (map: any) => { delete map.nodes[0]; },
  (map: any) => { map.composites = []; },
]) {
  const value = structuredClone(document); corrupt(value.composites!.find(item => item.id === instance.id)!.blueprint!.mapping); assert.throws(() => inspect(value));
}
const renamed = structuredClone(document); renamed.execution!.nodes.find(node => node.id === nodeId('parse'))!.presentation = { label: '我改过的读取' };
assert.ok(compared(renamed).nodeChanges.some(change => change.changes.includes('名称、说明或交互表单改变')));
const rewired = structuredClone(document); rewired.execution!.links = rewired.execution!.links.filter(link => link.target.nodeId !== nodeId('rows'));
assert.equal(compared(rewired).internalLinksChanged, true);
const guarded = structuredClone(document); guarded.execution!.nodes.find(node => node.id === nodeId('rows'))!.when = { nodeId: nodeId('parse'), portId: 'value', pointer: '/0/score', equals: 0, match: true };
assert.ok(compared(guarded).nodeChanges.some(change => change.changes.includes('条件改变')));
const newStep = structuredClone(document); newStep.execution!.nodes.push({ ...structuredClone(document.execution!.nodes.find(node => node.id === nodeId('rows'))!), id: 'extra', bindings: {}, position: { x: 3000, y: 0 } });
newStep.composites!.find(item => item.id === instance.id)!.nodeIds.push('extra');
assert.ok(compared(newStep).nodeChanges.some(change => change.changes.includes('组合内新增步骤')));
const deleted = readS2Document(mutateS2Batch(document, { kind: 'delete', nodeIds: [nodeId('parse')] }), definition);
assert.ok(compared(deleted).nodeChanges.some(change => change.changes.includes('原版步骤已删除')));
assert.ok(deleted.composites!.find(item => item.id === instance.id)!.blueprint!.mapping!.nodes.some(entry => entry.id === nodeId('parse')), 'Deletion retains source tombstones');
const moved = moveS2CanvasComposite(document, shellId(child.id));
assert.ok(compared(moved).nodeChanges.some(change => change.changes.includes('原版步骤已移出此组合')));
assert.ok(compared(moved).hierarchyChanges.some(change => change.includes('移出组合')));
const unwrapped = unwrapS2CanvasComposite(document, shellId(child.id));
assert.ok(compared(unwrapped).hierarchyChanges.some(change => change.includes('已拆开或移除')));
const changedLayout = structuredClone(document); changedLayout.execution!.nodes.find(node => node.id === nodeId('rows'))!.position.x += 15;
assert.equal(compared(changedLayout).relativeLayoutChanged, true);
assert.equal(compared(changedLayout).structuralDifferences, false);
const external = structuredClone(document);
external.execution!.nodes.find(node => node.id === nodeId('parse'))!.bindings.text = { kind: 'field', nodeId: 'input', fieldId: 'content' };
external.execution!.links.push({ source: { nodeId: nodeId('rows'), portId: 'table' }, target: { nodeId: 'view', portId: 'table' } });
external.execution!.nodes.find(node => node.id === 'view')!.when = { nodeId: nodeId('parse'), portId: 'value', pointer: '/0/score', equals: 0, match: true };
assert.equal(compared(external).externalConnectionCount, 3, 'Count field, data and control references without confusing them with internal wiring');
assert.equal(compared(external).structuralDifferences, false);
assert.equal(compared(external).materials[0].targets[0], '已选择内容块');
const sourceGuard = structuredClone(library); sourceGuard.execution!.nodes.find(node => node.id === 'rows')!.when = { nodeId: 'parse', portId: 'value', pointer: '/0/score', equals: false, match: true };
const guardDesign = createS2CompositeDesign(sourceGuard, plugins, root.id, metadata); sourceGuard.blueprints = [guardDesign];
const guardInstance = instantiateS2CompositeDesign(sourceGuard, plugins, metadata.id, metadata.version);
const guardReport = inspectS2CompositeInstance(guardInstance.document, definition, guardInstance.id);
assert.equal(guardReport.status, 'compared'); if (guardReport.status === 'compared') assert.equal(guardReport.structuralDifferences, false, 'Source guard endpoints must be mapped before comparison');

// Independent copies and subgraph/template roundtrips remap provenance instead of pointing at the original.
for (const current of [document, deleted, moved]) {
  const rootNow = current.composites!.find(item => item.id === instance.id)!;
  const copied = readS2Document(mutateS2Batch(current, { kind: 'copy', nodeIds: rootNow.nodeIds }), definition);
  const clone = copied.composites!.find(item => item.blueprint?.id === metadata.id && item.id !== instance.id && !current.composites!.some(old => old.id === item.id))!;
  assert.ok(clone); assert.ok(clone.blueprint!.mapping!.nodes.every(entry => !current.execution!.nodes.some(node => node.id === entry.id)));
  assert.ok(clone.blueprint!.mapping!.composites.every(entry => !current.composites!.some(item => item.id === entry.id)));
  const cloneReport = inspectS2CompositeInstance(copied, definition, clone.id); assert.equal(cloneReport.status, 'compared');
  if (current === deleted && cloneReport.status === 'compared') assert.ok(cloneReport.nodeChanges.some(change => change.changes.includes('原版步骤已删除')));
}
const fragment = exportS2Subgraph(definition, document, instance.nodeIds);
const imported = importS2Subgraph(fragment, definition, library), importedRoot = imported.document.composites!.find(item => item.blueprint?.id === metadata.id)!;
assert.ok(importedRoot.blueprint!.mapping!.nodes.every(entry => imported.nodeIds.includes(entry.id)));
const importedReport = inspectS2CompositeInstance(imported.document, definition, importedRoot.id);
assert.equal(importedReport.status, 'compared');
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, document)).initial.composites, document.composites);
assert.ok(!JSON.stringify(s2CanvasContext(document, null, [])).includes('localId'), 'Routine Agent context omits local source maps');
const large = structuredClone(document); large.nodes.forEach(node => { node.values.content = 'x'.repeat(5900); });
assert.ok(!JSON.stringify(s2CanvasContext(large, null, [])).includes('localId'), 'Indexed Agent context also omits maps');
const partial = mutateS2Batch(document, { kind: 'copy', nodeIds: [nodeId('rows')], compositeId: instance.id });
assert.ok(compared(partial).nodeChanges.some(change => change.changes.includes('组合内新增步骤')));

// Native falsy/default values are compared by presence, not truthiness. No raw value enters the report.
for (const value of [false, 0, null, '', 'PRIVATE_DEFAULT']) {
  const cap = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'stringify' };
  const local = { ...definition, plugins: [cap], initial: { nodes: [], edges: [], execution: { version: 1 as const, nodes: [{ id: 'convert', ...cap, bindings: { value: { kind: 'literal' as const, value } }, position: { x: 0, y: 0 } }], links: [] } } };
  const wrapped = wrapS2CanvasComposite(local.initial, [cap], ['convert'], '转换');
  const native = createS2CompositeDesign(wrapped.document, [cap], wrapped.id, { ...metadata, label: '转换' });
  const added = instantiateS2CompositeDesign({ ...wrapped.document, blueprints: [native] }, [cap], metadata.id, metadata.version);
  const check = (input: unknown) => { const result = inspectS2CompositeInstance(input, local, added.id); if (result.status !== 'compared') throw new Error(result.reason); return result; };
  assert.equal(check(added.document).parameters[0].differsFromSource, false);
  delete added.document.execution!.nodes.find(node => node.id === added.nodeIds[0])!.bindings.value;
  const report = check(added.document); assert.equal(report.parameters[0].differsFromSource, true); assert.equal(report.parameters[0].state, '当前未设置');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_DEFAULT'));
}
const bindCap = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'bind' };
const fixedDefinition = { ...definition, plugins: [bindCap], initial: { nodes: [], edges: [], execution: { version: 1 as const,
  nodes: [{ id: 'bind', ...bindCap, position: { x: 0, y: 0 }, bindings: { key: { kind: 'literal' as const, value: 'role' }, value: { kind: 'literal' as const, value: 'PRIVATE_FIXED' } } }], links: [] } } };
const fixedRoot = wrapS2CanvasComposite(fixedDefinition.initial, [bindCap], ['bind'], '角色设定');
const fixedDesign = createS2CompositeDesign(fixedRoot.document, [bindCap], fixedRoot.id, { ...metadata, label: '角色设定' });
const fixedInstance = instantiateS2CompositeDesign({ ...fixedRoot.document, blueprints: [fixedDesign] }, [bindCap], metadata.id, metadata.version);
fixedInstance.document.execution!.nodes.find(node => node.id === fixedInstance.nodeIds[0])!.bindings.key = { kind: 'literal', value: 'task' };
const fixedReport = inspectS2CompositeInstance(fixedInstance.document, fixedDefinition, fixedInstance.id);
assert.equal(fixedReport.status, 'compared'); if (fixedReport.status === 'compared') assert.ok(fixedReport.nodeChanges.some(change => change.changes.includes('内部固定内容或绑定改变')));
assert.ok(!JSON.stringify(fixedReport).includes('PRIVATE_FIXED'));

const previousFetch = globalThis.fetch; let network = 0; globalThis.fetch = async () => { network++; throw new Error('Synthetic instance inspection only'); };
const host = new S2PluginHost('instance-inspection', plugins); let ui: ReturnType<typeof harness> | undefined;
try {
  host.setDocument(document); const run = await host.enqueueWorkflow(instance.nodeIds).completion; assert.equal(run.status, 'succeeded');
  const snapshot = () => { const { event: _, ...frame } = host.prepare(null, undefined, '').frame; return JSON.stringify(frame); };
  const before = JSON.stringify(host.history()), frame = snapshot(), remaining = host.remainingCalls;
  inspect(); host.setDocument(legacy); inspect(legacy);
  assert.equal(JSON.stringify(host.history()), before); assert.equal(snapshot(), frame); assert.equal(host.remainingCalls, remaining);
  assert.deepEqual(s2SemanticDocument(document), s2SemanticDocument(legacy));
  let live!: S2PluginHost;
  const scene = { ...createS2Scene(browserRequest), canvasWorkspace: { ...definition, initial: document } };
  ui = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: scene, onHost: value => { live = value; } });
  await ui.openConversationSession();
  const label = `检查实例差异 · ${metadata.label}`, stale = ui.button(label).props.onClick;
  const revision = live.prepare(null, undefined, '').frame.revision, modelCalls = ui.modelCalls();
  stale(); ui.render(); assert.ok(ui.text().includes('未发现内部步骤、接线或层级差异'));
  assert.ok(!ui.text().includes('PRIVATE_INPUT')); assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64);
  assert.equal(live.prepare(null, undefined, '').frame.revision, revision); assert.equal(ui.modelCalls(), modelCalls);
  ui.button('＋内容与笔记').props.onClick(); ui.render(); assert.ok(ui.text().includes('实例检查已过期'));
  stale(); ui.render(); assert.ok(ui.text().includes('实例检查已过期'), 'Old handler cannot refresh a changed document');
  ui.button(label).props.onClick(); ui.render(); assert.ok(ui.text().includes('未发现内部步骤、接线或层级差异'));
  const endHandler = ui.button(label).props.onClick;
  const beforeDispose = JSON.stringify(ui.flow().props.nodes); ui.dispose(); endHandler();
  assert.throws(() => ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ui.flow().props.nodes), beforeDispose); assert.equal(live.history().length, 0); assert.equal(ui.modelCalls(), modelCalls);
  assert.equal(network, 0); assert.equal(JSON.stringify(document), original);
  console.log('S2 instance inspection passed: explicit bounded ID maps, strict inert/legacy fail-closed parsing, ordered-independent actual graph comparison, native defaults/materials separated from structure, missing/moved/added nodes, conditions/wiring/hierarchy/layout, remapped copies/tombstones/subgraphs/templates, private-value-free reports/context, unchanged actual Host receipts/revision/budget, production readonly/stale/end UI. Synthetic offline only; no migration, source-authenticity certification, browser/live-model acceptance or real resources.');
} finally { host.close(); ui?.dispose(); globalThis.fetch = previousFetch; }
