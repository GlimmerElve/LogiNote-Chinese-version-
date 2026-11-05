import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { SceneInitialRequest } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

// Real production handlers with an inert, locally imported workspace. No model/config/resource provider.
const fixtureText = readFileSync('scripts/fixtures/s2-output-reconnect-workspace.json', 'utf8');
const definition = importS2Workspace(fixtureText), fixtureKey = JSON.stringify(definition);
const sourceId = definition.initial.composites![0].nodeIds[0];
const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成新版输出重接', knowledgePoints: [], interactionPack: null };
const title = '记录整理组合', targetLabel = `「${title}」的沿用目标版本`;
const carryLabel = `新副本的可调项「${definition.initial.blueprints![0].blueprint.parameters[0].label}」`;
const showButton = '查看下游输出影响（不改线）', checkButton = '检查所选重接方案（不应用）';
const applyButton = '确认添加新版并应用所选重接（不运行）';
const uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic output-apply UI test has no transport'); };
async function uiFor(running = true, deferred = false, value: S2CanvasDefinition = definition) {
  let live: S2PluginHost | undefined;
  const draft = createS2Scene(request); draft.canvasWorkspace = structuredClone(value);
  const ui = harness({ legacyCatalogue: true, initialRequest: request, initialDraft: draft, deferStateUpdates: deferred, onHost: host => { live = host; } }); uis.push(ui);
  if (running) await ui.openConversationSession();
  return { ui, live: () => live };
}
type Trial = Awaited<ReturnType<typeof uiFor>>;
function section(ui: Trial['ui'], label: string) { return ui.elements().find(item => item.type === 'section' && item.props['aria-label'] === label); }
function notice(ui: Trial['ui']) { const status = ui.elements().find(item => item.props.className === 's2-status'); assert.ok(status); return ui.text(status); }
function findButton(ui: Trial['ui'], label: string) { return ui.elements().find(item => item.type === 'button' && ui.text(item) === label); }
function outputs(ui: Trial['ui']) { const region = section(ui, '下游输出重接预览'); assert.ok(region); return ui.elements(region).filter(item => item.type === 'select'); }
function exported(ui: Trial['ui']): S2Document {
  ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render();
  return importS2Workspace(ui.labelControl('工作区 JSON', 'textarea').props.value).initial;
}
function preview(ui: Trial['ui']) {
  ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '1.1.0' } }); ui.render();
  ui.button(`预览材料与参数沿用 · ${title}`).props.onClick(); ui.render();
  ui.labelControl(carryLabel, 'select').props.onChange({ target: { value: 'current' } }); ui.render();
  ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render();
  ui.button(showButton).props.onClick(); ui.render();
}
function choose(ui: Trial['ui'], index: number, keep: boolean) {
  const control = outputs(ui)[index], option = ui.elements(control).find(item => item.type === 'option' && item.props.value && !item.props.disabled && (keep ? item.props.value === 'keep' : item.props.value !== 'keep'));
  assert.ok(option); control.props.onChange({ target: { value: option.props.value } }); ui.render();
}
function checked(ui: Trial['ui'], keepData = false, keepCondition = false) {
  choose(ui, 0, keepData); choose(ui, 1, keepCondition);
  ui.button(checkButton).props.onClick(); ui.render();
  assert.ok(ui.text(section(ui, '重接方案检查结果')).includes('通过结构检查'));
}
async function prepared(running = true, deferred = false, value = definition) {
  const trial = await uiFor(running, deferred, value); preview(trial.ui); checked(trial.ui); return trial;
}
function hostState(trial: Trial) {
  const host = trial.live();
  return JSON.stringify({ history: host?.history(), workflows: host?.workflowHistory(), calls: host?.remainingCalls, models: trial.ui.modelCalls(), saved: trial.ui.saved });
}
function assertIdle(trial: Trial) {
  assert.equal(trial.ui.modelCalls(), trial.live() ? 1 : 0); assert.equal(trial.ui.saved.length, 0);
  if (trial.live()) { assert.equal(trial.live()!.history().length, 0); assert.equal(trial.live()!.workflowHistory().length, 0); assert.equal(trial.live()!.remainingCalls, 64); }
}
function assertApplied(before: S2Document, after: S2Document, keepData: boolean, keepCondition: boolean) {
  const newNodes = after.execution!.nodes.filter(node => !before.execution!.nodes.some(old => old.id === node.id));
  assert.equal(newNodes.length, 1, 'One exact reviewed independent copy is added');
  const newId = newNodes[0].id;
  assert.deepEqual(after.execution!.nodes.find(node => node.id === sourceId), before.execution!.nodes.find(node => node.id === sourceId), 'The old instance is never replaced or edited');
  assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.edges, before.edges); assert.deepEqual(after.blueprints, before.blueprints);
  assert.deepEqual(after.composites!.filter(item => before.composites!.some(old => old.id === item.id)), before.composites);
  assert.deepEqual(after.execution!.links, before.execution!.links.map(link => link.source.nodeId === sourceId && !keepData ? { ...link, source: { ...link.source, nodeId: newId } } : link), 'Only explicitly chosen data consumers are rebound');
  assert.deepEqual(after.execution!.nodes.find(node => node.id === 'view')!.when, { ...before.execution!.nodes.find(node => node.id === 'view')!.when!, ...(!keepCondition ? { nodeId: newId } : {}) }, 'Only the chosen condition source changes; pointer/equals/match stay exact');
  for (const node of before.execution!.nodes.filter(node => node.id !== 'view')) assert.deepEqual(after.execution!.nodes.find(item => item.id === node.id), node);
}
async function tick(ui: Trial['ui']) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
try {
  // No automatic apply: all-keep remains an independent-copy operation, not a fake rewiring confirmation.
  const allKeep = await uiFor(); preview(allKeep.ui);
  assert.equal(findButton(allKeep.ui, applyButton), undefined);
  checked(allKeep.ui, true, true); assert.equal(findButton(allKeep.ui, applyButton), undefined);
  assert.ok(findButton(allKeep.ui, '确认添加独立新版副本（不运行）'));
  assert.deepEqual(exported(allKeep.ui), definition.initial); assertIdle(allKeep);

  // Each checked plan is a single history transition, including both kinds and React-delayed updates.
  for (const deferred of [false, true]) for (const [keepData, keepCondition] of [[false, true], [true, false], [false, false]]) {
    const trial = await uiFor(true, deferred); preview(trial.ui); checked(trial.ui, keepData, keepCondition);
    const before = exported(trial.ui), beforeRevision = trial.live()!.prepare(null, undefined, '').frame.revision;
    const confirm = trial.ui.button(applyButton).props.onClick, independent = trial.ui.button('确认添加独立新版副本（不运行）').props.onClick;
    assert.equal(trial.ui.button(applyButton).props.disabled, false);
    const impact = trial.ui.text(section(trial.ui, '确认重接的影响'));
    for (const text of ['原组合', '可撤销', '人工等待会取消', '历史记录和已用额度保留', '不恢复等待或返还额度']) assert.ok(impact.includes(text), text);
    confirm(); confirm(); independent(); trial.ui.render();
    const after = exported(trial.ui); assertApplied(before, after, keepData, keepCondition);
    const cards = trial.ui.flow().props.nodes.filter((node: any) => node.type === 'composite');
    assert.equal(cards.length, 2); assert.ok(cards.every((node: any) => node.data.label === title));
    assert.deepEqual(Array.from(cards, (node: any) => node.data.referenceLabel), ['组合 1 · 来源 1.0.0', '组合 2 · 来源 1.1.0'], 'Same-name composite copies remain human-distinguishable by ordinal and source version');
    assert.equal(trial.live()!.prepare(null, undefined, '').frame.revision, beforeRevision + 1, 'Duplicate same-tick calls do not create another revision');
    assert.equal(section(trial.ui, '下游输出重接预览'), undefined); assert.equal(findButton(trial.ui, applyButton), undefined); assertIdle(trial);
    for (let i = 0; i < 2; i++) {
      trial.ui.keyShortcut('undo'); trial.ui.render(); assert.deepEqual(exported(trial.ui), before, 'One undo restores every original endpoint and removes the new copy');
      assert.ok(notice(trial.ui).includes('已撤销')); assert.ok(!notice(trial.ui).includes('已添加独立新版并重接'), 'Undo must retire the old apply-success notice');
      assert.equal(trial.ui.keyShortcut('undo').prevented, false, 'A combined add/reconnect must not hide a second undo entry');
      trial.ui.render(); assert.deepEqual(exported(trial.ui), before, 'An unavailable second undo preserves the whole graph');
      confirm(); trial.ui.render(); assert.deepEqual(exported(trial.ui), before, 'Undo cannot revive consumed approval');
      trial.ui.keyShortcut('redo'); trial.ui.render(); assert.deepEqual(exported(trial.ui), after, 'Redo restores exact reviewed IDs, data links and condition values');
      assert.ok(notice(trial.ui).includes('已重做')); assert.ok(!notice(trial.ui).includes('已添加独立新版并重接'), 'Redo describes restored design, not a newly applied approval');
      assertIdle(trial);
    }
  }

  // A later explicit run must not leave the previous "no run" success banner on screen.
  const runNotice = await prepared(); runNotice.ui.button(applyButton).props.onClick(); runNotice.ui.render();
  assert.ok(notice(runNotice.ui).includes('没有运行'));
  const targets = runNotice.ui.viewContext(sourceId).readCurrent().document.execution!.nodes.map(node => node.id);
  runNotice.ui.viewContext(sourceId).execution!.run(targets); runNotice.ui.render();
  assert.equal(runNotice.ui.viewContext(sourceId).execution!.running, true, 'Execution state is node-scoped; no retired global run panel');
  for (let i = 0; i < 100 && ['queued', 'running'].includes(runNotice.live()!.workflowHistory()[0]?.status); i++) await tick(runNotice.ui);
  assert.equal(runNotice.live()!.workflowHistory().length, 1); assert.equal(runNotice.live()!.workflowHistory()[0].status, 'succeeded');
  assert.equal(runNotice.ui.modelCalls(), 1); assert.equal(runNotice.ui.saved.length, 0);

  // Every edit, scope and lifecycle retirement invalidates captured confirmations, not only the visible button.
  const retirements: Array<[string, (trial: Trial) => void | Promise<void>, boolean?]> = [
    ['output choices', ({ ui }) => choose(ui, 1, true)],
    ['output choice and return', ({ ui }) => { choose(ui, 1, true); choose(ui, 1, false); }],
    ['recheck same plan', ({ ui }) => { ui.button(checkButton).props.onClick(); ui.render(); }],
    ['close output preview', ({ ui }) => { ui.button('收起并清除本次重接方案').props.onClick(); ui.render(); }],
    ['regenerate output preview', ({ ui }) => { ui.button(showButton).props.onClick(); ui.render(); }],
    ['target', ({ ui }) => { ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '' } }); ui.render(); }],
    ['copy choice', ({ ui }) => { ui.labelControl(carryLabel, 'select').props.onChange({ target: { value: 'target-default' } }); ui.render(); }],
    ['copy regeneration', ({ ui }) => { ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render(); }],
    ['copy cancellation', ({ ui }) => { ui.button('取消本次副本预览').props.onClick(); ui.render(); }],
    ['selection and return', ({ ui }) => { ui.flow().props.onNodeClick({}, { id: 'rows' }); ui.render(); ui.flow().props.onPaneClick(); ui.render(); }],
    ['edit and undo', ({ ui }) => { ui.button('＋练习笔记').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); }],
    ['layer and return', ({ ui }) => { ui.button(`进入内部 · ${title}`).props.onClick(); ui.render(); ui.button('返回总画布').props.onClick(); ui.render(); }],
    ['return/automatic cleanup', ({ ui }) => { ui.button('返回').props.onClick(); ui.render(); }],
    ['same workspace / fresh scene', async ({ ui }) => { ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: fixtureText } }); ui.render(); ui.button('导入并替换当前预览').props.onClick(); await tick(ui); }, false],
    ['independent copy', ({ ui }) => { ui.button('确认添加独立新版副本（不运行）').props.onClick(); ui.render(); }],
  ];
  for (const [name, retire, running] of retirements) {
    const trial = await prepared(running ?? true), confirm = trial.ui.button(applyButton).props.onClick;
    await retire(trial); const before = exported(trial.ui), state = hostState(trial);
    confirm(); confirm(); trial.ui.render();
    assert.deepEqual(exported(trial.ui), before, `${name}: obsolete approval cannot overwrite current state`);
    assert.equal(hostState(trial), state, `${name}: no host run, budget or save side effects`); assertIdle(trial);
  }

  // In-progress gestures, saving and pending Agent design are guarded synchronously, before any rerender.
  const drag = await prepared(), dragConfirm = drag.ui.button(applyButton).props.onClick;
  drag.ui.flow().props.onNodeDragStart(); dragConfirm(); drag.ui.render();
  assert.deepEqual(exported(drag.ui), definition.initial); assertIdle(drag);
  const saving = await prepared(), saveConfirm = saving.ui.button(applyButton).props.onClick;
  saving.ui.button('保存场景').props.onClick(); saveConfirm(); saving.ui.render();
  assert.deepEqual(exported(saving.ui), definition.initial);
  for (let i = 0; i < 20 && !saving.ui.saved.length; i++) await tick(saving.ui);
  assert.equal(saving.ui.saved.length, 1); assert.equal(saving.ui.modelCalls(), 1); assert.equal(saving.live()!.remainingCalls, 64);
  assert.deepEqual(saving.ui.saved[0].canvasWorkspace.initial, definition.initial);
  const designing = await prepared(false);
  assert.equal(findButton(designing.ui, 'AI 重新设计初稿（替换当前画布）'), undefined, 'Removed redesign workflow is not an alternate write entry');
  assert.deepEqual(exported(designing.ui), definition.initial); assertIdle(designing);

  // A semantic write retires current outputs, caches and human waits without refunding/debiting or auto-running.
  const human = { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' };
  const runtimeDefinition = readS2Definition({ ...definition, plugins: [...definition.plugins!, human], initial: { ...definition.initial,
    execution: { ...definition.initial.execution!, nodes: [...definition.initial.execution!.nodes, { id: 'ask', ...human, position: { x: 40, y: 600 }, bindings: { prompt: { kind: 'literal', value: '只用于测试的人工等待' } } }] } } });
  const runtime = await uiFor(true, false, runtimeDefinition), host = runtime.live()!;
  const oldRun = await host.enqueueWorkflow([sourceId]).completion; assert.equal(oldRun.status, 'succeeded');
  const artifactId = oldRun.nodes[0].artifactIds[0]; assert.ok(host.currentArtifact(artifactId));
  const cachedRun = await host.enqueueWorkflow([sourceId]).completion;
  assert.equal(cachedRun.nodes[0].status, 'cached'); const cachedArtifactId = cachedRun.nodes[0].artifactIds[0];
  assert.ok(host.currentArtifact(cachedArtifactId)); assert.equal(host.prepare(null, undefined, '').cacheReuses.length, 1);
  const wait = host.enqueueWorkflow(['ask']);
  for (let i = 0; i < 100 && !host.waitingHumanInputs().length; i++) await tick(runtime.ui);
  assert.equal(host.waitingHumanInputs().length, 1); const oldWait = host.waitingHumanInputs()[0];
  preview(runtime.ui); checked(runtime.ui);
  const remaining = host.remainingCalls, historyLength = host.history().length, workflows = host.workflowHistory().length;
  const beforeRuntime = exported(runtime.ui);
  assert.ok(host.currentArtifact(artifactId)); assert.equal(host.waitingHumanInputs().length, 1, 'Preview/check do not retire active evidence');
  runtime.ui.button(applyButton).props.onClick(); runtime.ui.render();
  assertApplied(beforeRuntime, exported(runtime.ui), false, false);
  assert.equal((await wait.completion).status, 'cancelled'); assert.equal(host.waitingHumanInputs().length, 0);
  assert.throws(() => host.currentArtifact(artifactId), /当前|修订/);
  assert.throws(() => host.currentArtifact(cachedArtifactId), /当前|修订/); assert.equal(host.prepare(null, undefined, '').cacheReuses.length, 0, 'Old cache evidence is not published as current after the design write');
  assert.throws(() => host.readCurrentStructuredOutput(sourceId, 'value'), /尚无|当前|结果|运行|输出/);
  assert.equal(host.remainingCalls, remaining); assert.equal(host.history().length, historyLength); assert.equal(host.workflowHistory().length, workflows);
  assert.equal(runtime.ui.modelCalls(), 1); assert.equal(runtime.ui.saved.length, 0);
  assert.ok(oldWait.id, 'The retired wait was host-issued, not an invented UI placeholder');
  runtime.ui.keyShortcut('undo'); runtime.ui.render();
  assert.deepEqual(exported(runtime.ui), beforeRuntime); assert.equal(host.waitingHumanInputs().length, 0, 'Undo restores design, not old approvals or waits');
  assert.throws(() => host.currentArtifact(artifactId), /当前|修订/); assert.equal(host.remainingCalls, remaining);

  assert.equal(network, 0); assert.equal(JSON.stringify(definition), fixtureKey);
  console.log('S2 output apply UI passed: explicit checked nonempty plan, one atomic add/reconnect, data and condition choices preserved independently, original instances and condition payloads untouched, duplicate/stale/lifecycle/busy/gesture rejection, exact single-step undo/redo with deferred hooks, native output/wait invalidation without budget changes or automatic execution. Production handlers with synthetic local fixtures only; no real model, resource or business acceptance.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = oldFetch; }
