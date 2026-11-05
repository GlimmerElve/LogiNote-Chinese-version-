import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { instantiateS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import type { SceneInitialRequest } from '../src/types';
import type { S2Document } from '../src/types/sceneS2';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

// This exact, inert file is also imported through the production browser textarea.
const fixtureText = readFileSync('scripts/fixtures/s2-output-reconnect-workspace.json', 'utf8');
const fixture = importS2Workspace(fixtureText), definition = structuredClone(fixture);
const originalFixture = JSON.stringify(fixture), sourceId = definition.initial.composites![0].nodeIds[0];
assert.equal(fixture.initial.blueprints!.length, 2);
assert.equal(fixture.initial.execution!.links.filter(link => link.source.nodeId === sourceId).length, 1);
assert.equal(fixture.initial.execution!.nodes.filter(node => node.when?.nodeId === sourceId).length, 1);
assert.deepEqual(readS2Definition(fixture), fixture);
definition.initial.execution!.nodes.find(node => node.id === sourceId)!.bindings.text = { kind: 'literal', value: 'PRIVATE_SOURCE_BODY' };
definition.initial.blueprints![1].blueprint.parameters[0].defaultValue = 'PRIVATE_TARGET_DEFAULT';
definition.initial.execution!.nodes.find(node => node.id === 'view')!.when!.equals = { PRIVATE_CONDITION_VALUE: false };
const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成下游重接检查', knowledgePoints: [] };
const title = '记录整理组合', targetLabel = `「${title}」的沿用目标版本`;
const choiceLabel = `新副本的可调项「${definition.initial.blueprints![0].blueprint.parameters[0].label}」`;
const previewButton = '查看下游输出影响（不改线）', checkButton = '检查所选重接方案（不应用）';
const uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic read-only output-plan test has no transport'); };
async function uiFor(running = true, deferred = false, canvasDefinition = definition) {
  let live: S2PluginHost | undefined;
  const draft = createS2Scene(request); draft.canvasWorkspace = structuredClone(canvasDefinition);
  const ui = harness({ legacyCatalogue: true, initialRequest: request, initialDraft: draft, deferStateUpdates: deferred, onHost: value => { live = value; } }); uis.push(ui);
  if (running) await ui.openConversationSession();
  return { ui, live: () => live };
}
type Trial = Awaited<ReturnType<typeof uiFor>>;
function section(ui: Trial['ui'], name: string) { return ui.elements().find(item => item.type === 'section' && item.props['aria-label'] === name); }
function controls(ui: Trial['ui']) { const region = section(ui, '下游输出重接预览'); assert.ok(region); return ui.elements(region).filter(item => item.type === 'select'); }
function chooseCopy(ui: Trial['ui'], value = 'current') { ui.labelControl(choiceLabel, 'select').props.onChange({ target: { value } }); ui.render(); }
function copyPreview(ui: Trial['ui']) {
  ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '1.1.0' } }); ui.render();
  ui.button(`预览材料与参数沿用 · ${title}`).props.onClick(); ui.render(); chooseCopy(ui);
  ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render();
}
function showOutputs(ui: Trial['ui']) { ui.button(previewButton).props.onClick(); ui.render(); }
async function prepared(running = true, deferred = false) { const trial = await uiFor(running, deferred); copyPreview(trial.ui); showOutputs(trial.ui); return trial; }
function exported(ui: Trial['ui']): S2Document {
  ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render();
  return importS2Workspace(ui.labelControl('工作区 JSON', 'textarea').props.value).initial;
}
function chooseOutput(ui: Trial['ui'], index: number, keep: boolean) {
  const control = controls(ui)[index], options = ui.elements(control).filter(item => item.type === 'option');
  const choice = options.find(option => option.props.value && !option.props.disabled && (keep ? option.props.value === 'keep' : option.props.value !== 'keep'));
  assert.ok(choice, 'The real public output or explicit keep option must exist');
  control.props.onChange({ target: { value: choice.props.value } }); ui.render();
}
function chooseAll(ui: Trial['ui'], keep = false) { for (let i = 0; i < controls(ui).length; i++) chooseOutput(ui, i, keep); }
function hostState(trial: Trial) {
  const host = trial.live();
  return JSON.stringify({ history: host?.history(), workflows: host?.workflowHistory(), remaining: host?.remainingCalls, models: trial.ui.modelCalls(), saved: trial.ui.saved });
}
function assertIdle(trial: Trial) {
  assert.equal(trial.ui.modelCalls(), trial.live() ? 1 : 0); assert.equal(trial.ui.saved.length, 0);
  if (trial.live()) { assert.equal(trial.live()!.history().length, 0); assert.equal(trial.live()!.workflowHistory().length, 0); assert.equal(trial.live()!.remainingCalls, 64); }
}
try {
  // Production component only: opening, selecting and checking are neither a commit nor a run.
  const first = await uiFor(), beforeDocument = exported(first.ui), beforeHost = hostState(first);
  assert.equal(first.ui.keyShortcut('undo').prevented, false); first.ui.render();
  assert.deepEqual(exported(first.ui), beforeDocument); assert.equal(hostState(first), beforeHost);
  copyPreview(first.ui); showOutputs(first.ui);
  assert.equal(controls(first.ui).length, 2); assert.ok(controls(first.ui).every(control => control.props.value === ''), 'No output is selected automatically');
  assert.equal(first.ui.button(checkButton).props.disabled, true);
  const shown = first.ui.text(section(first.ui, '下游输出重接预览'));
  for (const label of ['材料传递', '运行条件', '读取记录', '整理显示表格', '满足条件时展示', '格式兼容不代表内容适合', '仅添加副本']) assert.ok(shown.includes(label), label);
  for (const value of ['PRIVATE_SOURCE_BODY', 'PRIVATE_TARGET_DEFAULT', 'PRIVATE_CONDITION_VALUE']) assert.ok(!shown.includes(value), 'Preview must not disclose values or condition literals');
  assert.ok(first.ui.elements(section(first.ui, '下游输出重接预览')).filter(item => item.type === 'details').every(item => !item.props.open), 'Technical references remain progressively disclosed');
  chooseOutput(first.ui, 0, false); assert.equal(first.ui.button(checkButton).props.disabled, true, 'Every outgoing use needs an explicit choice');
  chooseOutput(first.ui, 1, true); assert.equal(first.ui.button(checkButton).props.disabled, false);
  first.ui.button(checkButton).props.onClick(); first.ui.render();
  assert.ok(first.ui.text(section(first.ui, '重接方案检查结果')).includes('通过结构检查'), first.ui.elements().filter(item => item.props.role === 'alert').map(item => first.ui.text(item)).join('\n'));
  assert.ok(first.ui.text(section(first.ui, '重接方案检查结果')).includes('计划保留原连接'));
  assert.equal(first.ui.keyShortcut('undo').prevented, false, 'Read-only preview and validation create no undo entry'); first.ui.render();
  assert.deepEqual(exported(first.ui), beforeDocument); assert.equal(hostState(first), beforeHost);
  const priorCheck = first.ui.button(checkButton).props.onClick;
  chooseOutput(first.ui, 1, false); assert.equal(section(first.ui, '重接方案检查结果'), undefined, 'Changing one choice retires the previous result');
  priorCheck(); first.ui.render(); assert.equal(section(first.ui, '重接方案检查结果'), undefined, 'Old draft-check handler must not inspect later selections');
  first.ui.button(checkButton).props.onClick(); first.ui.render();
  assert.ok(first.ui.text(section(first.ui, '重接方案检查结果')).includes('通过结构检查')); assert.deepEqual(exported(first.ui), beforeDocument);
  assert.equal(hostState(first), beforeHost); assertIdle(first);
  first.ui.button('收起并清除本次重接方案').props.onClick(); first.ui.render(); assert.equal(section(first.ui, '下游输出重接预览'), undefined);
  showOutputs(first.ui); assert.ok(controls(first.ui).every(control => control.props.value === ''), 'Reopening starts a fresh explicit selection, not an implicit continuation');

  // Forged, invalid and stale select values cannot become authority or change a line.
  const invalid = await prepared(); controls(invalid.ui)[0].props.onChange({ target: { value: 'unknown-output' } }); invalid.ui.render();
  assert.equal(controls(invalid.ui)[0].props.value, ''); assert.deepEqual(exported(invalid.ui), definition.initial); assertIdle(invalid);
  const staleSelect = controls(invalid.ui)[0].props.onChange;
  chooseOutput(invalid.ui, 1, true); staleSelect({ target: { value: 'keep' } }); invalid.ui.render();
  assert.equal(controls(invalid.ui)[0].props.value, '', 'A callback from an older draft cannot overwrite the new draft');

  // Two individually valid choices can conflict when combined; production UI must display the joint failure without editing.
  const pair = structuredClone(fixture.initial.blueprints![0]);
  const firstStep = pair.blueprint.workflow.nodes[0], extraStep = structuredClone(firstStep); extraStep.id = 'secondRead'; extraStep.position.y += 240;
  extraStep.bindings.text = { kind: 'literal', value: '[{"score":20}]' };
  pair.blueprint.workflow.nodes.push(extraStep); pair.composites[0].nodeIds.push(extraStep.id);
  pair.blueprint.outputs.push({ ...structuredClone(pair.blueprint.outputs[0]), id: 'secondOutput', source: { nodeId: extraStep.id, portId: 'value' } });
  const pairTarget = structuredClone(pair); pairTarget.blueprint.version = '1.1.0';
  const mergePlugin = { pluginId: 'workflow-merge', pluginVersion: '1.0.0', capabilityId: 'merge-json' }, pairPlugins = [...fixture.plugins!, mergePlugin];
  const expanded = instantiateS2CompositeDesign({ nodes: [], edges: [], blueprints: [pair, pairTarget] }, pairPlugins, pair.blueprint.id, '1.0.0', {}, undefined, '40000000-0000-0000-0000-000000000002');
  expanded.document.execution!.nodes.push({ id: 'collect', ...mergePlugin, position: { x: 500, y: 100 }, bindings: {}, presentation: { label: '汇集合成结果' } });
  expanded.document.execution!.links.push(...expanded.nodeIds.map(nodeId => ({ source: { nodeId, portId: 'value' }, target: { nodeId: 'collect', portId: 'candidates' } })));
  const conflictDef = readS2Definition({ ...fixture, plugins: pairPlugins, initial: expanded.document }), conflict = await uiFor(true, false, conflictDef);
  copyPreview(conflict.ui); showOutputs(conflict.ui); chooseAll(conflict.ui);
  conflict.ui.button(checkButton).props.onClick(); conflict.ui.render();
  const conflictText = conflict.ui.text(section(conflict.ui, '重接方案检查结果'));
  assert.ok(conflictText.includes('存在冲突'), conflictText); assert.match(conflictText, /重复|数量/);
  assert.equal(conflict.ui.keyShortcut('undo').prevented, false, 'A conflicting preview creates no undo entry'); conflict.ui.render();
  assert.deepEqual(exported(conflict.ui), conflictDef.initial); assertIdle(conflict);

  // All read-only entry points and callbacks retire on exact lifecycle boundaries, even undo/return restores the graph/view.
  const retirements: Array<[string, (trial: Trial) => void | Promise<void>, boolean?]> = [
    ['target version', ({ ui }) => { ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '' } }); ui.render(); }],
    ['copy choices', ({ ui }) => chooseCopy(ui, 'target-default')],
    ['copy regeneration', ({ ui }) => { ui.button('预览独立新版副本（不添加）').props.onClick(); ui.render(); }],
    ['copy cancelled', ({ ui }) => { ui.button('取消本次副本预览').props.onClick(); ui.render(); }],
    ['selection and return', ({ ui }) => { ui.flow().props.onNodeClick({}, { id: 'rows' }); ui.render(); ui.flow().props.onPaneClick(); ui.render(); }],
    ['edit then undo', ({ ui }) => { ui.button('＋练习笔记').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); }],
    ['view and return', ({ ui }) => { ui.button(`进入内部 · ${title}`).props.onClick(); ui.render(); ui.button('返回总画布').props.onClick(); ui.render(); }],
    ['return/automatic cleanup', ({ ui }) => { ui.button('返回').props.onClick(); ui.render(); }],
    ['workspace replacement', async ({ ui }) => { ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: fixtureText } }); ui.render(); ui.button('导入并替换当前预览').props.onClick(); await new Promise(resolve => setImmediate(resolve)); ui.render(); }, false],
  ];
  for (const [name, retire, running] of retirements) {
    const trial = await prepared(running ?? true); chooseAll(trial.ui);
    const show = trial.ui.button(previewButton).props.onClick, check = trial.ui.button(checkButton).props.onClick, change = controls(trial.ui)[0].props.onChange;
    await retire(trial); const expected = exported(trial.ui), afterRetireHost = hostState(trial);
    assert.ok(!section(trial.ui, '下游输出重接预览'), `${name}: report retires`);
    change({ target: { value: 'keep' } }); trial.ui.render(); check(); trial.ui.render(); show(); trial.ui.render();
    assert.ok(!section(trial.ui, '下游输出重接预览'), `${name}: stale callbacks do not reopen or repopulate the report`);
    assert.ok(!section(trial.ui, '重接方案检查结果'), `${name}: stale checks never return a fresh-seeming result`);
    assert.deepEqual(exported(trial.ui), expected, `${name}: no stale mutation`); assert.equal(hostState(trial), afterRetireHost, `${name}: no stale Host effects`); assertIdle(trial);
  }

  // Checking a replacement plan does not turn the old copy button into a hidden rewiring action.
  for (const deferred of [false, true]) {
    const trial = await prepared(true, deferred), before = exported(trial.ui), originalSource = before.execution!.nodes.find(node => node.id === sourceId)!;
    const confirmCopy = trial.ui.button('确认添加独立新版副本（不运行）').props.onClick;
    chooseAll(trial.ui); trial.ui.button(checkButton).props.onClick(); trial.ui.render();
    confirmCopy(); trial.ui.render(); const added = exported(trial.ui);
    assert.equal(added.execution!.nodes.length, before.execution!.nodes.length + 1);
    assert.deepEqual(added.execution!.links, before.execution!.links, 'Independent copy still leaves every original data connection in place');
    assert.deepEqual(added.execution!.nodes.find(node => node.id === 'view')!.when, before.execution!.nodes.find(node => node.id === 'view')!.when, 'Independent copy does not rebind the original condition');
    assert.deepEqual(added.execution!.nodes.find(node => node.id === sourceId), originalSource); assert.equal(section(trial.ui, '下游输出重接预览'), undefined);
    assertIdle(trial);
    trial.ui.keyShortcut('undo'); trial.ui.render(); assert.deepEqual(exported(trial.ui), before);
    trial.ui.keyShortcut('redo'); trial.ui.render(); assert.deepEqual(exported(trial.ui), added); assertIdle(trial);
  }

  for (const sceneSkill of ['S1', 'S4'] as const) {
    const scene = createS2Scene(request); scene.meta.sceneSkill = sceneSkill; scene.canvasWorkspace = structuredClone(definition);
    const ui = harness({ initialRequest: request, initialDraft: scene }); uis.push(ui);
    assert.ok(ui.text().includes('不能读取或修改 S1/S4')); assert.equal(section(ui, '下游输出重接预览'), undefined);
    assert.ok(!ui.elements().some(item => item.type === 'button' && ui.text(item) === previewButton)); assert.equal(ui.modelCalls(), 0);
  }
  assert.equal(network, 0); assert.equal(JSON.stringify(fixture), originalFixture);
  console.log('S2 output reconnection UI passed: real production read-only preview, independently explicit data/condition choices and whole-plan check, original values/links/conditions/history/budget preserved, no hidden value disclosure, exact target/copy/draft/selection/history/view/phase/workspace retirement with stale-callback rejection, independent copy remains non-rewiring including deferred hooks/undo/redo, S1/S4 isolated. Static browser import fixture validates. Synthetic offline only; not actual reconnection or model/business acceptance.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = oldFetch; }
