import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { S2Field } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, readS2Document, importS2Workspace, exportS2Workspace, exportS2Subgraph, importS2Subgraph } from '../src/services/scene/sceneS2Canvas';
import * as forms from '../src/services/scene/sceneS2ParameterForm';
import * as simpleForms from '../src/services/scene/sceneS2SimpleValueForm';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import { S2ControlInput } from '../src/components/scene/S2FieldEditor';
import { focusS2SimpleValueIssue } from '../src/components/scene/S2SimpleValueInput';
import { readS2NodePresentation } from '../src/services/scene/sceneS2Presentation';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { s2ParameterSource } from '../src/services/scene/sceneS2ControlDrafts';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

// Real parameter component with deterministic hooks; DOM pointer/IME behavior is separate browser acceptance.
function editorHarness(props: () => any, mountFocus = false) {
  let slots: any[] = [], cursor = 0, tree: any;
  const focusLog: string[] = [];
  let mounted: any;
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2JsonParameter.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require: (id: string) => {
    if (id === 'react') return React;
    if (id.endsWith('S2FieldEditor')) return { S2ControlInput: 'control-input' };
    if (id.endsWith('S2SimpleValueInput')) return { S2SimpleValueInput: 'simple-input', focusS2SimpleValueIssue };
    if (id.endsWith('sceneS2SimpleValueForm')) return simpleForms;
    if (id.endsWith('sceneS2ParameterForm')) return forms;
    if (id.endsWith('sceneS2ControlIssue')) return controlIssues;
    throw new Error(`Unexpected parameter editor dependency ${id}`);
  } });
  const native = (value: any): any[] => Array.isArray(value) ? value.flatMap(native) : value && typeof value === 'object'
    ? value.type === 'control-input' ? native(S2ControlInput(value.props)) : typeof value.type === 'function' ? native(value.type(value.props))
      : [value, ...native(value.children ?? value.props?.children)] : [];
  const render = () => {
    cursor = 0; tree = exports.S2JsonParameter(props());
    if (!mountFocus) return;
    if (mounted) mounted.isConnected = false;
    const controls: any[] = [], document: any = { activeElement: null };
    const form: any = { isConnected: true, ownerDocument: document, querySelectorAll: () => controls };
    mounted = form;
    for (const element of native(tree).filter(e => e.props['data-s2-simple-control'])) {
      const control: any = { parentElement: form, getAttribute: (name: string) => element.props[name], closest: () => form,
        matches: (selector: string) => selector === ':disabled' ? !!element.props.disabled : ['input', 'select', 'textarea'].includes(element.type) || element.type === 'button' && element.props.type === 'button',
        scrollIntoView() {}, focus() { document.activeElement = control; focusLog.push(element.props['data-s2-simple-control']); } };
      controls.push(control);
    }
    tree.props.ref.current = form;
  };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null))
    : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('')
    : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
  const button = (label: string) => { const found = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(found, label); return found; };
  const control = () => elements().find(e => e.type === 'control-input');
  const input = () => elements().find(e => e.type === 'textarea');
  const form = () => elements().find(e => e.type === 'form')!;
  render(); return { render, elements, text, button, control, input, form, native: () => native(tree), focusLog, mounted: () => mounted,
    fresh() { slots = []; render(); },
    draft(value: any) { assert.ok(control()); control().props.onChange(value); render(); },
    json(value: string) { assert.ok(input()); input().props.onChange({ target: { value } }); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
  };
}
const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Parameter forms use synthetic local data only'); };
try {
  const definition = importS2Workspace(readFileSync('scripts/fixtures/s2-parameter-forms-workspace.json', 'utf8'));
  const node = definition.initial.execution!.nodes.find(n => n.id === 'settings')!, field = node.presentation!.inputForms!.value;
  const original = node.bindings.value.kind === 'literal' ? node.bindings.value.value : null;
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const pasted = importS2Subgraph(exportS2Subgraph(definition, definition.initial, ['settings']), definition, definition.initial);
  assert.ok(pasted.document.execution!.nodes.some(n => n.id !== 'settings' && n.presentation?.inputForms?.value?.label === '练习要求'));
  const cap = s2BuiltinPluginRegistry().capability(node);
  for (const inputForms of [
    { invented: field }, { value: { ...field, id: 'other' } }, { value: { ...field, onSubmit: 'execute()' } },
    { value: { ...field, permissions: ['network'] } },
    { value: { ...field, fields: [{ id: 'x', label: '未安装', kind: 'html' }] } },
  ]) assert.throws(() => readS2NodePresentation({ label: '测试', inputForms }, cap));
  const textCap = s2BuiltinPluginRegistry().capability(definition.initial.execution!.nodes.find(n => n.id === 'source')!);
  assert.throws(() => readS2NodePresentation({ label: '文本端口不能伪装对象', inputForms: { text: { ...field, id: 'text' } } }, textCap));
  let getterReads = 0;
  const unsafe = { id: 'value', label: '拒绝执行', kind: 'form', fields: [{ id: 'safe', label: '安全', kind: 'text' }] };
  Object.defineProperty(unsafe.fields[0], 'defaultValue', { enumerable: true, get() { getterReads++; return '不应读取'; } });
  assert.throws(() => forms.readS2ParameterForm(unsafe, 'value')); assert.equal(getterReads, 0);
  const sparse: any[] = Array(1); Object.defineProperty(sparse, 'extra', { enumerable: true, value: '填补计数' });
  assert.throws(() => forms.readS2ParameterForm({ id: 'value', label: '稀疏选项', kind: 'enum', options: sparse }, 'value'));
  const hidden = { id: 'value', label: '隐藏属性', kind: 'text' };
  Object.defineProperty(hidden, 'defaultValue', { enumerable: false, value: '不应忽略' });
  assert.throws(() => forms.readS2ParameterForm(hidden, 'value'));
  assert.deepEqual(forms.submitS2ParameterForm(field, forms.s2ParameterFormDraft(field, original)), original);
  const simple = forms.readS2ParameterForm({ id: 'value', label: '基础类型', kind: 'form', fields: [
    { id: 'empty', label: '空文字', kind: 'text' }, { id: 'zero', label: '零', kind: 'number' }, { id: 'off', label: '否', kind: 'boolean' },
  ] }, 'value');
  for (const value of [{ empty: '', zero: 0, off: false }, {}, { empty: '' }]) {
    assert.deepEqual(forms.submitS2ParameterForm(simple, forms.s2ParameterFormDraft(simple, value)), value);
  }
  for (const value of [null, { empty: null }, { extra: 1 }, { zero: '0' }, { off: 0 }]) assert.throws(() => forms.s2ParameterFormDraft(simple, value));
  const withDefaults = forms.readS2ParameterForm({ id: 'value', label: '不能补写默认', kind: 'form', fields: [{ id: 'name', label: '名称', kind: 'text', defaultValue: '默认' }] }, 'value');
  assert.throws(() => forms.s2ParameterFormDraft(withDefaults, {}));
  for (const kind of ['form', 'list'] as const) {
    const nested = forms.readS2ParameterForm({ id: 'value', label: '不能补写容器', kind: 'form', fields: [{ id: 'optional', label: '可选', kind,
      ...(kind === 'form' ? { fields: [{ id: 'text', label: '内容', kind: 'text' }] } : { item: { id: 'text', label: '内容', kind: 'text' } }) }] }, 'value');
    assert.throws(() => forms.s2ParameterFormDraft(nested, {}));
  }
  for (const kind of ['text', 'multiline', 'code', 'enum'] as const) {
    const stringForm = forms.readS2ParameterForm({ id: 'value', label: '原文', kind, ...(kind === 'enum' ? { options: ['false'] } : {}) }, 'value');
    assert.equal(forms.submitS2ParameterForm(stringForm, forms.s2ParameterFormDraft(stringForm, 'false')), 'false');
    assert.throws(() => forms.s2ParameterFormDraft(stringForm, false));
  }
  for (const kind of ['enum', 'number', 'boolean', 'json'] as const) {
    const scalar = forms.readS2ParameterForm({ id: 'value', label: '可选材料', kind, ...(kind === 'enum' ? { options: ['基础', '进阶'] } : {}) }, 'value');
    assert.throws(() => forms.submitS2ParameterForm(scalar, forms.s2ParameterFormDraft(scalar, undefined)), /可选材料.*填写或选择/,
      'An omitted optional scalar cannot become an empty-string literal or a raw JSON parse failure');
    if (kind === 'enum') {
      assert.throws(() => forms.s2ParameterFormDraft(scalar, ''), /填写或选择/);
      assert.equal(forms.submitS2ParameterForm(scalar, forms.s2ParameterFormDraft(scalar, '进阶')), '进阶');
    }
  }
  for (const kind of ['text', 'multiline', 'code'] as const) {
    const scalar = forms.readS2ParameterForm({ id: 'value', label: '允许空文字', kind }, 'value');
    assert.equal(forms.submitS2ParameterForm(scalar, forms.s2ParameterFormDraft(scalar, '')), '', 'Explicit empty text remains valid');
  }
  const tableNode = definition.initial.execution!.nodes.find(n => n.id === 'observations')!;
  const tableValue = tableNode.bindings.value.kind === 'literal' ? tableNode.bindings.value.value : null;
  assert.deepEqual(forms.submitS2ParameterForm(tableNode.presentation!.inputForms!.value, forms.s2ParameterFormDraft(tableNode.presentation!.inputForms!.value, tableValue)), tableValue);
  const changedSchema = structuredClone(definition.initial);
  changedSchema.execution!.nodes[0].presentation!.inputForms!.value.fields![3].max = 19;
  assert.deepEqual(s2SemanticDocument(changedSchema), s2SemanticDocument(definition.initial), 'Editor schema is not execution semantics');
  assert.notEqual(s2ParameterSource(changedSchema, 'settings', 'value').key, s2ParameterSource(definition.initial, 'settings', 'value').key, 'Editor source identity protects changed schema');
  const moved = structuredClone(definition.initial); moved.execution!.nodes[0].position.x += 1;
  assert.equal(s2ParameterSource(moved, 'settings', 'value').key, s2ParameterSource(definition.initial, 'settings', 'value').key);

  const scene = createS2Scene({ source: 'custom', subject: '合成中文参数表单', sceneSkill: 'S2', knowledgePoints: [] }); scene.canvasWorkspace = definition;
  let host!: S2PluginHost;
  const ui = harness({ initialDraft: scene, onHost(value) { host = value; } });
  try {
    ui.button('开始试验').props.onClick(); ui.render();
    const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
    focus('settings');
    const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'settings' && e.props.portId === 'value')!.props; };
    assert.equal(ui.elements().filter(e => e.type === 'json-parameter' && e.props.portId === 'value').length, 1, 'One draft/editor owns form and JSON modes');
    const editor = editorHarness(props);
    const graphNode = () => ui.flow().props.nodes.find((n: any) => n.id === 'settings').data.node;
    const context = () => host.prepare(null, { goal: definition.goal, ...definition.instructions }, '只读取控件状态');
    editor.draft({ ...editor.control().props.draft, role: 'PRIVATE_FORM_DRAFT', count: '-' }); editor.submit();
    assert.deepEqual(props().value, original); assert.ok(editor.text().includes('题目数量'));
    assert.ok(!JSON.stringify(context()).includes('PRIVATE_FORM_DRAFT')); editor.fresh();
    assert.ok(editor.text().includes('草稿上次校验未通过')); assert.equal(editor.control().props.draft.count, '-');
    editor.button('改用 JSON 编辑（高级）').props.onClick(); editor.render();
    assert.ok(editor.control(), 'Invalid partial form cannot disappear on a mode switch');
    editor.draft({ ...editor.control().props.draft, role: '  你是耐心的老师。\n保留 {{literal}}  ', count: '0', examples: 'false' });
    editor.button('改用 JSON 编辑（高级）').props.onClick(); editor.render();
    const converted = JSON.parse(editor.input().props.value); assert.equal(converted.count, 0); assert.equal(converted.examples, false);
    const partial = '{"PRIVATE_JSON_DRAFT":'; editor.json(partial);
    editor.button('切回表单填写').props.onClick(); editor.render(); assert.equal(editor.input().props.value, partial);
    editor.json(JSON.stringify({ ...converted, extra: '不能丢失' })); editor.button('切回表单填写').props.onClick(); editor.render();
    assert.equal(JSON.parse(editor.input().props.value).extra, '不能丢失'); assert.ok(!editor.control());
    editor.json(JSON.stringify(converted)); editor.button('切回表单填写').props.onClick(); editor.render();
    assert.ok(editor.control()); assert.equal(editor.control().props.draft.role, converted.role);
    assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0);
    const duplicate = editor.form().props.onSubmit; duplicate({ preventDefault() {} }); duplicate({ preventDefault() {} }); editor.render();
    assert.deepEqual(props().value, converted);
    assert.equal(context().interactions.controlStates.find(e => e.kind === 'parameter-control')!.state, 'submitted');
    focus('source'); focus('settings'); editor.fresh(); assert.equal(editor.control().props.draft.role, converted.role);
    const staleValue = props(); props().onCommit({ ...converted, count: 2 }, props().sourceKey); ui.render(); editor.render();
    assert.ok(editor.text().includes('参数来源已变化')); assert.throws(() => staleValue.onCommit(converted, staleValue.sourceKey), /来源|接线/);
    editor.button('载入当前练习要求').props.onClick(); editor.render();
    const staleSchema = props(); graphNode().presentation.inputForms.value.fields[3].max = 18; ui.render(); editor.render();
    assert.throws(() => staleSchema.onCommit(converted, staleSchema.sourceKey), /来源|接线/);
    assert.equal((editor.control() ?? editor.input()).props.disabled, true); editor.button('载入当前练习要求').props.onClick(); editor.render();
    const finalValue = { ...converted, count: 0, examples: false };
    props().onCommit(finalValue, props().sourceKey); ui.render();
    ui.button('运行所选步骤').props.onClick();
    for (let i = 0; i < 30 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
    const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded');
    const artifact = host.currentArtifact(run.nodes.find(n => n.nodeId === 'settings')!.artifactIds[0]);
    assert.equal(artifact.payload.kind, 'inline'); if (artifact.payload.kind === 'inline') assert.deepEqual(JSON.parse(artifact.payload.value as string), finalValue);
    const oldLink = props(); ui.button('清除输入 value').props.onClick(); ui.render();
    ui.flow().props.onConnect({ source: 'source', sourceHandle: 'out:value', target: 'settings', targetHandle: 'in:value' }); ui.render();
    assert.equal(props().disabled, true); assert.throws(() => oldLink.onCommit(finalValue, oldLink.sourceKey), /来源|接线/);
    assert.ok(ui.text().includes('材料来自已连接的步骤'));
    focus('observations');
    const ended = ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'observations')!.props;
    ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => ended.onCommit([], ended.sourceKey), /过期/);
    assert.equal(ui.modelCalls(), 0); assert.equal(host.history().length, 1);
  } finally { ui.dispose(); }

  // Unknown-but-valid data is not invalidated by a display form, nor silently erased by it.
  const extraDocument = structuredClone(definition.initial); extraDocument.execution!.nodes[0].bindings.value = { kind: 'literal', value: { extra: null } };
  assert.deepEqual(readS2Document(extraDocument, definition).execution!.nodes[0].bindings.value, { kind: 'literal', value: { extra: null } });
  const fallbackProps = { nodeId: 'fallback', portId: 'value', formField: field, value: { extra: null } as S2Json, disabled: false, onCommit() { throw new Error('Not expected'); } };
  const fallback = editorHarness(() => fallbackProps); assert.ok(!fallback.control()); assert.deepEqual(JSON.parse(fallback.input().props.value), { extra: null });
  const optional: S2Field = { id: 'value', label: '可以开始填写', kind: 'form', fields: [{ id: 'name', label: '名称', kind: 'text', required: true }] };
  assert.doesNotThrow(() => forms.s2ParameterFormDraft(optional, undefined), 'Unbound input can start an unfinished form draft without committing anything');
  const helpScopes = [['a-b', 'c'], ['a', 'b-c']].map(([nodeId, portId]) => editorHarness(() => ({
    nodeId, portId, formField: { id: portId, label: '同名材料', kind: 'number' }, value: 0, disabled: false, onCommit() { assert.fail('Descriptions cannot commit'); },
  })).control().props.descriptionId);
  assert.notEqual(helpScopes[0], helpScopes[1], 'Delimiter-like node/port names cannot collide in description/error IDs');
  // Trusted local paths, not label parsing; same labels and selector-like text are harmless.
  const declared: S2Field = forms.readS2ParameterForm({ id: 'value', label: '练习要求', kind: 'form', fields: [
    { id: 'count', label: '同名 ["任意"]', kind: 'number', min: 0, max: 20, integer: true, required: true },
    { id: 'example', label: '同名 ["任意"]', kind: 'boolean', required: true },
    { id: 'cases', label: '检查清单', kind: 'list', minItems: 1, maxItems: 3, item: { id: 'case', label: '数量', kind: 'number', required: true, min: 0 } },
    { id: 'rows', label: '对照表', kind: 'table', minItems: 1, columns: [
      { id: 'score', label: '分数', type: 'number', required: true }, { id: 'note', label: '备注', type: 'string', nullable: true },
    ] }, { id: 'json', label: '补充内容', kind: 'json' },
  ] }, 'value');
  const valid = { count: 0, example: false, cases: [0], rows: [{ score: 0, note: null }], json: {} };
  const validDraft = forms.s2ParameterFormDraft(declared, valid) as Record<string, any>;
  const issueCases: Array<[any, Array<string | number>]> = [
    [{ ...validDraft, count: '-' }, ['fields', 'count']],
    [{ ...validDraft, count: '21' }, ['fields', 'count']],
    [{ ...validDraft, example: '' }, ['fields', 'example']],
    [{ ...validDraft, cases: [] }, ['fields', 'cases', 'add']],
    [{ ...validDraft, cases: ['-'] }, ['fields', 'cases', 'items', 0]],
    [{ ...validDraft, rows: [] }, ['fields', 'rows', 'add']],
    [{ ...validDraft, rows: [{ score: { state: 'missing', text: '' }, note: { state: 'null', text: '' } }] }, ['fields', 'rows', 'cells', 0, 'score', 'state']],
    [{ ...validDraft, rows: [{ score: { state: 'value', text: '-' }, note: { state: 'null', text: '' } }] }, ['fields', 'rows', 'cells', 0, 'score', 'text']],
    [{ ...validDraft, json: '{' }, ['fields', 'json']],
  ];
  for (const [draft, target] of issueCases) {
    let error: unknown;
    try { forms.submitS2ParameterForm(declared, draft); } catch (caught) { error = caught; }
    assert.ok(error); const issue = controlIssues.s2ControlIssue(error)!;
    assert.equal(issue.control, controlIssues.s2ControlTarget(target));
    assert.equal(controlIssues.s2ControlIssue(new Error(issue.message)), undefined, 'Matching text does not create trusted evidence');
    let commits = 0;
    const props = { nodeId: 'declared', portId: 'value', formField: declared, value: valid, disabled: false, drafts: new Map(), onCommit() { commits++; } };
    const editor = editorHarness(() => props, true);
    editor.draft(draft); editor.submit(); assert.equal(commits, 0);
    assert.equal(editor.focusLog.at(-1), issue.control);
    const invalidControls = editor.native().filter(e => ['input', 'select', 'textarea', 'button'].includes(e.type) && e.props['aria-invalid']);
    assert.equal(invalidControls.length, 1); assert.equal(invalidControls[0].props['data-s2-simple-control'], issue.control);
    for (const id of invalidControls[0].props['aria-describedby'].split(' ')) assert.ok(editor.native().some(e => e.props.id === id), 'Input has accessible requirements and inline reason');
    editor.fresh(); editor.button('定位填写问题').props.onClick(); assert.equal(editor.focusLog.at(-1), issue.control);
    editor.draft(validDraft); assert.ok(!editor.control().props.issue); assert.ok(!editor.text().includes('定位填写问题'));
    editor.submit(); assert.equal(commits, 1);
  }
  // Old callbacks may neither alter a newer draft nor move focus after mode/source/schema changes.
  const guardedProps = { nodeId: 'guarded', portId: 'value', formField: declared, value: valid, disabled: false, drafts: new Map(), sourceKey: 'original', onCommit() {} };
  const guarded = editorHarness(() => guardedProps, true);
  guarded.draft(issueCases[0][0]); guarded.submit();
  let oldLocate = guarded.button('定位填写问题').props.onClick, oldChange = guarded.control().props.onChange;
  guarded.draft(validDraft); const beforeStale = guardedProps.drafts.get('["guarded","value"]');
  const countBefore = guarded.focusLog.length; oldLocate(); oldChange(issueCases[0][0]);
  assert.equal(guarded.focusLog.length, countBefore); assert.equal(guardedProps.drafts.get('["guarded","value"]'), beforeStale);
  guarded.draft(issueCases[0][0]); guarded.submit(); oldLocate = guarded.button('定位填写问题').props.onClick;
  oldChange = guarded.control().props.onChange;
  const sourceDraft = guardedProps.drafts.get('["guarded","value"]');
  guardedProps.sourceKey = 'changed'; guarded.render(); oldLocate(); assert.equal(guarded.focusLog.length, countBefore + 1);
  oldChange(validDraft); assert.equal(guardedProps.drafts.get('["guarded","value"]'), sourceDraft, 'A new render retires old input callbacks even if draft identity has not changed');
  assert.ok(!guarded.control().props.issue); assert.ok(!guarded.text().includes('定位填写问题'));
  guardedProps.sourceKey = 'original'; guarded.render(); guardedProps.disabled = true; guarded.render(); oldLocate();
  assert.equal(guarded.focusLog.length, countBefore + 1);
  guardedProps.disabled = false; guarded.render(); guarded.mounted().isConnected = false;
  guarded.button('定位填写问题').props.onClick(); assert.equal(guarded.focusLog.length, countBefore + 1);
  // Host-origin errors, even branded by another caller, must never be promoted to local form guidance.
  let hostError: unknown;
  try { forms.submitS2ParameterForm(declared, issueCases[0][0]); } catch (error) { hostError = error; }
  const hostErrorEditor = editorHarness(() => ({ nodeId: 'host', portId: 'value', formField: declared, value: valid, disabled: false, onCommit() { throw hostError; } }), true);
  hostErrorEditor.submit(); assert.equal(hostErrorEditor.focusLog.length, 0); assert.ok(!hostErrorEditor.control().props.issue);
  assert.ok(!hostErrorEditor.text().includes('定位填写问题'));
  for (const change of ['schema', 'mode', 'reload'] as const) {
    const props = { nodeId: change, portId: 'value', formField: declared, value: valid, disabled: false, drafts: new Map(), onCommit() {} };
    const editor = editorHarness(() => props, true);
    editor.draft(issueCases[0][0]); editor.submit();
    const locate = editor.button('定位填写问题').props.onClick, before = editor.focusLog.length;
    if (change === 'schema') { props.formField = { ...declared, label: '新表单' }; editor.render(); }
    else if (change === 'reload') { editor.button('载入当前练习要求').props.onClick(); editor.render(); }
    else {
      editor.draft(validDraft); editor.button('改用 JSON 编辑（高级）').props.onClick(); editor.render();
      assert.ok(editor.input());
    }
    locate(); assert.equal(editor.focusLog.length, before); assert.ok(!editor.text().includes('定位填写问题'));
  }
  assert.equal(network, 0);
  console.log('S2 parameter forms passed: closed typed metadata and exact native/fallback roundtrips, trusted scalar/list/table/JSON control paths with inline accessible reasons, automatic/manual/remounted focus contract, no text/host-error impersonation, stale draft/render/schema/source/mode/reload/disabled/detached guards, production commit isolation and separate real local stringify result. Synthetic offline only; actual browser focus is separately verified, not model semantics.');
} finally { globalThis.fetch = previous; }
