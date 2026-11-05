import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2ConditionEditor } from '../src/components/scene/S2ConditionEditor';
import { S2ArtifactView, S2JsonTreeBranch } from '../src/components/scene/S2ArtifactView';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { readS2ContextEvent } from '../src/services/scene/sceneS2ArtifactAccess';
import * as controlDrafts from '../src/services/scene/sceneS2ControlDrafts';
import * as presentation from '../src/services/scene/sceneS2Presentation';
import { harness } from './scene-s2-ui-harness';

// Deterministic hooks; editors, canvas handlers, protocol and host remain production code.
function component(path: string, name: string, props: () => any) {
  let slots: any[] = [], cursor = 0, tree: any;
  const react = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require: (id: string) => id === 'react' ? react
    : id.endsWith('sceneS2ControlDrafts') ? controlDrafts : id.endsWith('sceneS2Presentation') ? presentation : {} });
  const render = () => { cursor = 0; tree = exports[name](props()); };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(v => elements(v ?? null))
    : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (v: any = tree): string => Array.isArray(v) ? v.map(item => text(item ?? null)).join('') : v && typeof v === 'object' ? text(v.children ?? []) : String(v ?? '');
  const find = (type: string) => elements().find(e => e.type === type)!;
  const button = (label: string) => { const e = elements().find(e => e.type === 'button' && text(e) === label); assert.ok(e, label); return e; };
  const change = (label: string, value: string) => { elements().find(e => e.props['aria-label'] === label)!.props.onChange({ target: { value } }); render(); };
  const key = (changes: any = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, keyCode: 13, nativeEvent: {},
    prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...changes });
  render(); return { render, elements, text, find, button, change, key, fresh() { slots = []; render(); },
    submit() { find('form').props.onSubmit({ preventDefault() {} }); render(); } };
}
const prior = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Condition/view regression forbids real IO'); };
try {
  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成条件与视图', knowledgePoints: [] });
  const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const parse = cap('structured-data', 'parse-json'), select = cap('structured-data', 'select'), treeView = cap('structured-view', 'json-tree');
  const literal = (value: any) => ({ kind: 'literal', value });
  const node = (id: string, capability: any, bindings: any) => ({ id, ...capability, position: { x: 0, y: 0 }, bindings });
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, select, treeView],
    blockTypes: [{ id: 'text', label: '文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    initial: { nodes: [{ id: 'data', type: 'text', position: { x: 0, y: 0 }, values: { content: '{}' } }], edges: [],
      execution: { version: 1, nodes: [node('source', parse, { text: literal('{"a/b":{"~key":[{}]},"leaf":0}') }),
        node('target', parse, { text: literal('{}') }), node('downstream', select, { pointer: literal('') }), node('tree', treeView, {})],
      links: [{ source: { nodeId: 'source', portId: 'value' }, target: { nodeId: 'downstream', portId: 'value' } },
        { source: { nodeId: 'source', portId: 'value' }, target: { nodeId: 'tree', portId: 'value' } }] } } });
  scene.canvasWorkspace = definition; let host!: S2PluginHost;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, onHost: value => { host = value; } });
  try {
    await ui.openConversationSession();
    const context = () => host.prepare(null, { goal: definition.goal, ...definition.instructions }, '只观察状态');
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const conditionProps = () => { ui.render(); return ui.elements().find(e => e.type === 'condition-editor')!.props; };
    const changeText = (value: string) => { ui.labelControl('参数 text', 'textarea').props.onChange({ target: { value } }); ui.render(); };
    focus('target');
    const editor = component('src/components/scene/S2ConditionEditor.tsx', 'S2ConditionEditor', conditionProps);
    editor.change('条件来源输出', JSON.stringify(['source', 'value']));
    editor.change('条件比较值（JSON）', '{"PRIVATE_CONDITION_DRAFT":'); editor.submit();
    assert.ok(editor.elements().some(e => e.props.role === 'alert')); assert.equal(conditionProps().when, undefined);
    editor.fresh(); assert.equal(editor.find('textarea').props.value, '{"PRIVATE_CONDITION_DRAFT":');
    assert.ok(!JSON.stringify(context()).includes('PRIVATE_CONDITION_DRAFT'));
    assert.equal(context().interactions.controlStates.find(e => e.kind === 'condition-control')!.state, 'invalid');
    focus('source'); focus('target'); editor.fresh(); assert.equal(editor.find('textarea').props.value, '{"PRIVATE_CONDITION_DRAFT":');
    editor.change('条件比较值（JSON）', '0'); editor.change('条件 JSON Pointer', '/leaf');
    for (const changes of [{}, { ctrlKey: true, nativeEvent: { isComposing: true } }, { ctrlKey: true, keyCode: 229 }]) {
      const event = editor.key(changes); editor.find('form').props.onKeyDown(event); assert.equal(event.prevented, false); assert.equal(conditionProps().when, undefined);
    }
    const shortcut = editor.find('form').props.onKeyDown, event = editor.key({ metaKey: true });
    shortcut(event); shortcut(event); editor.render(); assert.equal(event.prevented, true);
    assert.equal(conditionProps().when.pointer, '/leaf');
    assert.equal(context().interactions.controlStates.find(e => e.kind === 'condition-control')!.via, 'shortcut');
    const oldApply = conditionProps().onApply, oldBase = conditionProps().sourceKey;
    editor.change('条件比较值（JSON）', '2');
    conditionProps().onApply({ nodeId: 'source', portId: 'value', pointer: '/leaf', equals: 1, match: true }); editor.render();
    assert.ok(editor.text().includes('草稿已保留')); assert.equal(editor.find('textarea').props.value, '2');
    assert.throws(() => oldApply(null, oldBase), /来源已变化|操作已过期/); assert.equal(conditionProps().when.equals, 1);
    editor.button('载入当前执行条件').props.onClick(); editor.render(); assert.equal(editor.find('textarea').props.value, '1');
    editor.button('明确解除执行条件').props.onClick(); editor.render(); assert.equal(conditionProps().when, undefined);
    assert.equal(context().interactions.controlStates.find(e => e.kind === 'condition-control')!.state, 'cleared');
    focus('source');
    const cycle = component('src/components/scene/S2ConditionEditor.tsx', 'S2ConditionEditor', conditionProps);
    cycle.change('条件来源输出', JSON.stringify(['downstream', 'value'])); cycle.submit();
    assert.ok(cycle.elements().some(e => e.props.role === 'alert')); assert.equal(conditionProps().when, undefined, 'Combined data/condition cycle is atomic');
    assert.equal(host.history().length, 0); assert.equal(ui.modelCalls(), 1, 'Editing never invokes Agent');

    // Immediate text editing retains same-frame updates, but stale text/reference/clear cannot overwrite another change.
    focus('target');
    const immediate = ui.labelControl('参数 text', 'textarea').props.onChange;
    immediate({ target: { value: '{"one":1}' } }); immediate({ target: { value: '{"two":2}' } }); ui.render();
    assert.equal(ui.labelControl('参数 text', 'textarea').props.value, '{"two":2}');
    const staleText = ui.labelControl('参数 text', 'textarea').props.onChange;
    const staleReference = ui.labelControl('引用字段 text', 'select').props.onChange;
    const staleClear = ui.button('清除输入 text').props.onClick;
    ui.render(); // Another current render owns the independent change below, not this same-frame edit cursor.
    changeText('{"current":3}');
    staleText({ target: { value: 'stale' } }); staleReference({ target: { value: '["data","content"]' } }); staleClear(); ui.render();
    assert.equal(ui.labelControl('参数 text', 'textarea').props.value, '{"current":3}');
    ui.labelControl('引用字段 text', 'select').props.onChange({ target: { value: '["data","content"]' } }); ui.render();
    assert.equal(context().interactions.controlStates.filter(e => e.kind === 'parameter-control').find(e => e.nodeId === 'target')!.state, 'referenced');
    ui.button('清除输入 text').props.onClick(); ui.render();
    assert.equal(context().interactions.controlStates.filter(e => e.kind === 'parameter-control').find(e => e.nodeId === 'target')!.state, 'cleared');
    changeText('{}');

    // Real canvas node -> production view -> escaped pointer -> validated host event.
    focus('tree'); ui.viewContext('tree').execution!.run();
    for (let i = 0; i < 100 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(host.workflowHistory().at(-1)?.status, 'succeeded');
    const artifact = host.history().find(item => item.request.nodeId === 'source')!.artifacts[0];
    const original = JSON.stringify(artifact), calls = host.remainingCalls;
    const reactElements = (v: any): any[] => Array.isArray(v) ? v.flatMap(reactElements)
      : v && typeof v === 'object' && v.props ? [v, ...reactElements(v.props.children)] : [];
    ui.render(); const nodeData = ui.flow().props.nodes.find((n: any) => n.id === 'tree').data;
    assert.equal(typeof nodeData.onTreeToggle, 'function');
    assert.equal(nodeData.status, 'displayed'); assert.equal(nodeData.artifacts[0].id, artifact.id);
    const renderedNode = S2WorkflowNodeView({ data: nodeData } as any);
    const view = reactElements(renderedNode).find(e => e.type === S2ArtifactView)!;
    const beforeTree = context().interactions.totalEvents;
    const branches = reactElements(S2ArtifactView(view.props)).filter(e => e.type === S2JsonTreeBranch);
    assert.equal(context().interactions.totalEvents, beforeTree, 'Rendering default expansion records no action');
    const escaped = branches.find(e => e.props.label.startsWith('~key'))!; assert.ok(escaped);
    const branch = component('src/components/scene/S2ArtifactView.tsx', 'S2JsonTreeBranch', () => escaped.props);
    const activate = branch.find('summary').props.onClick;
    activate({ preventDefault() {} }); activate({ preventDefault() {} }); branch.render();
    assert.equal(branch.find('summary').props['aria-expanded'], false);
    const treeEvent = context().interactions.recentEvents.at(-1)!;
    assert.equal(treeEvent.kind, 'json-tree-view');
    assert.equal((treeEvent as any).pointer, '/a~1b/~0key'); assert.equal((treeEvent as any).open, false);
    assert.equal(readS2ContextEvent(context(), treeEvent.id).id, treeEvent.id);
    host.recordJsonTreeView(artifact.id, { pointer: '/a~1b/~0key/0', open: true });
    const eventCount = context().interactions.totalEvents;
    host.recordJsonTreeView(artifact.id, { pointer: '/a~1b/~0key/0', open: true });
    assert.equal(context().interactions.totalEvents, eventCount);
    for (const invalid of [{ pointer: '/missing', open: true }, { pointer: '/leaf', open: true }, { pointer: '', open: 'yes' },
      { pointer: '', open: true, execute: true }, Object.create({ pointer: '', open: true }),
      Object.defineProperty({ open: true }, 'pointer', { enumerable: true, get() { throw new Error('Getter must not run'); } })]) {
      assert.throws(() => host.recordJsonTreeView(artifact.id, invalid as any));
    }
    assert.throws(() => host.recordJsonTreeView('forged', { pointer: '', open: true }));
    assert.equal(JSON.stringify(host.currentArtifact(artifact.id)), original); assert.equal(host.remainingCalls, calls);
    focus('target');
    const endedApply = conditionProps().onApply, endedBase = conditionProps().sourceKey;
    const endedText = ui.labelControl('参数 text', 'textarea').props.onChange;
    changeText('{"revision":4}'); assert.throws(() => host.recordJsonTreeView(artifact.id, { pointer: '', open: false }));
    ui.dispose();
    assert.throws(() => endedApply(null, endedBase), /过期/); endedText({ target: { value: 'ended' } });
    assert.equal(ui.labelControl('参数 text', 'textarea').props.value, '{"revision":4}'); assert.equal(ui.modelCalls(), 1);
  } finally { ui.dispose(); }
  const html = renderToStaticMarkup(<S2ConditionEditor nodeId="safe" disabled={false} sources={[]} drafts={new Map([['safe', {
    base: JSON.stringify([null, []]), source: '', pointer: '', expected: '<script>alert(1)</script>', match: true, state: 'invalid',
  }]])} onApply={() => { throw new Error('SSR must not apply'); }} />);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('role="alert"')); assert.ok(html.includes('aria-invalid="true"'));
  const treeHtml = renderToStaticMarkup(<S2JsonTreeBranch label="<unsafe>" initialOpen={false} onChange={() => { throw new Error('SSR must not toggle'); }}>value</S2JsonTreeBranch>);
  assert.ok(treeHtml.includes('&lt;unsafe&gt;')); assert.ok(treeHtml.includes('aria-expanded="false"'));
  assert.equal(network, 0);
  console.log('S2 condition/view lifecycle passed: real editors/canvas/host, private persistent drafts, conflict/reload, atomic cycle rejection, shortcut/IME/duplicate guards, stale immediate text/reference/clear, explicit escaped JSON tree actions, exact recall, invalid/stale artifact rejection, no implicit execution or real IO. Offline synthetic only.');
} finally { globalThis.fetch = prior; }
