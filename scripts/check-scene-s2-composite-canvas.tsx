// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { readS2Definition, readS2Document, createS2Scene, applyS2Commands, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph, designS2Canvas, interactS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { wrapS2CanvasComposite, s2CanvasCompositeBlueprint, readS2CanvasComposites } from '../src/services/scene/sceneS2CompositeCanvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import { s2CanvasContext } from '../src/services/scene/sceneS2Context';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; assert.fail('Composite canvas checks are synthetic and offline'); };
const definition = readS2Definition(browserDefinition), plugins = definition.plugins;
definition.initial.execution!.links.push({ source: { nodeId: 'rows', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } });
const document = readS2Document(definition.initial, definition), original = JSON.stringify(document);
const wrapped = wrapS2CanvasComposite(document, plugins, ['parse', 'rows'], '整理记录'), current = readS2Document(wrapped.document, definition), composite = current.composites![0];
assert.equal(JSON.stringify(document), original); assert.deepEqual(s2SemanticDocument(current), s2SemanticDocument(document));
const blueprint = s2CanvasCompositeBlueprint(current, composite, plugins);
assert.deepEqual(blueprint.inputs[0].targets, [{ nodeId: 'parse', portId: 'text' }]); assert.equal(blueprint.workflow.nodes[0].bindings.text, undefined);
assert.deepEqual(blueprint.outputs[0].source, { nodeId: 'rows', portId: 'table' }); assert.ok(!JSON.stringify(blueprint).includes('我的原文'));
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, current)).initial.composites, current.composites);
const fragment = exportS2Subgraph(definition, current, composite.nodeIds), imported = importS2Subgraph(fragment, definition, current);
assert.equal(imported.document.composites!.length, 2); assert.ok(imported.document.composites![1].nodeIds.every(id => !composite.nodeIds.includes(id)));
const partial = JSON.parse(exportS2Subgraph(definition, current, ['rows'])); assert.deepEqual(partial.definition.initial.composites, []);
for (const raw of [null, [{}], [{ ...composite, grant: true }], [{ ...composite, nodeIds: ['input'] }], [{ ...composite, nodeIds: ['parse', 'parse'] }], [composite, { ...composite, id: 'another' }], [{ ...composite, id: 'parse' }]]) assert.throws(() => readS2CanvasComposites(raw, document, plugins));
let gets = 0; const hostile = { ...composite }; Object.defineProperty(hostile, 'label', { enumerable: true, get: () => { gets++; return 'unsafe'; } });
assert.throws(() => readS2CanvasComposites([hostile], document, plugins)); assert.equal(gets, 0);
const grouped = { ...structuredClone(document), groups: [{ id: 'groupA', label: '普通组', nodeIds: ['parse'], collapsed: false }] };
assert.throws(() => wrapS2CanvasComposite(grouped, plugins, composite.nodeIds, '冲突'), /重叠/);
const removed = applyS2Commands(definition, current, [{ op: 'remove-execution-node', id: 'rows' }]); assert.deepEqual(removed.composites![0].nodeIds, ['parse']);
const copied = applyS2Commands(definition, current, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: composite.nodeIds } }]); assert.equal(copied.composites!.length, 2);
const partialCopy = applyS2Commands(definition, current, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['rows'] } }]); assert.equal(partialCopy.composites!.length, 1);
const unwrapped = applyS2Commands(definition, current, [{ op: 'remove-composite', id: wrapped.id }]); assert.deepEqual(s2SemanticDocument(unwrapped), s2SemanticDocument(current));
const set = applyS2Commands(definition, document, [{ op: 'set-composite', composite }]); assert.deepEqual(set.composites, current.composites);
const large = structuredClone(current); large.nodes[0].values.content = 'x'.repeat(6000); large.nodes[1].values.content = 'y'.repeat(6000);
assert.deepEqual((s2CanvasContext(large, null, []) as any).composites, current.composites, 'Indexed agent context retains wrapper vocabulary/membership');

