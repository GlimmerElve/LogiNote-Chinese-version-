import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { S2JsonParameter } from '../src/components/scene/S2JsonParameter';
import { S2HumanInput } from '../src/components/scene/S2HumanInput';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { readS2ContextEvent } from '../src/services/scene/sceneS2ArtifactAccess';
import { harness } from './scene-s2-ui-harness';
import * as simpleForms from '../src/services/scene/sceneS2SimpleValueForm';

// Real editors and real production canvas handlers, deterministic hooks only.
function editorHarness(path: string, name: string, props: () => any) {
  let slots: any[] = [], cursor = 0, tree: any;
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Map, Error, require: (id: string) => id === 'react' ? React
    : id.endsWith('sceneS2SimpleValueForm') ? simpleForms : id.endsWith('S2SimpleValueInput') ? { S2SimpleValueInput: 'simple-input' } : { S2ArtifactView: 'artifact-view' } });
  const render = () => { cursor = 0; tree = exports[name](props()); };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null))
    : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('')
    : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
  const button = (label: string) => { const found = elements().find(element => element.type === 'button' && text(element) === label); assert.ok(found, label); return found; };
  const input = () => elements().find(element => element.type === 'textarea')!;
  const form = () => elements().find(element => element.type === 'form')!;
  const keyEvent = (changes: any = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    nativeEvent: {}, keyCode: 13, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...changes });
  render(); return { render, elements, text, button, input, form, keyEvent,
    fresh() { slots = []; render(); },
    draft(value: string) { input().props.onChange({ target: { value } }); render(); },
    submit() { form().props.onSubmit({ preventDefault() {} }); render(); },
  };
}
const prior = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Control lifecycle forbids real IO'); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail('Synthetic control lifecycle deadline'); }
try {
  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成控件生命周期', knowledgePoints: [] });
  const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const select = cap('structured-data', 'select'), parse = cap('structured-data', 'parse-json'), human = cap('human-input', 'json');
  const literal = (value: any) => ({ kind: 'literal', value });
  const node = (id: string, capability: any, bindings: any) => ({ id, ...capability, position: { x: 0, y: 0 }, bindings });
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [select, parse, human], initial: { ...scene.canvasWorkspace!.initial,
    execution: { version: 1, nodes: [
      node('select', select, { value: literal({ old: 1 }), pointer: literal('') }), node('parse', parse, { text: literal('{"upstream":true}') }),
      node('ask', human, { prompt: literal('填写合成 JSON') }), node('next', human, { prompt: literal('再填一个合成 JSON') }),
    ], links: [{ source: { nodeId: 'ask', portId: 'value' }, target: { nodeId: 'next', portId: 'context' } }] } } });
  scene.canvasWorkspace = definition; let host!: S2PluginHost;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, onHost: value => { host = value; } });
  try {
    await ui.openConversationSession();
    const strategy = { goal: definition.goal, ...definition.instructions };
    const context = () => host.prepare(null, strategy, '只查看元数据');
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    focus('select');
    const parameterProps = () => { ui.render(); return ui.elements().find(element => element.type === 'json-parameter' && element.props.portId === 'value')!.props; };
    const parameter = editorHarness('src/components/scene/S2JsonParameter.tsx', 'S2JsonParameter', parameterProps);
    parameter.button('改用 JSON 编辑（高级）').props.onClick(); parameter.render();
    parameter.draft('{"PRIVATE_PARAMETER_DRAFT":'); parameter.submit();
    assert.ok(parameter.elements().some(element => element.props.role === 'alert'));
    assert.equal(parameter.input().props.value, '{"PRIVATE_PARAMETER_DRAFT":');
    assert.deepEqual(parameterProps().value, { old: 1 });
    assert.equal(context().interactions.controlStates.find(event => event.kind === 'parameter-control')!.state, 'invalid');
    assert.ok(!JSON.stringify(context()).includes('PRIVATE_PARAMETER_DRAFT'));
    parameter.draft('{"x":2}');
    const plainEnter = parameter.keyEvent(); parameter.input().props.onKeyDown(plainEnter); assert.equal(plainEnter.prevented, false);
    for (const changes of [{ ctrlKey: true, nativeEvent: { isComposing: true } }, { ctrlKey: true, keyCode: 229 }]) {
      parameter.input().props.onKeyDown(parameter.keyEvent(changes)); assert.deepEqual(parameterProps().value, { old: 1 });
    }
    const shortcut = parameter.input().props.onKeyDown, submitEvent = parameter.keyEvent({ metaKey: true });
    shortcut(submitEvent); shortcut(submitEvent); parameter.render(); assert.equal(submitEvent.prevented, true);
    assert.deepEqual(parameterProps().value, { x: 2 });
    const submitted = context().interactions.controlStates.find(event => event.kind === 'parameter-control')!;
    assert.equal(submitted.state, 'submitted'); assert.equal(submitted.via, 'shortcut');
    assert.equal(host.remainingCalls, 64); assert.equal(ui.modelCalls(), 1);

    parameter.draft('{"retained":"草稿"}'); focus('parse'); focus('select'); parameter.fresh();
    assert.equal(parameter.input().props.value, '{"retained":"草稿"}', 'Selection remount does not discard the draft');
    const oldProps = parameterProps(), oldBase = oldProps.sourceKey;
    oldProps.onCommit({ external: true }, oldBase); ui.render(); parameter.render();
    assert.ok(parameter.text().includes('参数来源已变化')); assert.equal(parameter.input().props.disabled, true);
    parameter.submit(); assert.deepEqual(parameterProps().value, { external: true });
    assert.throws(() => oldProps.onCommit({ overwrite: true }, oldBase), /来源或接线/);
    parameter.button('载入当前内容').props.onClick(); parameter.render();
    parameter.button('改用 JSON 编辑（高级）').props.onClick(); parameter.render();
    parameter.draft('{"__proto__":true}'); parameter.submit(); assert.deepEqual(parameterProps().value, { external: true }, 'Valid JSON with invalid protocol keys cannot commit');
    parameter.draft('{"accepted":true}'); parameter.submit();
    assert.deepEqual(parameterProps().value, { accepted: true });
    const staleForLink = parameterProps();
    ui.button('清除输入 value').props.onClick(); ui.render();
    ui.flow().props.onConnect({ source: 'parse', sourceHandle: 'out:value', target: 'select', targetHandle: 'in:value' }); ui.render();
    assert.throws(() => staleForLink.onCommit({ illegal: true }, staleForLink.sourceKey), /来源或接线/);
    parameter.render(); assert.equal(parameter.input().props.disabled, true);
    assert.equal(host.history().length, 0); assert.equal(ui.modelCalls(), 1);

    // The second human node waits only AFTER the first actual input was submitted.
    focus('next'); ui.viewContext('next').execution!.run(); ui.render();
    await until(() => { ui.render(); return ui.inline('ask').elements().some(element => element.type === 'human-input' && element.props.wait.nodeId === 'ask'); });
    const humanProps = () => ui.inline('ask').elements().find(element => element.type === 'human-input' && element.props.wait.nodeId === 'ask')!.props;
    const originalHuman = humanProps(), humanEditor = editorHarness('src/components/scene/S2HumanInput.tsx', 'S2HumanInput', humanProps);
    humanEditor.draft('{PRIVATE_HUMAN_DRAFT'); humanEditor.submit();
    assert.ok(humanEditor.text().includes('JSON 格式无效')); humanEditor.fresh();
    assert.equal(humanEditor.input().props.value, '{PRIVATE_HUMAN_DRAFT');
    assert.ok(humanEditor.elements().some(element => element.props.role === 'alert'), 'Remount preserves invalid-state feedback without storing error text');
    const waitingContext = context(), waitingControl = waitingContext.interactions.controlStates.find(event => event.kind === 'human-control')!;
    assert.equal(waitingControl.state, 'invalid'); assert.equal(waitingControl.waitActive, true);
    assert.ok(!JSON.stringify(waitingContext).includes('PRIVATE_HUMAN_DRAFT'));
    assert.throws(() => host.recordHumanControl(originalHuman.wait.workflowId, originalHuman.wait.id, 'submitted' as any));
    ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只解释为什么提交没成功，不代填、不执行' } }); ui.render();
    ui.button('发送').props.onClick(); ui.render();
    assert.equal(ui.pluginContext().interactions.controlStates.find((event: any) => event.kind === 'human-control').waitActive, true);
    ui.resolve({ understanding: '尚有无效草稿', plan: '只解释', reply: '等待尚未解除。请核对 JSON 格式；我没有读到未提交的正文。', commands: [] }); await tick(); ui.render();
    assert.equal(host.waitingHumanInputs()[0].id, originalHuman.wait.id);
    humanEditor.draft('{"answer":true}');
    humanEditor.input().props.onKeyDown(humanEditor.keyEvent({ ctrlKey: true, nativeEvent: { isComposing: true } }));
    assert.equal(host.waitingHumanInputs()[0].id, originalHuman.wait.id);
    const humanShortcut = humanEditor.input().props.onKeyDown, humanEvent = humanEditor.keyEvent({ ctrlKey: true });
    humanShortcut(humanEvent); humanShortcut(humanEvent);
    await until(() => { ui.render(); return host.waitingHumanInputs().some(wait => wait.nodeId === 'next'); });
    assert.equal(readS2ContextEvent(waitingContext, waitingControl.id).waitActive, false, 'Same revision does not make a resolved wait active');
    assert.throws(() => originalHuman.onCancel(), /等待已失效/, 'An old cancel button cannot cancel the resumed workflow');
    assert.throws(() => host.recordHumanControl(originalHuman.wait.workflowId, originalHuman.wait.id, 'editing'), /失效/);
    assert.equal(host.waitingHumanInputs()[0].nodeId, 'next');
    const nextProps = ui.inline('next').elements().find(element => element.type === 'human-input' && element.props.wait.nodeId === 'next')!.props;
    const nextEditor = editorHarness('src/components/scene/S2HumanInput.tsx', 'S2HumanInput', () => nextProps);
    nextEditor.draft('{"pending":true}');
    // Editing another parameter is still possible; it invalidates old execution/waits, never replays them.
    focus('parse'); ui.labelControl('参数 text', 'textarea').props.onChange({ target: { value: '{"changed":true}' } }); ui.render();
    assert.equal(host.waitingHumanInputs().length, 0);
    nextEditor.submit(); assert.ok(nextEditor.text().includes('失效')); assert.equal(nextEditor.input().props.value, '{"pending":true}');
    assert.equal(host.remainingCalls, 64); assert.equal(ui.modelCalls(), 2);
    ui.dispose();
    assert.throws(() => oldProps.onCommit({ afterEnd: true }, oldBase), /过期/);
    assert.equal(host.history().length, 0); assert.equal(network, 0);
    const parameterMarkup = renderToStaticMarkup(<S2JsonParameter nodeId="safe" portId="value" sourceKey="source" disabled={false}
      drafts={new Map([['["safe","value"]', { base: 'source', draft: '<script>text only</script>', state: 'invalid' }]])} onCommit={() => {}} />);
    const humanMarkup = renderToStaticMarkup(<S2HumanInput wait={nextProps.wait} onSubmit={nextProps.onSubmit} onCancel={nextProps.onCancel} disabled={false}
      drafts={new Map([[JSON.stringify([nextProps.wait.workflowId, nextProps.wait.id, nextProps.wait.revision]), { draft: '<script>text only</script>', state: 'invalid' }]])} />);
    for (const markup of [parameterMarkup, humanMarkup]) {
      assert.ok(!markup.includes('<script>')); assert.ok(markup.includes('&lt;script&gt;'));
      assert.ok(markup.includes('aria-invalid="true"') && markup.includes('aria-describedby=') && markup.includes('role="alert"'));
    }
  } finally { ui.dispose(); }
  console.log('S2 control lifecycle passed: real JSON/human editors and production host callbacks, persistent private drafts, conflict/reload and stale binding/wire checks, typed atomic commit, native/shortcut/IME/double-submit guards, source-bound metadata and live wait projection, discussion while waiting, no stale cancel of resumed work, edit/end invalidation and zero real IO. Offline synthetic only.');
} finally { globalThis.fetch = prior; }
