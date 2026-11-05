import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import type { SceneInitialRequest } from '../src/types';
import { harness } from './scene-s2-ui-harness';

// A real browser can import this same inert workspace through the ordinary textarea.
const fixtureText = readFileSync('scripts/fixtures/s2-transform-recovery-workspace.json', 'utf8');
const definition = importS2Workspace(fixtureText), fixtureKey = JSON.stringify(definition);
assert.deepEqual(readS2Definition(definition), definition);
const data = { ready: false, score: 0, empty: null, '': '', items: [false, 0, null], 'a/b': { '~key': 0 } }, repairedText = JSON.stringify(data);
const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成本地转换失败恢复', knowledgePoints: [] };
const uis: ReturnType<typeof harness>[] = [], priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic transform recovery UI test has no transport'); };
const ordinaryText = (root: any): string => Array.isArray(root) ? root.map(ordinaryText).join('')
  : root && typeof root === 'object' ? root.type === 'details' ? '' : ordinaryText(root.children) : String(root ?? '');
function validSource(pointer = '/missing') {
  const current = structuredClone(definition); current.initial.execution!.nodes[0].bindings.text = { kind: 'literal', value: repairedText };
  current.initial.execution!.nodes[1].bindings.pointer = { kind: 'literal', value: pointer }; return current;
}
function makeUi(deferred = false, value: S2CanvasDefinition = definition) {
  let host!: S2PluginHost; const draft = createS2Scene(request); draft.canvasWorkspace = structuredClone(value);
  const ui = harness({ initialRequest: request, initialDraft: draft, deferStateUpdates: deferred, onHost: current => { host = current; } }); uis.push(ui);
  ui.button('开始试验').props.onClick(); ui.render();
  const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
  const snapshot = () => JSON.stringify(document());
  const panel = () => ui.elements().find(item => item.type === 'section' && item.props['aria-label'] === '运行问题与恢复');
  const label = (id: string) => s2ConnectionNodeLabel(value, document(), id);
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const selected = () => ui.labelControl('选择执行节点', 'select').props.value;
  const action = (label: string) => { const item = ui.elements().filter(item => item.type === 'button' && ui.text(item) === label && !item.props.disabled).at(-1); assert.ok(item, label); return item.props.onClick; };
  const inspect = (id: string) => action(`查看运行问题 · ${label(id)}`), locate = (id: string) => action(`查看相关步骤 · ${label(id)}`);
  return { ui, document, snapshot, panel, label, focus, selected, inspect, locate, action, host: () => host };
}
type Trial = ReturnType<typeof makeUi>;
async function tick(trial: Trial) { await new Promise(resolve => setImmediate(resolve)); trial.ui.render(); }
async function run(trial: Trial, id = 'view') {
  trial.focus(id); const count = trial.host().workflowHistory().length;
  trial.ui.button('运行所选步骤').props.onClick(); trial.ui.render();
  for (let i = 0; i < 200 && (trial.host().workflowHistory().length === count || ['queued', 'running'].includes(trial.host().workflowHistory().at(-1)!.status)); i++) await tick(trial);
  assert.equal(trial.host().workflowHistory().length, count + 1); return trial.host().workflowHistory().at(-1)!;
}
const state = (trial: Trial) => JSON.stringify({ history: trial.host().history(), workflows: trial.host().workflowHistory(), remaining: trial.host().remainingCalls, models: trial.ui.modelCalls(), saves: trial.ui.saved });
function noExternal(trial: Trial) { assert.equal(trial.ui.modelCalls(), 0); assert.equal(trial.ui.saved.length, 0); assert.equal(network, 0); }
async function failed(deferred = false, kind: 'parse' | 'extract' = 'parse', value = kind === 'parse' ? definition : validSource()) {
  const trial = makeUi(deferred, value), failure = await run(trial); assert.equal(failure.status, 'failed');
  assert.equal(failure.nodes.find(node => node.nodeId === kind)!.status, 'failed');
  trial.inspect(kind)(); trial.ui.render(); assert.ok(trial.panel()); return trial;
}
function fieldForm(trial: Trial) { return trial.ui.elements().find(item => item.type === 'form' && item.props['aria-label'] === '设置提取字段'); }
function chooseField(trial: Trial, pointer: string) {
  trial.ui.labelControl('要提取哪一部分', 'select').props.onChange({ target: { value: JSON.stringify(pointer) } }); trial.ui.render();
  assert.ok(fieldForm(trial)); fieldForm(trial)!.props.onSubmit({ preventDefault() {} }); trial.ui.render();
}
try {
  // A genuine syntax failure remains a failed local invocation, not a silently repaired document.
  for (const deferred of [false, true]) {
    const trial = await failed(deferred), before = trial.snapshot(), unchanged = state(trial);
    assert.match(ordinaryText(trial.panel()), /格式|JSON|原文/); assert.ok(ordinaryText(trial.panel()).includes(trial.label('parse')));
    assert.ok(!ordinaryText(trial.panel()).includes('TRANSFORM_REJECTED')); assert.ok(!ordinaryText(trial.panel()).includes('"ready":false'));
    assert.ok(trial.ui.elements(trial.panel()).filter(item => item.type === 'details').every(item => !item.props.open));
    assert.equal(trial.host().history()[0].receipt.error!.code, 'TRANSFORM_REJECTED'); assert.equal(trial.host().remainingCalls, 63);
    const locate = trial.locate('parse'); locate(); locate(); trial.ui.render();
    assert.equal(trial.selected(), 'parse'); assert.equal(trial.panel(), undefined); assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged);
    assert.ok(trial.ui.flow().props.nodes.some((node: any) => node.id === 'parse'));
    assert.ok(!trial.ui.flow().props.nodes.some((node: any) => node.id === 'transform-inner'), 'Location reaches the real innermost settings');
    trial.ui.labelControl('填写待修原文', 'textarea').props.onChange({ target: { value: repairedText } }); trial.ui.render();
    assert.equal(trial.host().workflowHistory().length, 1); assert.equal(trial.host().remainingCalls, 63, 'Typing repaired JSON does not automatically run');
    const pathFailure = await run(trial); assert.equal(pathFailure.nodes.find(node => node.nodeId === 'parse')!.status, 'succeeded');
    assert.equal(pathFailure.nodes.find(node => node.nodeId === 'extract')!.status, 'failed'); assert.equal(trial.host().remainingCalls, 61);
    trial.inspect('extract')(); trial.ui.render(); assert.ok(trial.panel()); assert.match(ordinaryText(trial.panel()), /提取|字段|位置|路径/);
    const pathBefore = trial.snapshot(), pathState = state(trial), locateExtraction = trial.action(`查看提取设置 · ${trial.label('extract')}`);
    locateExtraction(); locateExtraction(); trial.ui.render(); assert.equal(trial.selected(), 'extract'); assert.equal(trial.panel(), undefined);
    assert.equal(trial.snapshot(), pathBefore); assert.equal(state(trial), pathState); assert.equal(fieldForm(trial), undefined, 'Locating does not automatically read a field list');
    trial.ui.button('查看当前材料的字段（不运行）').props.onClick(); trial.ui.render(); assert.ok(fieldForm(trial));
    const menu = trial.ui.labelControl('要提取哪一部分', 'select');
    assert.ok(trial.ui.elements(menu).some(item => item.type === 'option' && item.props.value === JSON.stringify('/ready')));
    assert.ok(!trial.ui.elements(menu).some(item => item.type === 'option' && item.props.value === JSON.stringify('/missing')));
    assert.equal(trial.snapshot(), pathBefore); assert.equal(state(trial), pathState, 'Inspection uses the current full parse output, with no rerun');
    chooseField(trial, '/ready'); assert.equal(trial.host().workflowHistory().length, 2); assert.equal(trial.host().remainingCalls, 61);
    const result = await run(trial); assert.equal(result.status, 'succeeded'); assert.equal(result.nodes.find(node => node.nodeId === 'view')!.status, 'displayed');
    const artifact = trial.host().readCurrentStructuredOutput('extract', 'value'); assert.equal(artifact.payload.kind, 'inline');
    if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, false);
    assert.equal(trial.host().remainingCalls, 60); noExternal(trial);
  }

  // A failed parse has no current output; the field helper must not treat an error or a preview as full source data.
  const noOutput = await failed(); noOutput.focus('extract'); const noOutputBefore = noOutput.snapshot(), noOutputState = state(noOutput);
  noOutput.ui.button('查看当前材料的字段（不运行）').props.onClick(); noOutput.ui.render();
  assert.equal(fieldForm(noOutput), undefined); assert.match(noOutput.ui.text(), /尚无|完整|当前结果/);
  assert.equal(noOutput.snapshot(), noOutputBefore); assert.equal(state(noOutput), noOutputState); noExternal(noOutput);

  // Referenced text stays at its real owner: locating a content block never converts it to a fixed input.
  for (const mode of ['parse-text', 'extract-pointer'] as const) {
    const current = mode === 'parse-text' ? validSource('/ready') : validSource();
    current.initial.nodes.push({ id: 'material', type: 'note', position: { x: 40, y: 480 }, values: { content: mode === 'parse-text' ? '{bad' : '/missing' } });
    const targetId = mode === 'parse-text' ? 'parse' : 'extract', portId = mode === 'parse-text' ? 'text' : 'pointer';
    current.initial.execution!.nodes.find(node => node.id === targetId)!.bindings[portId] = { kind: 'field', nodeId: 'material', fieldId: 'content' };
    const trial = await failed(true, targetId, readS2Definition(current)), before = trial.snapshot(), unchanged = state(trial);
    assert.ok(ordinaryText(trial.panel()).includes(trial.label('material')), 'The diagnostic names the actual referenced content owner');
    trial.locate('material')(); trial.ui.render();
    assert.equal(trial.ui.labelControl('选择块', 'select').props.value, 'material'); assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged);
    trial.ui.labelControl('原文', 'textarea').props.onChange({ target: { value: mode === 'parse-text' ? repairedText : '/ready' } }); trial.ui.render();
    assert.deepEqual(trial.document().execution!.nodes.find(node => node.id === targetId)!.bindings[portId], { kind: 'field', nodeId: 'material', fieldId: 'content' });
    assert.equal(trial.host().workflowHistory().length, 1); assert.equal((await run(trial)).status, 'succeeded'); noExternal(trial);
  }

  // An upstream text-producing step is not a literal in the parser; recovery names and locates that step.
  const linked = validSource('/ready'), renderer = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' };
  linked.plugins!.push(renderer);
  linked.initial.execution!.nodes.push({ id: 'text-source', ...renderer, position: { x: 20, y: 500 }, bindings: { template: { kind: 'literal', value: '{bad' }, variables: { kind: 'literal', value: {} } }, presentation: { label: '生成待核对文字' } });
  delete linked.initial.execution!.nodes[0].bindings.text;
  linked.initial.execution!.links.push({ source: { nodeId: 'text-source', portId: 'text' }, target: { nodeId: 'parse', portId: 'text' } });
  const upstream = await failed(false, 'parse', readS2Definition(linked)), linkedBefore = upstream.snapshot(), linkedState = state(upstream);
  assert.ok(ordinaryText(upstream.panel()).includes(upstream.label('text-source')));
  upstream.locate('text-source')(); upstream.ui.render(); assert.equal(upstream.selected(), 'text-source');
  assert.equal(upstream.snapshot(), linkedBefore); assert.equal(state(upstream), linkedState); noExternal(upstream);

  // Valid falsy values and standard escaped/array/root paths are exact values, not parse/select failures.
  const valid: Array<[string, S2Json]> = [['/ready', false], ['/score', 0], ['/empty', null], ['/', ''], ['/items/0', false], ['/items/1', 0], ['/items/2', null], ['/items', [false, 0, null]], ['/a~1b/~0key', 0], ['', data]];
  for (const [pointer, expected] of valid) {
    const trial = makeUi(false, validSource(pointer)), result = await run(trial); assert.equal(result.status, 'succeeded', pointer);
    const output = trial.host().readCurrentStructuredOutput('extract', 'value'); assert.equal(output.payload.kind, 'inline');
    if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, expected);
    assert.equal(trial.host().readWorkflowDiagnostic(result.id, 'parse'), null); assert.equal(trial.host().readWorkflowDiagnostic(result.id, 'extract'), null); noExternal(trial);
  }

  // Invalid syntax, an absent field/index and a forbidden/noncanonical access remain distinct native reasons.
  for (const [pointer, reason] of [['items/0', 'pointer-syntax'], ['/items/9', 'pointer-missing'], ['/items/01', 'pointer-inaccessible'], ['/constructor', 'pointer-inaccessible']] as const) {
    const trial = await failed(false, 'extract', validSource(pointer)), record = trial.host().workflowHistory().at(-1)!;
    assert.deepEqual(trial.host().readWorkflowDiagnostic(record.id, 'extract'), { kind: 'structured-transform', reason, inputPortIds: reason === 'pointer-syntax' ? ['pointer'] : ['value', 'pointer'] });
    const before = trial.snapshot(), unchanged = state(trial); trial.action(`查看提取设置 · ${trial.label('extract')}`)(); trial.ui.render();
    assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged); assert.equal(fieldForm(trial), undefined); noExternal(trial);
  }

  // Semantically unsafe parsed JSON is a genuine native failure, but not a JSON syntax error.
  for (const text of ['1e400', '{"constructor":"synthetic"}']) {
    const current = validSource(''); current.initial.execution!.nodes[0].bindings.text = { kind: 'literal', value: text };
    const trial = makeUi(false, current), result = await run(trial);
    assert.equal(result.nodes.find(node => node.nodeId === 'parse')!.status, 'failed');
    assert.equal(trial.host().history()[0].receipt.error!.code, 'TRANSFORM_REJECTED');
    assert.equal(trial.host().readWorkflowDiagnostic(result.id, 'parse'), null, 'Do not relabel data safety/size errors as missing JSON punctuation');
    assert.equal(trial.panel(), undefined); noExternal(trial);
  }

  // Existing diagnostic safety applies to both transformation failures and the specialized extraction entry.
  const retirements: Array<[string, (trial: Trial) => void | Promise<void>]> = [
    ['selection roundtrip', trial => { trial.focus('parse'); trial.focus('view'); }],
    ['view roundtrip', trial => { trial.ui.button('进入内部 · 材料转换组合').props.onClick(); trial.ui.render(); trial.ui.button('返回总画布').props.onClick(); trial.ui.render(); }],
    ['edit and undo', trial => { trial.ui.button('＋练习笔记').props.onClick(); trial.ui.render(); trial.ui.keyShortcut('undo'); trial.ui.render(); }],
    ['new run', async trial => { await run(trial); }],
    ['end', trial => { trial.ui.button('结束试验').props.onClick(); trial.ui.render(); }],
    ['direct source retry', async trial => {
      const host = trial.host(), context = host.prepare('parse', { goal: definition.goal, ...definition.instructions }, '仅重跑合成来源');
      const input = context.bindings.find(item => item.fieldId === 'text'); assert.ok(input);
      const result = await host.execute({ nodeId: 'parse', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', inputs: { text: [input.artifactId] }, reason: 'Synthetic explicit local retry' }, context.frame, 'transform-recovery-direct');
      assert.equal(result.receipt.status, 'succeeded'); trial.ui.render();
    }],
  ];
  for (const [name, retire] of retirements) for (const deferred of [false, true]) {
    const trial = await failed(deferred, 'extract'), locate = trial.locate('extract'), inspect = trial.inspect('extract'), targeted = trial.action(`查看提取设置 · ${trial.label('extract')}`);
    await retire(trial); const before = trial.snapshot(), selection = trial.selected(), unchanged = state(trial);
    assert.equal(trial.panel(), undefined, `${name}: diagnostic retired`);
    locate(); targeted(); inspect(); trial.ui.render(); assert.equal(trial.panel(), undefined, `${name}: old handlers cannot reopen a stale diagnostic`);
    assert.equal(trial.selected(), selection); assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged); noExternal(trial);
  }
  assert.equal(JSON.stringify(definition), fixtureKey); assert.equal(network, 0);
  console.log('S2 transform recovery UI passed: native JSON syntax failure then select-path failure, explicit innermost navigation and manual repairs with separate runs, current complete output field selection, exact false/zero/null/empty/array/escaped/root values, original non-syntax safety failures preserved, scoped stale/duplicate/retry/history/end guards with deferred hooks. No automatic edits, retries, model or resource IO; no browser-focus claim.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = priorFetch; }
