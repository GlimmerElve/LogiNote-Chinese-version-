import assert from 'node:assert/strict';
import { previewS2CompositeMigration, prepareS2CompositeCopy, acceptS2CompositeCopy, isS2CompositeCopyCurrent, readS2CompositeCopyDesign, discardS2CompositeCopy,
  type S2CompositeCopyChoice } from '../src/services/scene/sceneS2CompositeMigration';
import { createS2CompositeDesign, instantiateS2CompositeDesign, readS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2CompositeDesign, S2CompositeValues } from '../src/types/sceneS2Composite';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

const definition = readS2Definition(browserDefinition), plugins = definition.plugins!;
const base = structuredClone(definition.initial); base.execution!.nodes.find(node => node.id === 'parse')!.bindings.text = { kind: 'literal', value: '[{"name":"PRIVATE_OLD","score":0}]' };
const child = wrapS2CanvasComposite(base, plugins, ['parse'], '内部读取');
const wrapped = wrapS2CanvasComposite(child.document, plugins, ['parse', 'rows'], '原始处理');
const metadata = { id: 'records', version: '1.0.0', label: '独立处理', description: '合成独立新版副本' };
const first = createS2CompositeDesign(wrapped.document, plugins, wrapped.id, metadata), second = structuredClone(first);
second.blueprint.version = '1.1.0'; second.blueprint.parameters[0].defaultValue = '[{"name":"PRIVATE_TARGET","score":1}]';
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
function setup(a = first, b = second, def: S2CanvasDefinition = definition, initial: S2Document = wrapped.document, values: S2CompositeValues = { parameters: { [first.blueprint.parameters[0].id]: '[{"name":"PRIVATE_ACTUAL","score":0}]' } }) {
  const added = instantiateS2CompositeDesign(readS2Document({ ...initial, blueprints: [a, b] }, def), def.plugins, a.blueprint.id, a.blueprint.version, values);
  const document = readS2Document(added.document, def);
  const report = () => { const p = previewS2CompositeMigration(document, def, added.id, b.blueprint.version); if (p.status !== 'preview') throw new Error(p.reason); return p; };
  const p = report();
  const choices = (choice: S2CompositeCopyChoice) => p.items.filter(item => item.copyChoices.length).map(item => ({ key: item.key, choice }));
  const prepare = (choice: S2CompositeCopyChoice) => prepareS2CompositeCopy(p, document, def, choices(choice));
  return { document, id: added.id, nodeIds: added.nodeIds, report, p, choices, prepare, definition: def };
}
const oldFetch = globalThis.fetch; let network = 0; globalThis.fetch = async () => { network++; throw new Error('Synthetic copy-only verification'); };
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
try {
  const trial = setup(), original = JSON.stringify(trial.document), candidate = trial.prepare('current');
  assert.ok(!JSON.stringify(candidate).includes('PRIVATE_')); assert.equal(candidate.applied, false); assert.equal(candidate.executionRequested, false);
  assert.equal(candidate.nodeCount, 2); assert.equal(candidate.compositeCount, 2); assert.equal(candidate.requiredPending.length, 0);
  const design = readS2CompositeCopyDesign(candidate, trial.document, definition);
  assert.ok(JSON.stringify(design).includes('PRIVATE_ACTUAL')); assert.equal(design.execution.nodes.length, 2);
  assert.ok(!JSON.stringify(design).includes('我的原文')); assert.ok(design.execution.nodes.every(node => !trial.document.execution!.nodes.some(old => old.id === node.id)));
  const reviewedIds = design.execution.nodes.map(node => node.id);
  design.execution.nodes[0].bindings.text = { kind: 'literal', value: 'MUTATED' };
  assert.ok(!JSON.stringify(readS2CompositeCopyDesign(candidate, trial.document, definition)).includes('MUTATED'));
  assert.equal(JSON.stringify(trial.document), original); assert.equal(isS2CompositeCopyCurrent(structuredClone(candidate), trial.document, definition), false);
  const accepted = acceptS2CompositeCopy(candidate, trial.document, definition);
  assert.deepEqual(accepted.nodeIds, reviewedIds); assert.equal(accepted.id, candidate.id);
  assert.deepEqual(accepted.document.execution!.nodes.filter(node => trial.document.execution!.nodes.some(old => old.id === node.id)), trial.document.execution!.nodes);
  assert.deepEqual(accepted.document.composites!.filter(item => trial.document.composites!.some(old => old.id === item.id)), trial.document.composites);
  assert.deepEqual(accepted.document.blueprints, trial.document.blueprints); assert.deepEqual(accepted.document.nodes, trial.document.nodes);
  assert.equal(accepted.document.composites!.find(item => item.id === accepted.id)!.blueprint!.version, '1.1.0');
  assert.throws(() => acceptS2CompositeCopy(candidate, trial.document, definition), /已使用/);
  assert.throws(() => acceptS2CompositeCopy(structuredClone(candidate), trial.document, definition), /过期/);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, accepted.document)).initial, accepted.document);
  const defaults = trial.prepare('target-default'), empty = trial.prepare('empty');
  assert.ok(JSON.stringify(readS2CompositeCopyDesign(defaults, trial.document, definition)).includes('PRIVATE_TARGET'));
  assert.equal(readS2CompositeCopyDesign(empty, trial.document, definition).execution.nodes.find(node => node.capabilityId === 'parse-json')!.bindings.text, undefined);
  assert.equal(empty.requiredPending.length, 1, 'Explicit empty must erase the target default, not silently fill it');
  const cancelled = trial.prepare('current'); discardS2CompositeCopy(cancelled); assert.throws(() => acceptS2CompositeCopy(cancelled, trial.document, definition), /取消/);
  const altered = trial.prepare('current'); altered.nodeCount = 40; assert.equal(isS2CompositeCopyCurrent(altered, trial.document, definition), false);
  const stale = trial.prepare('current'); const changed = structuredClone(trial.document); changed.blueprints![1].blueprint.description = '同版本内容变化';
  assert.throws(() => acceptS2CompositeCopy(stale, changed, definition), /过期/);
  const config = structuredClone(definition); config.instructions.response += '新限制'; assert.throws(() => acceptS2CompositeCopy(stale, trial.document, config), /过期/);
  for (const bad of [[], {}, null, [...trial.choices('current'), ...trial.choices('current')], [{ ...trial.choices('current')[0], key: 'unknown' }], [{ ...trial.choices('current')[0], grant: true }], [{ ...trial.choices('current')[0], choice: 'auto' }]]) {
    assert.throws(() => prepareS2CompositeCopy(trial.p, trial.document, definition, bad));
  }
  let gets = 0; const hostile = [{ key: trial.choices('current')[0].key }]; Object.defineProperty(hostile[0], 'choice', { enumerable: true, get: () => { gets++; return 'current'; } });
  assert.throws(() => prepareS2CompositeCopy(trial.p, trial.document, definition, hostile)); assert.equal(gets, 0);

  // An edited source may be kept while a clean target is added, never overwritten or silently merged.
  const edited = setup(); edited.document.execution!.nodes.find(node => node.id === edited.nodeIds[0])!.presentation = { label: '用户自定义读取' };
  const editedReport = edited.report(); const keep = prepareS2CompositeCopy(editedReport, edited.document, definition, edited.choices('current'));
  const kept = acceptS2CompositeCopy(keep, edited.document, definition); assert.deepEqual(kept.document.execution!.nodes.find(node => node.id === edited.nodeIds[0]), edited.document.execution!.nodes.find(node => node.id === edited.nodeIds[0]));
  assert.ok(keep.warnings.some(reason => reason.includes('不能直接覆盖')));
  const outbound = setup(); outbound.document.execution!.links.push({ source: { nodeId: outbound.nodeIds[1], portId: 'table' }, target: { nodeId: 'view', portId: 'table' } });
  const outboundReport = outbound.report(), outboundCandidate = prepareS2CompositeCopy(outboundReport, outbound.document, definition, outbound.choices('current'));
  const withCopy = acceptS2CompositeCopy(outboundCandidate, outbound.document, definition);
  assert.ok(withCopy.document.execution!.links.some(link => link.source.nodeId === outbound.nodeIds[1] && link.target.nodeId === 'view'));
  assert.ok(!withCopy.document.execution!.links.some(link => withCopy.nodeIds.includes(link.source.nodeId) && !withCopy.nodeIds.includes(link.target.nodeId)), 'No outgoing consumer is rewired');

  // Carry typed content references and external producers, not their bodies/outputs or old internal task chains.
  const field = setup(); field.document.execution!.nodes.find(node => node.id === field.nodeIds[0])!.bindings.text = { kind: 'field', nodeId: 'input', fieldId: 'content' };
  const fieldCopy = acceptS2CompositeCopy(prepareS2CompositeCopy(field.report(), field.document, definition, field.choices('current')), field.document, definition);
  assert.deepEqual(fieldCopy.document.execution!.nodes.find(node => node.id === fieldCopy.nodeIds[0])!.bindings.text, { kind: 'field', nodeId: 'input', fieldId: 'content' });
  const linkedDef = { ...definition, plugins: [...plugins, cap('stringify')] }, linked = setup(first, second, linkedDef);
  linked.document.execution!.nodes.push({ id: 'feed', ...cap('stringify'), position: { x: 100, y: 800 }, bindings: { value: { kind: 'literal', value: [] } } });
  delete linked.document.execution!.nodes.find(node => node.id === linked.nodeIds[0])!.bindings.text;
  linked.document.execution!.links.push({ source: { nodeId: 'feed', portId: 'text' }, target: { nodeId: linked.nodeIds[0], portId: 'text' } });
  const linkedCopy = acceptS2CompositeCopy(prepareS2CompositeCopy(linked.report(), linked.document, linkedDef, linked.choices('current')), linked.document, linkedDef);
  assert.ok(linkedCopy.document.execution!.links.some(link => link.source.nodeId === 'feed' && link.target.nodeId === linkedCopy.nodeIds[0]));
  linked.document.composites!.find(item => item.id === linked.id)!.nodeIds.push('feed');
  assert.throws(() => prepareS2CompositeCopy(linked.report(), linked.document, linkedDef, linked.choices('current')), /冲突/);

  // Same-parent nested copies extend only ancestors, not the source subtree.
  const nested = setup(); const parent = wrapS2CanvasComposite(nested.document, plugins, nested.nodeIds, '外层练习'); nested.document = readS2Document(parent.document, definition);
  const nestedPreview = previewS2CompositeMigration(nested.document, definition, nested.id, '1.1.0'); if (nestedPreview.status !== 'preview') throw new Error(nestedPreview.reason);
  const nestedCandidate = prepareS2CompositeCopy(nestedPreview, nested.document, definition, nested.choices('current'));
  const nestedCopy = acceptS2CompositeCopy(nestedCandidate, nested.document, definition);
  assert.equal(nestedCopy.document.composites!.find(item => item.id === nestedCopy.id)!.parentId, parent.id);
  assert.deepEqual(nestedCopy.document.composites!.find(item => item.id === nested.id), nested.document.composites!.find(item => item.id === nested.id));
  assert.ok(nestedCopy.nodeIds.every(id => nestedCopy.document.composites!.find(item => item.id === parent.id)!.nodeIds.includes(id)));

  const emptyDoc = { nodes: [], edges: [] };
  function native(value: any): S2CompositeDesign {
    const design = structuredClone(first); design.blueprint.id = 'native'; design.blueprint.plugins = [cap('stringify')];
    design.blueprint.workflow = { version: 1, nodes: [{ id: 'convert', ...cap('stringify'), position: { x: 0, y: 0 }, bindings: {} }], links: [] };
    design.blueprint.inputs = []; design.blueprint.parameters = [{ id: 'value', label: '待转换内容', type: { id: 'structured-data.value', version: 1 }, target: { nodeId: 'convert', portId: 'value' }, defaultValue: value }];
    design.blueprint.outputs = [{ id: 'result', label: '结果', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'convert', portId: 'text' } }];
    design.composites = [{ id: design.rootId, label: '转换', nodeIds: ['convert'] }]; return readS2CompositeDesign(design);
  }
  for (const value of [false, 0, null, '']) {
    const a = native('old'), b = native('new'); b.blueprint.version = '1.1.0'; const def = { ...definition, plugins: a.blueprint.plugins, initial: emptyDoc }; delete def.business;
    const n = setup(a, b, def, emptyDoc, { parameters: { value } });
    const copy = acceptS2CompositeCopy(n.prepare('current'), n.document, def);
    assert.deepEqual(copy.document.execution!.nodes.find(node => node.id === copy.nodeIds[0])!.bindings.value, { kind: 'literal', value });
  }
  for (const pluginId of ['local-material', 'project-notes']) {
    const a = structuredClone(first); a.blueprint.id = 'resource'; a.blueprint.plugins = [cap('read-text', pluginId)];
    a.blueprint.workflow = { version: 1, nodes: [{ id: 'read', ...a.blueprint.plugins[0], position: { x: 0, y: 0 }, bindings: {} }], links: [] };
    a.blueprint.inputs = [{ id: 'resource', label: '本局资料', type: { id: 'core.text', version: 1 }, required: true, multiple: false, targets: [{ nodeId: 'read', portId: 'resource' }] }]; a.blueprint.parameters = [];
    a.blueprint.outputs = [{ id: 'text', label: '文本', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'read', portId: 'text' } }]; a.composites = [{ id: a.rootId, label: '资料', nodeIds: ['read'] }];
    const b = structuredClone(a); b.blueprint.version = '1.1.0'; const def = { ...definition, plugins: a.blueprint.plugins, initial: emptyDoc }; delete def.business;
    const resource = setup(a, b, def, emptyDoc, {}); resource.document.execution!.nodes[0].bindings.resource = { kind: 'literal', value: 'PRIVATE_HANDLE' };
    const p = resource.report(); assert.deepEqual(p.items[0].copyChoices, ['empty']);
    assert.throws(() => prepareS2CompositeCopy(p, resource.document, def, resource.choices('current')), /资料/);
    const c = prepareS2CompositeCopy(p, resource.document, def, resource.choices('empty'));
    assert.ok(!JSON.stringify(readS2CompositeCopyDesign(c, resource.document, def)).includes('PRIVATE_HANDLE'));
    const copy = acceptS2CompositeCopy(c, resource.document, def); assert.equal(copy.document.execution!.nodes.find(node => node.id === copy.nodeIds[0])!.bindings.resource, undefined);
  }
  const denied = structuredClone(second); denied.blueprint.plugins.push(cap('stringify')); denied.blueprint.workflow.nodes.push({ id: 'extra', ...cap('stringify'), position: { x: 0, y: 800 }, bindings: { value: { kind: 'literal', value: null } } }); denied.composites.find(item => item.id === denied.rootId)!.nodeIds.push('extra');
  const deniedSetup = setup(first, denied); assert.throws(() => deniedSetup.prepare('current'), /选装/);
  const capacity = setup(); for (let i = capacity.document.execution!.nodes.length; i < 40; i++) capacity.document.execution!.nodes.push({ id: `capacity${i}`, ...cap('parse-json'), position: { x: i, y: 1000 }, bindings: {} });
  assert.throws(() => prepareS2CompositeCopy(capacity.report(), capacity.document, definition, capacity.choices('current')), /40/);

  // Adding a new model-node design still grants no provider, budget or execution permission.
  const modelDesign = structuredClone(first); modelDesign.blueprint.id = 'model-copy'; modelDesign.blueprint.plugins = [cap('generate', 'model-test')];
  modelDesign.blueprint.workflow = { version: 1, nodes: [{ id: 'model', ...modelDesign.blueprint.plugins[0], position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '只用合成材料' } } }], links: [] };
  modelDesign.blueprint.inputs = []; modelDesign.blueprint.parameters = [];
  modelDesign.blueprint.outputs = [{ id: 'text', label: '待核对回复', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'model', portId: 'text' } }];
  modelDesign.composites = [{ id: modelDesign.rootId, label: '模型试验', nodeIds: ['model'] }];
  const nextModelDesign = structuredClone(modelDesign); nextModelDesign.blueprint.version = '1.1.0';
  const modelDef = { ...definition, plugins: modelDesign.blueprint.plugins, initial: emptyDoc }; delete modelDef.business;
  const modelTrial = setup(modelDesign, nextModelDesign, modelDef, emptyDoc, {});
  const modelCopy = acceptS2CompositeCopy(modelTrial.prepare('empty'), modelTrial.document, modelDef);
  const modelHost = new S2PluginHost('copy-no-model-grant', modelDef.plugins); hosts.push(modelHost); modelHost.setDocument(modelCopy.document);
  assert.throws(() => modelHost.enqueueWorkflow(modelCopy.nodeIds), /授权|模型/); assert.equal(modelHost.history().length, 0); assert.equal(modelHost.remainingCalls, 64);

  // Actual Host is untouched by prepare/accept-return; committing the design invalidates old waits but never replays/debits.
  const human = cap('text', 'human-input'), hostDef = { ...definition, plugins: [...plugins, human] }, hostTrial = setup(first, second, hostDef);
  hostTrial.document.execution!.nodes.push({ id: 'ask', ...human, position: { x: 0, y: 900 }, bindings: { prompt: { kind: 'literal', value: '合成等待' } } });
  const host = new S2PluginHost('copy-check', hostDef.plugins); hosts.push(host); host.setDocument(hostTrial.document);
  assert.equal((await host.enqueueWorkflow(hostTrial.nodeIds).completion).status, 'succeeded');
  const waitJob = host.enqueueWorkflow(['ask']); for (let i = 0; i < 200 && !host.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
  const state = () => { const { event: _, ...frame } = host.prepare(null, undefined, '').frame; return JSON.stringify([frame, host.waitingHumanInputs(), host.history(), host.remainingCalls]); };
  const before = state(), remaining = host.remainingCalls;
  const hostPreview = hostTrial.report(), hostCandidate = prepareS2CompositeCopy(hostPreview, hostTrial.document, hostDef, hostTrial.choices('current'));
  const hostCopy = acceptS2CompositeCopy(hostCandidate, hostTrial.document, hostDef); assert.equal(state(), before);
  host.setDocument(hostCopy.document); assert.equal(host.waitingHumanInputs().length, 0); assert.equal((await waitJob.completion).status, 'cancelled');
  assert.equal(host.remainingCalls, remaining); assert.equal(host.history().length, 2);
  const run = await host.enqueueWorkflow(hostCopy.nodeIds).completion; assert.equal(run.status, 'succeeded'); assert.equal(host.remainingCalls, remaining - 2);
  assert.ok(JSON.stringify(host.currentArtifact(run.nodes[1].artifactIds[0])).includes('PRIVATE_ACTUAL'));

  // Production UI: no automatic choices/add, stable reviewed IDs, change/cancel/edit→undo/start/end and duplicate confirmation guards.
  function uiFor(deferStateUpdates = false) { let live!: S2PluginHost; const ui = harness({ legacyCatalogue: true, deferStateUpdates, initialRequest: browserRequest, initialDraft: { ...createS2Scene(browserRequest), canvasWorkspace: { ...definition, initial: trial.document } }, onHost: h => { live = h; } }); uis.push(ui); return { ui, live: () => live }; }
  const targetLabel = `「${metadata.label}」的沿用目标版本`, inputLabel = `新副本的可调项「${first.blueprint.parameters[0].label}」`;
  function choose(ui: ReturnType<typeof harness>, value: string) { ui.labelControl(inputLabel, 'select').props.onChange({ target: { value } }); ui.render(); }
  function previewUI(ui: ReturnType<typeof harness>) { ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '1.1.0' } }); ui.render(); ui.button(`预览材料与参数沿用 · ${metadata.label}`).props.onClick(); ui.render(); }
  const { ui, live } = uiFor(); await ui.openConversationSession(); previewUI(ui);
  assert.equal(ui.button('预览独立新版副本（不添加）').props.disabled, true); choose(ui, 'current');
  ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render();
  assert.ok(!ui.text().includes('PRIVATE_ACTUAL')); const staleConfirm = ui.button('确认添加独立新版副本（不运行）').props.onClick;
  choose(ui, 'target-default'); staleConfirm(); ui.render(); assert.equal(live().history().length, 0); assert.ok(!ui.text().includes('已按确认内容添加'));
  ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render(); const cancelledConfirm = ui.button('确认添加独立新版副本（不运行）').props.onClick;
  ui.button('取消本次副本预览').props.onClick(); ui.render(); cancelledConfirm(); ui.render(); assert.ok(!ui.text().includes('已按确认内容添加'));
  choose(ui, 'current'); ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render(); const undoConfirm = ui.button('确认添加独立新版副本（不运行）').props.onClick;
  ui.button('＋内容与笔记').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); undoConfirm(); ui.render(); assert.ok(!ui.text().includes('已按确认内容添加'));
  ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render(); ui.button('查看新增副本完整设计（含值与技术字段）').props.onClick(); ui.render(); assert.ok(ui.text().includes('PRIVATE_ACTUAL'));
  const confirm = ui.button('确认添加独立新版副本（不运行）').props.onClick; const beforeNodes = trial.document.execution!.nodes.length;
  confirm(); ui.render(); confirm(); ui.render();
  assert.ok(ui.text().includes('已按确认内容添加独立新版副本')); assert.equal(live().history().length, 0); assert.equal(live().remainingCalls, 64); assert.equal(ui.modelCalls(), 1);
  ui.button('保存场景').props.onClick(); for (let i = 0; i < 100 && !ui.saved.length; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  assert.equal(ui.saved[0].canvasWorkspace.initial.execution.nodes.length, beforeNodes + 2);
  assert.deepEqual(ui.saved[0].canvasWorkspace.initial.execution.nodes.filter((node: any) => trial.nodeIds.includes(node.id)), trial.document.execution!.nodes.filter(node => trial.nodeIds.includes(node.id)));
  ui.keyShortcut('undo'); ui.render(); confirm(); ui.render(); assert.equal(ui.modelCalls(), 1);
  const start = uiFor(); previewUI(start.ui); choose(start.ui, 'current'); start.ui.button('预览独立新版副本（不添加）').props.onClick(); start.ui.render();
  const beforeStartConfirm = start.ui.button('确认添加独立新版副本（不运行）').props.onClick; await start.ui.openConversationSession(); beforeStartConfirm(); start.ui.render(); assert.ok(start.ui.text().includes('已按确认内容添加'), 'A read-only conversation no longer invalidates an unchanged design preview');
  const ending = uiFor(); await ending.ui.openConversationSession(); previewUI(ending.ui); choose(ending.ui, 'current'); ending.ui.button('预览独立新版副本（不添加）').props.onClick(); ending.ui.render(); const endConfirm = ending.ui.button('确认添加独立新版副本（不运行）').props.onClick;
  const beforeDispose = JSON.stringify(ending.ui.flow().props.nodes); ending.ui.dispose(); endConfirm(); assert.throws(() => ending.ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ending.ui.flow().props.nodes), beforeDispose); assert.equal(ending.live().history().length, 0);
  // React may evaluate updater functions after documentRef changes. History must retain pre-action values, not that mutable ref.
  const deferred = uiFor(true); await deferred.ui.openConversationSession(); previewUI(deferred.ui); choose(deferred.ui, 'current');
  deferred.ui.button('预览独立新版副本（不添加）').props.onClick(); deferred.ui.render();
  deferred.ui.button('确认添加独立新版副本（不运行）').props.onClick(); deferred.ui.render();
  const exported = () => { deferred.ui.button('导出工作区 JSON 到下方').props.onClick(); deferred.ui.render(); return JSON.parse(deferred.ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial as S2Document; };
  const addedHistory = exported(); assert.equal(addedHistory.execution!.nodes.length, beforeNodes + 2);
  for (let i = 0; i < 2; i++) {
    deferred.ui.keyShortcut('undo'); deferred.ui.render(); assert.deepEqual(exported(), trial.document, 'Undo restores the precise pre-add graph with deferred updates');
    deferred.ui.keyShortcut('redo'); deferred.ui.render(); assert.deepEqual(exported(), addedHistory, 'Redo restores the exact reviewed design with deferred updates');
  }
  assert.equal(deferred.live().history().length, 0); assert.equal(deferred.live().remainingCalls, 64); assert.equal(deferred.ui.modelCalls(), 1);
  assert.equal(network, 0); assert.equal(JSON.stringify(trial.document), original);
  console.log('S2 independent version copy passed: explicit complete selections, host-issued stable full candidates and one-use/cancel/tamper/stale gates, native falsy/default/empty/reference handling, no resource/model authority transfer or output rewiring, nested ownership and atomic capacity rejection, actual Host preview isolation/edit invalidation/separately queued local execution, production select/review/confirm/undo/save/change/cancel/start/end and duplicate guards. Synthetic offline only; not in-place upgrade, global library, real resources, model semantics or browser acceptance.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
