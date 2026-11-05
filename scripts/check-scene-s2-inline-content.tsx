import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as controls from '../src/services/scene/sceneS2Controls';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import * as controlHints from '../src/services/scene/sceneS2ControlHints';
import type { S2Field } from '../src/types/sceneS2';
import type { S2FieldDrafts } from '../src/components/scene/S2FieldEditor';

globalThis.fetch = async () => assert.fail('Inline field regression must not call models, notes, or network');
type El = { type: any; props: any; children: any[] };
let slots: any[] = [], cursor = 0;
const fakeReact = {
  createElement(type: any, props: any, ...children: any[]): any {
    return typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children };
  },
  useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
  useRef(initial: any) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
};
function load(file: string, dependencies: Record<string, any>) {
  const exported: any = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exported, require: (id: string) => {
    if (id === 'react') return fakeReact;
    const dependency = Object.entries(dependencies).find(([suffix]) => id.endsWith(suffix));
    assert(dependency, `Unexpected dependency: ${id}`); return dependency[1];
  }, console, JSON, Map });
  return exported;
}
const fields = load('src/components/scene/S2FieldEditor.tsx', {
  sceneS2Controls: controls, sceneS2ControlIssue: controlIssues, sceneS2ControlHints: controlHints,
  S2FieldPreview: { S2FieldPreview: (props: any) => ({ type: 'field-preview', props, children: [] }) },
  S2SimpleValueInput: { focusS2SimpleValueIssue() {} },
});
const content = load('src/components/scene/S2ContentNodeView.tsx', {
  '@xyflow/react': { Handle: (props: any) => ({ type: 'handle', props, children: [] }), Position: { Left: 'left', Right: 'right' } },
  S2ArtifactView: { S2ArtifactView: (props: any) => ({ type: 'artifact', props, children: [] }) },
  S2FieldPreview: { S2FieldPreview: (props: any) => ({ type: 'field-preview', props, children: [] }) },
});
const all = (tree: any): El[] => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object'
  ? [tree, ...all(tree.children)] : [];
