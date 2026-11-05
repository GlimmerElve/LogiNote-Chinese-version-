import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { S2HumanDrafts } from '../src/services/scene/sceneS2ControlDrafts';
import type { S2Document, S2Field } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, importS2Workspace, exportS2Workspace, importS2Subgraph, exportS2Subgraph } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import * as forms from '../src/services/scene/sceneS2ParameterForm';
import * as issues from '../src/services/scene/sceneS2ControlIssue';
import { focusS2SimpleValueIssue } from '../src/components/scene/S2SimpleValueInput';
import { S2HumanInput } from '../src/components/scene/S2HumanInput';
import { harness } from './scene-s2-ui-harness';

// Real component and real host, deterministic hooks. Browser focus/pointer rendering is verified separately.
function inputHarness(props: () => React.ComponentProps<typeof S2HumanInput>) {
  let slots: any[] = [], cursor = 0, tree: any;
  const ReactStub = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2HumanInput.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require(id: string) {
    if (id === 'react') return ReactStub;
    if (id.endsWith('S2ArtifactView')) return { S2ArtifactView: 'artifact' };
    if (id.endsWith('S2FieldEditor')) return { S2ControlInput: 'control-input' };
    if (id.endsWith('sceneS2ParameterForm')) return forms;
    if (id.endsWith('sceneS2ControlIssue')) return issues;
    if (id.endsWith('S2SimpleValueInput')) return { focusS2SimpleValueIssue };
    throw new Error(`Unexpected human form dependency ${id}`);
  } });
  const render = () => { cursor = 0; tree = exports.S2HumanInput(props()); };
  const elements = (v: any = tree): any[] => Array.isArray(v) ? v.flatMap(item => elements(item ?? null))
    : v && typeof v === 'object' ? [v, ...elements(v.children ?? [])] : [];
  const text = (v: any = tree): string => Array.isArray(v) ? v.map(item => text(item ?? null)).join('')
    : v && typeof v === 'object' ? text(v.children ?? []) : String(v ?? '');
  const button = (label: string) => { const found = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(found, label); return found; };
  const control = () => elements().find(e => e.type === 'control-input');
  const textarea = () => elements().find(e => e.type === 'textarea');
  const form = () => elements().find(e => e.type === 'form');
  render(); return { render, elements, text, button, control, textarea, form,
    fresh() { slots = []; render(); },
    draft(value: any) { assert.ok(control()); control().props.onChange(value); render(); },
    json(value: string) { assert.ok(textarea()); textarea().props.onChange({ target: { value } }); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
    toggle() { button(control() ? '改用 JSON 编辑（高级）' : '切回表单填写').props.onClick(); render(); },
  };
}
type Wait = ReturnType<S2PluginHost['waitingHumanInputs']>[number];
async function waitFor(host: S2PluginHost, id: string): Promise<Wait> {
  for (let i = 0; i < 500; i++) {
    const wait = host.waitingHumanInputs().find(wait => wait.workflowId === id);
    if (wait) return wait;
    const record = host.workflowHistory().find(run => run.id === id)!;
    assert.ok(!['failed', 'cancelled'].includes(record.status), record.error);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Synthetic run did not reach human form wait');
}
async function complete(job: { completion: Promise<S2WorkflowRun> }) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([job.completion, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Synthetic completion deadline')), 2500);
  })]); } finally { clearTimeout(timer!); }
}
const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Response form tests use synthetic local data only'); };
const hosts: S2PluginHost[] = [];
try {
  const definition = importS2Workspace(readFileSync('scripts/fixtures/s2-human-form-workspace.json', 'utf8'));
  const field = definition.initial.execution!.nodes[0].presentation!.responseForm!;
  const scene = createS2Scene({ source: 'custom', subject: 'Synthetic response form', sceneSkill: 'S2', knowledgePoints: [] });
  scene.canvasWorkspace = definition;
  const hostFor = (document: S2Document = definition.initial) => {
    const host = new S2PluginHost(scene.sceneId, definition.plugins!); host.setDocument(document); hosts.push(host); return host;
  };
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const pasted = importS2Subgraph(exportS2Subgraph(definition, definition.initial, ['ask', 'result']), definition, definition.initial);
  assert.ok(pasted.document.execution!.nodes.some(n => n.id !== 'ask' && n.presentation?.responseForm?.label === '练习要求'));

  // Metadata is copied from the enqueued graph, not re-read from the latest display or a UI-owned object.
  const host = hostFor(), oldJob = host.enqueueWorkflow(['result']);
  const updated = structuredClone(definition.initial);
  updated.execution!.nodes[0].presentation!.responseForm!.label = '更新的要求';
  updated.execution!.nodes[0].presentation!.responseForm!.fields![0].label = '新的角色名称';
  host.setDocument(updated);
  const oldWait = await waitFor(host, oldJob.id);
  assert.equal(oldWait.responseForm!.label, '练习要求');
  oldWait.responseForm!.fields![0].label = '不应篡改宿主';
  assert.equal(host.waitingHumanInputs()[0].responseForm!.fields![0].label, '角色设定');
  const newJob = host.enqueueWorkflow(['result']), newWait = await waitFor(host, newJob.id);
  assert.equal(newWait.responseForm!.label, '更新的要求');
  const oldAgain = host.waitingHumanInputs().find(w => w.workflowId === oldJob.id)!;
  assert.equal(oldAgain.responseForm!.label, '练习要求');
  assert.equal(host.history().length, 0); assert.equal(host.remainingCalls, 64);
  assert.throws(() => host.submitHumanInput('foreign', oldAgain.id, {}), /失效/);
  assert.throws(() => host.submitHumanInput(oldJob.id, newWait.id, {}), /失效/);
  // Form constraints are presentation-only; an explicit valid JSON value still uses the actual typed port.
  for (const [job, wait, value] of [[oldJob, oldAgain, { zero: 0, off: false, empty: null }], [newJob, newWait, {}]] as const) {
    host.submitHumanInput(job.id, wait.id, value);
    assert.throws(() => host.submitHumanInput(job.id, wait.id, value), /失效|提交/);
    const run = await complete(job); assert.equal(run.status, 'succeeded');
    const human = run.nodes.find(n => n.nodeId === 'ask')!, result = run.nodes.find(n => n.nodeId === 'result')!;
    const answer = host.currentArtifact(human.artifactIds[0]), output = host.currentArtifact(result.artifactIds[0]);
    assert.equal(answer.source.kind, 'user'); assert.equal(answer.source.invocationId, undefined);
    assert.equal(human.invocationId, undefined); assert.equal(answer.payload.kind, 'inline');
    if (answer.payload.kind === 'inline') assert.deepEqual(answer.payload.value, value);
    assert.equal(output.payload.kind, 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(JSON.parse(output.payload.value as string), value);
  }
  assert.equal(host.history().length, 2); assert.equal(host.remainingCalls, 62, 'Only downstream stringify calls consume plugin budget');

  // Visible defaults are local drafts; neither opening nor changing the form answers the wait.
  const componentHost = hostFor(), componentJob = componentHost.enqueueWorkflow(['result']), componentWait = await waitFor(componentHost, componentJob.id);
  const drafts: S2HumanDrafts = new Map(); let submitCalls = 0;
  const states: Array<[string, string | undefined]> = [];
  const component = inputHarness(() => ({ wait: componentWait, nodeLabel: '填写练习要求', disabled: false, drafts,
    onStateChange: (state, via) => states.push([state, via]), onCancel: () => componentHost.cancelWorkflow(componentJob.id),
    onSubmit(value, via) { submitCalls++; componentHost.submitHumanInput(componentJob.id, componentWait.id, value, via); } }));
  assert.equal(component.control().props.draft.count, '0'); assert.equal(component.control().props.draft.examples, 'false');
  assert.equal(component.control().props.draft.role, '耐心的提示词工程老师');
  assert.equal(componentHost.waitingHumanInputs().length, 1); assert.equal(submitCalls, 0); assert.equal(componentHost.remainingCalls, 64);
  const markup = renderToStaticMarkup(<S2HumanInput wait={componentWait} nodeLabel="填写练习要求" disabled={false} onSubmit={() => {}} onCancel={() => {}} />);
  assert.ok(markup.includes('角色设定') && markup.includes('练习目标') && markup.includes('题目数量') && markup.includes('是否举例'));
  assert.ok(markup.includes('aria-label="填写练习要求"')); assert.ok(!markup.includes('补充数据（JSON 格式）'));
  component.draft({ ...component.control().props.draft, role: 'PRIVATE_UNSUBMITTED_RESPONSE', count: '-' }); component.submit();
  assert.equal(submitCalls, 0); assert.ok(component.text().includes('题目数量'));
  assert.ok(!JSON.stringify(componentHost.prepare(null, { goal: definition.goal, ...definition.instructions }, '只讨论')).includes('PRIVATE_UNSUBMITTED_RESPONSE'));
  component.fresh(); assert.equal(component.control().props.draft.count, '-'); assert.ok(component.text().includes('上次提交未成功'));
  component.toggle(); assert.ok(component.control()); assert.equal(component.control().props.draft.count, '-');
  component.draft({ ...component.control().props.draft, role: '  保留原文 {{role}}\n  ', count: '0', examples: 'false', topics: ['角色', '约束'] });
  component.toggle(); const native = JSON.parse(component.textarea().props.value);
  assert.equal(native.count, 0); assert.equal(native.examples, false); assert.equal(native.role, '  保留原文 {{role}}\n  ');
  component.json('{"unfinished":'); component.toggle(); assert.ok(!component.control()); assert.equal(component.textarea().props.value, '{"unfinished":');
  component.json(JSON.stringify({ ...native, extra: null })); component.toggle(); assert.ok(!component.control());
  assert.equal(JSON.parse(component.textarea().props.value).extra, null);
  component.json('null'); component.toggle(); assert.equal(component.textarea().props.value, 'null'); assert.ok(!component.control());
  component.json(JSON.stringify(native)); component.toggle(); assert.ok(component.control());
  assert.equal(submitCalls, 0); assert.equal(componentHost.workflowHistory()[0].status, 'waiting');
  const keyEvent = (extra: Record<string, unknown> = {}) => ({ key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    keyCode: 13, nativeEvent: {}, target: { tagName: 'TEXTAREA' }, preventDefault() {}, stopPropagation() {}, ...extra });
  for (const event of [keyEvent({ nativeEvent: { isComposing: true } }), keyEvent({ keyCode: 229 }), keyEvent({ ctrlKey: false }), keyEvent({ altKey: true }), keyEvent({ shiftKey: true })]) {
    component.form().props.onKeyDown(event); assert.equal(submitCalls, 0);
  }
  let implicitPrevented = 0;
  component.form().props.onKeyDown(keyEvent({ ctrlKey: false, target: { tagName: 'INPUT' }, preventDefault() { implicitPrevented++; } }));
  assert.equal(implicitPrevented, 1); assert.equal(submitCalls, 0, 'Plain Enter in a one-line field must not implicitly continue the workflow');
  component.form().props.onKeyDown(keyEvent({ ctrlKey: false, target: { tagName: 'TEXTAREA' }, preventDefault() { implicitPrevented++; } }));
  component.form().props.onKeyDown(keyEvent({ ctrlKey: false, target: { tagName: 'BUTTON' }, preventDefault() { implicitPrevented++; } }));
  component.form().props.onKeyDown(keyEvent({ ctrlKey: false, target: { tagName: 'INPUT' }, nativeEvent: { isComposing: true }, preventDefault() { implicitPrevented++; } }));
  assert.equal(implicitPrevented, 1, 'Multiline newline, button keyboard activation and IME remain available');
  const shortcut = component.form().props.onKeyDown; shortcut(keyEvent()); shortcut(keyEvent()); component.render();
  assert.equal(submitCalls, 1); assert.equal(component.control().props.disabled, true);
  const componentDone = await complete(componentJob); assert.equal(componentDone.status, 'succeeded');
  const submitted = componentHost.currentArtifact(componentDone.nodes.find(n => n.nodeId === 'ask')!.artifactIds[0]);
  assert.equal(submitted.payload.kind, 'inline'); if (submitted.payload.kind === 'inline') assert.deepEqual(submitted.payload.value, native);
  assert.ok(componentHost.prepare(null, { goal: definition.goal, ...definition.instructions }, '检查').interactions.controlStates
    .some(item => item.kind === 'human-control' && item.state === 'submitted' && item.via === 'shortcut'));

  // JSON is an explicit escape hatch for values not representable by this display form, never a lossy conversion.
  for (const value of [null, false, 0, { extra: null, zero: 0, off: false }, { role: 'only-one-key' }]) {
    const rawHost = hostFor(), job = rawHost.enqueueWorkflow(['result']), wait = await waitFor(rawHost, job.id);
    const editor = inputHarness(() => ({ wait, disabled: false, onCancel() {}, onSubmit(answer) { rawHost.submitHumanInput(job.id, wait.id, answer); } }));
    editor.toggle(); editor.json(JSON.stringify(value)); editor.toggle();
    assert.ok(!editor.control(), 'Unrepresentable JSON remains in the advanced editor');
    editor.submit(); assert.equal((await complete(job)).status, 'succeeded');
    const artifact = rawHost.currentArtifact(rawHost.workflowHistory()[0].nodes.find(n => n.nodeId === 'ask')!.artifactIds[0]);
    assert.equal(artifact.payload.kind, 'inline'); if (artifact.payload.kind === 'inline') assert.deepEqual(artifact.payload.value, value);
  }

  // A table form retains absent cells, false, zero and explicit null separately.
  const tableField: S2Field = { id: 'value', label: '练习记录', kind: 'table', columns: [
    { id: 'title', label: '名称', type: 'string', required: true }, { id: 'score', label: '得分', type: 'number', nullable: true },
    { id: 'understood', label: '理解', type: 'boolean' },
  ] };
  const tableDocument = structuredClone(definition.initial); tableDocument.execution!.nodes[0].presentation!.responseForm = tableField;
  const tableHost = hostFor(tableDocument), tableJob = tableHost.enqueueWorkflow(['result']), tableWait = await waitFor(tableHost, tableJob.id);
  const rows: S2Json = [{ title: '零分', score: 0, understood: false }, { title: '空值', score: null }, { title: '尚未填写' }];
  const tableEditor = inputHarness(() => ({ wait: tableWait, disabled: false, onCancel() {}, onSubmit(value) { tableHost.submitHumanInput(tableJob.id, tableWait.id, value); } }));
  tableEditor.draft(forms.s2ParameterFormDraft(tableField, rows)); tableEditor.toggle(); assert.deepEqual(JSON.parse(tableEditor.textarea().props.value), rows);
  tableEditor.toggle(); tableEditor.submit(); assert.equal((await complete(tableJob)).status, 'succeeded');
  const tableArtifact = tableHost.currentArtifact(tableHost.workflowHistory()[0].nodes.find(n => n.nodeId === 'ask')!.artifactIds[0]);
  if (tableArtifact.payload.kind === 'inline') assert.deepEqual(tableArtifact.payload.value, rows);

  // A forged schema generation cannot submit a saved draft under a different schema.
  const conflictDrafts: S2HumanDrafts = new Map(); let currentWait = structuredClone(componentWait), conflictedSubmits = 0;
  const conflicting = inputHarness(() => ({ wait: currentWait, disabled: false, drafts: conflictDrafts, onCancel() {}, onSubmit() { conflictedSubmits++; } }));
  conflicting.draft({ ...conflicting.control().props.draft, role: '保留本地草稿' });
  currentWait = { ...currentWait, responseForm: { ...currentWait.responseForm!, label: 'changed' } };
  conflicting.render(); assert.ok(conflicting.text().includes('本次表单已变化')); conflicting.submit(); assert.equal(conflictedSubmits, 0);
  assert.ok(JSON.stringify([...conflictDrafts.values()]).includes('保留本地草稿'));

  // Actual parent callbacks reject stale/ended waits instead of resuming another workflow.
  let parentHost!: S2PluginHost;
  const ui = harness({ initialDraft: scene, onHost(value) { parentHost = value; hosts.push(value); } });
  try {
    ui.button('开始试验').props.onClick(); ui.render(); ui.button('运行全部步骤').props.onClick();
    for (let i = 0; i < 500 && !parentHost.waitingHumanInputs().length; i++) { await new Promise(resolve => setTimeout(resolve, 1)); ui.render(); }
    ui.render();
    const actual = ui.elements().find(e => e.type === 'human-input')!.props as React.ComponentProps<typeof S2HumanInput>;
    assert.equal(actual.wait.responseForm!.label, field.label);
    const staleDrafts = new Map(); const staleEditor = inputHarness(() => ({ ...actual, drafts: staleDrafts }));
    staleEditor.draft({ ...staleEditor.control().props.draft, role: 'PRIVATE_STALE_FORM' });
    const changed = structuredClone(definition.initial); changed.execution!.nodes[0].bindings.prompt = { kind: 'literal', value: '语义已经改变' };
    parentHost.setDocument(changed); staleEditor.submit();
    assert.equal(parentHost.waitingHumanInputs().length, 0); assert.equal(parentHost.history().length, 0);
    assert.ok(staleEditor.text().includes('失效') || staleEditor.text().includes('过期'));
    assert.equal(staleEditor.control().props.draft.role, 'PRIVATE_STALE_FORM');
    ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => actual.onSubmit({ zero: 0 }, 'form'), /过期|失效|结束/);
    assert.equal(ui.modelCalls(), 0);
  } finally { ui.dispose(); }

  const disabled = inputHarness(() => ({ wait: componentWait, disabled: true, onSubmit() { assert.fail('Disabled form must not submit'); }, onCancel() { assert.fail('Disabled form must not cancel'); } }));
  disabled.submit(); disabled.form().props.onKeyDown(keyEvent()); disabled.toggle(); disabled.button('取消本次运行（保留已完成记录）').props.onClick();
  assert.ok(disabled.control()); assert.equal(disabled.control().props.disabled, true);
  assert.equal(network, 0);
  console.log('S2 response forms passed: saved/subgraph metadata, enqueue-time immutable form generations, human/native data downstream without artificial plugin debit, visible defaults with no auto-submit, production component form/JSON lifecycle and exact fallback, partial/invalid drafts, table false/zero/null/missing preservation, shortcut/IME/duplicate guards, stale/end parent protection, no draft leakage/model/network. Synthetic offline only; browser and real-model accuracy are separate.');
} finally { for (const host of hosts) host.close(); globalThis.fetch = previousFetch; }
