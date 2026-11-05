// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { applyS2Commands, createS2Scene, designS2Canvas, exportS2Subgraph, exportS2Workspace, importS2Subgraph, importS2Workspace, readS2Definition, readS2Document, interactS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { moveS2CanvasComposite, readS2CanvasComposites, s2CanvasCompositeBlueprint, s2CompositePath, wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { harness } from './scene-s2-ui-harness';
import { addS2PackCapability } from './fixtures/s2-canvas-ui-actions';

const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic nested canvas only'); };
const definition = readS2Definition(browserDefinition), plugins = definition.plugins;
definition.initial.execution!.links.push({ source: { nodeId: 'rows', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } });
const base = readS2Document(definition.initial, definition), original = JSON.stringify(base);
const parse = wrapS2CanvasComposite(base, plugins, ['parse'], '读取材料'), rows = wrapS2CanvasComposite(parse.document, plugins, ['rows'], '整理材料');
const parent = wrapS2CanvasComposite(rows.document, plugins, ['parse', 'rows'], '处理记录'), nested = readS2Document(parent.document, definition);
const validate = (doc: typeof nested) => readS2Document(doc, definition);
const composite = (id: string) => nested.composites!.find(item => item.id === id)!;
assert.deepEqual(s2CompositePath(nested, parse.id).map(item => item.id), [parent.id, parse.id]);
assert.deepEqual(s2SemanticDocument(nested), s2SemanticDocument(base));
assert.deepEqual(s2CanvasCompositeBlueprint(nested, composite(parent.id), plugins).outputs[0].source, { nodeId: 'rows', portId: 'table' });
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, nested)).initial.composites, nested.composites);
for (const invalid of [
  nested.composites!.map(item => item.id === parent.id ? { ...item, parentId: parse.id } : item),
  nested.composites!.map(item => item.id === parse.id ? { ...item, parentId: 'missing' } : item),
  nested.composites!.map(item => item.id === parent.id ? { ...item, nodeIds: ['rows'] } : item),
  [...nested.composites!, { id: 'sibling', label: '非法共享', nodeIds: ['parse'] }],
  nested.composites!.map(item => item.id === parse.id ? { ...item, parentId: null } : item),
  nested.composites!.map(item => item.id === parse.id ? { ...item, nodeIds: [parent.id] } : item),
]) assert.throws(() => readS2CanvasComposites(invalid, base, plugins));
let getter = 0; const hostile = { ...composite(parse.id) }; Object.defineProperty(hostile, 'parentId', { enumerable: true, get: () => { getter++; return parent.id; } });
assert.throws(() => readS2CanvasComposites([hostile], base, plugins)); assert.equal(getter, 0);
let deep = wrapS2CanvasComposite(base, plugins, ['parse'], '第一层');
for (let i = 2; i <= 4; i++) deep = wrapS2CanvasComposite(deep.document, plugins, ['parse'], `第${i}层`);
assert.equal(Math.max(...deep.document.composites!.map(item => s2CompositePath(deep.document, item.id).length)), 4);
assert.throws(() => wrapS2CanvasComposite(deep.document, plugins, ['parse'], '第五层'), /4层/);
assert.throws(() => wrapS2CanvasComposite(nested, plugins, ['parse'], '越层截取'), /完整/);
assert.throws(() => moveS2CanvasComposite(nested, parent.id, parse.id), /自身/);
assert.throws(() => applyS2Commands(definition, nested, [{ op: 'move-composite', id: parse.id }]), /明确/);
const moved = validate(moveS2CanvasComposite(nested, parse.id));
assert.equal(moved.composites!.find(item => item.id === parse.id)!.parentId, undefined);
assert.deepEqual(moved.composites!.find(item => item.id === parent.id)!.nodeIds, ['rows']);
const returned = applyS2Commands(definition, moved, [{ op: 'move-composite', id: parse.id, parentId: parent.id }]);
assert.deepEqual(new Set(returned.composites!.find(item => item.id === parent.id)!.nodeIds), new Set(['parse', 'rows']));
const alone = wrapS2CanvasComposite(parse.document, plugins, ['parse'], '只有子组合');
const emptyRemoved = validate(moveS2CanvasComposite(alone.document, parse.id));
assert.ok(!emptyRemoved.composites!.some(item => item.id === alone.id));
const dissolved = applyS2Commands(definition, nested, [{ op: 'remove-composite', id: parent.id }]);
assert.ok(dissolved.composites!.every(item => !item.parentId)); assert.deepEqual(s2SemanticDocument(dissolved), s2SemanticDocument(base));
const copied = applyS2Commands(definition, nested, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['parse', 'rows'] } }]);
assert.equal(copied.composites!.length, 6);
const newRoot = copied.composites!.find(item => !item.parentId && item.id !== parent.id)!;
assert.equal(copied.composites!.filter(item => item.parentId === newRoot.id).length, 2);
assert.ok(newRoot.nodeIds.every(id => !['parse', 'rows'].includes(id)));
const innerCopy = applyS2Commands(definition, nested, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['parse'], compositeId: parent.id } }]);
assert.equal(innerCopy.composites!.length, 4); assert.equal(innerCopy.composites!.find(item => item.id === parent.id)!.nodeIds.length, 3);
assert.equal(innerCopy.composites!.find(item => item.label === '读取材料 副本')!.parentId, parent.id);
const leafCopy = applyS2Commands(definition, nested, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['parse'], compositeId: parse.id } }]);
assert.equal(leafCopy.composites!.length, 3); assert.equal(leafCopy.composites!.find(item => item.id === parse.id)!.nodeIds.length, 2);
assert.throws(() => applyS2Commands(definition, nested, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['view'], compositeId: parse.id } }]), /超出/);
const fragment = exportS2Subgraph(definition, nested, ['parse']), childFragment = JSON.parse(fragment);
assert.equal(childFragment.definition.initial.composites.length, 1); assert.equal(childFragment.definition.initial.composites[0].parentId, undefined);
const imported = importS2Subgraph(exportS2Subgraph(definition, nested, ['parse', 'rows']), definition, nested).document;
assert.equal(imported.composites!.length, 6); assert.equal(imported.composites!.filter(item => !item.parentId).length, 2);
const deleted = applyS2Commands(definition, nested, [{ op: 'remove-execution-node', id: 'parse' }]);
assert.equal(deleted.composites!.length, 2); assert.deepEqual(deleted.composites!.find(item => item.id === parent.id)!.nodeIds, ['rows']);
assert.equal(applyS2Commands(definition, deleted, [{ op: 'remove-execution-node', id: 'rows' }]).composites!.length, 0);
assert.equal(JSON.stringify(base), original);

