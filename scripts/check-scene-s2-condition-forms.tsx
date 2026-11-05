import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { S2Document, S2WorkflowCondition, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { executeS2Structured } from '../src/services/scene/sceneS2Structured';
import * as controlDrafts from '../src/services/scene/sceneS2ControlDrafts';
import * as presentation from '../src/services/scene/sceneS2Presentation';
import { s2ConnectionDescriptions } from '../src/services/scene/sceneS2Connections';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { harness } from './scene-s2-ui-harness';

// Deterministic hooks around the actual editor; no reimplementation of condition execution.
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
  const control = (label: string) => { const e = elements().find(e => e.props['aria-label'] === label); assert.ok(e, label); return e; };
  const button = (label: string) => { const e = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(e, label); return e; };
  const render = () => { cursor = 0; tree = exports.S2ConditionEditor(props()); };
  const form = () => elements().find(e => e.type === 'form')!;
  render(); return { render, elements, text, control, button, form,
    change(label: string, value: string) { control(label).props.onChange({ target: { value } }); render(); },
    click(label: string) { button(label).props.onClick(); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); } };
}
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const parse = cap('structured-data', 'parse-json'), stringify = cap('structured-data', 'stringify');
const check = cap('json-check', 'validate'), simulation = cap('workflow-simulation', 'step'), confirm = cap('human-input', 'confirm');
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, capability: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings']): S2WorkflowNode => ({ id, ...capability, position: { x: 0, y: 0 }, bindings });
const data = { 'a/b': { '~leaf': [0, false, null, '80', ''] }, status: 'pass', approved: true };
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成条件易用性', knowledgePoints: [], interactionPack: null });
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, stringify, check, simulation, confirm],
  blockTypes: [{ id: 'text', label: '合成文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  initial: { nodes: [{ id: 'content', type: 'text', position: { x: 0, y: 0 }, values: { content: '{}' } }], edges: [], execution: { version: 1, links: [], nodes: [
    { ...node('source', parse, { text: literal(JSON.stringify(data)) }), presentation: { label: '合成考试结果', description: '只用于离线验证' } },
    node('target', parse, { text: literal('{}') }), node('check', check, { text: literal('{}') }),
    node('simulation', simulation, { purpose: literal('模拟审批'), assumptions: literal('合成假设，不代表真实审批'), sample: literal({ accepted: true }) }),
    node('human', confirm, { prompt: literal('合成确认，不授予权限') }), node('text-output', stringify, { value: literal({}) }),
  ] } } });
