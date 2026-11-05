import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as simple from '../src/services/scene/sceneS2SimpleValueForm';
import * as forms from '../src/services/scene/sceneS2ParameterForm';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import { S2SimpleValueInput } from '../src/components/scene/S2SimpleValueInput';
import type { S2Json } from '../src/types/sceneS2Plugin';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { assertS2StructuredValue } from '../src/services/scene/sceneS2PluginProtocol';
import { readS2Definition, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { browserTemplateDefinition } from './fixtures/s2-browser-definition';

function editorHarness(props: () => any) {
  let slots: any[] = [], cursor = 0, tree: any;
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2JsonParameter.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require: (id: string) => {
    if (id === 'react') return React;
    if (id.endsWith('S2FieldEditor')) return { S2ControlInput: 'declared-control' };
    if (id.endsWith('S2SimpleValueInput')) return { S2SimpleValueInput: 'simple-control' };
    if (id.endsWith('sceneS2ParameterForm')) return forms;
    if (id.endsWith('sceneS2ControlIssue')) return controlIssues;
    if (id.endsWith('sceneS2SimpleValueForm')) return simple;
    throw new Error(`Unexpected simple parameter dependency ${id}`);
  } });
  const render = () => { cursor = 0; tree = exports.S2JsonParameter(props()); };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null))
    : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('')
    : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
  const button = (label: string) => { const found = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(found, label); return found; };
  const control = () => elements().find(e => e.type === 'simple-control');
  const input = () => elements().find(e => e.type === 'textarea');
  const form = () => elements().find(e => e.type === 'form')!;
  render(); return { render, elements, text, button, control, input, form,
    fresh() { slots = []; render(); },
    draft(value: any) { assert.ok(control()); control().props.onChange(value); render(); },
    json(value: string) { assert.ok(input()); input().props.onChange({ target: { value } }); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
    click(label: string) { button(label).props.onClick(); render(); },
  };
}