const host = new S2PluginHost('synthetic-nesting', plugins!), uis: ReturnType<typeof harness>[] = [];
try {
  host.setDocument(base); const run = await host.enqueueWorkflow(['view']).completion, calls = host.remainingCalls;
  host.setDocument(nested); host.setDocument(moved); host.setDocument(dissolved);
  assert.equal(host.remainingCalls, calls); assert.equal(host.history()[0].receipt.publication, 'current');
  assert.equal(host.prepare(null, { goal: 'g', ...definition.instructions }, 'explain').frame.revision, run.revision);
  const humanPlugins = [{ pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' }];
  const human = { nodes: [], edges: [], execution: { version: 1 as const, links: [], nodes: [{ id: 'ask', ...humanPlugins[0], position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal' as const, value: '合成回答' } } }] } };
  const humanHost = new S2PluginHost('nested-wait', humanPlugins);
  try {
    humanHost.setDocument(human); const job = humanHost.enqueueWorkflow(['ask']);
    for (let i = 0; i < 100 && !humanHost.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
    const wait = humanHost.waitingHumanInputs()[0]; assert.ok(wait);
    const child = wrapS2CanvasComposite(human, humanPlugins, ['ask'], '回答'), outer = wrapS2CanvasComposite(child.document, humanPlugins, ['ask'], '人工环节');
    humanHost.setDocument(outer.document); assert.equal(humanHost.waitingHumanInputs()[0].id, wait.id);
    humanHost.submitHumanInput(job.id, wait.id, '完整原文'); assert.equal((await job.completion).status, 'succeeded'); assert.equal(humanHost.remainingCalls, 64);
  } finally { humanHost.close(); }
  const scene = createS2Scene(browserRequest), built = { ...definition, initial: nested };
  const designed = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => s2DesignFixtureResponse(request, built) });
  assert.deepEqual(designed.initial.composites, nested.composites);
  let semanticCalls = 0;
  await interactS2Canvas({ ...scene, canvasWorkspace: built }, nested, '先解释这里的用途，不修改和运行。', null, [], { viewCompositeId: parse.id, invoke: async request => {
    semanticCalls++; const input = JSON.parse(request.userInput);
    assert.deepEqual(input.currentView.compositePath.map((item: any) => item.id), [parent.id, parse.id]);
    if (input.stage === 'turn-understand') {
      assert.equal(input.pluginCatalog, undefined);
      return { content: JSON.stringify({ understanding: '解释当前层', desiredOutcome: '理解用途', actions: ['reply'], constraints: ['不修改和运行'], questions: [], evaluation: 'advice' }) };
    }
    return { content: JSON.stringify({ understanding: '解释当前层', plan: '仅解释', reply: '这里是读取材料组合，不会运行。', commands: [] }) };
  } });
  assert.equal(semanticCalls, 2);
  await assert.rejects(interactS2Canvas({ ...scene, canvasWorkspace: built }, nested, '解释', null, [], { viewCompositeId: 'missing', invoke: async () => { assert.fail('Invalid view must stop before dispatch'); } }), /父级不存在/);
  const anchors = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: { ...scene, canvasWorkspace: built } }); uis.push(anchors);
  anchors.renderComposite(parent.id); anchors.renderComposite(parent.id);
  assert.deepEqual(anchors.anchorUpdates, [parent.id], 'Unchanged ports do not refresh repeatedly');
  anchors.button('进入内部 · 处理记录').props.onClick(); anchors.render();
  anchors.labelControl('移动「读取材料」到', 'select').props.onChange({ target: { value: '' } }); anchors.render();
  anchors.button('返回总画布').props.onClick(); anchors.render(); anchors.renderComposite(parent.id);
  assert.deepEqual(anchors.anchorUpdates, [parent.id, parent.id], 'Moving out refreshes the changed public ports');
  anchors.labelControl('移动「读取材料」到', 'select').props.onChange({ target: { value: parent.id } }); anchors.render(); anchors.renderComposite(parent.id);
  assert.equal(anchors.anchorUpdates.length, 3, 'Moving back refreshes handles even when the shell remains mounted');

  // Real production UI: create an outer shell from two child shells, then wire across child interfaces.
  const editable = structuredClone(rows.document); editable.execution!.links = editable.execution!.links.filter(link => link.target.nodeId !== 'rows');
  let live!: S2PluginHost; const ui = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: { ...scene, canvasWorkspace: { ...definition, initial: editable } }, onHost: value => { live = value; } }); uis.push(ui);
  await ui.openConversationSession();
  const select = (ids: string[]) => { ui.flow().props.onNodesChange(ids.map(id => ({ type: 'select', id, selected: true }))); ui.render(); };
  select([parse.id, rows.id]); ui.labelControl('组合名称', 'input').props.onChange({ target: { value: '记录处理总流程' } }); ui.render();
  ui.button('封装选中步骤').props.onClick(); ui.render();
  const shell = ui.flow().props.nodes.find((node: any) => node.type === 'composite'); assert.equal(shell.data.label, '记录处理总流程');
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 1); assert.equal(live.history().length, 0);
  const oldChange = ui.flow().props.onNodesChange; shell.data.enter(); ui.render();
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 2); assert.ok(ui.text().includes('跳转到组合 · 记录处理总流程'));
  const children = ui.flow().props.nodes.filter((node: any) => node.type === 'composite'), reader = children.find((node: any) => node.id === parse.id), table = children.find((node: any) => node.id === rows.id);
  ui.flow().props.onConnect({ source: reader.id, sourceHandle: `out:${reader.data.blueprint.outputs[0].id}`, target: table.id, targetHandle: `in:${table.data.blueprint.inputs[0].id}` }); ui.render();
  assert.ok(ui.flow().props.edges.some((edge: any) => edge.source === parse.id && edge.target === rows.id && edge.sourceHandle.startsWith('out:output')));
  const pos = ui.flow().props.nodes.find((node: any) => node.id === 'parse').position;
  oldChange([{ type: 'position', id: shell.id, position: { x: -999, y: -999 } }]); ui.render(); assert.deepEqual(ui.flow().props.nodes.find((node: any) => node.id === 'parse').position, pos);
  const oldRun = () => ui.viewContext('parse').execution!.run(['parse', 'rows']);
  const oldViewRun = ui.viewContext('parse').execution!.run;
  ui.flow().props.nodes.find((node: any) => node.id === parse.id).data.enter(); ui.render();
  assert.ok(!ui.flow().props.nodes.find((node: any) => node.id === 'parse').hidden); assert.ok(ui.flow().props.nodes.find((node: any) => node.id === 'rows').hidden);
  assert.throws(() => oldViewRun(['parse', 'rows']), /过期/); ui.render(); assert.equal(live.workflowHistory().length, 0, 'Old layer cannot run a target after navigation');
  ui.button('返回上级画布').props.onClick(); ui.render(); assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 2);
  oldRun();
  for (let i = 0; i < 200 && live.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(live.workflowHistory().at(-1)?.status, 'succeeded'); assert.deepEqual(live.workflowHistory().at(-1)!.targets, ['parse', 'rows']); assert.equal(live.remainingCalls, 62);
  ui.button('保存场景').props.onClick();
  for (let i = 0; i < 100 && !ui.saved.length; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(ui.saved[0].canvasWorkspace.initial.composites.filter((item: any) => item.parentId === shell.id).length, 2);
  ui.button('进入内部 · 读取材料').props.onClick(); ui.render(); ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'parse' } }); ui.render();
  ui.button('复制所选（含内部连线）').props.onClick(); ui.render();
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'execution' && !node.hidden).length, 2, ui.text());
  const beforeAdd = new Set(ui.flow().props.nodes.filter((node: any) => node.type === 'execution').map((node: any) => node.id));
  addS2PackCapability(ui, 'structured-data@1.0.0/parse-json');
  const added = ui.flow().props.nodes.find((node: any) => node.type === 'execution' && !beforeAdd.has(node.id)); assert.ok(added);
  assert.equal(added.data.node.capabilityId, 'parse-json');
  const currentDocument = ui.viewContext(added.id).readCurrent().document;
  assert.ok(currentDocument.composites.find((item: any) => item.id === parse.id).nodeIds.includes(added.id), 'An exact menu addition belongs to the currently open inner combination');
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'execution' && !node.hidden).length, 3); assert.equal(live.history().length, 2, 'Adding/editing does not execute');
  ui.labelControl('移动「读取材料」到', 'select').props.onChange({ target: { value: '' } }); ui.render();
  assert.ok(!ui.text().includes('跳转到组合 · 记录处理总流程跳转到组合 · 读取材料'), 'Moved child now has a root breadcrumb');
  ui.button('返回上级画布').props.onClick(); ui.render();
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 2);
  ui.button('拆开组合（保留步骤） · 读取材料').props.onClick(); ui.render();
  assert.equal(ui.flow().props.nodes.filter((node: any) => node.type === 'composite').length, 1);
  const ended = ui.button('进入内部 · 记录处理总流程').props.onClick; const beforeDispose = JSON.stringify(ui.flow().props.nodes); ui.dispose(); ended();
  assert.throws(() => ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ui.flow().props.nodes), beforeDispose); assert.equal(ui.modelCalls(), 1); assert.equal(network, 0);
  console.log('S2 nested composite passed: explicit bounded parent chains, complete ownership and public boundaries, invalid/cyclic/foreign/deep rejection, reparent/unwrap/prune and partial/full scoped copy, independent remapping/import/template, unchanged actual Host receipts and human waits, synthetic builder, production UI outer-wrap/two-layer navigation/proxy wiring/real member run/new-step ownership/move/end and stale-view callbacks. Offline synthetic only; not browser/live-model/library acceptance.');
} finally { host.close(); uis.forEach(ui => ui.dispose()); globalThis.fetch = previous; }