scene.canvasWorkspace = definition;
const sourceChoice = JSON.stringify(['source', 'value']);
const condition = (pointer: string, equals: S2Json, match = true): S2WorkflowCondition => ({ nodeId: 'source', portId: 'value', pointer, equals, match });
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const prior = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Condition forms forbid real IO'); };
async function until(predicate: () => boolean) { for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(predicate(), 'Expected local operation to finish'); }
try {
  // Each ordinary scalar writes its exact native type; invalid drafts cannot replace the last applied condition.
  for (const sample of [
    { kind: 'string', control: '期望文字', input: '80', value: '80' },
    { kind: 'string', control: '期望文字', input: '', value: '' },
    { kind: 'string', control: '期望文字', input: '引号"与换行\n及反斜杠\\', value: '引号"与换行\n及反斜杠\\' },
    { kind: 'number', control: '期望数字', input: '0', value: 0 },
    { kind: 'number', control: '期望数字', input: '-1.25e2', value: -125 },
    { kind: 'boolean', control: '期望选择', input: 'false', value: false },
    { kind: 'null', control: '', input: '', value: null },
  ]) {
    let document = structuredClone(definition.initial), applies = 0;
    const component = editor(() => ({ nodeId: 'target', when: document.execution!.nodes[1].when, disabled: false,
      sourceKey: controlDrafts.s2ConditionSource(document, 'target').key, sources: [{ nodeId: 'source', portId: 'value', typeId: 'structured-data.value', label: '合成考试结果 · 解析结果（步骤 1）' }],
      onApply(value: S2WorkflowCondition | null) { const next = structuredClone(document); if (value) next.execution!.nodes[1].when = value; else delete next.execution!.nodes[1].when;
        document = readS2Document(next, definition); applies++; return controlDrafts.s2ConditionSource(document, 'target').key; } }));
    component.change('条件来源输出', sourceChoice); component.change('期望内容类型', sample.kind);
    if (sample.control) component.change(sample.control, sample.input);
    assert.equal(applies, 0); component.submit(); assert.equal(applies, 1);
    assert.deepEqual(document.execution!.nodes[1].when, condition('', sample.value));
    assert.ok(component.text().includes('合成考试结果')); assert.ok(!component.text().includes('source/value'));
    component.change('期望内容类型', 'number');
    for (const invalid of ['', '01', 'NaN', 'Infinity', '1e309', 'false', '"80"', '0x10', '1,2']) {
      component.change('期望数字', invalid); component.submit();
      assert.equal(applies, 1, `Invalid numeric draft ${invalid} must not reach a committed condition`);
      assert.deepEqual(document.execution!.nodes[1].when, condition('', sample.value));
      assert.ok(component.text().includes('未应用'));
    }
    component.change('期望内容类型', 'boolean'); component.submit(); assert.equal(applies, 1, 'Unchosen boolean is not false by default');
    component.change('条件比较值（JSON）', '{"complex":[false,0,null]}'); component.change('条件 JSON Pointer', '/a~1b'); component.submit();
    assert.equal(applies, 2); assert.deepEqual(document.execution!.nodes[1].when, condition('/a~1b', { complex: [false, 0, null] }));
    component.click('明确解除执行条件'); assert.equal(document.execution!.nodes[1].when, undefined);
  }

  // Loading a native-valid large condition must not exceed the editor limit merely from indentation.
  {
    const equals = Array(1500).fill(0), compact = JSON.stringify(equals);
    assert.equal(new TextEncoder().encode(compact).byteLength, 3001);
    assert.ok(JSON.stringify(equals, null, 2).length > 6000);
    const initial = structuredClone(definition.initial); initial.execution!.nodes[1].when = condition('', equals);
    let document = readS2Document(initial, definition), applies = 0;
    const component = editor(() => ({ nodeId: 'target', when: document.execution!.nodes[1].when, disabled: false,
      sourceKey: controlDrafts.s2ConditionSource(document, 'target').key,
      sources: [{ nodeId: 'source', portId: 'value', typeId: 'structured-data.value', label: '合成完整结果' }],
      onApply(value: S2WorkflowCondition | null) {
        const next = structuredClone(document); if (value) next.execution!.nodes[1].when = value; else delete next.execution!.nodes[1].when;
        document = readS2Document(next, definition); applies++; return controlDrafts.s2ConditionSource(document, 'target').key;
      } }));
    assert.equal(component.control('条件比较值（JSON）').props.value, compact);
    component.submit(); assert.equal(applies, 1);
    assert.deepEqual(document.execution!.nodes[1].when, condition('', equals));
    component.change('分支命中方式', 'false'); component.submit(); assert.equal(applies, 2);
    assert.deepEqual(document.execution!.nodes[1].when, condition('', equals, false));
    component.click('载入当前执行条件');
    assert.equal(component.control('条件比较值（JSON）').props.value, compact);
    component.submit(); assert.equal(applies, 3);
    // A compact draft within the character limit must still pass the original native byte limit.
    const tooManyBytes = JSON.stringify('汉'.repeat(2000));
    assert.ok(tooManyBytes.length < 6000 && new TextEncoder().encode(tooManyBytes).byteLength > 6000);
    component.change('条件比较值（JSON）', tooManyBytes); component.submit();
    assert.equal(applies, 3); assert.ok(component.text().includes('条件比较值最多6000字节'));
    assert.deepEqual(document.execution!.nodes[1].when, condition('', equals, false));
  }

  // A real local Host evaluates strict equality, not business meaning or coercion.
  for (const sample of [
    { pointer: '/a~1b/~0leaf/0', equals: 0, status: 'succeeded' },
    { pointer: '/a~1b/~0leaf/0', equals: '0', status: 'skipped' },
    { pointer: '/a~1b/~0leaf/1', equals: false, status: 'succeeded' },
    { pointer: '/a~1b/~0leaf/2', equals: null, status: 'succeeded' },
    { pointer: '/a~1b/~0leaf/4', equals: '', status: 'succeeded' },
    { pointer: '/a~1b/~0leaf/0', equals: '0', match: false, status: 'succeeded' },
    { pointer: '/a~1b/~0leaf/0', equals: 0, match: false, status: 'skipped' },
    { pointer: '/missing', equals: null, status: 'blocked' },
  ]) {
    const document = structuredClone(definition.initial); document.execution!.nodes[1].when = condition(sample.pointer, sample.equals, sample.match ?? true);
    const host = new S2PluginHost(`condition-${hosts.length}`, definition); hosts.push(host); host.setDocument(readS2Document(document, definition));
    const run = await host.enqueueWorkflow(['target']).completion;
    assert.equal(run.nodes.find(item => item.nodeId === 'target')!.status, sample.status);
    assert.equal(host.history().filter(item => item.request.nodeId === 'target').length, sample.status === 'succeeded' ? 1 : 0);
  }

  // The condition reader admits exactly the pre-existing four condition output types; it grants nothing new.
  const host = new S2PluginHost('condition-read-types', definition); hosts.push(host); host.setDocument(definition.initial);
  for (const [id, port, type] of [['source', 'value', 'structured-data.value'], ['check', 'assessment', 'core.assessment'], ['simulation', 'result', 'workflow-simulation.result']] as const) {
    const before = host.remainingCalls;
    assert.throws(() => host.readCurrentConditionOutput(id, port), /尚无/); assert.equal(host.remainingCalls, before);
    assert.equal((await host.enqueueWorkflow([id]).completion).status, 'succeeded');
    const artifact = host.readCurrentConditionOutput(id, port); assert.equal(artifact.type.id, type);
    const cloned = structuredClone(artifact); if (artifact.payload.kind === 'inline') artifact.payload.value = 'changed clone';
    assert.deepEqual(host.readCurrentConditionOutput(id, port), cloned);
    if (type !== 'structured-data.value') assert.throws(() => host.readCurrentStructuredOutput(id, port), /只支持/);
  }
  const humanJob = host.enqueueWorkflow(['human']); await until(() => host.waitingHumanInputs().length > 0);
  assert.throws(() => host.readCurrentConditionOutput('human', 'decision'), /尚无/);
  const wait = host.waitingHumanInputs()[0]; host.submitHumanInput(wait.workflowId, wait.id, false);
  assert.equal((await humanJob.completion).status, 'succeeded');
  const decision = host.readCurrentConditionOutput('human', 'decision'); assert.equal(decision.type.id, 'human-input.decision');
  assert.deepEqual(decision.payload, { kind: 'inline', value: { approved: false } });
  await host.enqueueWorkflow(['text-output']).completion;
  assert.throws(() => host.readCurrentConditionOutput('text-output', 'text'), /只支持/);
  assert.throws(() => host.readCurrentConditionOutput('missing', 'value'), /只支持/);
  assert.throws(() => host.readCurrentConditionOutput('source', 'missing'), /只支持/);
  assert.throws(() => host.readCurrentStructuredOutput('human', 'decision'), /只支持/);
  let rejectRun = false;
  const failingHost = new S2PluginHost('condition-failed-rerun', definition, (call, inputs) => rejectRun
    ? Promise.resolve({ status: 'failed', outputs: {}, error: { code: 'SYNTHETIC_REJECTED', message: '合成来源执行失败' } })
    : executeS2Structured(call, inputs)); hosts.push(failingHost); failingHost.setDocument(definition.initial);
  await failingHost.enqueueWorkflow(['source']).completion;
  const historical = failingHost.readCurrentConditionOutput('source', 'value'); rejectRun = true;
  assert.equal((await failingHost.enqueueWorkflow(['source'], undefined, { force: true }).completion).status, 'failed');
  assert.equal(failingHost.currentArtifact(historical.id).id, historical.id);
  assert.throws(() => failingHost.readCurrentConditionOutput('source', 'value'), /尚无/, 'Failed rerun cannot fall back to historical output');

  // Production parent closures + actual editor: inspecting and choosing are local drafts, never execution.
  let live!: S2PluginHost;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, deferStateUpdates: true, onHost(value) { live = value; } }); uis.push(ui);
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const props = () => { ui.render(); const found = ui.elements().find(e => e.type === 'condition-editor'); assert.ok(found); return found.props; };
  const exported = () => { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial as S2Document; };
  focus('target'); const component = editor(props), initial = exported();
  assert.ok(props().sources.some((item: any) => item.label.includes('合成考试结果')));
  assert.ok(props().sources.every((item: any) => item.label && !item.label.includes('@1')));
  assert.ok(!props().sources.some((item: any) => item.nodeId === 'text-output'));
  component.change('条件来源输出', sourceChoice); component.click('查看可比较的字段（不运行）');
  assert.equal(live, undefined, 'Inspecting unavailable output does not create a session'); assert.deepEqual(exported(), initial);
  const previewApply = props().onApply;
  await ui.openConversationSession(); assert.throws(() => previewApply(condition('', true)), /过期/);
  component.render(); component.click('查看可比较的字段（不运行）'); assert.ok(component.text().includes('尚无'));
  assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64);
  focus('source'); ui.viewContext('source').execution!.run(); ui.render();
  await until(() => { ui.render(); try { live.readCurrentConditionOutput('source', 'value'); return true; } catch { return false; } });
  focus('target'); component.render(); component.click('查看可比较的字段（不运行）');
  const options = component.elements().filter(item => item.type === 'option').map(item => component.text(item));
  assert.ok(options.some(text => text.includes('字段「a/b」') && text.includes('字段「~leaf」') && text.includes('第1项')));
  assert.ok(options.some(text => text.includes('字段「approved」')), 'Ordinary JSON fields keep their original names');
  assert.ok(!options.includes('80')); assert.equal(live.remainingCalls, 63);
  component.change('比较哪部分内容', JSON.stringify('/a~1b/~0leaf/0')); component.change('期望内容类型', 'number'); component.change('期望数字', '0');
  assert.deepEqual(exported(), initial); assert.equal(live.remainingCalls, 63); assert.equal(ui.modelCalls(), 1);
  const replacedSubmit = component.form().props.onSubmit;
  component.change('期望数字', '1'); replacedSubmit({ preventDefault() {} }); component.render();
  assert.equal(props().when, undefined, 'A replaced draft cannot be applied by an older form callback'); component.change('期望数字', '0');
  const oldFields = props().onInspectSource('source', 'value');
  const cache = live.enqueueWorkflow(['source']); assert.throws(() => oldFields.check(), /尚无/); await cache.completion;
  assert.throws(() => oldFields.check(), /变化/); component.submit(); assert.equal(props().when, undefined);
  component.click('查看可比较的字段（不运行）'); component.submit(); assert.deepEqual(props().when, condition('/a~1b/~0leaf/0', 0));
  assert.ok(!component.text().includes('条件操作已过期'), 'A successful application retires its menu without a misleading stale-operation message');
  assert.equal(live.remainingCalls, 63, 'Applying a condition does not run its source or target');
  ui.viewContext('target').execution!.run(); ui.render();
  await until(() => { ui.render(); return live.workflowHistory().at(-1)?.status === 'succeeded'; });
  assert.equal(live.remainingCalls, 61, 'Package user execution includes the target and its connected local downstream'); assert.equal(ui.modelCalls(), 1);
  component.render(); component.click('查看可比较的字段（不运行）');
  const forceFields = props().onInspectSource('source', 'value'), beforeForce = exported();
  const force = live.enqueueWorkflow(['source'], undefined, { force: true }); assert.throws(() => forceFields.check(), /尚无/); await force.completion;
  assert.throws(() => forceFields.check(), /变化/); component.submit(); assert.deepEqual(exported(), beforeForce);
  component.click('查看可比较的字段（不运行）');
  const oldApply = props().onApply, oldBase = props().sourceKey, oldInspect = props().onInspectSource;
  ui.button('＋合成文本').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render();
  assert.deepEqual(exported(), beforeForce); assert.throws(() => oldApply(null, oldBase), /过期/); assert.throws(() => oldInspect('source', 'value'), /过期/);
  // Explicit advanced editing remains independent of an unavailable/old field menu.
  component.render(); component.change('条件 JSON Pointer', '/missing'); component.change('条件比较值（JSON）', 'null'); component.submit();
  assert.deepEqual(props().when, condition('/missing', null));
  ui.viewContext('target').execution!.run(); ui.render();
  await until(() => { ui.render(); return live.workflowHistory().at(-1)?.status === 'failed'; });
  const last = live.workflowHistory().at(-1)!; assert.equal(last.nodes.find(item => item.nodeId === 'target')!.status, 'blocked');
  const ended = props().onApply, endedInspect = props().onInspectSource, beforeEnd = exported();
  ui.button('返回').props.onClick(); ui.render();
  assert.throws(() => ended(null), /过期/); assert.throws(() => endedInspect('source', 'value'), /过期/);
  component.render(); component.submit(); assert.deepEqual(exported(), beforeEnd); assert.equal(ui.modelCalls(), 1);
  host.close(); assert.throws(() => host.readCurrentConditionOutput('source', 'value'), /结束/);

  // Known builtin meaning only: aliases, a matching JSON key, version or port lookalikes confer nothing.
  assert.equal(presentation.s2IsHumanConfirmationOutput({ ...confirm }, 'decision'), true);
  for (const [producer, port] of [[parse, 'value'], [confirm, 'value'], [{ ...confirm, pluginVersion: '2.0.0' }, 'decision'],
    [{ ...confirm, capabilityId: 'json' }, 'decision'], [{ ...confirm, pluginId: 'pretend-human' }, 'decision']] as const)
    assert.equal(presentation.s2IsHumanConfirmationOutput(producer, port), false);
  for (const equals of [true, false]) for (const match of [true, false]) {
    const predicate = { nodeId: 'human', portId: 'decision', pointer: '/approved', equals, match };
    const outcome = equals === match ? '同意' : '不同意';
    assert.equal(presentation.s2HumanConfirmationOutcome(predicate), outcome);
    let applied: S2WorkflowCondition | undefined;
    const component = editor(() => ({ when: applied ?? predicate, disabled: false,
      sources: [{ nodeId: 'human', portId: 'decision', typeId: 'human-input.decision', confirmation: true, label: '本人核对（步骤 5）' }],
      onApply(value: S2WorkflowCondition) { applied = structuredClone(value); } }));
    assert.equal(component.control('确认后的执行时机').props.value, outcome === '同意' ? 'approved' : 'declined');
    assert.match(component.text(), new RegExp(`本人${outcome}时运行`));
    const oldChoice = component.control('确认后的执行时机').props.onChange;
    component.change('确认后的执行时机', outcome === '同意' ? 'declined' : 'approved'); component.submit();
    assert.deepEqual(applied, { ...predicate, match: !match }, 'Human-readable choice must preserve equals:false as well as true');
    oldChoice({ target: { value: outcome === '同意' ? 'approved' : 'declined' } }); component.render();
    assert.equal(component.control('确认后的执行时机').props.value, outcome === '同意' ? 'declined' : 'approved', 'Old choice handlers cannot replace a newer applied draft');
  }
  for (const candidate of [condition('/approved', 'true'), condition('/approved', 1), condition('', true), condition('/approved/0', true)])
    assert.equal(presentation.s2HumanConfirmationOutcome(candidate), undefined);
  for (const route of ['ordinary', 'legacy', 'nested'] as const) for (const deferStateUpdates of [false, true]) {
    const local = structuredClone(definition);
    local.initial.execution!.nodes[1].when = { nodeId: 'human', portId: 'decision', pointer: '/approved', equals: false, match: false };
    // A JSON object deliberately looks like a confirmation; it must retain generic field semantics.
    local.initial.execution!.nodes[0].presentation = { label: '由你确认', outputs: { value: '你的选择' } };
    if (route === 'legacy') local.initial.execution!.nodes.forEach(node => { delete node.presentation; });
    if (route === 'nested') {
      local.initial = wrapS2CanvasComposite(local.initial, local.plugins, ['human'], '内层核对').document;
      local.initial = wrapS2CanvasComposite(local.initial, local.plugins, ['human'], '外层任务').document;
    }
    const checked = readS2Definition(local), draft = createS2Scene({ sceneSkill: 'S2', subject: '合成确认条件', source: 'custom', knowledgePoints: [], interactionPack: null });
    draft.canvasWorkspace = checked;
    let live!: S2PluginHost;
    const task = harness({ legacyCatalogue: true, initialDraft: draft, deferStateUpdates, onHost(value) { live = value; } }); uis.push(task);
    try {
      await task.openConversationSession();
      const document = () => task.viewContext('target').readCurrent().document;
      const focus = (id: string) => { task.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); task.render(); };
      const props = () => { task.render(); return task.elements().find(e => e.type === 'condition-editor')!.props; };
      focus('target');
      assert.equal(props().sources.find((item: any) => item.nodeId === 'human').confirmation, true);
      assert.equal(props().sources.find((item: any) => item.nodeId === 'source').confirmation, false);
      const component = editor(props), before = JSON.stringify(document());
      assert.match(component.text(), /本人同意时运行/); assert.equal(live.remainingCalls, 64); assert.equal(live.workflowHistory().length, 0);
      component.click('查看可比较的字段（不运行）'); assert.match(component.text(), /尚无/);
      assert.equal(JSON.stringify(document()), before); assert.equal(live.workflowHistory().length, 0);
      focus('human'); task.viewContext('human').execution!.run(); task.render();
      await until(() => { task.render(); return live.waitingHumanInputs().length === 1; });
      task.inline('human').elements().find(e => e.type === 'human-input')!.props.onSubmit(false);
      await until(() => { task.render(); return live.workflowHistory().at(-1)?.status === 'succeeded'; });
      focus('target'); component.render(); component.click('查看可比较的字段（不运行）');
      const menu = props().onInspectSource('human', 'decision');
      assert.equal(menu.options.find((item: any) => item.pointer === '/approved').label, '是否同意');
      component.change('确认后的执行时机', 'declined'); assert.equal(JSON.stringify(document()), before);
      component.submit(); assert.deepEqual(props().when, { nodeId: 'human', portId: 'decision', pointer: '/approved', equals: false, match: true });
      assert.equal(live.remainingCalls, 64); assert.match(component.text(), /本人不同意时运行/);
      assert.equal(component.control('条件 JSON Pointer').props.value, '/approved');
      assert.equal(component.control('条件比较值（JSON）').props.value, 'false');
      const description = s2ConnectionDescriptions(checked, document()).find(item => item.kind === 'condition')!;
      assert.equal(description.shortLabel, '不同意时运行'); assert.match(description.summary, /明确不同意时/);
      assert.doesNotMatch(description.summary + description.detail, /approved|已经同意/);
      assert.equal(JSON.parse(description.technical).pointer, '/approved');
      const edge = task.flow().props.edges.find((item: any) => item.id === JSON.stringify(['condition', 'target']));
      assert.equal(edge.label, '不同意时运行', 'Human confirmation edges expose semantic meaning, not technical paths');
      assert.match(edge.ariaLabel, /明确不同意时/, 'The accessible condition meaning remains exact');
      if (route === 'nested') assert.notEqual(edge.source, 'human', 'The visible condition comes through a composite output proxy, not a rewritten source');
      for (const answer of [false, true]) {
        task.viewContext('target').execution!.run(); task.render();
        await until(() => { task.render(); return live.waitingHumanInputs().length === 1; });
        task.inline('human').elements().find(e => e.type === 'human-input')!.props.onSubmit(answer);
        await until(() => { task.render(); return live.workflowHistory().at(-1)?.status === 'succeeded'; });
        assert.equal(live.workflowHistory().at(-1)!.nodes.find(node => node.nodeId === 'target')!.status, answer ? 'skipped' : 'succeeded');
      }
      assert.equal(live.remainingCalls, 63); assert.equal(task.modelCalls(), 1);
      component.render(); component.click('查看可比较的字段（不运行）');
      const current = JSON.stringify(document()), stale = props().onInspectSource('human', 'decision');
      const rerun = live.enqueueWorkflow(['human']);
      await until(() => { task.render(); return live.waitingHumanInputs().length === 1; });
      assert.throws(() => stale.check(), /尚无/); component.submit(); assert.equal(JSON.stringify(document()), current);
      const waiting = live.waitingHumanInputs()[0]; live.submitHumanInput(waiting.workflowId, waiting.id, false); await rerun.completion;
      assert.throws(() => stale.check(), /变化/); component.submit(); assert.equal(JSON.stringify(document()), current);
      component.click('查看可比较的字段（不运行）'); component.submit(); assert.equal(JSON.stringify(document()), current);
      const ended = props().onApply; task.button('返回').props.onClick(); task.render();
      assert.throws(() => ended(null), /过期/); assert.equal(task.modelCalls(), 1);
    } finally { task.dispose(); }
  }
  const generic = structuredClone(definition.initial);
  generic.execution!.nodes[1].when = { nodeId: 'source', portId: 'value', pointer: '/approved', equals: true, match: true };
  const genericDescription = s2ConnectionDescriptions(definition, generic).find(item => item.kind === 'condition')!;
  assert.equal(genericDescription.shortLabel, '相等时运行'); assert.match(genericDescription.summary, /指定位置/);
  assert.equal(network, 0);
  console.log('S2 condition forms passed: exact typed drafts and generic JSON fields, trusted builtin confirmation labels/outcome truth table without equals:false rewrite, ordinary/alias-free/nested output-proxy routes under ordinary/deferred hooks, explicit inspection/application with no execution, stale/latest/end and advanced compatibility, unchanged real local equality/skip/missing-field guards and no model/IO. Synthetic offline only; not browser, user comprehension or model acceptance.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = prior; }