function event(extra: any = {}) {
  return { defaultPrevented: false, stopped: false, nativeEvent: {}, keyCode: 0, ctrlKey: false, metaKey: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
}
function editor(initial: string, definition: S2Field, variant: 'panel' | 'inline' = 'inline') {
  slots = []; cursor = 0;
  let value = initial, field = definition, disabled = false, failHost = false, done = 0, commits = 0;
  const drafts: S2FieldDrafts = new Map(), states: string[] = [];
  const inside = {}, form = { contains: (target: unknown) => target === inside };
  let tree: El;
  const render = () => {
    cursor = 0;
    tree = fields.S2FieldEditor({ nodeId: 'data', field, value, drafts, disabled, variant,
      onDone() { done++; }, onStateChange(state: string) { states.push(state); }, onSubmit(raw: unknown) {
        if (failHost) throw new Error('Synthetic host rejected the current commit');
        const checked = controls.readS2FieldSubmission(structuredClone(raw), 'data', field, value); value = checked.value; commits++;
      } });
    if (typeof tree.props.ref === 'function') tree.props.ref(form);
    return tree;
  };
  render();
  const input = () => { const found = all(tree).find(item => ['input', 'textarea'].includes(item.type) && item.props['aria-label'] === field.label); assert(found); return found; };
  return {
    get value() { return value; }, get commits() { return commits; }, get done() { return done; }, get tree() { return tree; }, drafts, states, input, render,
    change(next: string) { input().props.onChange({ target: { value: next } }); render(); },
    blur(relatedTarget: unknown = null) { tree.props.onBlur(event({ currentTarget: form, relatedTarget })); render(); },
    key(key: string, extra: any = {}) { const keyboard = event({ key, ...extra }); tree.props.onKeyDown(keyboard); render(); return keyboard; },
    compositionStart() { tree.props.onCompositionStart(); }, compositionEnd() { tree.props.onCompositionEnd(); },
    reload() { const button = all(tree).find(item => item.type === 'button' && item.children.join('') === `载入当前${field.label}`); assert(button); button.props.onClick(); render(); },
    external(next: string, schema = field) { value = next; field = schema; render(); },
    setDisabled(next: boolean) { disabled = next; render(); },
    setHostFailure(next: boolean) { failHost = next; },
    inside,
  };
}
const text = controls.readS2Field({ id: 'content', label: '内容', kind: 'text', required: true, maxLength: 8 });
let ui = editor('初始', text);
assert.equal(all(ui.tree).filter(item => item.type === 'button').length, 0, 'Ordinary inline text has no submit/reload buttons');
assert(!all(ui.tree).some(item => item.props?.role === 'status'), 'Inline typing does not repeat draft status');
assert.equal(ui.input().props.maxLength, 8); assert.equal(ui.input().props.autoFocus, true);
ui.change('已编辑'); ui.blur(ui.inside); assert.equal(ui.commits, 0, 'Focus moving within the same editor does not save');
ui.blur(); assert.equal(ui.value, '已编辑'); assert.equal(ui.commits, 1); assert.equal(ui.done, 1);
assert.equal(ui.drafts.get('["data","content"]')!.state, 'submitted');
ui.change('未保存'); ui.key('Escape'); assert.equal(ui.value, '已编辑'); assert.equal(ui.commits, 1);
assert.equal(ui.drafts.get('["data","content"]')!.draft, '已编辑', 'Escape discards only the current uncommitted draft');
assert.equal(ui.done, 2);

ui = editor('初始', text); ui.change('回车保存');
const shortcut = ui.key('Enter'); assert(shortcut.defaultPrevented); assert(shortcut.stopped); assert.equal(ui.commits, 1);
const alreadySubmitted = ui.tree.props.onBlur; alreadySubmitted(event({ currentTarget: { contains: () => false }, relatedTarget: null }));
assert.equal(ui.commits, 1, 'Shortcut followed by blur cannot submit the same draft twice');
ui = editor('初始', text); ui.change('拼音输入'); ui.compositionStart();
ui.key('Enter'); ui.blur(); assert.equal(ui.commits, 0, 'Composition blocks both shortcuts and focus-leave submission');
ui.compositionEnd(); ui.key('Enter', { nativeEvent: { isComposing: true } }); assert.equal(ui.commits, 0);
ui.key('Enter', { keyCode: 229 }); assert.equal(ui.commits, 0);
ui.key('Enter'); assert.equal(ui.commits, 1);

const multiline = controls.readS2Field({ ...text, kind: 'multiline', maxLength: 100 });
for (const modifier of ['ctrlKey', 'metaKey']) {
  ui = editor('原文', multiline); ui.change('新段落\n下一行');
  assert.equal(ui.key('Enter').defaultPrevented, false); assert.equal(ui.commits, 0, 'Multiline Enter remains a newline');
  ui.key('Enter', { [modifier]: true }); assert.equal(ui.value, '新段落\n下一行'); assert.equal(ui.commits, 1);
}

ui = editor('原值', text); ui.change(''); ui.blur();
assert.equal(ui.commits, 0); assert.equal(ui.done, 0); assert.equal(ui.drafts.get('["data","content"]')!.state, 'invalid');
assert(all(ui.tree).some(item => item.props?.role === 'alert')); ui.render();
assert.equal(ui.drafts.get('["data","content"]')!.draft, '', 'Invalid draft survives remount/re-render');
ui.change('123456789'); ui.blur(); assert.equal(ui.commits, 0, 'Programmatic over-length edits still fail the full local validator');
ui.change('可恢复'); ui.key('Enter'); assert.equal(ui.commits, 1); assert.equal(ui.done, 1);

ui = editor('原值', text); ui.change('我的草稿'); ui.external('外部更改'); ui.blur();
assert.equal(ui.value, '外部更改'); assert.equal(ui.commits, 0); assert.equal(ui.done, 0);
assert.equal(ui.drafts.get('["data","content"]')!.draft, '我的草稿'); assert(ui.input().props.disabled);
ui.reload(); assert.equal(ui.drafts.get('["data","content"]')!.draft, '外部更改');
ui.change('新草稿'); ui.key('Enter'); assert.equal(ui.value, '新草稿');
ui = editor('原值', text); ui.change('保留草稿'); ui.external('原值', { ...text, maxLength: 4 }); ui.blur();
assert.equal(ui.commits, 0); assert.equal(ui.drafts.get('["data","content"]')!.draft, '保留草稿');
ui.reload(); ui.change('适配'); ui.blur(); assert.equal(ui.value, '适配');

ui = editor('原值', text); ui.change('未发出'); const staleBlur = ui.tree.props.onBlur, staleKey = ui.tree.props.onKeyDown;
ui.render(); staleBlur(event({ currentTarget: { contains: () => false }, relatedTarget: null })); staleKey(event({ key: 'Escape' }));
assert.equal(ui.commits, 0); assert.equal(ui.done, 0, 'Stale render callbacks cannot commit or close a newer editor');
ui.setDisabled(true); ui.blur(); ui.key('Escape'); assert.equal(ui.commits, 0); assert.equal(ui.done, 0);
ui.setDisabled(false); ui.setHostFailure(true); ui.key('Enter');
assert.equal(ui.commits, 0); assert.equal(ui.done, 0); assert.equal(ui.drafts.get('["data","content"]')!.draft, '未发出');
ui.setHostFailure(false); ui.change('重试'); ui.blur(); assert.equal(ui.value, '重试'); assert.equal(ui.done, 1);
ui = editor('原值', text, 'panel');
assert(all(ui.tree).some(item => item.type === 'button' && item.props.type === 'submit'));
assert.equal(ui.tree.props.onBlur, undefined, 'Existing panel editors keep explicit submission');

let activations = 0, legacy = '';
const field = { id: 'content', label: '内容', value: '可以选取的原文', definition: multiline, startEdit() { activations++; } };
const node = (extra = {}, fields = [field]) => content.S2ContentNodeView({ data: { title: '内容块', fields, semanticIn: true, semanticOut: true, ...extra } });
let tree = node(), preview = all(tree).find(item => item.props?.className?.includes('s2-content-preview'))!;
assert.equal(preview.props.style.userSelect, 'text');
const click = event(); preview.props.onClick(click); assert(click.stopped); assert.equal(activations, 0, 'Single click cannot open editing or propagate to a node settings panel');
preview.props.onDoubleClick(event()); assert.equal(activations, 1);
preview.props.onKeyDown(event({ key: 'F2' })); assert.equal(activations, 2);
preview.props.onKeyDown(event({ key: 'Enter' })); assert.equal(activations, 3);
preview.props.onDoubleClick(event({ target: { closest: () => ({ tagName: 'BUTTON' }) } })); assert.equal(activations, 3, 'Controls/handles inside a preview cannot activate editing');
all(tree).find(item => item.type === 'strong')!.props.onDoubleClick(event()); assert.equal(activations, 4);
assert.deepEqual(all(tree).filter(item => item.type === 'handle').map(item => item.props.id ?? item.props.type), ['target', 'field:content', 'source']);
for (const blocked of [{ readOnly: true }, { disabled: true }]) {
  tree = node(blocked); const blockedPreview = all(tree).find(item => item.props?.className?.includes('s2-content-preview'))!;
  assert.equal(blockedPreview.props.tabIndex, undefined); blockedPreview.props.onDoubleClick(event()); assert.equal(activations, 4);
}
tree = node({}, [{ ...field, editor: { type: 'injected-editor', props: {}, children: [] } } as any]);
assert(all(tree).some(item => item.type === 'injected-editor')); assert(!all(tree).some(item => item.props?.className?.includes('s2-content-preview')));
tree = node({}, [{ id: 'legacy', label: '旧正文', value: '旧值', edit(next: string) { legacy = next; } } as any]);
all(tree).find(item => item.type === 'textarea')!.props.onChange({ target: { value: '即时保留' } }); assert.equal(legacy, '即时保留');
console.log('S2 inline content passed: actual generic node callbacks and field editor validation, explicit activation, focus-leave/keyboard/IME, escape/current-value restore, required/length errors, conflict/reload, host failure/stale/disabled/duplicate guards, panel and legacy editing unchanged. Synthetic offline callbacks; not browser focus E2E.');