const h = new S2PluginHost('synthetic-composite-canvas', plugins!), uis: ReturnType<typeof harness>[] = [];
try {
  h.setDocument(document); const first = await h.enqueueWorkflow(['view']).completion, beforeRevision = first.revision, beforeCalls = h.remainingCalls;
  h.setDocument(current); assert.equal(h.prepare(null, { goal: 'g', ...definition.instructions }, 'explain').frame.revision, beforeRevision);
  assert.equal(h.remainingCalls, beforeCalls); assert.equal(h.history()[0].receipt.publication, 'current');
  // A real in-flight human wait is preserved by encapsulation; the wrapper is not a second answer channel.
  const humanPlugins = [{ pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' }];
  const humanDoc = { nodes: [], edges: [], execution: { version: 1 as const, nodes: [{ id: 'ask', ...humanPlugins[0], position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal' as const, value: '输入合成回答' } } }], links: [] } };
  const humanHost = new S2PluginHost('composite-wait', humanPlugins); humanHost.setDocument(humanDoc);
  try {
    const job = humanHost.enqueueWorkflow(['ask']);
    for (let i = 0; i < 100 && !humanHost.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
    const wait = humanHost.waitingHumanInputs()[0]; assert.ok(wait);
    humanHost.setDocument(wrapS2CanvasComposite(humanDoc, humanPlugins, ['ask'], '填写材料').document);
    assert.equal(humanHost.waitingHumanInputs()[0].id, wait.id); humanHost.submitHumanInput(job.id, wait.id, '合成回答');
    assert.equal((await job.completion).status, 'succeeded'); assert.equal(humanHost.remainingCalls, 64);
  } finally { humanHost.close(); }
  const stages: string[] = [], buildScene = createS2Scene(browserRequest), built = { ...definition, initial: current };
  const designed = await designS2Canvas(buildScene, { disclosure: 'complete', invoke: async request => {
    const input = JSON.parse(request.userInput); stages.push(input.stage);
    if (input.stage === 'assemble') assert.ok(request.systemPromptOverride?.includes('最多4层'));
    return s2DesignFixtureResponse(request, built);
  } });
  assert.deepEqual(stages, ['understand', 'assemble']); assert.deepEqual(designed.initial.composites, current.composites);
  const turnScene = { ...buildScene, canvasWorkspace: { ...definition, initial: document } };
  const reply = await interactS2Canvas(turnScene, document, '把读取和整理封装成组合，只给建议不运行。', null, [], { invoke: async request => {
    const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') {
      assert.ok(!request.systemPromptOverride?.includes('最多4层'));
      return { content: JSON.stringify({ understanding: '合成语义决定', desiredOutcome: '提出封装建议', actions: ['reply', 'edit'], constraints: ['不运行'], questions: [], evaluation: 'advice' }) };
    }
    if (input.stage === 'turn-act') { assert.ok(request.systemPromptOverride?.includes('最多4层')); return { content: JSON.stringify({ understanding: '封装', plan: '等待确认', reply: '仅建议封装，不执行。', commands: [{ op: 'set-composite', composite }] }) }; }
    const query = input.sources.find((source: any) => source.id === 'query');
    return { content: JSON.stringify({ verdict: 'accept', reason: '合成审查，不是模型准确性', evidence: [{ sourceId: query.id, quote: query.text }] }) };
  } });
  assert.equal(reply.commands[0].op, 'set-composite'); assert.equal(reply.executionRequest, undefined); assert.equal(JSON.stringify(document), original);
  const scene = createS2Scene(browserRequest); scene.canvasWorkspace = { ...definition, initial: document };
  let live!: S2PluginHost; const ui = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: scene, onHost: value => { live = value; } }); uis.push(ui);
  await ui.openConversationSession();
  const select = (id: string) => { ui.flow().props.onNodesChange([{ type: 'select', id, selected: true }]); ui.render(); };
  select('parse'); select('rows'); ui.labelControl('组合名称', 'input').props.onChange({ target: { value: '整理记录' } }); ui.render();
  ui.button('封装选中步骤').props.onClick(); ui.render(); assert.ok(ui.text().includes('已封装选中步骤'), ui.text());
  let shell = ui.flow().props.nodes.find((node: any) => node.type === 'composite'); assert.ok(shell); assert.equal(shell.data.label, '整理记录');
  assert.equal(live.workflowHistory().length, 0); assert.ok(ui.flow().props.nodes.find((node: any) => node.id === 'parse').hidden);
  const projected = ui.flow().props.edges.find((edge: any) => edge.source === shell.id && edge.target === 'view'); assert.ok(projected?.sourceHandle.startsWith('out:output'));
  const snapshot = JSON.stringify(shell.data.blueprint); const staleEnter = shell.data.enter;
  shell.data.enter(); ui.render(); assert.ok(ui.text().includes('正在编辑：')); assert.ok(!ui.flow().props.nodes.find((node: any) => node.id === 'parse').hidden);
  ui.button('返回上级画布').props.onClick(); ui.render(); assert.ok(ui.flow().props.nodes.find((node: any) => node.id === 'parse').hidden);
  const source = ui.flow().props.nodes.find((node: any) => node.type === 'composite').data.blueprint.inputs[0];
  ui.flow().props.onConnect({ source: 'input', sourceHandle: 'field:content', target: shell.id, targetHandle: `in:${source.id}` }); ui.render();
  assert.ok(!ui.elements().some(item => item.type === 'button' && ui.text(item) === '运行组合 · 整理记录'), 'No retired global composite-run control');
  ui.viewContext('parse').execution!.run(['parse', 'rows']);
  for (let i = 0; i < 200 && live.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(live.workflowHistory().at(-1)?.status, 'succeeded'); assert.deepEqual(live.workflowHistory().at(-1)!.targets, ['parse', 'rows']);
  assert.equal(live.workflowHistory().at(-1)!.nodes.some(node => node.nodeId === 'view'), false, 'Wrapper run is explicit member targets, not unrelated renderer or full canvas');
  assert.equal(ui.modelCalls(), 1); const calls = live.remainingCalls, revision = live.history().at(-1)!.receipt.revision;
  shell = ui.flow().props.nodes.find((node: any) => node.type === 'composite');
  const position = shell.position;
  ui.flow().props.onNodesChange([{ type: 'position', id: shell.id, position: { x: position.x + 35, y: position.y + 40 }, dragging: false }]); ui.render();
  assert.equal(live.remainingCalls, calls); assert.equal(live.prepare(null, { goal: 'g', ...definition.instructions }, 'explain').frame.revision, revision);
  assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'parse').position.x, document.execution!.nodes[0].position.x + 35);
  staleEnter(); ui.render(); assert.ok(ui.text().includes('组合或画布已变化'));
  const endedEnter = ui.flow().props.nodes.find((node: any) => node.type === 'composite').data.enter;
  ui.button('进入内部 · 整理记录').props.onClick(); ui.render();
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'parse' } }); ui.render();
  const portChoice = ui.labelControl('为文本内容选择材料', 'select'); assert.ok(portChoice);
  ui.button('返回上级画布').props.onClick(); ui.render();
  ui.button('保存场景').props.onClick();
  for (let i = 0; i < 200 && !ui.saved.length; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(ui.saved[0].canvasWorkspace.initial.composites[0].label, '整理记录'); assert.ok(!JSON.stringify(ui.saved[0]).includes('resourceScopes'));
  ui.button('拆开组合（保留步骤） · 整理记录').props.onClick(); ui.render(); assert.ok(!ui.flow().props.nodes.some((node: any) => node.type === 'composite'));
  assert.equal(live.remainingCalls, calls); assert.equal(live.history()[0].receipt.publication, 'current');
  ui.dispose(); endedEnter(); assert.equal(live.workflowHistory().at(-1)?.publication, 'stale'); assert.equal(ui.modelCalls(), 1);
  const ui2 = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: { ...scene, canvasWorkspace: { ...definition, initial: current } } }); uis.push(ui2);
  await ui2.openConversationSession(); const oldNodeChange = ui2.flow().props.onNodesChange;
  const priorPosition = ui2.flow().props.nodes.find((node: any) => node.id === 'rows').position;
  ui2.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '把组合缩到只含整理步骤，先给建议。' } }); ui2.render(); ui2.button('发送').props.onClick(); ui2.render();
  ui2.resolve({ understanding: '合成改封装', plan: '等确认', reply: '仅改变封装成员，不运行。', commands: [{ op: 'set-composite', composite: { ...composite, nodeIds: ['rows'] } }] });
  for (let i = 0; i < 50 && !ui2.elements().some(item => item.type === 'button' && ui2.text(item) === '确认应用修改'); i++) { await new Promise(resolve => setImmediate(resolve)); ui2.render(); }
  assert.equal(ui2.flow().props.nodes.find((node: any) => node.type === 'composite').data.count, 2, 'Agent proposal is not applied automatically');
  assert.ok(ui2.elements().some(item => item.type === 'button' && ui2.text(item) === '确认应用修改'), ui2.text().slice(-1600));
  ui2.button('确认应用修改').props.onClick(); ui2.render(); assert.equal(ui2.flow().props.nodes.find((node: any) => node.type === 'composite').data.count, 1);
  oldNodeChange([{ type: 'position', id: composite.id, position: { x: -900, y: -900 }, dragging: false }]); ui2.render();
  assert.deepEqual(ui2.flow().props.nodes.find((node: any) => node.id === 'rows').position, priorPosition, 'Old shell drag cannot move newly remapped membership');
  assert.equal(ui2.modelCalls(), 2);
  assert.equal(snapshot.includes('整理记录'), true); assert.equal(network, 0);
  console.log('S2 composite canvas passed: validated single-level metadata, recomputed E1 public boundary, overlap/forgery rejection, copy/delete/subgraph/template lifecycle, indexed Agent context, layout-only revision preservation, actual UI encapsulate/enter/back/proxy-field/run/drag/save/unwrap/end and stale callbacks. Synthetic offline handlers, not browser/nested/real-model acceptance.');
} finally { h.close(); uis.forEach(ui => ui.dispose()); globalThis.fetch = previousFetch; }
