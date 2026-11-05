import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as simple from '../src/services/scene/sceneS2SimpleValueForm';
import * as forms from '../src/services/scene/sceneS2ParameterForm';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import { assertS2StructuredValue } from '../src/services/scene/sceneS2PluginProtocol';
import { S2SimpleValueInput, focusS2SimpleValueIssue } from '../src/components/scene/S2SimpleValueInput';
import { createS2Scene, readS2Definition, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserRecordFormDefinition, browserRecordFormRequest, browserRecordFormValue, browserGroupFormDefinition, browserGroupFormRequest, browserGroupFormValue, browserListFormDefinition, browserListFormRequest, browserListFormValue, browserMixedListFormValue, browserNamedListFormDefinition, browserNamedListFormRequest, browserNamedListFormValue } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

// Real parameter component/hooks plus the real native record controls; no model or DOM emulation claims.
function editorHarness(props: () => any, mountFocus = false) {
  let slots: any[] = [], cursor = 0, tree: any;
  const focusLog: Array<{ control: string; opened: boolean[] }> = [];
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
    if (id.endsWith('S2FieldEditor')) return { S2ControlInput: 'declared-control' };
    if (id.endsWith('S2SimpleValueInput')) return { S2SimpleValueInput: 'simple-control', focusS2SimpleValueIssue };
    if (id.endsWith('sceneS2SimpleValueForm')) return simple;
    if (id.endsWith('sceneS2ParameterForm')) return forms;
    if (id.endsWith('sceneS2ControlIssue')) return controlIssues;
    throw new Error(`Unexpected record editor dependency ${id}`);
  } });
  const render = () => {
    cursor = 0; tree = exports.S2JsonParameter(props());
    if (!mountFocus) return;
    if (mounted) mounted.isConnected = false;
    const doc: any = { activeElement: null }, controls: any[] = [];
    mounted = { tagName: 'FORM', isConnected: true, ownerDocument: doc, querySelectorAll: () => controls };
    const form = mounted;
    // Inert DOM contract doubles only. Actual native focus/scroll is separately checked in a browser.
    const attach = (value: any, parent: any) => {
      if (Array.isArray(value)) { value.forEach(child => attach(child, parent)); return; }
      if (!value || typeof value !== 'object') return;
      if (value.type === 'simple-control') { attach(S2SimpleValueInput(value.props), parent); return; }
      const element: any = { tagName: String(value.type).toUpperCase(), parentElement: parent, open: false,
        disabled: !!value.props.disabled || !!parent.disabled, closest: () => form, getAttribute: (name: string) => value.props[name] ?? null,
        matches: (selector: string) => selector === ':disabled' ? element.disabled : ['input', 'select', 'textarea'].includes(value.type),
        scrollIntoView() {}, focus() {
          doc.activeElement = element; const opened: boolean[] = [];
          for (let p = parent; p && p !== form; p = p.parentElement) if (p.tagName === 'DETAILS') opened.push(p.open);
          focusLog.push({ control: value.props['data-s2-simple-control'], opened });
        } };
      if (value.props['data-s2-simple-control']) controls.push(element);
      (value.children ?? [value.props.children]).forEach((child: any) => attach(child, element));
    };
    tree.props.ref.current = form; tree.children.forEach((child: any) => attach(child, form));
  };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null))
    : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('')
    : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
  const button = (label: string) => { const found = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(found, label); return found; };
  const control = () => elements().find(e => e.type === 'simple-control');
  const input = () => elements().find(e => e.type === 'textarea');
  const form = () => elements().find(e => e.type === 'form')!;
  const nativeElements = (value: any): any[] => Array.isArray(value) ? value.flatMap(nativeElements)
    : value && typeof value === 'object' ? [value, ...nativeElements(value.props?.children)] : [];
  const native = (label: string) => {
    const found = nativeElements(S2SimpleValueInput(control().props)).find(e => e.props?.['aria-label'] === label
      || e.type === 'button' && e.props.children === label); assert.ok(found, label); return found;
  };
  render(); return { render, text, button, control, input, form, native, focusLog,
    fresh() { if (mountFocus) { mounted.isConnected = false; tree.props.ref.current = null; } slots = []; render(); },
    detach() { mounted.isConnected = false; },
    change(label: string, value: string) { native(label).props.onChange({ target: { value } }); render(); },
    press(label: string) { native(label).props.onClick(); render(); },
    json(value: string) { input().props.onChange({ target: { value } }); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
    click(label: string) { button(label).props.onClick(); render(); },
  };
}
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Record forms use synthetic offline data only'); };
try {
  const values = [[], [{}], [{ 名称: '', 分数: 0, 负零: -0, 通过: false, 备注: null, 'a/b~c': '中文\n{{literal}}' }, { 独有: true }, {}]];
  for (const value of values) assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(value)), value);
  const groupedValues = [{ 第一组: { 名称: '', 数字: 0, 负零: -0, 判断: false, 备注: null, 'a/b~c': '原样' }, 第二组: { 名称: '独立名称' }, 空组: {} },
    [{ 设置: { 数字: 0 } }, { 设置: { 判断: false } }, {}]];
  for (const value of groupedValues) assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(value)), value);
  const maxGroup = { 分组: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, i])) };
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(maxGroup)), maxGroup);
  const nestedAccessor = {}; let nestedReads = 0;
  Object.defineProperty(nestedAccessor, '正文', { enumerable: true, get() { nestedReads++; return 'never'; } });
  for (const value of [{ 分组: nestedAccessor }, { 分组: { 子列表: [[]] } }, { 分组: { 更深: {} } },
    { 分组: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i])) }]) assert.throws(() => simple.s2SimpleValueDraft(value));
  assert.equal(nestedReads, 0);
  const duplicateGroupField = simple.s2SimpleValueDraft({ 分组: { 内容: '' } });
  duplicateGroupField.rows[0].rows!.push({ ...duplicateGroupField.rows[0].rows![0] });
  assert.throws(() => simple.submitS2SimpleValueDraft(duplicateGroupField), /名称重复/);
  const tooDeep = simple.s2SimpleValueDraft({ 分组: { 内容: '' } });
  Object.assign(tooDeep.rows[0].rows![0], { kind: 'object', rows: [] });
  assert.throws(() => simple.submitS2SimpleValueDraft(tooDeep), /分组过深/);
  // The native material can fit its port while the larger UI draft cannot. Fall back whole on load.
  const denseGroups = Array.from({ length: 32 }, () => Object.fromEntries(Array.from({ length: 2 }, (_, g) =>
    [`g${g}`, Object.fromEntries(Array.from({ length: 30 }, (_, f) => [`f${f}`, 'x']))])));
  assertS2StructuredValue(denseGroups); assert.throws(() => simple.s2SimpleValueDraft(denseGroups));
  let denseApplied: unknown;
  const denseEditor = editorHarness(() => ({ nodeId: 'dense', portId: 'value', label: '完整分组材料', value: denseGroups, valueForm: true, disabled: false,
    onCommit(value: unknown) { denseApplied = value; } }));
  assert.ok(denseEditor.input()); assert.deepEqual(JSON.parse(denseEditor.input().props.value), denseGroups);
  denseEditor.submit(); assert.deepEqual(denseApplied, denseGroups);
  const max = Array.from({ length: 32 }, (_, i) => ({ 序号: i }));
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(max)), max);
  let getters = 0; const accessor: any[] = [{}];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { getters++; return {}; } });
  const sparse = new Array(1), extra: any[] = [{}]; Object.assign(extra, { hidden: 1 });
  for (const value of [[[]], [{ nested: { deeper: {} } }], [{ nested: [[]] }], [...max, {}], sparse, extra, accessor,
    [Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i]))]]) assert.throws(() => simple.s2SimpleValueDraft(value));
  assert.equal(getters, 0);
  for (const change of ['duplicate-id', 'bad-id', 'bad-counter', 'duplicate-field', 'missing-field'] as const) {
    const draft = simple.s2SimpleValueDraft([{ a: 0 }, { b: false }]);
    if (change === 'duplicate-id') draft.records![1].id = draft.records![0].id;
    if (change === 'bad-id') draft.records![0].id = 'record-0';
    if (change === 'bad-counter') draft.nextRecordId = 1;
    if (change === 'duplicate-field') draft.records![0].rows.push({ ...draft.records![0].rows[0] });
    if (change === 'missing-field') draft.records![0].rows[0].kind = 'missing';
    assert.throws(() => simple.submitS2SimpleValueDraft(draft));
  }

  // Scalar lists are native arrays, not records with guessed columns or stringified values.
  const scalarLists = [[1], [null], ['', '  中文\n{{literal}}', 0, -0, 1.25, false, true, null], Array.from({ length: 32 }, (_, i) => i)];
  for (const value of scalarLists) {
    const draft = simple.s2SimpleValueDraft(value); assert.equal(draft.kind, 'list');
    assert.deepEqual(simple.submitS2SimpleValueDraft(draft), value);
  }
  assert.equal(simple.s2SimpleValueDraft([]).kind, 'records', 'Old empty record templates keep their existing editor');
  // Object items keep native identity and independent field sets inside ordinary lists.
  const mixedValues = [browserMixedListFormValue, [0, { '': '', 'a/b~c"[]': '原样', 负零: -0 }, {}],
    { 列表: [{ 甲: 0 }, { 乙: false }, {}] }, { 分组: { 列表: [null, { 名称: '', 次数: 0 }, {}] } },
    [{ 分组: { 列表: [false, { 甲: null }] } }, { 列表: [{ 独有: '' }] }]];
  for (const value of mixedValues) assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(value)), value);
  assert.equal(simple.s2SimpleValueDraft(browserMixedListFormValue).kind, 'list');
  assert.equal(simple.s2SimpleValueDraft([{ 甲: 0 }, {}]).kind, 'records', 'Existing all-object root arrays keep their record editor');
  const maxObjectItem = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, i]));
  const maxMixed = [maxObjectItem, ...Array.from({ length: 31 }, () => null)];
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(maxMixed)), maxMixed);
  let objectReads = 0; const objectAccessor = {}, objectHidden = {};
  Object.defineProperty(objectAccessor, '值', { enumerable: true, get() { objectReads++; return 0; } });
  Object.defineProperty(objectHidden, '值', { enumerable: false, value: 0 });
  for (const value of [[0, objectAccessor], [0, objectHidden], [0, JSON.parse('{"__proto__":0}')],
    [0, Object.assign(Object.create({ inherited: 0 }), { own: false })], [0, { 内层: {} }], [0, { 内层: [] }],
    [0, { 内层: { 更深: false } }], [0, { ...maxObjectItem, extra: 0 }],
    { 分组: { 列表: [0, { 内层: [] }] } }]) assert.throws(() => simple.s2SimpleValueDraft(value));
  assert.equal(objectReads, 0);
  for (const issue of ['duplicate', 'missing', 'number', 'nested-object', 'nested-list', 'too-many', 'extra', 'getter'] as const) {
    const draft = simple.s2SimpleValueDraft([0, { 甲: 0, 乙: false }]), item = draft.items![1];
    if (issue === 'duplicate') item.rows![1].name = '甲';
    if (issue === 'missing') item.rows![0].kind = 'missing';
    if (issue === 'number') item.rows![0].number = '-';
    if (issue === 'nested-object') Object.assign(item.rows![0], { kind: 'object', rows: [] });
    if (issue === 'nested-list') Object.assign(item.rows![0], { kind: 'list', items: [], nextItemId: 1 });
    if (issue === 'too-many') item.rows = Array.from({ length: 33 }, (_, i) => ({ ...item.rows![0], name: `f${i}` }));
    if (issue === 'extra') Object.assign(item, { surprise: true });
    if (issue === 'getter') Object.defineProperty(item, 'rows', { enumerable: true, get() { objectReads++; return []; } });
    assert.throws(() => simple.submitS2SimpleValueDraft(draft));
  }
  assert.equal(objectReads, 0);
  const denseObjects = { 甲: Array.from({ length: 30 }, () => structuredClone(maxObjectItem)), 乙: Array.from({ length: 30 }, () => structuredClone(maxObjectItem)) };
  assertS2StructuredValue(denseObjects); assert.throws(() => simple.s2SimpleValueDraft(denseObjects), /超过128000字节/);
  let mixedApplied: unknown;
  const fallbackObject = { 列表: [0, { 保留: { 完整: [false, null, ''] } }] };
  const mixedFallback = editorHarness(() => ({ nodeId: 'mixed-fallback', portId: 'value', valueForm: true, disabled: false,
    value: fallbackObject, onCommit(value: unknown) { mixedApplied = value; } }));
  assert.ok(mixedFallback.input()); mixedFallback.submit(); assert.deepEqual(mixedApplied, fallbackObject);
  const denseMixedEditor = editorHarness(() => ({ nodeId: 'dense-mixed-fallback', portId: 'value', valueForm: true, disabled: false,
    value: denseObjects, onCommit(value: unknown) { mixedApplied = value; } }));
  assert.ok(denseMixedEditor.input()); denseMixedEditor.submit(); assert.deepEqual(mixedApplied, denseObjects);
  const disabledMixedProps = { nodeId: 'disabled-mixed', portId: 'value', label: '混合材料', valueForm: true, disabled: true,
    value: [0, { 名称: '' }], onCommit() { throw Error('Disabled mixed form cannot commit'); } };
  const disabledMixed = editorHarness(() => disabledMixedProps), disabledMixedBefore = structuredClone(disabledMixed.control().props.draft);
  disabledMixed.change('混合材料第2项第1项的文字', '不能写入'); disabledMixed.change('混合材料第2项的内容类型', 'string');
  disabledMixed.press('为混合材料第2项添加一项内容'); disabledMixed.press('删除混合材料第2项'); disabledMixed.submit();
  assert.deepEqual(disabledMixed.control().props.draft, disabledMixedBefore);
  const maxMixedEditor = editorHarness(() => ({ nodeId: 'max-mixed', portId: 'value', label: '混合材料', valueForm: true, disabled: false,
    value: maxMixed, onCommit() { throw Error('Capacity checks do not apply automatically'); } }));
  assert.equal(maxMixedEditor.native('为混合材料添加一个列表项').props.disabled, true);
  assert.equal(maxMixedEditor.native('为混合材料第1项添加一项内容').props.disabled, true);
  maxMixedEditor.press('为混合材料添加一个列表项'); maxMixedEditor.press('为混合材料第1项添加一项内容');
  assert.deepEqual(simple.submitS2SimpleValueDraft(maxMixedEditor.control().props.draft), maxMixed);
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserListFormRequest), definition = structuredClone(browserListFormDefinition);
    definition.initial.execution!.nodes[0].bindings.value = { kind: 'literal', value: structuredClone(browserMixedListFormValue) };
    if (deferStateUpdates) definition.initial.execution!.nodes.forEach(node => { delete node.presentation; });
    scene.canvasWorkspace = readS2Definition(definition);
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
      focus('listSelect');
      const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'listSelect' && e.props.portId === 'value')!.props; };
      const editor = editorHarness(props), prefix = props().label, itemPath = `${prefix}第2项`;
      const choices = (label: string) => editor.native(label).props.children.flat(Infinity).filter((v: any) => v?.type === 'option').map((v: any) => v.props.value);
      assert.ok(choices(`${itemPath}的内容类型`).includes('object'));
      const fieldChoices = choices(`${itemPath}第1项的内容类型`);
      assert.ok(!fieldChoices.includes('object') && !fieldChoices.includes('list') && !fieldChoices.includes('records'));
      editor.change(`${itemPath}第2项的数字`, '-'); editor.submit(); assert.match(editor.text(), /有效数字/);
      assert.deepEqual(props().value, browserMixedListFormValue); assert.equal(host.workflowHistory().length, 0);
      editor.fresh(); assert.equal(editor.native(`${itemPath}第2项的数字`).props.value, '-'); editor.change(`${itemPath}第2项的数字`, '0');
      editor.press(`为${itemPath}添加一项内容`); editor.submit(); assert.match(editor.text(), /尚未填写/);
      editor.change(`${itemPath}第6项的字段名称`, '名称'); editor.change(`${itemPath}第6项的内容类型`, 'string'); editor.submit(); assert.match(editor.text(), /名称重复/);
      editor.change(`${itemPath}第6项的字段名称`, '举例'); editor.change(`${itemPath}第6项的文字`, '我的例子');
      editor.change(`${itemPath}的内容类型`, 'string'); editor.change(`${itemPath}的文字`, '另一份草稿'); editor.change(`${itemPath}的内容类型`, 'object');
      assert.equal(editor.native(`${itemPath}第6项的文字`).props.value, '我的例子');
      const objectId = editor.control().props.draft.items[1].id;
      editor.press(`上移${prefix}第2项`); assert.equal(editor.control().props.draft.items[0].id, objectId);
      assert.equal(editor.native(`${prefix}第1项第6项的文字`).props.value, '我的例子');
      editor.press(`为${prefix}添加一个列表项`); editor.change(`${prefix}第8项的内容类型`, 'object');
      editor.press(`为${prefix}第8项添加一项内容`); editor.change(`${prefix}第8项第1项的内容类型`, 'boolean'); editor.change(`${prefix}第8项第1项的选择`, 'false');
      editor.press(`删除${prefix}第8项`);
      const expected = [{ ...browserMixedListFormValue[1] as object, 举例: '我的例子' }, browserMixedListFormValue[0], ...browserMixedListFormValue.slice(2)];
      assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      editor.click('改用 JSON 编辑（高级）'); const formatted = JSON.stringify(expected, null, 1); editor.json(formatted); editor.click('切回常用表单');
      assert.equal(editor.control().props.draft.items[0].id, objectId); editor.click('改用 JSON 编辑（高级）'); assert.equal(editor.input().props.value, formatted);
      editor.click('切回常用表单'); assert.deepEqual(props().value, browserMixedListFormValue); assert.equal(host.remainingCalls, 64);
      editor.submit(); assert.deepEqual(props().value, expected); assert.equal(host.workflowHistory().length, 0);
      assert.ok(!JSON.stringify(props().value).includes('item-')); focus('listView'); ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const result = host.workflowHistory().at(-1)!; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
      const output = host.currentArtifact(result.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, expected);
      focus('listSelect'); editor.fresh(); ui.keyShortcut('undo'); ui.render(); editor.render(); assert.match(editor.text(), /参数来源已变化/); editor.submit(); assert.deepEqual(props().value, browserMixedListFormValue);
      ui.keyShortcut('redo'); ui.render(); editor.render(); assert.deepEqual(props().value, expected);
      const ended = props(); ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => ended.onCommit(expected, ended.sourceKey), /过期/);
      assert.equal(host.workflowHistory().length, 1); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }
  for (const value of [Array.from({ length: 33 }, (_, i) => i), [undefined], [NaN], [Infinity], [[1]], [1, { nested: {} }], [null, []]]) assert.throws(() => simple.s2SimpleValueDraft(value as any));
  for (const change of ['duplicate-id', 'bad-id', 'bad-counter', 'missing', 'nested', 'extra', 'too-many'] as const) {
    const draft = simple.s2SimpleValueDraft([0, false]);
    if (change === 'duplicate-id') draft.items![1].id = draft.items![0].id;
    if (change === 'bad-id') draft.items![0].id = 'record-1';
    if (change === 'bad-counter') draft.nextItemId = 1;
    if (change === 'missing') draft.items![0].kind = 'missing';
    if (change === 'nested') Object.assign(draft.items![0], { kind: 'object', rows: [{ name: 'deeper', ...simple.emptyS2SimpleScalar(), kind: 'object', rows: [] }] });
    if (change === 'extra') Object.assign(draft.items![0], { extra: true });
    if (change === 'too-many') draft.items = Array.from({ length: 33 }, () => draft.items![0]);
    assert.throws(() => simple.submitS2SimpleValueDraft(draft));
  }
  const listAccessor = [0]; let listReads = 0;
  Object.defineProperty(listAccessor, '0', { enumerable: true, get() { listReads++; return 1; } });
  assert.throws(() => simple.s2SimpleValueDraft(listAccessor)); assert.equal(listReads, 0);
  const listProps: any = { nodeId: 'list-bounds', portId: 'value', label: '列表材料', valueForm: true, value: [0], disabled: false, onCommit(value: unknown) { listProps.value = value; } };
  const bounds = editorHarness(() => listProps);
  bounds.change('列表材料的内容类型', 'list'); bounds.press('添加一个列表项');
  bounds.submit(); assert.match(bounds.text(), /尚未填写/); assert.equal(bounds.control().props.draft.items.length, 2);
  bounds.press('删除列表材料第2项'); bounds.press('删除列表材料第1项'); bounds.submit();
  assert.equal(bounds.control().props.draft.kind, 'list'); assert.deepEqual(simple.submitS2SimpleValueDraft(bounds.control().props.draft), []);
  for (let i = 0; i < 32; i++) bounds.press('添加一个列表项');
  assert.equal(bounds.native('添加一个列表项').props.disabled, true); bounds.press('添加一个列表项'); assert.equal(bounds.control().props.draft.items.length, 32);
  assert.equal(bounds.native('上移列表材料第1项').props.disabled, true); assert.equal(bounds.native('下移列表材料第32项').props.disabled, true);
  const beforeDisabled = structuredClone(bounds.control().props.draft); listProps.disabled = true; bounds.render();
  bounds.press('删除列表材料第1项'); bounds.press('下移列表材料第1项'); bounds.change('列表材料第1项的内容类型', 'null');
  assert.deepEqual(bounds.control().props.draft, beforeDisabled);
  for (const unsupported of [[{ nested: {} }, 0], [[0]], Array.from({ length: 33 }, (_, i) => i)]) {
    let applied: unknown;
    const fallback = editorHarness(() => ({ nodeId: 'unsupported-list', portId: 'value', valueForm: true, disabled: false, value: unsupported, onCommit(value: unknown) { applied = value; } }));
    assert.ok(fallback.input()); fallback.submit(); assert.deepEqual(applied, unsupported);
  }
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserListFormRequest); scene.canvasWorkspace = readS2Definition(browserListFormDefinition, { requireBusiness: true });
    // No presentation aliases are required for automatic ordinary-port forms.
    if (deferStateUpdates) scene.canvasWorkspace.initial.execution!.nodes.forEach(node => { delete node.presentation; });
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
      focus('listSelect');
      const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'listSelect' && e.props.portId === 'value')!.props; };
      const editor = editorHarness(props), label = props().label;
      assert.equal(editor.control().props.draft.kind, 'list');
      const stale = editor.native(`${label}第1项的文字`).props.onChange;
      editor.change(`${label}第1项的文字`, '我的列表'); stale({ target: { value: '过期覆盖' } }); editor.render();
      assert.equal(editor.native(`${label}第1项的文字`).props.value, '我的列表');
      editor.change(`${label}第2项的数字`, '-'); editor.submit(); assert.deepEqual(props().value, browserListFormValue);
      editor.click('改用 JSON 编辑（高级）'); assert.ok(editor.control()); editor.fresh(); assert.equal(editor.native(`${label}第2项的数字`).props.value, '-');
      editor.change(`${label}第2项的数字`, '0'); editor.press('添加一个列表项');
      editor.change(`${label}第6项的内容类型`, 'number'); editor.change(`${label}第6项的数字`, '2');
      editor.change(`${label}第6项的内容类型`, 'string'); editor.change(`${label}第6项的文字`, '未应用的文字');
      editor.change(`${label}第6项的内容类型`, 'number'); assert.equal(editor.native(`${label}第6项的数字`).props.value, '2');
      editor.press(`上移${label}第6项`); editor.press(`删除${label}第6项`);
      const expected = ['我的列表', 0, false, null, 2], ids = editor.control().props.draft.items.map((item: any) => item.id);
      assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      editor.click('改用 JSON 编辑（高级）'); const formatted = '[ "我的列表", 0, false, null, 2 ]'; editor.json(formatted);
      editor.click('切回常用表单'); assert.deepEqual(editor.control().props.draft.items.map((item: any) => item.id), ids);
      editor.click('改用 JSON 编辑（高级）'); assert.equal(editor.input().props.value, formatted);
      editor.json('["未完成",'); editor.click('切回常用表单'); assert.equal(editor.input().props.value, '["未完成",');
      editor.json('["文字",{"更深":{}}]'); editor.click('切回常用表单'); assert.ok(editor.input()); assert.deepEqual(JSON.parse(editor.input().props.value), ['文字', { 更深: {} }]);
      editor.json(formatted); editor.click('切回常用表单');
      assert.deepEqual(props().value, browserListFormValue); assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
      const submit = editor.form().props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }); editor.render();
      assert.deepEqual(props().value, expected); assert.equal(host.remainingCalls, 64); assert.ok(!JSON.stringify(props().value).includes('item-'));
      focus('listView'); ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const result = host.workflowHistory().at(-1)!; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
      const output = host.currentArtifact(result.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, expected);
      focus('listSelect'); editor.fresh(); assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      ui.keyShortcut('undo'); ui.render(); editor.render(); assert.match(editor.text(), /参数来源已变化/); assert.deepEqual(props().value, browserListFormValue);
      editor.submit(); assert.deepEqual(props().value, browserListFormValue); ui.keyShortcut('redo'); ui.render(); editor.render(); assert.deepEqual(props().value, expected);
      assert.equal(host.remainingCalls, 63); assert.equal(host.workflowHistory().length, 1);
      const ended = props(); ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => ended.onCommit(expected, ended.sourceKey), /过期/); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }

  const namedValues = [{ 主题: [], 分组: { 例子: ['', 0, -0, false, true, null, '中文\n{{literal}}'] }, 其他: null },
    [{ 主题: ['第一条'], 分组: { 例子: [] } }, { 主题: [], 独有: false }], { '': [], 'a/b~c': [0] }];
  for (const value of namedValues) assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(value)), value);
  const maxNamed = { 列表: Array.from({ length: 32 }, (_, i) => i) };
  assert.deepEqual(simple.submitS2SimpleValueDraft(simple.s2SimpleValueDraft(maxNamed)), maxNamed);
  let namedReads = 0; const namedAccessor = [0];
  Object.defineProperty(namedAccessor, '0', { enumerable: true, get() { namedReads++; return 0; } });
  const namedHidden = [0]; Object.defineProperty(namedHidden, '0', { enumerable: false, value: 0 });
  const namedExtra = [0]; Object.assign(namedExtra, { extra: false });
  for (const value of [namedAccessor, namedHidden, namedExtra, new Array(1), Array.from({ length: 33 }, () => 0), [[]], [{ nested: {} }], [null, { nested: [] }], [undefined], [NaN]]) {
    for (const wrap of [(v: any) => ({ 列表: v }), (v: any) => [{ 分组: { 列表: v } }]]) assert.throws(() => simple.s2SimpleValueDraft(wrap(value)));
  }
  assert.equal(namedReads, 0);
  for (const issue of ['duplicate', 'counter', 'missing', 'extra', 'nested', 'getter'] as const) {
    const draft = simple.s2SimpleValueDraft({ 知识点: [0, false] }), row = draft.rows[0];
    if (issue === 'duplicate') row.items![1].id = row.items![0].id;
    if (issue === 'counter') row.nextItemId = 1;
    if (issue === 'missing') row.items![0].kind = 'missing';
    if (issue === 'extra') Object.assign(row.items![0], { extra: true });
    if (issue === 'nested') Object.assign(row.items![0], { kind: 'list', items: [] });
    if (issue === 'getter') Object.defineProperty(row, 'items', { enumerable: true, get() { namedReads++; return []; } });
    assert.throws(() => simple.submitS2SimpleValueDraft(draft));
  }
  assert.equal(namedReads, 0);
  // Native value fits the unchanged port, but metadata for 1,920 scalar items must fall back whole.
  const denseNamed = Array.from({ length: 32 }, () => ({ 甲: Array.from({ length: 30 }, () => 0), 乙: Array.from({ length: 30 }, () => false) }));
  assertS2StructuredValue(denseNamed); assert.throws(() => simple.s2SimpleValueDraft(denseNamed));
  const tooManyNamed = Array.from({ length: 32 }, () => ({ 甲: Array.from({ length: 32 }, () => 0), 乙: Array.from({ length: 32 }, () => 0), 丙: Array.from({ length: 32 }, () => 0) }));
  assert.throws(() => simple.s2SimpleValueDraft(tooManyNamed), /元素过多/, 'Native entry budget is checked incrementally before full UI metadata expansion');
  for (const value of [denseNamed, { 列表: [[0]] }, { 分组: { 列表: [{ 嵌套: {} }] } }]) {
    let applied: unknown;
    const fallback = editorHarness(() => ({ nodeId: 'named-fallback', portId: 'value', valueForm: true, disabled: false, value, onCommit(next: unknown) { applied = next; } }));
    assert.ok(fallback.input()); fallback.submit(); assert.deepEqual(applied, value);
  }
  for (const asRecords of [false, true]) for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserNamedListFormRequest), definition = structuredClone(browserNamedListFormDefinition);
    const original = asRecords ? [structuredClone(browserNamedListFormValue), { 独有: '第二条不变', 知识点: ['独立列表'], 练习设置: { 参考例子: [] } }] : structuredClone(browserNamedListFormValue);
    definition.initial.execution!.nodes[0].bindings.value = { kind: 'literal', value: original };
    if (deferStateUpdates) definition.initial.execution!.nodes.forEach(node => { delete node.presentation; });
    scene.canvasWorkspace = readS2Definition(definition);
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
      focus('listSelect');
      const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'listSelect' && e.props.portId === 'value')!.props; };
      const editor = editorHarness(props), prefix = props().label + (asRecords ? '第1条记录' : '');
      const points = `${prefix}第2项的列表`, examples = `${prefix}第3项第1项的列表`;
      const row = () => asRecords ? editor.control().props.draft.records[0].rows[1] : editor.control().props.draft.rows[1];
      assert.equal(row().kind, 'list');
      const nativeItems = editor.native(`${points}第1项的内容类型`).props.children.flat(Infinity).filter((item: any) => item?.type === 'option').map((item: any) => item.props.value);
      assert.ok(nativeItems.includes('object') && !nativeItems.includes('list') && !nativeItems.includes('records'), 'List items may contain scalar-only named fields, not nested lists or records');
      const stale = editor.native(`${points}第1项的文字`).props.onChange;
      editor.change(`${points}第1项的文字`, '我的知识点'); stale({ target: { value: '旧回调覆盖' } }); editor.render();
      assert.equal(editor.native(`${points}第1项的文字`).props.value, '我的知识点');
      editor.change(`${points}第2项的数字`, '-'); editor.submit(); assert.match(editor.text(), /知识点/); assert.deepEqual(props().value, original);
      editor.click('改用 JSON 编辑（高级）'); assert.ok(editor.control()); editor.fresh(); assert.equal(editor.native(`${points}第2项的数字`).props.value, '-');
      editor.change(`${points}第2项的数字`, '0');
      editor.press(`为${points}添加一个列表项`); editor.submit(); assert.match(editor.text(), /尚未填写/);
      editor.change(`${points}第6项的内容类型`, 'string'); editor.change(`${points}第6项的文字`, '新增知识点');
      for (let n = 6; n > 1; n--) editor.press(`上移${points}第${n}项`);
      editor.press(`为${examples}添加一个列表项`); editor.change(`${examples}第1项的内容类型`, 'string'); editor.change(`${examples}第1项的文字`, '形象例子');
      // Type changes hide rather than destroy private list drafts.
      editor.change(`${prefix}第2项的内容类型`, 'string'); editor.change(`${prefix}第2项的文字`, '另一份草稿'); editor.change(`${prefix}第2项的内容类型`, 'list');
      assert.equal(editor.native(`${points}第1项的文字`).props.value, '新增知识点');
      editor.press(`为${examples}添加一个列表项`); editor.press(`删除${examples}第2项`);
      const expectedObject = { ...browserNamedListFormValue, 知识点: ['新增知识点', '我的知识点', 0, false, null, ''], 练习设置: { 参考例子: ['形象例子'], 需要提示: false } };
      const expected = asRecords ? [expectedObject, (original as any[])[1]] : expectedObject, ids = row().items.map((item: any) => item.id);
      assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      editor.click('改用 JSON 编辑（高级）'); const formatted = JSON.stringify(expected, null, 1); editor.json(formatted); editor.click('切回常用表单');
      assert.deepEqual(row().items.map((item: any) => item.id), ids); editor.click('改用 JSON 编辑（高级）'); assert.equal(editor.input().props.value, formatted);
      editor.json(JSON.stringify({ 知识点: ['普通项', { 嵌套: {} }] })); editor.click('切回常用表单'); assert.ok(editor.input()); assert.deepEqual(JSON.parse(editor.input().props.value), { 知识点: ['普通项', { 嵌套: {} }] });
      editor.json(formatted); editor.click('切回常用表单');
      assert.deepEqual(props().value, original); assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
      const commit = editor.form().props.onSubmit; commit({ preventDefault() {} }); commit({ preventDefault() {} }); editor.render();
      assert.deepEqual(props().value, expected); assert.equal(host.remainingCalls, 64); assert.ok(!JSON.stringify(props().value).includes('item-'));
      focus('listView'); ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const result = host.workflowHistory().at(-1)!; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
      const output = host.currentArtifact(result.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, expected);
      focus('listSelect'); editor.fresh(); assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      ui.keyShortcut('undo'); ui.render(); editor.render(); assert.match(editor.text(), /参数来源已变化/); editor.submit(); assert.deepEqual(props().value, original);
      ui.keyShortcut('redo'); ui.render(); editor.render(); assert.deepEqual(props().value, expected); assert.equal(host.workflowHistory().length, 1); assert.equal(host.remainingCalls, 63);
      const ended = props(); ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => ended.onCommit(expected, ended.sourceKey), /过期/); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }

  const notATable = structuredClone(browserRecordFormDefinition);
  notATable.initial.execution!.nodes.find(node => node.id === 'recordRows')!.bindings.value = { kind: 'literal', value: browserListFormValue };
  const incompatible = readS2Definition(notATable), incompatibleHost = new S2PluginHost('list-is-not-table', incompatible.plugins);
  try {
    incompatibleHost.setDocument(incompatible.initial);
    const result = await incompatibleHost.enqueueWorkflow(['recordView']).completion;
    assert.equal(result.status, 'failed'); assert.equal(incompatibleHost.remainingCalls, 63);
    assert.equal(result.nodes.find(node => node.nodeId === 'recordRows')!.artifactIds.length, 0);
    assert.deepEqual(incompatible.initial.execution!.nodes[0].bindings.value, { kind: 'literal', value: browserListFormValue });
    assert.equal(incompatibleHost.workflowHistory().length, 1, 'No implicit retry, flattening or conversion to invented columns');
  } finally { incompatibleHost.close(); }
  const definition = readS2Definition(browserRecordFormDefinition);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)).initial, definition.initial);
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserRecordFormRequest); scene.canvasWorkspace = definition;
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
      focus('recordRows');
      const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'recordRows')!.props; };
      const editor = editorHarness(props), label = props().label;
      const field = (record: number, item: number, suffix: string) => `${label}第${record}条记录第${item}项的${suffix}`;
      assert.equal(editor.control().props.draft.kind, 'records');
      const stale = editor.native(field(1, 1, '文字')).props.onChange;
      editor.change(field(1, 1, '文字'), '我的中文记录'); stale({ target: { value: '过期覆盖' } }); editor.render();
      assert.equal(editor.native(field(1, 1, '文字')).props.value, '我的中文记录');
      editor.change(field(1, 2, '数字'), '-'); editor.click('改用 JSON 编辑（高级）');
      assert.ok(editor.control()); assert.equal(editor.native(field(1, 2, '数字')).props.value, '-');
      editor.fresh(); assert.equal(editor.native(field(1, 2, '数字')).props.value, '-');
      editor.submit(); assert.deepEqual(props().value, browserRecordFormValue); assert.equal(host.remainingCalls, 64);
      editor.change(field(1, 2, '数字'), '0');
      editor.press('添加一条记录'); editor.press(`为${label}第3条记录添加一项内容`);
      editor.change(field(3, 1, '字段名称'), '姓名'); editor.change(field(3, 1, '内容类型'), 'string'); editor.change(field(3, 1, '文字'), '新增记录');
      editor.press(`上移${label}第3条记录`); editor.press(`删除${label}第3条记录`);
      editor.press(`为${label}第2条记录添加一项内容`); editor.press(`删除${label}第2条记录第2项`);
      const expected = [{ ...browserRecordFormValue[0], 姓名: '我的中文记录' }, { 姓名: '新增记录' }];
      assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      const ids = editor.control().props.draft.records.map((r: any) => r.id);
      editor.click('改用 JSON 编辑（高级）'); assert.deepEqual(JSON.parse(editor.input().props.value), expected);
      const formatting = '[ ' + JSON.stringify(expected[0]) + ',\n ' + JSON.stringify(expected[1]) + ' ]';
      editor.json(formatting); editor.click('切回常用表单'); assert.deepEqual(editor.control().props.draft.records.map((r: any) => r.id), ids);
      editor.click('改用 JSON 编辑（高级）'); assert.equal(editor.input().props.value, formatting);
      editor.json('[{"未完成":'); editor.click('切回常用表单'); assert.equal(editor.input().props.value, '[{"未完成":');
      const nested = [{ ...expected[0], 嵌套: { 更深: { 不可裁剪: false } } }];
      editor.json(JSON.stringify(nested)); editor.click('切回常用表单'); assert.deepEqual(JSON.parse(editor.input().props.value), nested);
      editor.json(formatting); editor.click('切回常用表单');
      assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0); assert.deepEqual(props().value, browserRecordFormValue);
      const submit = editor.form().props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }); editor.render();
      assert.deepEqual(props().value, expected); assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
      assert.ok(!JSON.stringify(props().value).includes('record-'));
      focus('notes'); focus('recordRows'); editor.fresh(); assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      focus('recordView'); ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
      const artifact = host.currentArtifact(run.nodes.find(n => n.nodeId === 'recordRows')!.artifactIds[0]);
      assert.equal(artifact.payload.kind, 'inline'); if (artifact.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(artifact.payload.value as unknown as S2Table), expected);
      ui.keyShortcut('undo'); ui.render(); focus('recordRows'); editor.render();
      assert.deepEqual(props().value, browserRecordFormValue); assert.match(editor.text(), /参数来源已变化/);
      assert.equal(host.remainingCalls, 63); assert.equal(host.workflowHistory().length, 1);
      editor.submit(); assert.deepEqual(props().value, browserRecordFormValue);
      ui.keyShortcut('redo'); ui.render(); editor.render(); assert.deepEqual(props().value, expected);
      assert.equal(host.workflowHistory().length, 1); assert.equal(host.remainingCalls, 63);
      const ended = props(); ui.button('结束试验').props.onClick(); ui.render();
      assert.throws(() => ended.onCommit(expected, ended.sourceKey), /过期/); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserGroupFormRequest); scene.canvasWorkspace = readS2Definition(browserGroupFormDefinition);
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
      focus('groupSelect');
      const props = () => { ui.render(); return ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'groupSelect' && e.props.portId === 'value')!.props; };
      const editor = editorHarness(props), label = props().label;
      const childOptions = editor.native(`${label}第1项第1项的内容类型`).props.children.flat(Infinity).filter((item: any) => item?.type === 'option').map((item: any) => item.props.value);
      assert.ok(!childOptions.includes('object') && !childOptions.includes('records'), 'Child controls cannot build unsupported deeper containers');
      editor.change(`${label}第1项第1项的文字`, '我的分组资料');
      const oldChild = editor.native(`${label}第2项第1项的数字`).props.onChange;
      editor.change(`${label}第2项第1项的数字`, '-'); oldChild({ target: { value: '99' } }); editor.render();
      assert.equal(editor.native(`${label}第2项第1项的数字`).props.value, '-');
      editor.click('改用 JSON 编辑（高级）'); assert.ok(editor.control()); editor.submit();
      assert.deepEqual(props().value, browserGroupFormValue); assert.equal(host.remainingCalls, 64); editor.fresh();
      assert.equal(editor.native(`${label}第2项第1项的数字`).props.value, '-');
      editor.change(`${label}第2项第1项的数字`, '0');
      editor.press(`为${label}添加一项内容`); editor.change(`${label}第4项的字段名称`, '临时分组');
      editor.change(`${label}第4项的内容类型`, 'object'); editor.press(`为${label}第4项添加一项内容`);
      editor.change(`${label}第4项第1项的字段名称`, '保留草稿'); editor.change(`${label}第4项第1项的内容类型`, 'string');
      editor.change(`${label}第4项第1项的文字`, '尚未应用');
      editor.change(`${label}第4项的内容类型`, 'string'); editor.change(`${label}第4项的文字`, '另一种填写');
      editor.change(`${label}第4项的内容类型`, 'object'); assert.equal(editor.native(`${label}第4项第1项的文字`).props.value, '尚未应用');
      editor.press(`删除${label}第4项`); editor.press(`删除${label}第1项第2项`);
      editor.press(`为${label}第2项添加一项内容`); editor.change(`${label}第2项第4项的字段名称`, '用途');
      editor.change(`${label}第2项第4项的内容类型`, 'string'); editor.change(`${label}第2项第4项的文字`, '仅合成任务');
      const expected = { 学习者信息: { 昵称: '我的分组资料' }, 练习设置: { 题量: 0, 需要提示: false, 补充: null, 用途: '仅合成任务' }, 说明: '这些是合成资料' };
      assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      editor.click('改用 JSON 编辑（高级）'); assert.deepEqual(JSON.parse(editor.input().props.value), expected);
      const bad = { ...expected, 其他: { 更深: { 全文: '不能丢失' } } }; editor.json(JSON.stringify(bad)); editor.click('切回常用表单');
      assert.ok(editor.input()); assert.deepEqual(JSON.parse(editor.input().props.value), bad);
      const formatted = JSON.stringify(expected); editor.json(formatted); editor.click('切回常用表单'); editor.click('改用 JSON 编辑（高级）');
      assert.equal(editor.input().props.value, formatted); editor.click('切回常用表单');
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64); assert.deepEqual(props().value, browserGroupFormValue);
      editor.submit(); assert.deepEqual(props().value, expected); assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0);
      focus('groupView'); ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const result = host.workflowHistory().at(-1)!; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, 63);
      const output = host.currentArtifact(result.nodes.find(node => node.nodeId === 'groupSelect')!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, expected.练习设置);
      focus('groupSelect'); editor.fresh(); assert.deepEqual(simple.submitS2SimpleValueDraft(editor.control().props.draft), expected);
      ui.keyShortcut('undo'); ui.render(); editor.render(); assert.deepEqual(props().value, browserGroupFormValue);
      assert.match(editor.text(), /参数来源已变化/); assert.equal(host.remainingCalls, 63); assert.equal(host.workflowHistory().length, 1);
      ui.keyShortcut('redo'); ui.render(); editor.render(); assert.deepEqual(props().value, expected);
      const ended = props(); ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => ended.onCommit(expected, ended.sourceKey), /过期/);
      assert.equal(ui.modelCalls(), 0); assert.equal(host.remainingCalls, 63);
    } finally { ui.dispose(); }
  }
  // Exact locally branded issue paths, independent of Chinese labels, punctuation or error wording.
  const issueCases: Array<{ value: any; edit: (draft: any) => void; path: any[]; depth: number }> = [
    { value: undefined, edit() {}, path: ['kind'], depth: 0 },
    { value: 0, edit(d) { d.number = '-'; }, path: ['number'], depth: 0 },
    { value: false, edit(d) { d.boolean = ''; }, path: ['boolean'], depth: 0 },
    { value: { 'a/b~c"[]': 0 }, edit(d) { d.rows[0].number = ''; }, path: ['rows', 0, 'number'], depth: 0 },
    { value: { 甲: 0, 乙: 1 }, edit(d) { d.rows[1].name = '甲'; }, path: ['rows', 1, 'name'], depth: 0 },
    { value: [0], edit(d) { d.items[0].number = '-'; }, path: ['items', 0, 'number'], depth: 0 },
    { value: [0, { 次数: 0 }], edit(d) { d.items[1].rows[0].number = '-'; }, path: ['items', 1, 'rows', 0, 'number'], depth: 1 },
    { value: [0, { 甲: '', 乙: '' }], edit(d) { d.items[1].rows[1].name = '甲'; }, path: ['items', 1, 'rows', 1, 'name'], depth: 1 },
    { value: { 组: { 清单: [0, { 次数: 0 }] } }, edit(d) { d.rows[0].rows[0].items[1].rows[0].number = '-'; },
      path: ['rows', 0, 'rows', 0, 'items', 1, 'rows', 0, 'number'], depth: 3 },
    { value: [{ 分组: { 列表: [0] } }, { 分组: { 列表: [1] } }], edit(d) { d.records[1].rows[0].rows[0].items[0].number = '-'; },
      path: ['records', 1, 'rows', 0, 'rows', 0, 'items', 0, 'number'], depth: 3 },
  ];
  for (const item of issueCases) {
    const draft = simple.s2SimpleValueDraft(item.value); item.edit(draft); let issueError: unknown;
    try { simple.submitS2SimpleValueDraft(draft); assert.fail('Must reject'); } catch (error) { issueError = error; }
    const issue = simple.s2SimpleValueIssue(issueError)!; assert.ok(issue); assert.equal(issue.control, JSON.stringify(item.path));
    issue.control = 'forged'; assert.equal(simple.s2SimpleValueIssue(issueError)!.control, JSON.stringify(item.path));
    assert.equal(simple.s2SimpleValueIssue(new Error((issueError as Error).message)), undefined);
    assert.equal(simple.s2SimpleValueIssue({ control: JSON.stringify(item.path), message: (issueError as Error).message }), undefined);
    let commits = 0;
    const draftMap = new Map(), p: any = { nodeId: 'issue', portId: 'value', label: '问题材料', value: item.value, drafts: draftMap,
      disabled: false, valueForm: true, onCommit() { commits++; throw new Error('Never commit invalid draft'); } };
    const editor = editorHarness(() => p, true);
    editor.control().props.onChange(draft); editor.render(); editor.submit();
    assert.equal(commits, 0); assert.equal(editor.focusLog.length, 1); assert.equal(editor.focusLog[0].control, JSON.stringify(item.path));
    assert.equal(editor.focusLog[0].opened.length, item.depth); assert.ok(editor.focusLog[0].opened.every(Boolean));
    assert.equal(editor.control().props.issue.control, JSON.stringify(item.path));
    const native = S2SimpleValueInput(editor.control().props);
    const all = (v: any): any[] => Array.isArray(v) ? v.flatMap(all) : v && typeof v === 'object' ? [v, ...all(v.props?.children)] : [];
    const invalidControls = all(native).filter(e => e.props?.['aria-invalid'] === true);
    assert.equal(invalidControls.length, 1); assert.equal(invalidControls[0].props['data-s2-simple-control'], JSON.stringify(item.path));
    assert.ok(all(native).some(e => e.props?.id === invalidControls[0].props['aria-describedby']));
    editor.click('定位填写问题'); assert.equal(editor.focusLog.length, 2); assert.equal(commits, 0);
    const stale = editor.button('定位填写问题').props.onClick;
    editor.render(); stale(); assert.equal(editor.focusLog.length, 2, 'Old render/selection cannot steal focus');
    editor.fresh(); assert.ok(editor.control().props.issue, 'Location survives remount with its private invalid draft'); editor.click('定位填写问题'); assert.equal(editor.focusLog.length, 3);
    const beforeDisable = editor.button('定位填写问题').props.onClick;
    p.disabled = true; editor.render(); beforeDisable(); editor.click('定位填写问题'); assert.equal(editor.focusLog.length, 3);
    p.disabled = false; p.sourceKey = 'changed'; editor.render(); assert.equal(editor.control().props.issue, undefined); beforeDisable(); assert.equal(editor.focusLog.length, 3);
    editor.click('载入当前问题材料'); assert.equal(editor.control().props.issue, undefined); assert.equal(commits, 0);
  }
  const detachedProps: any = { nodeId: 'detach', portId: 'value', valueForm: true, disabled: false, onCommit() { throw Error('No commit'); } };
  const detached = editorHarness(() => detachedProps, true); detached.submit(); const detachLocate = detached.button('定位填写问题').props.onClick;
  const detachedFocuses = detached.focusLog.length; detached.detach(); detachLocate(); assert.equal(detached.focusLog.length, detachedFocuses);
  detached.render(); detached.change('固定内容的内容类型', 'string'); assert.equal(detached.control().props.issue, undefined, 'Editing clears invalid marker/path');
  detached.click('改用 JSON 编辑（高级）'); assert.equal(detached.control(), undefined);
  detached.json('{"未完成":'); detached.submit(); assert.ok(!detached.text().includes('定位填写问题'), 'JSON syntax errors do not guess form fields');
  const hostError = editorHarness(() => ({ nodeId: 'host-error', portId: 'value', value: 0, valueForm: true, disabled: false,
    onCommit() { throw new Error('内容第 1 项：请选择“是”或“否”。'); } }), true);
  hostError.submit(); assert.equal(hostError.focusLog.length, 0); assert.ok(!hostError.control().props.issue, 'Host text cannot impersonate local form validation');
  const structure = simple.s2SimpleValueDraft([0]); structure.items![0].id = 'bad';
  try { simple.submitS2SimpleValueDraft(structure); assert.fail(); } catch (error) { assert.equal(simple.s2SimpleValueIssue(error), undefined); }
  assert.equal(network, 0);
  console.log('S2 mixed object list items passed: scalar-only named fields, independent native values and empty objects in root/named/group/record lists; 32-item/field, descriptor/depth/whole-draft bounds; real controls add/delete/reorder/type drafts, incomplete/duplicate/number focus; ordinary/deferred production apply and separate local run, exact output, source/undo/redo/end, zero model/network. Synthetic offline only.');
  console.log('S2 simple form issue navigation passed: locally branded scalar/name/list/record/group paths, one exact annotated native control, closed ancestors opened without applying; private remount retention and stale-render/source/disabled/detached guards, generic/host/JSON non-inference. Inert DOM doubles only; native focus/scroll checked separately in browser. Zero model/network.');
  console.log('S2 named lists passed: scalar leaves in objects/records/one-level groups, independent and empty lists, exact falsy/-0/order, closed IDs/descriptors/32-item and whole-draft bounds; real native add/delete/reorder/type-retention and lossless JSON fallback; production apply/run/source/undo/redo/end under ordinary/deferred hooks and alias-free defaults, exact real local output, zero model/network. Synthetic offline only.');
  console.log('S2 ordinary lists passed: 32-item native mixed-scalar arrays, exact types/empty/-0/order, safe descriptors and stable closed IDs; actual controls add/delete/reorder, max/disabled/missing guards, private drafts and lossless JSON fallback; production separate apply/run, source conflicts, undo/redo/end with and without aliases, zero model/network. Synthetic offline only.');
  console.log('S2 record forms passed: independent native fields, empty/falsy/null/missing preservation, dense/closed bounds and inert descriptors; real record controls add/delete/reorder, incomplete drafts and stale handlers, form/JSON fallback, formatting and remount; production apply/run/undo/redo/end guards with exact real local table output and no model/network. Synthetic offline only.');
  console.log('S2 grouped materials passed: bounded named object groups and grouped records, native empty/falsy/null/omitted distinctions, 32/33 and depth/getter guards; real child controls, group add/delete/type draft retention, incomplete/stale events, whole JSON fallback; production apply and separate select/view output, source conflict/undo/redo/end without model or network. Synthetic offline only.');
} finally { globalThis.fetch = previous; }
