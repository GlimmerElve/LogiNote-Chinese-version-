import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { SceneInitialRequest } from '../src/types';
import { harness } from './scene-s2-ui-harness';

// Imported through the browser's normal workspace textarea too. No configuration, model or resource IO.
const fixtureText = readFileSync('scripts/fixtures/s2-runtime-recovery-workspace.json', 'utf8');
const definition = importS2Workspace(fixtureText), fixtureKey = JSON.stringify(definition);
assert.deepEqual(readS2Definition(definition), definition);
const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成运行问题恢复', knowledgePoints: [] };
const uis: ReturnType<typeof harness>[] = [], oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic runtime recovery test has no transport'); };
const ordinaryText = (root: any): string => Array.isArray(root) ? root.map(ordinaryText).join('')
  : root && typeof root === 'object' ? root.type === 'details' ? '' : ordinaryText(root.children) : String(root ?? '');
function uiFor(deferred = false, value: S2CanvasDefinition = definition) {
  let host!: S2PluginHost;
  const draft = createS2Scene(request); draft.canvasWorkspace = structuredClone(value);
  const ui = harness({ initialRequest: request, initialDraft: draft, deferStateUpdates: deferred, onHost: current => { host = current; } }); uis.push(ui);
  ui.button('开始试验').props.onClick(); ui.render();
  const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
  const snapshot = () => JSON.stringify(document());
  const panel = () => ui.elements().find(item => item.type === 'section' && item.props['aria-label'] === '运行问题与恢复');
  const label = (id: string) => s2ConnectionNodeLabel(value, document(), id);
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const selected = () => ui.labelControl('选择执行节点', 'select').props.value;
  const button = (text: string) => { const found = ui.elements().filter(item => item.type === 'button' && ui.text(item) === text && !item.props.disabled).at(-1); assert.ok(found, text); return found; };
  const inspect = (id: string) => button(`查看运行问题 · ${label(id)}`).props.onClick;
  const locate = (id: string) => button(`查看相关步骤 · ${label(id)}`).props.onClick;
  return { ui, host: () => host, document, snapshot, panel, label, focus, selected, inspect, locate, button };
}
type Trial = ReturnType<typeof uiFor>;
async function tick(trial: Trial) { await new Promise(resolve => setImmediate(resolve)); trial.ui.render(); }
async function run(trial: Trial, id = 'view') {
  trial.focus(id); const count = trial.host().workflowHistory().length;
  trial.ui.button('运行所选步骤').props.onClick(); trial.ui.render();
  for (let i = 0; i < 200 && (trial.host().workflowHistory().length === count || ['queued', 'running'].includes(trial.host().workflowHistory().at(-1)!.status)); i++) await tick(trial);
  assert.equal(trial.host().workflowHistory().length, count + 1); return trial.host().workflowHistory().at(-1)!;
}
function quietState(trial: Trial) { return JSON.stringify({ history: trial.host().history(), workflows: trial.host().workflowHistory(), calls: trial.host().remainingCalls, model: trial.ui.modelCalls(), saved: trial.ui.saved }); }
function assertNoExternal(trial: Trial) { assert.equal(trial.ui.modelCalls(), 0); assert.equal(trial.ui.saved.length, 0); assert.equal(network, 0); }
async function conflict(deferred = false) {
  const trial = uiFor(deferred), result = await run(trial);
  assert.equal(result.status, 'failed'); assert.equal(result.nodes.find(item => item.nodeId === 'merge')!.status, 'failed');
  assert.equal(result.nodes.find(item => item.nodeId === 'view')!.status, 'blocked');
  assert.equal(result.nodes.find(item => item.nodeId === 'merge')!.mergeEvidence!.candidateArtifactIds.length, 2);
  trial.inspect('merge')(); trial.ui.render(); assert.ok(trial.panel()); return trial;
}
try {
  // Actual failed execution, explicit inspection, exact candidate provenance, nested navigation and manual repair.
  for (const deferred of [false, true]) {
    const trial = await conflict(deferred), initial = trial.snapshot(), state = quietState(trial);
    const panel = trial.panel()!, text = ordinaryText(panel);
    assert.match(text, /多路|多个|多份|冲突|两路/);
    for (const id of ['merge', 'left', 'right']) assert.ok(text.includes(trial.label(id)), `Actual related node ${id}`);
    for (const internal of ['structured-data', 'merge-json', 'candidateArtifactIds', '"branch":"same"']) assert.ok(!text.includes(internal), `Ordinary recovery text is not a technical payload: ${internal}`);
    const details = trial.ui.elements(panel).filter(item => item.type === 'details'); assert.ok(details.length); assert.ok(details.every(item => !item.props.open));
    assert.equal(trial.snapshot(), initial); assert.equal(quietState(trial), state); assertNoExternal(trial);
    const locate = trial.locate('right'); locate(); locate(); trial.ui.render();
    assert.equal(trial.selected(), 'right'); assert.equal(trial.panel(), undefined); assert.equal(trial.snapshot(), initial); assert.equal(quietState(trial), state);
    assert.ok(trial.ui.flow().props.nodes.some((node: any) => node.id === 'right'));
    assert.ok(!trial.ui.flow().props.nodes.some((node: any) => node.id === 'branch-group'), 'Locate enters the real innermost composite, not an outer proxy');
    const condition = trial.ui.elements().find(item => item.type === 'condition-editor')!; assert.ok(condition);
    condition.props.onApply({ ...condition.props.when, match: false }, condition.props.sourceKey); trial.ui.render();
    assert.equal(trial.document().execution!.nodes.find(node => node.id === 'right')!.when!.match, false);
    assert.equal(trial.host().workflowHistory().length, 1, 'Manual repair does not silently rerun');
    assert.equal(trial.host().remainingCalls, 62, 'Inspection, location and editing cost no plugin calls');
    const repaired = await run(trial); assert.equal(repaired.status, 'succeeded');
    assert.equal(repaired.nodes.find(node => node.nodeId === 'right')!.status, 'skipped');
    assert.equal(repaired.nodes.find(node => node.nodeId === 'merge')!.mergeEvidence!.selectedNodeId, 'left');
    assert.equal(repaired.nodes.find(node => node.nodeId === 'view')!.status, 'displayed');
    assert.equal(trial.host().remainingCalls, 61); assertNoExternal(trial);
  }

  // Required-input errors are preflight diagnoses: no job, artifact, call, history or implicit material choice.
  const missing = uiFor(true); missing.focus('missing'); const missingBefore = missing.snapshot();
  missing.ui.button('运行所选步骤').props.onClick(); missing.ui.render();
  assert.ok(missing.panel()); assert.match(ordinaryText(missing.panel()), /材料|输入|原文/);
  assert.ok(ordinaryText(missing.panel()).includes(missing.label('missing')));
  assert.equal(missing.snapshot(), missingBefore); assert.equal(missing.host().workflowHistory().length, 0); assert.equal(missing.host().history().length, 0); assert.equal(missing.host().remainingCalls, 64);
  const priorMissingLocate = missing.locate('missing');
  missing.ui.button('运行所选步骤').props.onClick(); missing.ui.render(); const latestMissing = missing.ui.text(missing.panel()), currentMissingLocate = missing.locate('missing');
  priorMissingLocate(); missing.ui.render(); assert.equal(missing.ui.text(missing.panel()), latestMissing, 'A second preflight failure retires the earlier locate ticket without erasing the new diagnosis');
  currentMissingLocate(); missing.ui.render(); assert.equal(missing.panel(), undefined); assert.equal(missing.selected(), 'missing');
  missing.ui.labelControl('为需要补充的原文选择材料', 'select').props.onChange({ target: { value: 'manual' } }); missing.ui.render();
  missing.ui.labelControl('填写需要补充的原文', 'textarea').props.onChange({ target: { value: '{"synthetic":true}' } }); missing.ui.render();
  assert.equal(missing.host().workflowHistory().length, 0); assert.equal(missing.host().remainingCalls, 64);
  assert.equal((await run(missing, 'missing')).status, 'succeeded'); assert.equal(missing.host().remainingCalls, 63); assertNoExternal(missing);

  // Failure is not absence: one broken candidate blocks the merge, even if the other source succeeded.
  const brokenDefinition = structuredClone(definition);
  brokenDefinition.initial.execution!.nodes.find(node => node.id === 'right')!.bindings.text = { kind: 'literal', value: '{broken' };
  const broken = uiFor(false, readS2Definition(brokenDefinition)); const blockedRun = await run(broken);
  assert.equal(blockedRun.nodes.find(node => node.nodeId === 'right')!.status, 'failed'); assert.equal(blockedRun.nodes.find(node => node.nodeId === 'merge')!.status, 'blocked');
  assert.deepEqual(blockedRun.nodes.find(node => node.nodeId === 'merge')!.mergeEvidence!.blockedNodeIds, ['right']);
  const brokenBefore = broken.snapshot(), brokenState = quietState(broken);
  broken.inspect('merge')(); broken.ui.render(); assert.ok(broken.panel()); assert.ok(ordinaryText(broken.panel()).includes(broken.label('right')));
  assert.equal(broken.snapshot(), brokenBefore); assert.equal(quietState(broken), brokenState); assertNoExternal(broken);

  // The canvas-node entry opens the same current diagnosis; viewing it is not another attempt.
  const fromCanvas = await conflict(); fromCanvas.focus('merge');
  const card = fromCanvas.ui.flow().props.nodes.find((node: any) => node.id === 'merge'); assert.ok(card?.data.onInspectIssue);
  const canvasBefore = fromCanvas.snapshot(), canvasState = quietState(fromCanvas);
  card.data.onInspectIssue(); fromCanvas.ui.render(); assert.ok(fromCanvas.panel());
  assert.equal(fromCanvas.snapshot(), canvasBefore); assert.equal(quietState(fromCanvas), canvasState); assertNoExternal(fromCanvas);

  // A direct, explicitly authorized local invocation is a new attempt too, not only workflow requeue.
  for (const deferred of [false, true]) {
    const direct = await conflict(deferred), locate = direct.locate('right'), inspect = direct.inspect('merge');
    const before = direct.snapshot(), selected = direct.selected(), host = direct.host(), failure = host.workflowHistory().at(-1)!;
    const context = host.prepare('left', { goal: definition.goal, ...definition.instructions }, '仅重跑合成候选甲，不运行其他步骤');
    const input = context.bindings.find(binding => binding.nodeId === 'left' && binding.fieldId === 'text'); assert.ok(input);
    const execution = host.execute({ nodeId: 'left', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json',
      inputs: { text: [input.artifactId] }, reason: 'Synthetic explicitly confirmed standalone local invocation' }, context.frame, `runtime-recovery-direct-${deferred}`);
    assert.equal(host.readWorkflowDiagnostic(failure.id, 'merge'), null, 'The direct attempt token immediately retires the old workflow proof');
    locate(); inspect(); direct.ui.render();
    assert.equal(direct.panel(), undefined); assert.equal(direct.selected(), selected); assert.equal(direct.snapshot(), before);
    assert.equal((await execution).receipt.status, 'succeeded'); direct.ui.render(); const afterDirect = quietState(direct);
    locate(); inspect(); direct.ui.render();
    assert.equal(direct.panel(), undefined); assert.equal(direct.selected(), selected); assert.equal(direct.snapshot(), before); assert.equal(quietState(direct), afterDirect);
    assert.equal(host.workflowHistory().length, 1); assert.equal(host.history().length, 3); assert.equal(host.remainingCalls, 61); assertNoExternal(direct);
  }

  // A different native enqueue error must remain the original error, never a fabricated missing-material diagnosis.
  const exhausted = uiFor();
  for (let i = 0; i < 64; i++) assert.equal((await exhausted.host().enqueueWorkflow(['left']).completion).status, 'succeeded');
  exhausted.focus('view'); const exhaustedBefore = exhausted.snapshot(), exhaustedState = quietState(exhausted);
  exhausted.ui.button('运行所选步骤').props.onClick(); exhausted.ui.render();
  assert.equal(exhausted.panel(), undefined); assert.ok(exhausted.ui.text().includes('执行队列已满'));
  assert.equal(exhausted.snapshot(), exhaustedBefore); assert.equal(quietState(exhausted), exhaustedState); assertNoExternal(exhausted);

  // Callback identity is temporary: lifecycle/view/selection/history/new-run transitions never revive old diagnosis.
  const retirements: Array<[string, (trial: Trial) => Promise<void> | void]> = [
    ['selection and return', trial => { trial.focus('missing'); trial.focus('view'); }],
    ['view and return', trial => { trial.ui.button('进入内部 · 分支检查组合').props.onClick(); trial.ui.render(); trial.ui.button('返回总画布').props.onClick(); trial.ui.render(); }],
    ['edit and undo', trial => { trial.ui.button('＋练习笔记').props.onClick(); trial.ui.render(); trial.ui.keyShortcut('undo'); trial.ui.render(); }],
    ['same-input rerun', async trial => { await run(trial); }],
    ['end', trial => { trial.ui.button('结束试验').props.onClick(); trial.ui.render(); }],
    ['removed source', trial => { trial.focus('right'); trial.ui.button('批量删除所选').props.onClick(); trial.ui.render(); }],
  ];
  for (const [name, retire] of retirements) for (const deferred of [false, true]) {
    const trial = await conflict(deferred), locate = trial.locate('right'), inspect = trial.inspect('merge');
    await retire(trial); const before = trial.snapshot(), selected = trial.selected(), state = quietState(trial);
    assert.equal(trial.panel(), undefined, `${name}: diagnostic panel retired`);
    locate(); inspect(); trial.ui.render();
    assert.equal(trial.panel(), undefined, `${name}: old callbacks cannot revive or navigate old diagnostics`);
    assert.equal(trial.selected(), selected); assert.equal(trial.snapshot(), before); assert.equal(quietState(trial), state); assertNoExternal(trial);
  }

  // Success/displayed/skipped are not falsely described as a new failure; historical failures cannot claim currentness.
  const healed = await conflict(); const oldInspector = healed.inspect('merge'); healed.locate('right')(); healed.ui.render();
  const oldCondition = healed.ui.elements().find(item => item.type === 'condition-editor')!;
  oldCondition.props.onApply({ ...oldCondition.props.when, match: false }, oldCondition.props.sourceKey); healed.ui.render(); await run(healed);
  oldInspector(); healed.ui.render(); assert.equal(healed.panel(), undefined); assertNoExternal(healed);
  assert.equal(JSON.stringify(definition), fixtureKey); assert.equal(network, 0);
  console.log('S2 runtime recovery UI passed: native failed exclusive merge and blocked downstream, explicit value-free diagnostic and innermost navigation, human condition repair then separate successful run, missing-input preflight without dispatch, failed candidate never treated as absent, scoped stale/duplicate/requeue/history/end guards with deferred hooks. No automatic edits/retries, real model, resource IO or business-semantic acceptance.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = oldFetch; }
