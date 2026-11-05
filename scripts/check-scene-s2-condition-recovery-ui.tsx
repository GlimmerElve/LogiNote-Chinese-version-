import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createS2Scene, importS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import * as controlDrafts from '../src/services/scene/sceneS2ControlDrafts';
import * as presentation from '../src/services/scene/sceneS2Presentation';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import type { SceneInitialRequest } from '../src/types';
import { harness } from './scene-s2-ui-harness';

const fixtureText = readFileSync('scripts/fixtures/s2-condition-recovery-workspace.json', 'utf8');
const definition = importS2Workspace(fixtureText), fixtureKey = JSON.stringify(definition);
assert.deepEqual(readS2Definition(definition), definition);
const request: SceneInitialRequest = { source: 'build', sceneSkill: 'S2', subject: '合成条件阻塞恢复', knowledgePoints: [], interactionPack: null };
const uis: ReturnType<typeof harness>[] = [], priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Condition recovery UI acceptance forbids external IO'); };
const ordinaryText = (root: any): string => Array.isArray(root) ? root.map(ordinaryText).join('')
  : root && typeof root === 'object' ? root.type === 'details' ? '' : ordinaryText(root.children) : String(root ?? '');

// Execute the real child editor as well as the real parent component, without DOM or model approximations.
function editor(props: () => any) {
  const slots: any[] = []; let cursor = 0, tree: any;
  const react = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2ConditionEditor.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require: (id: string) => id === 'react' ? react : id.endsWith('sceneS2ControlDrafts') ? controlDrafts : id.endsWith('sceneS2Presentation') ? presentation : {} });
  const elements = (v: any = tree): any[] => Array.isArray(v) ? v.flatMap(item => elements(item ?? null)) : v && typeof v === 'object' ? [v, ...elements(v.children ?? [])] : [];
  const text = (v: any = tree): string => Array.isArray(v) ? v.map(item => text(item ?? null)).join('') : v && typeof v === 'object' ? text(v.children ?? []) : String(v ?? '');
  const control = (label: string) => { const item = elements().find(item => item.props['aria-label'] === label); assert.ok(item, label); return item; };
  const render = () => { cursor = 0; tree = exports.S2ConditionEditor(props()); };
  render(); return { render, elements, text,
    change(label: string, value: string) { control(label).props.onChange({ target: { value } }); render(); },
    click(label: string) { const item = elements().find(item => item.type === 'button' && text(item) === label); assert.ok(item, label); item.props.onClick(); render(); },
    submit() { elements().find(item => item.type === 'form')!.props.onSubmit({ preventDefault() {} }); render(); } };
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
  const inspect = () => action(`查看运行问题 · ${label('target')}`), locate = (id: string) => action(`查看相关步骤 · ${label(id)}`);
  const conditionProps = () => { ui.render(); const item = ui.elements().find(item => item.type === 'condition-editor'); assert.ok(item); return item.props; };
  return { ui, document, snapshot, panel, label, focus, selected, inspect, locate, conditionProps, action, host: () => host };
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
async function missing(deferred = false, value = definition) {
  const trial = makeUi(deferred, value), failure = await run(trial);
  assert.equal(failure.status, 'failed'); assert.equal(failure.nodes.find(node => node.nodeId === 'target')!.status, 'blocked');
  assert.equal(failure.nodes.find(node => node.nodeId === 'view')!.status, 'blocked');
  trial.inspect()(); trial.ui.render(); assert.ok(trial.panel()); return trial;
}
try {
  for (const deferred of [false, true]) {
    const trial = await missing(deferred), before = trial.snapshot(), unchanged = state(trial), panel = trial.panel();
    const ordinary = ordinaryText(panel); assert.match(ordinary, /条件/); assert.match(ordinary, /字段|位置|部分/);
    assert.ok(ordinary.includes(trial.label('target'))); assert.ok(ordinary.includes(trial.label('source')));
    for (const raw of ['structured-data', 'source-output-unavailable', 'pointer-missing', '"accepted":true']) assert.ok(!ordinary.includes(raw), raw);
    assert.ok(trial.ui.elements(panel).filter(item => item.type === 'details').every(item => !item.props.open));
    assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged);
    const locate = trial.locate('target'), conditionLocate = trial.action(`查看运行条件 · ${trial.label('target')}`);
    conditionLocate(); conditionLocate(); locate(); trial.ui.render();
    assert.equal(trial.selected(), 'target'); assert.equal(trial.panel(), undefined); assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged);
    assert.ok(trial.ui.flow().props.nodes.some((node: any) => node.id === 'target'));
    assert.ok(!trial.ui.flow().props.nodes.some((node: any) => node.id === 'condition-inner'), 'Recovery reaches the real inner condition settings');
    assert.ok(trial.ui.elements().some(item => item.type === 'details' && item.props['aria-label'] === '运行条件设置'), 'The target is the existing native condition section, not a separate auto-editing form');
    const form = editor(trial.conditionProps); form.click('查看可比较的字段（不运行）');
    const options = form.elements().filter(item => item.type === 'option'); assert.ok(options.some(item => item.props.value === JSON.stringify('/ready')));
    assert.ok(!options.some(item => item.props.value === JSON.stringify('/missing')), 'The menu uses full current output, not the missing configured field');
    assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged, 'Reading the field menu does not dispatch or alter a condition');
    form.change('比较哪部分内容', JSON.stringify('/ready')); form.change('期望内容类型', 'boolean'); form.change('期望选择', 'false'); form.submit(); trial.ui.render();
    assert.equal(trial.document().execution!.nodes.find(node => node.id === 'target')!.when!.pointer, '/ready');
    assert.equal(trial.document().execution!.nodes.find(node => node.id === 'target')!.when!.equals, false);
    assert.equal(trial.host().workflowHistory().length, 1); assert.equal(trial.host().remainingCalls, 63);
    const success = await run(trial); assert.equal(success.status, 'succeeded'); assert.equal(success.nodes.find(node => node.nodeId === 'view')!.status, 'displayed');
    assert.equal(trial.host().remainingCalls, 62); noExternal(trial);
  }

  // A failed condition source is missing evidence, never a false result or permission to keep using old output.
  const brokenDefinition = structuredClone(definition); brokenDefinition.initial.execution!.nodes[0].bindings.text = { kind: 'literal', value: '{invalid' };
  brokenDefinition.initial.execution!.nodes[1].when!.pointer = '/ready';
  const broken = await missing(true, readS2Definition(brokenDefinition));
  assert.equal(broken.host().workflowHistory()[0].nodes[0].status, 'failed'); assert.match(ordinaryText(broken.panel()), /来源|结果/);
  const original = broken.snapshot(), budget = broken.host().remainingCalls;
  broken.locate('source')(); broken.ui.render(); assert.equal(broken.selected(), 'source'); assert.equal(broken.snapshot(), original);
  broken.ui.labelControl('填写核验原文', 'textarea').props.onChange({ target: { value: '{"ready":false}' } }); broken.ui.render();
  assert.equal(broken.host().workflowHistory().length, 1); assert.equal(broken.host().remainingCalls, budget);
  assert.equal((await run(broken)).status, 'succeeded'); noExternal(broken);

  // False, zero, null, an empty key/string, arrays and escaped paths are complete data, not absent evidence.
  const rootValue = JSON.parse((definition.initial.execution!.nodes[0].bindings.text as { value: string }).value);
  const validCases: Array<[string, S2Json]> = [['/ready', false], ['/score', 0], ['/empty', null], ['/', ''], ['/items', [false, 0, null]], ['/items/0', false], ['/items/1', 0], ['/items/2', null], ['/a~1b/~0key', 0], ['', rootValue]];
  for (const [pointer, equals] of validCases) {
    const current = structuredClone(definition); Object.assign(current.initial.execution!.nodes[1].when!, { pointer, equals });
    const trial = makeUi(false, readS2Definition(current)), result = await run(trial);
    assert.equal(result.status, 'succeeded', pointer); assert.equal(result.nodes.find(node => node.nodeId === 'target')!.status, 'succeeded');
    assert.equal(trial.host().readWorkflowDiagnostic(result.id, 'target'), null); assert.equal(trial.panel(), undefined); noExternal(trial);
  }
  for (const value of [false, 0, null]) {
    const current = structuredClone(definition); current.initial.execution!.nodes[0].bindings.text = { kind: 'literal', value: JSON.stringify(value) };
    Object.assign(current.initial.execution!.nodes[1].when!, { pointer: '', equals: value });
    const trial = makeUi(false, readS2Definition(current)), result = await run(trial);
    assert.equal(result.status, 'succeeded'); assert.equal(result.nodes.find(node => node.nodeId === 'target')!.status, 'succeeded');
    assert.equal(trial.host().readWorkflowDiagnostic(result.id, 'target'), null); noExternal(trial);
  }
  for (const pointer of ['/missing', '/items/3']) {
    const current = structuredClone(definition); Object.assign(current.initial.execution!.nodes[1].when!, { pointer, equals: false, match: false });
    const trial = await missing(false, current);
    assert.equal(trial.host().workflowHistory()[0].nodes.find(node => node.nodeId === 'target')!.status, 'blocked', 'An absent field cannot satisfy an inequality branch');
    assert.equal(trial.host().remainingCalls, 63); noExternal(trial);
  }
  const falseDefinition = structuredClone(definition); Object.assign(falseDefinition.initial.execution!.nodes[1].when!, { pointer: '/ready', equals: true });
  const falseBranch = makeUi(false, falseDefinition), falseRun = await run(falseBranch);
  assert.equal(falseRun.status, 'succeeded'); assert.equal(falseRun.nodes.find(node => node.nodeId === 'target')!.status, 'skipped');
  assert.equal(falseRun.nodes.find(node => node.nodeId === 'view')!.status, 'skipped'); assert.equal(falseBranch.host().readWorkflowDiagnostic(falseRun.id, 'target'), null);
  assert.equal(falseBranch.host().remainingCalls, 63); assert.equal(falseBranch.panel(), undefined); noExternal(falseBranch);

  // Evidence and navigation remain exact-attempt scoped, including the same graph after undo or a direct source invocation.
  const retirements: Array<[string, (trial: Trial) => void | Promise<void>]> = [
    ['selection roundtrip', trial => { trial.focus('source'); trial.focus('view'); }],
    ['view roundtrip', trial => { trial.ui.button('进入内部 · 条件核验组合').props.onClick(); trial.ui.render(); trial.ui.button('返回总画布').props.onClick(); trial.ui.render(); }],
    ['edit and undo', trial => { trial.ui.button('＋练习笔记').props.onClick(); trial.ui.render(); trial.ui.keyShortcut('undo'); trial.ui.render(); }],
    ['new run', async trial => { await run(trial); }],
    ['end', trial => { trial.ui.button('结束试验').props.onClick(); trial.ui.render(); }],
    ['direct source retry', async trial => {
      const host = trial.host(), context = host.prepare('source', { goal: definition.goal, ...definition.instructions }, '只重跑合成来源');
      const input = context.bindings.find(item => item.fieldId === 'text'); assert.ok(input);
      const execution = await host.execute({ nodeId: 'source', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json',
        inputs: { text: [input.artifactId] }, reason: 'Synthetic explicit single local source retry' }, context.frame, 'condition-recovery-direct');
      assert.equal(execution.receipt.status, 'succeeded'); trial.ui.render();
    }],
  ];
  for (const [name, retire] of retirements) for (const deferred of [false, true]) {
    const trial = await missing(deferred), locate = trial.locate('target'), inspect = trial.inspect(), conditionLocate = trial.action(`查看运行条件 · ${trial.label('target')}`);
    await retire(trial); const before = trial.snapshot(), selection = trial.selected(), unchanged = state(trial);
    assert.equal(trial.panel(), undefined, `${name}: old diagnosis retired`);
    locate(); conditionLocate(); inspect(); trial.ui.render(); assert.equal(trial.panel(), undefined, `${name}: old callbacks cannot revive diagnosis`);
    assert.equal(trial.selected(), selection); assert.equal(trial.snapshot(), before); assert.equal(state(trial), unchanged); noExternal(trial);
  }
  assert.equal(JSON.stringify(definition), fixtureKey); assert.equal(network, 0);
  console.log('S2 condition recovery UI passed: genuine missing-pointer and unavailable-source blocks, current full-result field inspection, explicit condition/source repair followed by separately requested local execution, native false/zero/null/empty-key/array/escaped/root semantics distinct from skipped branches, innermost navigation and exact-attempt stale guards with deferred hooks. No automatic changes, retries, models or resource IO; non-inline adapter evidence is covered by the companion service tests.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = priorFetch; }
