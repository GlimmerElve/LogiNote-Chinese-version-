import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as controls from '../src/services/scene/sceneS2Controls';
import * as issues from '../src/services/scene/sceneS2ControlIssue';
import * as controlHints from '../src/services/scene/sceneS2ControlHints';
import * as forms from '../src/services/scene/sceneS2ParameterForm';
import { S2ControlInput } from '../src/components/scene/S2FieldEditor';
import { focusS2SimpleValueIssue } from '../src/components/scene/S2SimpleValueInput';
import type { S2Field } from '../src/types/sceneS2';

// Production components with deterministic hooks and inert DOM contract doubles.
// This verifies callback ownership, not native browser focus or React scheduling.
function editor(kind: 'field' | 'human', props: any) {
  let slots: any[] = [], cursor = 0, tree: any, mounted: any, mountedRef: any;
  const focus: string[] = [];
  const React = {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
  };
  const exports: any = {}, name = kind === 'field' ? 'S2FieldEditor' : 'S2HumanInput';
  vm.runInNewContext(ts.transpileModule(readFileSync(`src/components/scene/${name}.tsx`, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require(id: string) {
    if (id === 'react') return React;
    if (id.endsWith('sceneS2Controls')) return controls;
    if (id.endsWith('sceneS2ControlIssue')) return issues;
    if (id.endsWith('sceneS2ControlHints')) return controlHints;
    if (id.endsWith('sceneS2ParameterForm')) return forms;
    if (id.endsWith('S2FieldEditor')) return { S2ControlInput };
    if (id.endsWith('S2SimpleValueInput')) return { focusS2SimpleValueIssue };
    if (id.endsWith('S2ArtifactView')) return { S2ArtifactView: 'artifact' };
    if (id.endsWith('S2FieldPreview')) return { S2FieldPreview: 'preview' };
    throw new Error(`Unexpected dependency ${id}`);
  } });
  const all = (v: any = tree): any[] => Array.isArray(v) ? v.flatMap(child => all(child ?? null)) : v && typeof v === 'object'
    ? [v, ...all(v.children ?? v.props?.children ?? null)] : [];
  const native = (v: any = tree): any[] => Array.isArray(v) ? v.flatMap(child => native(child ?? null)) : v && typeof v === 'object'
    ? typeof v.type === 'function' ? native(v.type(v.props)) : [v, ...native(v.children ?? v.props?.children ?? null)] : [];
  const text = (v: any = tree): string => Array.isArray(v) ? v.map(child => text(child ?? null)).join('') : v && typeof v === 'object'
    ? text(v.children ?? v.props?.children ?? null) : String(v ?? '');
  const button = (label: string) => { const result = all().find(e => e.type === 'button' && text(e) === label); assert.ok(result, label); return result; };
  const attachRef = (ref: any, element: any) => { if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; };
  const render = () => {
    cursor = 0; tree = exports[name](props);
    if (mounted) { mounted.isConnected = false; attachRef(mountedRef, null); }
    const elements: any[] = [], document: any = { activeElement: null };
    const form: any = { isConnected: true, ownerDocument: document, querySelectorAll: () => elements };
    mounted = form;
    const rootForm = all().find(e => e.type === 'form');
    if (!rootForm) return;
    mountedRef = rootForm.props.ref;
    attachRef(mountedRef, form);
    for (const element of native().filter(e => e.props['data-s2-simple-control'])) {
      const control: any = { parentElement: form, getAttribute: (name: string) => element.props[name], closest: () => form,
        matches: (selector: string) => selector === ':disabled' ? !!element.props.disabled : ['input', 'select', 'textarea'].includes(element.type) || element.type === 'button' && element.props.type === 'button',
        scrollIntoView() {}, focus() { document.activeElement = control; focus.push(element.props['data-s2-simple-control']); } };
      elements.push(control);
    }
  };
  const form = () => all().find(e => e.type === 'form');
  const input = () => all().find(e => typeof e.type === 'function' && e.props.field);
  render(); return { props, render, all, native, text, button, form, input, focus, mounted: () => mounted,
    draft(draft: any) { input().props.onChange(draft); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
    fresh() { slots = []; render(); },
  };
}

const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic form navigation has no IO'); };
try {
  const field: S2Field = controls.readS2Field({ id: 'value', label: '练习设置', kind: 'form', fields: [
    { id: 'count', label: '次数', kind: 'number', required: true, min: 0, max: 20 },
    { id: 'off', label: '举例', kind: 'boolean', required: true },
    { id: 'cases', label: '清单', kind: 'list', minItems: 1, item: { id: 'item', label: '内容', kind: 'text', required: true } },
    { id: 'rows', label: '记录', kind: 'table', minItems: 1, columns: [{ id: 'score', label: '分数', type: 'number', required: true }] },
  ] });
  const value = { count: 0, off: false, cases: ['原文'], rows: [{ score: 0 }] }, raw = JSON.stringify(value);
  const valid = forms.s2ParameterFormDraft(field, value) as Record<string, any>;
  const cases: Array<[any, Array<string | number>]> = [
    [{ ...valid, count: '-' }, ['fields', 'count']], [{ ...valid, off: '' }, ['fields', 'off']],
    [{ ...valid, cases: [] }, ['fields', 'cases', 'add']], [{ ...valid, cases: [''] }, ['fields', 'cases', 'items', 0]],
    [{ ...valid, rows: [] }, ['fields', 'rows', 'add']],
    [{ ...valid, rows: [{ score: { state: 'missing', text: '' } }] }, ['fields', 'rows', 'cells', 0, 'score', 'state']],
    [{ ...valid, rows: [{ score: { state: 'value', text: '-' } }] }, ['fields', 'rows', 'cells', 0, 'score', 'text']],
  ];
  const wait = { workflowId: 'run1', id: 'wait1', nodeId: 'ask', revision: 1, capabilityId: 'json', prompt: '填写', artifacts: [], responseForm: field };
  for (const kind of ['field', 'human'] as const) {
    for (const [draft, path] of cases) {
      let calls = 0;
      const props: any = { nodeId: 'source', field, value: raw, wait, disabled: false, drafts: new Map(), onCancel() {}, onSubmit() { calls++; } };
      const ui = editor(kind, props); ui.draft(draft); ui.submit();
      assert.equal(calls, 0); assert.equal(ui.focus.at(-1), issues.s2ControlTarget(path));
      const invalid = ui.native().filter(e => ['input', 'select', 'textarea', 'button'].includes(e.type) && e.props['aria-invalid']);
      assert.equal(invalid.length, 1);
      for (const id of invalid[0].props['aria-describedby'].split(' ')) assert.ok(ui.native().some(e => e.props.id === id));
      ui.fresh(); ui.button('定位填写问题').props.onClick(); assert.equal(ui.focus.at(-1), issues.s2ControlTarget(path));
      const oldLocate = ui.button('定位填写问题').props.onClick, oldChange = ui.input().props.onChange, oldSubmit = ui.form().props.onSubmit;
      ui.draft(valid); const preserved = [...props.drafts.values()][0], before = ui.focus.length;
      oldLocate(); oldChange(draft); oldSubmit({ preventDefault() {} });
      assert.equal(calls, 0); assert.equal(ui.focus.length, before); assert.equal([...props.drafts.values()][0], preserved);
      assert.ok(!ui.input().props.issue); assert.ok(!ui.text().includes('定位填写问题'));
      const submit = ui.form().props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }); ui.render(); assert.equal(calls, 1);
    }
    for (const change of ['source', 'schema', 'disabled', 'detached'] as const) {
      const props: any = { nodeId: 'source', field, value: raw, wait: { ...wait }, disabled: false, drafts: new Map(), onCancel() {}, onSubmit() { assert.fail('Stale submit'); } };
      const ui = editor(kind, props); ui.draft(cases[0][0]); ui.submit();
      const locate = ui.button('定位填写问题').props.onClick, submit = ui.form().props.onSubmit, before = ui.focus.length;
      if (change === 'source') { if (kind === 'field') props.value = '{}'; else props.wait = { ...wait, workflowId: 'run2', id: 'wait2', revision: 2 }; ui.render(); }
      else if (change === 'schema') { if (kind === 'field') props.field = { ...field, label: 'changed' }; else props.wait = { ...wait, responseForm: { ...field, label: 'changed' } }; ui.render(); }
      else if (change === 'disabled') { props.disabled = true; ui.render(); }
      else ui.mounted().isConnected = false;
      locate(); assert.equal(ui.focus.length, before);
      if (change !== 'detached') submit({ preventDefault() {} });
    }
    let hostError: unknown;
    try { forms.submitS2ParameterForm(field, cases[0][0]); } catch (error) { hostError = error; }
    const failed = editor(kind, { nodeId: 'source', field, value: raw, wait, disabled: false, drafts: new Map(), onCancel() {}, onSubmit() { throw hostError; } });
    if (kind === 'human') failed.draft(valid);
    failed.submit(); assert.equal(failed.focus.length, 0); assert.ok(!failed.input().props.issue); assert.ok(!failed.text().includes('定位填写问题'));
    const recovery = editor(kind, { nodeId: 'source', field, value: raw, wait, disabled: false, drafts: new Map(), onCancel() {}, onSubmit() {} });
    recovery.draft(cases[0][0]); recovery.submit();
    const oldLocate = recovery.button('定位填写问题').props.onClick, beforeRecovery = recovery.focus.length;
    if (kind === 'field') { recovery.button('载入当前练习设置').props.onClick(); recovery.render(); }
    else { recovery.draft(valid); recovery.button('改用 JSON 编辑（高级）').props.onClick(); recovery.render(); }
    oldLocate(); assert.equal(recovery.focus.length, beforeRecovery); assert.ok(!recovery.text().includes('定位填写问题'));
  }
  // A new wait on the same mounted component retires EVERY old mutation callback.
  let submitted = 0, cancelled = 0;
  const props: any = { wait, disabled: false, drafts: new Map(), onSubmit() { submitted++; }, onCancel() { cancelled++; } };
  const human = editor('human', props); human.draft(cases[0][0]); human.submit();
  const old = { locate: human.button('定位填写问题').props.onClick, cancel: human.button('取消本次运行（保留已完成记录）').props.onClick,
    change: human.input().props.onChange, submit: human.form().props.onSubmit, toggle: human.button('改用 JSON 编辑（高级）').props.onClick };
  props.wait = { ...wait, workflowId: 'run2', id: 'wait2', revision: 2 }; human.render();
  const before = JSON.stringify([...props.drafts]), focused = human.focus.length;
  old.locate(); old.cancel(); old.change(valid); old.submit({ preventDefault() {} }); old.toggle();
  assert.equal(JSON.stringify([...props.drafts]), before); assert.equal(submitted, 0); assert.equal(cancelled, 0); assert.equal(human.focus.length, focused);
  assert.ok(!human.text().includes('请输入完整值'), 'Old wait errors do not leak into a new wait');
  human.draft(valid); const cancel = human.button('取消本次运行（保留已完成记录）').props.onClick;
  cancel(); cancel(); human.render(); assert.equal(cancelled, 1); assert.equal(submitted, 0);
  assert.ok(human.text().includes('已请求取消'));
  props.wait = { ...wait, workflowId: 'run2', id: 'wait2', revision: 3 }; human.render();
  assert.ok(!human.text().includes('已请求取消'), 'Done/cancelled feedback belongs only to the completed wait');
  human.draft(valid); human.submit(); assert.equal(submitted, 1);
  for (const identity of ['workflowId', 'id', 'revision'] as const) {
    const isolated: any = { wait, disabled: false, drafts: new Map(), onSubmit() { assert.fail('Old wait submit'); }, onCancel() { assert.fail('Old wait cancel'); } };
    const ui = editor('human', isolated); ui.draft(cases[0][0]); ui.submit();
    const locate = ui.button('定位填写问题').props.onClick, cancel = ui.button('取消本次运行（保留已完成记录）').props.onClick;
    isolated.wait = { ...wait, [identity]: identity === 'revision' ? 2 : 'changed' }; ui.render();
    const before = ui.focus.length; locate(); cancel(); assert.equal(ui.focus.length, before);
    assert.ok(!ui.input().props.issue); assert.equal(ui.input().props.draft.count, '', `${identity} alone starts an independent draft`);
  }
  assert.equal(network, 0);
  console.log('S2 field/human issue feedback passed: exact local scalar/list/table paths and accessible reasons, automatic/manual/remounted focus contract, private drafts, unchanged explicit commits, no host-error promotion; stale draft/render/source/schema/mode/disabled/detached isolation and independent workflow/wait/revision ownership with old submit/cancel/change/toggle rejection. Inert DOM doubles, no actual browser or model/IO claim.');
} finally { globalThis.fetch = previous; }