let network = 0; const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Simple value forms are local synthetic tests only'); };
try {
  const nativeValues: S2Json[] = ['', '  中文\n{{role}}\t<script>仅文字</script>', 0, -0, 1.25, false, true, null, {},
    { 名称: '', 分数: 0, 已通过: false, 备注: null, 'a/b~c': '原样', '': true }];
  for (const value of nativeValues) assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(value)), value);
  assert.throws(() => simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(undefined)), /尚未填写/);
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft([])), []);
  for (const value of [[[]], { nested: { deeper: {} } }, { rows: [[1]] }, { missing: undefined }, new Date(), { ['长'.repeat(201)]: 1 },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`字段${i}`, i]))]) assert.throws(() => simple.s2SimpleValueDraft(value as S2Json));
  const max = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`字段${i}`, i]));
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(max)), max);
  let getters = 0; const hostile = {};
  Object.defineProperty(hostile, 'private', { enumerable: true, get() { getters++; return 'not read'; } });
  assert.throws(() => simple.s2SimpleValueDraft(hostile)); assert.equal(getters, 0);
  const hidden = {}; Object.defineProperty(hidden, 'kept', { enumerable: false, value: 1 }); assert.throws(() => simple.s2SimpleValueDraft(hidden));
  const symbol = { visible: 1, [Symbol('hidden')]: 2 }; assert.throws(() => simple.s2SimpleValueDraft(symbol));
  for (const name of ['__proto__', 'prototype', 'constructor']) assert.throws(() => simple.s2SimpleValueDraft(Object.fromEntries([[name, 1]])));
  const duplicate = simple.s2SimpleValueDraft({ 名称: '甲' }); duplicate.rows.push({ ...duplicate.rows[0], text: '乙' });
  assert.throws(() => simple.submitS2SimpleValueDraft(duplicate), /名称重复/);
  const missing = simple.s2SimpleValueDraft({ 未填写: 1 }); missing.rows[0].kind = 'missing';
  assert.throws(() => simple.submitS2SimpleValueDraft(missing), /尚未填写/);
  const numeric = simple.s2SimpleValueDraft(0);
  for (const text of ['', ' ', '-', '01', 'NaN', 'Infinity', '1e999', '0x20', '1.']) assert.throws(() => simple.submitS2SimpleValueDraft({ ...numeric, number: text }));
  assert.equal(simple.submitS2SimpleValueDraft({ ...numeric, number: ' 1e2 ' }), 100);
  assert.throws(() => simple.submitS2SimpleValueDraft({ ...simple.s2SimpleValueDraft(false), boolean: '' }), /请选择/);
  assert.throws(() => simple.s2SimpleValueDraft('中'.repeat(9000)), /完整载荷/);
  const changed = simple.s2SimpleValueDraft(''); changed.text = '中'.repeat(9000);
  assert.throws(() => simple.submitS2SimpleValueDraft(changed), /完整载荷/);
  const badDraft = simple.s2SimpleValueDraft(false);
  Object.defineProperty(badDraft, 'boolean', { enumerable: true, get() { getters++; return 'true'; } });
  assert.throws(() => simple.submitS2SimpleValueDraft(badDraft)); assert.equal(getters, 0);

  // The real native controls preserve unfinished values when switching the chosen type.
  let controlDraft = simple.s2SimpleValueDraft('未提交的中文'), disabled = false;
  const inputTree = () => S2SimpleValueInput({ draft: controlDraft, label: '合成材料', disabled, onChange(next) { controlDraft = next; } });
  const nativeElements = (node: any): any[] => Array.isArray(node) ? node.flatMap(nativeElements)
    : node && typeof node === 'object' ? [node, ...nativeElements(node.props?.children)] : [];
  const inputControl = (label: string) => { const element = nativeElements(inputTree()).find(e => e.props?.['aria-label'] === label); assert.ok(element, label); return element; };
  inputControl('合成材料的内容类型').props.onChange({ target: { value: 'number' } });
  inputControl('合成材料的数字').props.onChange({ target: { value: '-' } });
  inputControl('合成材料的内容类型').props.onChange({ target: { value: 'string' } });
  assert.equal(inputControl('合成材料的文字').props.value, '未提交的中文');
  inputControl('合成材料的内容类型').props.onChange({ target: { value: 'number' } }); assert.equal(inputControl('合成材料的数字').props.value, '-');
  disabled = true; inputControl('合成材料的数字').props.onChange({ target: { value: '2' } }); assert.equal(controlDraft.number, '-');

  let value: S2Json | undefined, commits = 0;
  const drafts = new Map(), props: any = { nodeId: 'input', portId: 'value', label: '练习材料', valueForm: true, drafts, disabled: false,
    onCommit(next: S2Json) { commits++; value = next; props.value = next; } };
  const editor = editorHarness(() => props);
  assert.equal(editor.control().props.draft.kind, 'missing'); assert.equal(editor.form().props['aria-label'], '编辑练习材料');
  editor.submit(); assert.equal(commits, 0); assert.match(editor.text(), /尚未填写/);
  editor.draft({ ...editor.control().props.draft, kind: 'string', text: '' }); editor.submit(); assert.equal(value, ''); assert.equal(commits, 1);
  editor.draft(simple.s2SimpleValueDraft(false)); assert.equal(value, ''); editor.submit(); assert.equal(value, false); assert.equal(commits, 2);
  editor.draft(simple.s2SimpleValueDraft(0)); editor.submit(); assert.equal(value, 0); assert.equal(commits, 3);
  editor.draft(simple.s2SimpleValueDraft(null)); editor.submit(); assert.equal(value, null); assert.equal(commits, 4);
  editor.draft({ ...simple.s2SimpleValueDraft(0), number: '-' });
  editor.click('改用 JSON 编辑（高级）'); assert.ok(editor.control()); assert.equal(editor.control().props.draft.number, '-'); assert.equal(commits, 4);
  editor.fresh(); assert.equal(editor.control().props.draft.number, '-', 'Unsubmitted draft survives selection/remount');
  const whole = { 角色: '你是老师\n {{text}}', 数量: 0, 示例: false, 备注: null };
  editor.draft(simple.s2SimpleValueDraft(whole)); editor.click('改用 JSON 编辑（高级）');
  assert.deepEqual(JSON.parse(editor.input().props.value), whole); assert.equal(commits, 4);
  editor.json('{"草稿":'); editor.click('切回常用表单'); assert.equal(editor.input().props.value, '{"草稿":');
  editor.json(JSON.stringify({ ...whole, 不可丢字段: { 更深: { 保留: true } } })); editor.click('切回常用表单');
  assert.ok(editor.input()); assert.deepEqual(JSON.parse(editor.input().props.value).不可丢字段, { 更深: { 保留: true } });
  const formatted = '{ "名称" : "原始排版", "数字":0 }'; editor.json(formatted); editor.click('切回常用表单'); editor.click('改用 JSON 编辑（高级）');
  assert.equal(editor.input().props.value, formatted, 'Lossless roundtrip preserves unchanged JSON draft formatting');
  editor.click('切回常用表单'); editor.draft(simple.s2SimpleValueDraft(whole)); editor.submit(); assert.deepEqual(value, whole); assert.equal(commits, 5);
  const duplicateSubmit = editor.form().props.onSubmit; duplicateSubmit({ preventDefault() {} }); duplicateSubmit({ preventDefault() {} }); assert.equal(commits, 5);
  editor.draft(simple.s2SimpleValueDraft('不会提交')); props.disabled = true; editor.render(); editor.submit(); assert.equal(commits, 5); assert.equal(editor.control().props.disabled, true);
  props.disabled = false; props.value = '新来源'; editor.render(); assert.match(editor.text(), /参数来源已变化/); editor.submit(); assert.equal(commits, 5);
  editor.click('载入当前练习材料'); assert.equal(editor.control().props.draft.text, '新来源');
  const staleChange = editor.control().props.onChange, staleSubmit = editor.form().props.onSubmit, staleSwitch = editor.button('改用 JSON 编辑（高级）').props.onClick;
  editor.draft(simple.s2SimpleValueDraft('当前草稿'));
  staleChange(simple.s2SimpleValueDraft('过期覆盖')); staleSubmit({ preventDefault() {} }); staleSwitch(); editor.render();
  assert.equal(editor.control().props.draft.text, '当前草稿'); assert.equal(commits, 5);
  props.valueForm = false; editor.render(); assert.match(editor.text(), /参数来源已变化/); editor.submit(); assert.equal(commits, 5);
  const declared = editorHarness(() => ({ nodeId: 'declared', portId: 'value', disabled: false, valueForm: true, value: '原样',
    formField: { id: 'value', label: '专属输入', kind: 'text' }, onCommit() { throw new Error('No commits'); } }));
  assert.ok(declared.elements().some(e => e.type === 'declared-control')); assert.ok(!declared.control());
  for (const input of [[{ nested: {} }, 1], { complex: { deeper: { remains: false } } }]) {
    const fallback = editorHarness(() => ({ nodeId: 'advanced', portId: 'value', disabled: false, valueForm: true, value: input, onCommit() {} }));
    assert.ok(!fallback.control()); assert.deepEqual(JSON.parse(fallback.input().props.value), input);
    assert.equal(fallback.input().props.value, JSON.stringify(input, null, 2), 'Ordinary advanced inputs keep readable indentation');
  }
  for (const input of [{ nested: { x: 'a'.repeat(23980) } }, ['a'.repeat(23994)]]) for (const valueForm of [true, false]) {
    assertS2StructuredValue(input); assert.ok(JSON.stringify(input).length <= 24000); assert.ok(JSON.stringify(input, null, 2).length > 24000);
    let applied: S2Json | undefined, applications = 0;
    const fallback = editorHarness(() => ({ nodeId: 'large-advanced', portId: 'value', disabled: false, valueForm, value: input,
      onCommit(next: S2Json) { applications++; applied = next; } }));
    if (fallback.control()) fallback.click('改用 JSON 编辑（高级）');
    assert.ok(!fallback.control()); assert.equal(fallback.input().props.value, JSON.stringify(input));
    fallback.submit(); assert.equal(applications, 1); assert.deepEqual(applied, input, 'Legal nested and array inputs apply intact without editing formatting');
  }
  const off = editorHarness(() => ({ nodeId: 'semantic', portId: 'value', disabled: false, value: {}, onCommit() {} }));
  assert.ok(!off.control()); assert.ok(off.input(), 'Other semantic types retain the original JSON editor unless explicitly enabled');
  const nearLimit = { 一: 'a'.repeat(23990) };
  assert.ok(JSON.stringify(nearLimit, null, 2).length > 24000);
  const limitProps: any = { nodeId: 'limit', portId: 'value', disabled: false, valueForm: true, value: nearLimit, onCommit(next: S2Json) { limitProps.value = next; } };
  const limitEditor = editorHarness(() => limitProps); assert.ok(limitEditor.control());
  limitEditor.submit(); limitEditor.click('改用 JSON 编辑（高级）');
  assert.ok(limitEditor.input().props.value.length <= 24000); assert.deepEqual(JSON.parse(limitEditor.input().props.value), nearLimit);

  // The unchanged native port and real local adapter consume exact data after a separate explicit run.
  const raw = structuredClone(browserTemplateDefinition); delete raw.business;
  raw.plugins = [{ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'stringify' }];
  raw.initial.execution = { version: 1, nodes: [{ id: 'input', ...raw.plugins[0], position: { x: 0, y: 0 },
    bindings: { value: { kind: 'literal', value: simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(whole)) } } }], links: [] };
  const definition = readS2Definition(raw);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)).initial, definition.initial);
  const host = new S2PluginHost('simple-native', definition.plugins); host.setDocument(definition.initial);
  try {
    assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
    const result = await host.enqueueWorkflow(['input']).completion; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
    const artifact = host.currentArtifact(result.nodes[0].artifactIds[0]); assert.equal(artifact.payload.kind, 'inline');
    if (artifact.payload.kind === 'inline') assert.deepEqual(JSON.parse(artifact.payload.value as string), whole);
  } finally { host.close(); }
  assert.equal(network, 0);
  console.log('S2 simple value forms passed: exact native scalar/flat-object roundtrips, omitted/empty/null/false/zero distinctions, Chinese names, closed limits, duplicate/key/getter rejection, lossless advanced fallback, draft/mode/source/disabled lifecycle, declared forms priority and separate real local adapter execution. Synthetic offline only.');
} finally { globalThis.fetch = oldFetch; }
