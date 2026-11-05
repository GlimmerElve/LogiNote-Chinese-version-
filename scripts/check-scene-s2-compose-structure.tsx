import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2ComposeEditor, type S2ComposeEditorProps } from '../src/interaction-packs/prompt-lab/ComposeEditor';
import * as compose from '../src/interaction-packs/prompt-lab/composeControls';
import { createS2Scene, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Composition structure checks forbid model/network IO'); };
const cap = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose' };
const display = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
const literal = (value: any) => ({ kind: 'literal' as const, value });
const field = (nodeId: string) => ({ kind: 'field' as const, nodeId, fieldId: 'content' });
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成固定入口结构', knowledgePoints: [] });
const definition = readS2Definition({ version: 1, goal: '只修改结构标题，材料由画布连线提供',
  instructions: { understanding: '区分标题与正文', planning: '不修改连线', response: '只报告真实修改' },
  blockTypes: [{ id: 'text', label: '内容块', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap, display], initial: { nodes: [
    { id: 'role', type: 'text', label: '角色材料', position: { x: 0, y: 0 }, values: { content: 'PRIVATE_ROLE_BODY' } },
    { id: 'task', type: 'text', label: '任务材料', position: { x: 0, y: 200 }, values: { content: 'PRIVATE_TASK_BODY' } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: 'producer', ...cap, position: { x: 200, y: 300 }, bindings: { part1: literal('PRIVATE_LINKED_BODY') }, presentation: { label: '上游内容' } },
    { id: 'assemble', ...cap, position: { x: 400, y: 0 }, bindings: { part1: field('role'), part3: field('task'), prefixes: literal(['角色：', '', '输出：', '', '预设未连：']), separator: literal('\n') } },
    { id: 'display', ...display, position: { x: 800, y: 0 }, bindings: {} },
  ], links: [
    { source: { nodeId: 'producer', portId: 'text' }, target: { nodeId: 'assemble', portId: 'part2' } },
    { source: { nodeId: 'assemble', portId: 'text' }, target: { nodeId: 'display', portId: 'text' } },
  ] } } });
const initial = definition.initial, saved = JSON.stringify(initial);
const structure = (document = initial) => compose.s2ComposeStructure(definition, document, 'assemble');
const sourceBindings = (document: typeof initial) => Object.fromEntries(Object.entries(document.execution!.nodes.find(node => node.id === 'assemble')!.bindings).filter(([key]) => /^part[1-8]$/.test(key)));
let host: S2PluginHost | undefined;
try {
  const state = structure(); assert.equal(state.simple, true);
  assert.deepEqual(state.slots.map(slot => [slot.portId, slot.connected, slot.sourceLabel]), [
    ['part1', true, '角色材料'], ['part2', true, '上游内容'], ['part3', true, '任务材料'], ['part4', false, '未连接'], ['part5', false, '未连接'],
  ]);
  assert.ok(!JSON.stringify(state.slots).includes('PRIVATE_'), 'The compact structure projection has source names without body previews');
  const config = { prefixes: ['  角色改：', '输入：', '任务：', '', '预设未连：'], separator: '\n---\n' };
  const changed = compose.applyS2ComposeStructure(definition, initial, 'assemble', config, state.base);
  assert.deepEqual(sourceBindings(changed), sourceBindings(initial)); assert.deepEqual(changed.execution!.links, initial.execution!.links);
  const expected = structuredClone(initial); expected.execution!.nodes.find(node => node.id === 'assemble')!.bindings.prefixes = literal(config.prefixes);
  expected.execution!.nodes.find(node => node.id === 'assemble')!.bindings.separator = literal(config.separator);
  assert.deepEqual(changed, expected, 'A structure edit changes only prefixes/separator; no source, ordering, position or link rewrite');
  assert.throws(() => compose.applyS2ComposeStructure(definition, changed, 'assemble', config, state.base), /变化/);
  for (const raw of [{ prefixes: ['x'.repeat(121)], separator: '' }, { prefixes: Array(9).fill(''), separator: '' }, { prefixes: [false], separator: '' },
    { prefixes: Array(1), separator: '' }, { prefixes: [], separator: 'x'.repeat(121) }, { prefixes: [], separator: '', part1: literal('forged') }]) {
    assert.throws(() => compose.applyS2ComposeStructure(definition, initial, 'assemble', raw as any, state.base));
  }
  let getters = 0; const hostile = { separator: '' };
  Object.defineProperty(hostile, 'prefixes', { enumerable: true, get() { getters++; return []; } });
  assert.throws(() => compose.applyS2ComposeStructure(definition, initial, 'assemble', hostile as any, state.base)); assert.equal(getters, 0);
  const bare = structuredClone(initial), emptyNode = bare.execution!.nodes.find(node => node.id === 'assemble')!;
  emptyNode.bindings = {}; bare.execution!.links = bare.execution!.links.filter(link => link.target.nodeId !== 'assemble');
  const empty = structure(bare); assert.deepEqual(empty.slots.map(slot => slot.title), ['角色', '任务', '输出要求']);
  assert.deepEqual(empty.prefixes, ['', '', '']); assert.ok(empty.slots.every(slot => !slot.connected));
  assert.equal(compose.applyS2ComposeStructure(definition, bare, 'assemble', { prefixes: ['', '', ''], separator: '\n' }, empty.base), bare, 'Reading/default blur cannot materialize prefixes into a legacy bare graph');
  const eighth = structuredClone(initial); eighth.execution!.nodes.find(node => node.id === 'assemble')!.bindings.part8 = literal('EIGHTH_BODY');
  assert.equal(structure(eighth).slots.length, 8, 'Sparse old part8 remains a visible fixed input');
  const dynamic = structuredClone(initial); delete dynamic.execution!.nodes.find(node => node.id === 'assemble')!.bindings.separator;
  dynamic.execution!.links.push({ source: { nodeId: 'producer', portId: 'text' }, target: { nodeId: 'assemble', portId: 'separator' } });
  readS2Document(dynamic, definition); assert.equal(structure(dynamic).simple, false);
  assert.throws(() => compose.applyS2ComposeStructure(definition, dynamic, 'assemble', config, structure(dynamic).base), /其他步骤/);

  // The old programmatic edit remains compatible for saved graphs/callers. It
  // is intentionally absent from the new editor's UI and callback surface.
  const legacy = compose.s2ComposeControls(definition, initial, 'assemble');
  const reordered = compose.applyS2ComposeControls(definition, initial, 'assemble', [...legacy.rows].reverse(), '|', legacy.base);
  assert.deepEqual(reordered.execution!.nodes.find(node => node.id === 'assemble')!.bindings.part1, field('task'));
  assert.deepEqual(reordered.execution!.nodes.find(node => node.id === 'assemble')!.bindings.part3, field('role'));

  host = new S2PluginHost(scene.sceneId, definition); host.setDocument(changed);
  const result = await host.enqueueWorkflow(['display']).completion; assert.equal(result.status, 'succeeded');
  const output = host.currentArtifact(result.nodes.find(node => node.nodeId === 'assemble')!.artifactIds[0]);
  assert.equal(output.payload.kind, 'inline'); if (output.payload.kind === 'inline') assert.equal(output.payload.value, '  角色改：PRIVATE_ROLE_BODY\n---\n输入：PRIVATE_LINKED_BODY\n---\n任务：PRIVATE_TASK_BODY');
  assert.equal(host.history().length, 2, 'Only the actual upstream and assembly nodes execute after an explicit run');

  const html = renderToStaticMarkup(<S2ComposeEditor definition={definition} document={initial} nodeId="assemble" onStructureChange={() => assert.fail('SSR never edits')} />);
  assert.equal((html.match(/data-s2-compose-port=/g) ?? []).length, 5);
  assert.ok(!html.includes('<select') && !html.includes('<button') && !html.includes('<form') && !html.includes('PRIVATE_'));
  for (const removed of ['使用哪份内容', '添加一段', '上移', '下移', '应用组装设置', '载入当前组装设置']) assert.ok(!html.includes(removed));
  assert.ok(html.includes('预设未连：') && html.includes('未连接')); assert.ok(!html.includes('<details open'));

  // Real component handlers, deterministic hooks and actual pure edits. Browser
  // pointer/focus behavior is deliberately left to the separate browser check.
  let document = structuredClone(initial), calls = 0; const errors: string[] = [];
  let props: S2ComposeEditorProps = { definition, document, nodeId: 'assemble', scopeKey: 'scene-a', onError: message => errors.push(message),
    onStructureChange(next, base) { calls++; document = compose.applyS2ComposeStructure(definition, document, props.nodeId, structuredClone(next), base); props = { ...props, document }; } };
  const slots: any[] = []; let cursor = 0, tree: any; const effects: Array<() => void> = [];
  const fakeReact = { createElement: (type: any, value: any, ...children: any[]) => ({ type, props: value ?? {}, children }),
    useState(value: any) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next: any) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(value: any) { const index = cursor++; slots[index] ??= { value: { current: value } }; return slots[index].value; },
    useEffect(effect: () => any, deps: any[]) { const index = cursor++, prior = slots[index];
      if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) { slots[index] = { deps, cleanup: prior?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); }); }
    } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/interaction-packs/prompt-lab/ComposeEditor.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, require: (name: string) => name === 'react' ? fakeReact : name === './composeControls' ? compose : assert.fail(name) });
  const elements = (root: any = tree): any[] => Array.isArray(root) ? root.flatMap(item => elements(item ?? null)) : root && typeof root === 'object' ? [root, ...elements(root.children ?? [])] : [];
  const text = (root: any = tree): string => Array.isArray(root) ? root.map(item => text(item ?? null)).join('') : root && typeof root === 'object' ? text(root.children ?? []) : String(root ?? '');
  const control = (label: string) => { const element = elements().find(item => ['input', 'textarea'].includes(item.type) && item.props['aria-label'] === label); assert.ok(element, label); return element; };
  function render() { cursor = 0; tree = exports.S2ComposeEditor(props); effects.splice(0).forEach(effect => effect()); }
  const change = (label: string, value: string) => { control(label).props.onChange({ target: { value } }); render(); };
  const blur = (label: string) => { control(label).props.onBlur(); render(); };
  const enter = (label: string, extra: Record<string, any> = {}) => { control(label).props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {}, stopPropagation() {}, ...extra }); render(); };
  render(); assert.equal(elements().filter(item => item.type === 'input').length, 5);
  blur('入口1标题'); assert.equal(calls, 0);
  change('入口1标题', '改后的角色：'); assert.equal(calls, 0); assert.ok(text().includes('草稿尚未保存'));
  enter('入口1标题', { nativeEvent: { isComposing: true } }); assert.equal(calls, 0);
  const duplicateBlur = control('入口1标题').props.onBlur;
  enter('入口1标题'); assert.equal(calls, 1); duplicateBlur(); assert.equal(calls, 1);
  assert.equal(control('入口1标题').props.value, '改后的角色：'); assert.deepEqual(sourceBindings(document), sourceBindings(initial)); assert.deepEqual(document.execution!.links, initial.execution!.links);
  change('入口间的分隔文字', '\n\n'); enter('入口间的分隔文字'); assert.equal(calls, 1);
  enter('入口间的分隔文字', { ctrlKey: true }); assert.equal(calls, 2);
  change('入口2标题', 'x'.repeat(121)); blur('入口2标题'); assert.equal(calls, 2); assert.equal(control('入口2标题').props['aria-invalid'], true);
  change('入口2标题', '材料：'); blur('入口2标题'); assert.equal(calls, 3);
  change('入口1标题', '冲突中的私有草稿'); const oldBlur = control('入口1标题').props.onBlur;
  document = compose.applyS2ComposeStructure(definition, document, 'assemble', { prefixes: ['外部角色：', '外部材料：', '输出：', '', '预设未连：'], separator: '|' }, structure(document).base);
  props = { ...props, document }; render(); assert.equal(control('入口1标题').props.value, '冲突中的私有草稿'); assert.ok(text().includes('结构已变化'));
  oldBlur(); blur('入口1标题'); assert.equal(calls, 3);
  change('入口1标题', '明确重确认：'); blur('入口1标题'); assert.equal(calls, 4);
  assert.equal(structure(document).prefixes[1], '外部材料：', 'Resolving one draft cannot overwrite a newer title on another input');
  assert.deepEqual(sourceBindings(document), sourceBindings(initial)); assert.deepEqual(document.execution!.links, initial.execution!.links);
  change('入口3标题', '上一场景私有标题'); const priorScene = control('入口3标题').props.onBlur;
  props = { ...props, scopeKey: 'scene-b' }; render(); assert.equal(control('入口3标题').props.value, '输出：'); priorScene(); blur('入口3标题'); assert.equal(calls, 4);
  change('入口1标题', '结束前未提交'); const ended = control('入口1标题').props.onBlur;
  props = { ...props, disabled: true }; render(); ended(); blur('入口1标题'); assert.equal(calls, 4); assert.equal(control('入口1标题').props.disabled, true);
  props = { ...props, disabled: false }; render(); const unmounted = control('入口1标题').props.onBlur;
  slots.forEach(slot => slot.cleanup?.()); unmounted(); assert.equal(calls, 4);
  assert.equal(JSON.stringify(initial), saved); assert.equal(network, 0);
  console.log('S2 compose structure passed: fixed three/eight-slot mapping including unconnected presets, source names without body copies, prefix/separator-only edits preserving all bindings/links and old programmatic compatibility, real local upstream/compose output, compact buttonless SSR, blur/Enter/IME/duplicate controls, explicit conflict retention and per-item resolution, scene/end/unmount guards. Offline synthetic only.');
} finally { host?.close(); globalThis.fetch = previousFetch; }
