// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import * as controlHints from '../src/services/scene/sceneS2ControlHints';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as controls from '../src/services/scene/sceneS2Controls';
import { S2FieldEditor, S2ControlInput, type S2FieldDrafts } from '../src/components/scene/S2FieldEditor';
import { applyS2Commands, createS2Scene, designS2Canvas, readS2Definition, exportS2Workspace, importS2Workspace, interactS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Controls regression forbids network'); };
const field = controls.readS2Field({ id: 'settings', label: '试验设置', kind: 'form', required: true, fields: [
  { id: 'count', label: '次数', kind: 'number', min: 1, max: 8, integer: true, required: true },
  { id: 'format', label: '格式', kind: 'enum', options: ['JSON', '纯文本'], required: true },
  { id: 'example', label: '举例', kind: 'boolean', required: true },
  { id: 'cases', label: '样例', kind: 'list', minItems: 1, maxItems: 3, item: { id: 'case', label: '样例内容', kind: 'multiline', maxLength: 100, required: true } },
] });
const raw = JSON.stringify({ count: 2, format: 'JSON', example: false, cases: ['保留\n原文', '<script>text only</script>'] });
let host: S2PluginHost | undefined;
try {
  assert.equal(controls.s2SubmitControlDraft(field, controls.s2ControlDraft(field, raw)), raw);
  const invalid = [
    { ...field, onSubmit: 'fetch()' }, { ...field, fields: [{ id: 'x', label: 'x', kind: 'html' }] },
    { id: 'n', label: 'n', kind: 'number', min: 4, max: 2 }, { id: 'e', label: 'e', kind: 'enum', options: ['a', 'a'] },
    { id: 'l', label: 'l', kind: 'list', maxItems: 33, item: { id: 'i', label: 'i', kind: 'text' } },
    { id: 'b', label: 'b', kind: 'boolean', defaultValue: 'false' },
    { id: 'n', label: 'n', kind: 'number', defaultValue: null },
    { ...field, fields: [field] }, JSON.parse('{"id":"x","label":"x","kind":"text","__proto__":{}}'),
  ];
  invalid.forEach(value => assert.throws(() => controls.readS2Field(value)));
  for (const change of [{ count: 0 }, { count: 1.5 }, { count: '2' }, { format: 'XML' }, { example: 'false' }, { cases: [] }, { extra: true }]) {
    assert.throws(() => controls.validateS2FieldText(field, JSON.stringify({ ...JSON.parse(raw), ...change })));
  }
  assert.throws(() => controls.validateS2FieldText(field, '{}'));
  assert.throws(() => controls.validateS2FieldText(field, '', false));
  assert.equal(controls.validateS2FieldText(field, ''), '', 'An unfinished whole field may remain blank');
  assert.equal(controls.s2DefaultFieldText(controls.readS2Field({ id: 'flag', label: 'flag', kind: 'boolean', defaultValue: false })), 'false');
  const optional = controls.readS2Field({ id: 'n', label: 'n', kind: 'number' });
  assert.equal(controls.s2SubmitControlDraft(optional, ''), '');
  for (const kind of ['text', 'multiline', 'code'] as const) {
    const form = controls.readS2Field({ id: 'form', label: '空值保真', kind: 'form', fields: [
      { id: 'note', label: '可选文本', kind }, { id: 'count', label: '次数', kind: 'number', required: true },
    ] });
    for (const value of [{ note: '', count: 1 }, { count: 1 }, { note: '原文', count: 1 }]) {
      const encoded = JSON.stringify(value);
      assert.equal(controls.s2SubmitControlDraft(form, controls.s2ControlDraft(form, encoded)), encoded);
    }
    const list = controls.readS2Field({ id: 'list', label: '空文本列表', kind: 'list', item: { id: 'item', label: '内容', kind } });
    assert.equal(controls.s2SubmitControlDraft(list, controls.s2ControlDraft(list, '[""]')), '[""]');
    const required = controls.readS2Field({ id: 'text', label: '必填文本', kind, required: true });
    assert.throws(() => controls.s2SubmitControlDraft(required, ''));
  }
  for (const id of ['toString', 'valueOf', 'hasOwnProperty']) {
    const form = controls.readS2Field({ id: 'form', label: '自身字段', kind: 'form', fields: [{ id, label: id, kind: 'text' }] });
    assert.equal(controls.validateS2FieldText(form, '{}', false), '{}');
    assert.equal(controls.s2SubmitControlDraft(form, controls.s2ControlDraft(form, '{}')), '{}');
    const own = JSON.stringify({ [id]: '' });
    assert.equal(controls.s2SubmitControlDraft(form, controls.s2ControlDraft(form, own)), own);
    form.fields![0].required = true;
    assert.throws(() => controls.validateS2FieldText(form, '{}', false));
    assert.equal(controls.validateS2FieldText(form, JSON.stringify({ [id]: '真实自身值' }), false), JSON.stringify({ [id]: '真实自身值' }));
  }
  const event = { version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: field.id, previousValue: '', value: raw };
  assert.equal(controls.readS2FieldSubmission(event, 'goal', field, '').value, raw);
  assert.throws(() => controls.readS2FieldSubmission({ ...event, execute: true }, 'goal', field, ''));
  assert.throws(() => controls.readS2FieldSubmission(event, 'goal', field, raw));

  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成控件配置练习', knowledgePoints: [], interactionPack: null });
  const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
  scene.canvasWorkspace = readS2Definition({ ...scene.canvasWorkspace,
    blockTypes: [{ id: 'settings', label: '设置块', fields: [field] }], plugins: [parse],
    initial: { nodes: [{ id: 'goal', type: 'settings', position: { x: 0, y: 0 }, values: { settings: '' } }], edges: [],
      execution: { version: 1, nodes: [{ id: 'parse', ...parse, position: { x: 400, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'settings' } } }], links: [] } } });
  const def = scene.canvasWorkspace, original = JSON.stringify(def.initial);
  assert.throws(() => applyS2Commands(def, def.initial, [{ op: 'update-node', id: 'goal', values: { settings: '{"count":0}' } }]));
  assert.equal(JSON.stringify(def.initial), original, 'Malformed Agent edit cannot partly mutate the document');
  const updated = applyS2Commands(def, def.initial, [{ op: 'update-node', id: 'goal', values: { settings: raw } }]);
  assert.deepEqual(importS2Workspace(exportS2Workspace(def, updated)).initial, updated);
  host = new S2PluginHost(scene.sceneId, def); host.setDocument(updated);
  const run = await host.enqueueWorkflow().completion;
  assert.equal(run.status, 'succeeded');
  const output = host.history().at(-1)!.artifacts[0];
  assert.equal(output.payload.kind, 'inline');
  if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, JSON.parse(raw));

  const stages: string[] = [];
  const designed = await designS2Canvas(scene, { disclosure: 'complete', invoke: async call => {
    stages.push(JSON.parse(call.userInput).stage);
    if (stages.at(-1) === 'assemble') { assert.ok(call.systemPromptOverride!.includes('maxItems')); assert.ok(call.systemPromptOverride!.includes('kind:text|multiline|number|enum|boolean|list|form')); }
    const response = s2DesignFixtureResponse(call, def);
    if (stages.at(-1) === 'assemble') {
      const candidate = JSON.parse(response.content);
      candidate.business.completion.reference.nodes[0].values.settings = raw;
      response.content = JSON.stringify(candidate);
    }
    return response;
  } });
  assert.deepEqual(stages, ['understand', 'assemble']); assert.deepEqual(designed.blockTypes, def.blockTypes);
  const turnStages: string[] = [];
  const discussed = await interactS2Canvas(scene, updated, '先解释这份设置，暂不执行', 'goal', [], { invoke: async call => {
    const input = JSON.parse(call.userInput); turnStages.push(input.stage);
    const descriptors = input.stage === 'turn-understand' ? input.fieldControls : input.blockTypes;
    assert.deepEqual(descriptors, def.blockTypes, 'Both semantic understanding and action see the declared form, not only raw JSON');
    assert.ok(JSON.stringify(input.current).includes('settings'));
    return { content: JSON.stringify(input.stage === 'turn-understand'
      ? { understanding: '用户只需理解配置', desiredOutcome: '解释', actions: ['reply'], constraints: [], questions: [] }
      : { understanding: '配置含次数、格式、开关与样例', plan: '只解释', reply: '次数为2，关闭举例，样例文本保持原文。', commands: [] }) };
  } });
  assert.deepEqual(turnStages, ['turn-understand', 'turn-act']); assert.deepEqual(discussed.commands, []);
  const ui = harness({ initialDraft: scene });
  const editor = () => { const found = ui.elements().find(el => el.type === 'field-editor'); assert.ok(found); return found; };
  ui.flow().props.onNodeClick({}, { id: 'goal' }); ui.render();
  const stale = editor().props.onSubmit;
  assert.throws(() => stale({ ...event, value: '{}' }));
  editor().props.onSubmit(event); ui.render();
  assert.equal(ui.flow().props.nodes.find((n: any) => n.id === 'goal').data.fields[0].value, raw);
  assert.throws(() => stale(event), /变化/);
  assert.equal(ui.statuses.includes('running'), false, 'Editing alone does not acquire a session');
  const runningValue = raw.replace('"count":2', '"count":3');
  editor().props.onSubmit({ ...event, previousValue: raw, value: runningValue }); ui.render();
  assert.equal(ui.modelCalls(), 0, 'A checked field submission remains local and never starts an Agent turn');
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只解释我提交的配置' } }); ui.render();
  ui.button('发送').props.onClick(); ui.render();
  assert.equal(ui.history()!.length, 0, 'Field-submission envelopes are not synthetic chat messages');
  assert.ok(ui.pluginContext()?.interactions.fieldStates.some((state: any) => state.nodeId === 'goal' && state.fieldId === field.id && state.state === 'submitted'),
    'Actual local submitted state remains available through host interaction evidence');
  ui.resolve({ understanding: '配置', plan: '解释', reply: '已读取真实配置', commands: [] });
  await new Promise(resolve => setTimeout(resolve, 0)); ui.render();
  const after = editor().props.onSubmit;
  ui.dispose();
  assert.throws(() => after({ ...event, previousValue: runningValue, value: raw }), /过期/);
  ui.dispose();

  // Exercise the real recursive UI and root draft lifecycle using deterministic hooks.
  type El = { type: string; props: any; children: any[] };
  let slots: any[] = [], cursor = 0;
  const fakeReact = { createElement(type: any, props: any, ...children: any[]): any { return typeof type === 'function' ? type(props) : { type, props: props ?? {}, children }; },
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2FieldEditor.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports, require: (id: string) => id === 'react' ? fakeReact : id.endsWith('sceneS2ControlIssue') ? controlIssues : id.endsWith('sceneS2ControlHints') ? controlHints : controls, JSON, Map, console });
  const drafts: S2FieldDrafts = new Map(); let committed = '', submits = 0;
  const controlStates: string[] = [];
  const props = () => ({ nodeId: 'goal', field, value: committed, drafts, disabled: false, onSubmit: (v: any) => {
    const checked = controls.readS2FieldSubmission(structuredClone(v), 'goal', field, committed); committed = checked.value; submits++;
  }, onStateChange: (state: string) => controlStates.push(state) });
  const render = (): El => { cursor = 0; return exports.S2FieldEditor(props()); };
  const all = (tree: any): El[] => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object' ? [tree, ...all(tree.children)] : [];
  let tree = render();
  const control = (label: string) => { const found = all(tree).find(e => e.props['aria-label'] === label && ['input', 'textarea', 'select'].includes(e.type)); assert.ok(found, label); return found; };
  const click = (text: string) => { const found = all(tree).find(e => e.type === 'button' && e.children.join('') === text); assert.ok(found, text); found.props.onClick(); tree = render(); };
  const change = (label: string, value: string) => { control(label).props.onChange({ target: { value } }); tree = render(); };
  tree.props.onSubmit({ preventDefault() {} }); tree = render(); assert.equal(submits, 0); assert.ok(all(tree).some(e => e.props.role === 'alert'));
  slots = []; tree = render();
  const restoredError = all(tree).find(e => e.props.role === 'alert');
  assert.ok(restoredError, 'Invalid draft retains a visible error after selection remount');
  assert.equal(tree.props['aria-invalid'], true);
  assert.equal(tree.props['aria-describedby'], restoredError.props.id, 'Restored error is associated with the field form');
  assert.deepEqual(Object.keys(drafts.get('["goal","settings"]')!).sort(), ['base', 'draft', 'issue', 'schema', 'state'], 'Only trusted local issue evidence, never raw host exceptions, survives remount');
  assert.equal(drafts.get('["goal","settings"]')!.issue!.control, controlIssues.s2ControlTarget(['fields', 'count']));
  change('试验设置 / 次数', '2'); change('试验设置 / 格式', 'JSON'); change('试验设置 / 举例', 'false');
  assert.equal(tree.props['aria-invalid'], false); assert.ok(!all(tree).some(e => e.props.role === 'alert'), 'Editing clears stale validation feedback');
  click('添加试验设置 / 样例项'); change('试验设置 / 样例 / 第 1 项', '用户保留\n原文');
  assert.equal(committed, '', 'Typing only changes the draft');
  const preserved = JSON.stringify(drafts.get('["goal","settings"]')!.draft);
  slots = []; tree = render(); assert.equal(JSON.stringify(drafts.get('["goal","settings"]')!.draft), preserved, 'Selection remount preserves draft');
  tree.props.onSubmit({ preventDefault() {} }); tree.props.onSubmit({ preventDefault() {} }); tree = render();
  assert.equal(submits, 1); assert.equal(JSON.parse(committed).example, false); assert.equal(JSON.parse(committed).cases[0], '用户保留\n原文');
  change('试验设置 / 次数', '3'); committed = raw; tree = render();
  assert.ok(all(tree).some(e => e.props.role === 'alert'), 'Concurrent newer value blocks old draft');
  tree.props.onSubmit({ preventDefault() {} }); assert.equal(submits, 1);
  click('载入当前试验设置'); assert.equal(control('试验设置 / 次数').props.value, '2');
  assert.ok(['editing', 'invalid', 'submitted', 'conflict', 'reloaded'].every(state => controlStates.includes(state)), 'Native form submit/error/recovery reports status, not draft bodies or raw keystrokes');
  const markup = renderToStaticMarkup(React.createElement(S2FieldEditor, { nodeId: 'goal', field, value: raw, drafts: new Map(), disabled: false, onSubmit() {} }));
  assert.ok(!markup.includes('<script>')); assert.ok(markup.includes('&lt;script&gt;')); assert.ok(markup.includes('<legend>'));
  // Missing optional text is displayed as a controlled empty input without silently creating an own value.
  const emptyForm = controls.readS2Field({ id: 'empty', label: '空值表单', kind: 'form', fields: [
    { id: 'toString', label: '备注', kind: 'multiline' }, { id: 'code', label: '代码', kind: 'code' },
  ] });
  slots = []; const emptyDrafts: S2FieldDrafts = new Map(); let emptyValue = '{}';
  const renderEmpty = () => { cursor = 0; return exports.S2FieldEditor({ nodeId: 'empty', field: emptyForm, value: emptyValue,
    drafts: emptyDrafts, disabled: false, onSubmit: (v: any) => { emptyValue = v.value; } }); };
  let emptyTree = renderEmpty();
  assert.ok(all(emptyTree).filter(e => e.type === 'textarea').every(e => e.props.value === ''));
  emptyTree.props.onSubmit({ preventDefault() {} }); emptyTree = renderEmpty(); assert.equal(emptyValue, '{}');
  for (const label of ['空值表单 / 备注', '空值表单 / 代码']) {
    all(emptyTree).find(e => e.type === 'textarea' && e.props['aria-label'] === label)!.props.onChange({ target: { value: '' } });
    emptyTree = renderEmpty();
  }
  emptyTree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(emptyValue), { toString: '', code: '' }, 'Explicit blank edits remain own empty text values');
  // Descriptions expose existing rules without inventing or mutating any.
  const describe = (declaration: unknown) => controlHints.s2FieldRequirement(controls.readS2Field(declaration));
  assert.equal(describe({ id: 'n', label: '数量', kind: 'number', min: 0, max: 20, integer: true }), '填写整数，范围 0～20（含边界）。');
  assert.equal(describe({ id: 'n', label: '数量', kind: 'number', max: 0 }), '填写数字，不大于 0。');
  assert.equal(describe({ id: 'n', label: '数量', kind: 'number', min: -1.5 }), '填写数字，不小于 -1.5。');
  assert.equal(describe({ id: 'n', label: '数量', kind: 'number', min: 0, max: 0 }), '填写数字，只能为 0。');
  for (const kind of ['list', 'table'] as const) {
    const container = { id: 'items', label: '项目', kind, required: true,
      ...(kind === 'list' ? { item: { id: 'item', label: '内容', kind: 'text' } } : { columns: [{ id: 'item', label: '内容', type: 'string' }] }) };
    const zero = controls.readS2Field({ ...container, minItems: 0, maxItems: 0 });
    assert.equal(controlHints.s2FieldRequirement(zero), `需要 0 ${kind === 'list' ? '项' : '行'}。`);
    assert.equal(controls.s2SubmitControlDraft(zero, []), '[]', 'Required container alone never implies a nonempty container');
    assert.ok(describe(container).includes('最多 32'));
    assert.ok(describe({ ...container, minItems: 1, maxItems: 3 }).includes('至少 1'));
  }
  const emojiText = controls.readS2Field({ id: 'text', label: '备注', kind: 'text', maxLength: 2 });
  assert.ok(controlHints.s2FieldRequirement(emojiText).includes('最多 2 个字符'));
  assert.equal(controls.s2SubmitControlDraft(emojiText, '😀'), '😀'); assert.throws(() => controls.s2SubmitControlDraft(emojiText, '😀a'));
  assert.ok(!controlHints.s2FieldRequirement(emojiText).includes('必填'));
  assert.ok(describe({ ...emojiText, required: true }).includes('不能只填空格'));
  assert.ok(describe({ id: 'text', label: '备注', kind: 'code' }).includes('6000'));
  const beforeHints = JSON.stringify(field);
  const markupWithHints = renderToStaticMarkup(<><S2ControlInput field={field} draft={controls.s2ControlDraft(field, raw)} disabled={false}
    descriptionId="first-scope" issue={{ control: controlIssues.s2ControlTarget(['fields', 'count']), message: '本地校验原因', errorId: 'issue-scope' }} onChange={() => assert.fail('Reading hints must not change values')} />
    <S2ControlInput field={field} draft={controls.s2ControlDraft(field, raw)} disabled={false} descriptionId="second-scope" onChange={() => assert.fail('No implicit edits')} /></>);
  assert.equal(JSON.stringify(field), beforeHints);
  const hintIds = [...markupWithHints.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(hintIds.length, new Set(hintIds).size, 'Independent forms, repeated items and nested fields have unique description IDs');
  for (const match of markupWithHints.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of match[1].split(' ')) assert.ok(hintIds.includes(id), id);
  assert.ok(/aria-describedby="[^"]+ issue-scope-field"/.test(markupWithHints), 'Requirements and the existing inline error both remain associated');
  assert.ok(markupWithHints.includes('范围 1～8') && markupWithHints.includes('至少 1 项，最多 3 项'));
  console.log('S2 control requirements passed: exact inclusive/zero/equal/one-sided bounds, native character units and default counts, required empty containers unchanged; readonly nested multi-form descriptions with unique IDs and simultaneous accessible errors. Synthetic offline only.');
  console.log('S2 controls passed: closed bounded typed schemas/defaults, atomic validation and edits, production builder/field-submit/history/end guards, exact JSON field→parse plugin handoff, template roundtrip, recursive real form/list/scalar UI, drafts across selection, error recovery/conflict/duplicate-submit and escaped accessible SSR. Synthetic offline only; no live model or browser E2E.');
} finally { host?.close(); globalThis.fetch = priorFetch; }
