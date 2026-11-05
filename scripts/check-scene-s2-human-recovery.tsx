import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { createS2Scene, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import { S2HumanInput } from '../src/components/scene/S2HumanInput';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import type { S2Document } from '../src/types/sceneS2';
import { harness } from './scene-s2-ui-harness';

// Production human form handlers; only React scheduling and artifact display are test substitutes.
function formHarness(props: () => React.ComponentProps<typeof S2HumanInput>) {
  const slots: any[] = []; let cursor = 0, tree: any;
  const react = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(initial: any) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2HumanInput.tsx', 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { exports, JSON, Error, require: (name: string) => name === 'react' ? react : { S2ArtifactView: 'artifact' } });
  const render = () => { cursor = 0; tree = exports.S2HumanInput(props()); };
  const elements = (value: any = tree): any[] => Array.isArray(value) ? value.flatMap(item => elements(item ?? null)) : value && typeof value === 'object' ? [value, ...elements(value.children ?? [])] : [];
  const text = (value: any = tree): string => Array.isArray(value) ? value.map(item => text(item ?? null)).join('') : value && typeof value === 'object' ? text(value.children ?? []) : String(value ?? '');
  render(); return { render, elements, text,
    draft(value: string) { elements().find(item => item.type === 'textarea').props.onChange({ target: { value } }); render(); },
    submit() { elements().find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }); render(); },
    button(label: string) { const found = elements().find(item => item.type === 'button' && text(item) === label); assert.ok(found, label); return found.props.onClick; },
  };
}
const definition = importS2Workspace(readFileSync('scripts/fixtures/s2-human-recovery-workspace.json', 'utf8'));
const originalDefinition = JSON.stringify(definition), uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Human recovery tests must not access IO'); };
try {
  for (const deferred of [false, true]) {
    const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: 'Synthetic human recovery', knowledgePoints: [], interactionPack: null }); scene.canvasWorkspace = structuredClone(definition);
    let host!: S2PluginHost;
    const ui = harness({ initialDraft: scene, deferStateUpdates: deferred, onHost: value => { host = value; } }); uis.push(ui);
    ui.button('开始试验').props.onClick(); ui.render();
    const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const settle = async (test: () => boolean) => { for (let i = 0; i < 500; i++) { ui.render(); if (test()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Local UI did not settle'); };
    const queue = async (id: string) => { focus(id); ui.button('运行所选步骤').props.onClick(); ui.render(); const run = host.workflowHistory().at(-1)!; await settle(() => host.workflowHistory().find(item => item.id === run.id)!.status === 'waiting'); return run.id; };
    const human = (runId: string) => { const input = ui.elements().find(item => item.type === 'human-input' && item.props.wait.workflowId === runId); assert.ok(input); return { ...input, props: input.props as React.ComponentProps<typeof S2HumanInput> }; };
    const label = (runId: string, id: string) => `${s2ConnectionNodeLabel(definition, document(), id)} · 第 ${host.workflowHistory().findIndex(run => run.id === runId) + 1} 次运行`;
    const navigation = (runId: string, id: string, confirm = false) => ui.button(`${confirm ? '前往确认' : '前往填写'} · ${label(runId, id)}`).props.onClick;
    const ledger = () => JSON.stringify([document(), host.history(), host.workflowHistory(), host.remainingCalls, ui.modelCalls(), ui.saved]);

    const first = await queue('result'), second = await queue('text');
    assert.equal(host.waitingHumanInputs().length, 2); assert.equal(host.remainingCalls, 63); assert.equal(host.history().length, 1);
    const overview = ui.elements().find(item => item.props['aria-label'] === '等待你的操作'); assert.ok(overview); assert.match(ui.text(overview), /等待不是失败/);
    assert.ok(ui.text(overview).includes('第 1 次运行') && ui.text(overview).includes('第 2 次运行'));
    let currentInput = human(first).props;
    const form = formHarness(() => currentInput); form.draft('{"未完成":');
    let focused = 0, scrolled = 0;
    assert.equal(typeof currentInput.panelRef, 'function');
    if (typeof currentInput.panelRef === 'function') currentInput.panelRef({ focus() { focused++; }, scrollIntoView() { scrolled++; } } as unknown as HTMLElement);
    const before = ledger(), draftBefore = JSON.stringify([...currentInput.drafts]), oldLocate = navigation(first, 'ask');
    const staleHistoryCancel = ui.button('取消第 1 次运行（保留已完成记录）').props.onClick;
    const readArtifact = host.currentArtifact; host.currentArtifact = () => { throw new Error('Navigation cannot read material'); };
    oldLocate(); host.currentArtifact = readArtifact; ui.render();
    assert.equal(focused, 1); assert.equal(scrolled, 1); assert.equal(ledger(), before); assert.equal(JSON.stringify([...currentInput.drafts]), draftBefore);
    assert.equal(ui.labelControl('选择执行节点', 'select').props.value, 'ask');
    assert.ok(!ui.flow().props.nodes.some((node: any) => node.id === 'inner'), 'Navigate to actual innermost members');
    oldLocate(); staleHistoryCancel(); ui.render(); assert.equal(focused, 1); assert.equal(ledger(), before);
    assert.match(ui.text(), /入口已过期/);

    currentInput = human(first).props; const oldSubmit = currentInput.onSubmit;
    const freshCancel = deferred ? currentInput.onCancel : ui.button('取消第 1 次运行（保留已完成记录）').props.onClick;
    freshCancel(); if (!deferred) freshCancel();
    await settle(() => host.workflowHistory().find(run => run.id === first)!.status === 'cancelled');
    assert.equal(host.waitingHumanInputs().length, 1); assert.equal(host.waitingHumanInputs()[0].workflowId, second);
    assert.equal(host.history().length, 1); assert.equal(host.remainingCalls, 63);
    assert.throws(() => oldSubmit({ forged: true }), /失效/); assert.equal(host.history().length, 1);
    assert.match(ui.text(), /所有尚未完成的步骤和等待/); assert.match(ui.text(), /不会自动重试/);

    let textProps = human(second).props; const textForm = formHarness(() => textProps), rawText = '  合成说明\n第二行  ';
    textForm.draft(rawText); textForm.submit();
    await settle(() => host.workflowHistory().find(run => run.id === second)!.status === 'succeeded');
    assert.match(ui.text(), /已接收.*输入；所属运行会继续处理/);
    const textNode = host.workflowHistory().find(run => run.id === second)!.nodes[0], textArtifact = host.currentArtifact(textNode.artifactIds[0]);
    assert.deepEqual(textArtifact.payload, { kind: 'inline', value: rawText }); assert.equal(host.remainingCalls, 63);
    staleHistoryCancel(); ui.render(); assert.equal(host.workflowHistory().find(run => run.id === second)!.status, 'succeeded');

    const third = await queue('result'); let replacement = human(third).props;
    assert.notEqual(replacement.wait.id, currentInput.wait.id); const replacementForm = formHarness(() => replacement);
    assert.equal(replacementForm.elements().find(item => item.type === 'textarea').props.value, '');
    replacementForm.draft('{invalid'); replacementForm.submit();
    assert.match(replacementForm.text(), /草稿已保留，等待尚未解除/); assert.equal(host.waitingHumanInputs().length, 1); assert.equal(host.remainingCalls, 63);
    replacementForm.draft('{"分数":0,"完成":false,"备注":null}'); const submit = replacementForm.elements().find(item => item.type === 'form').props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
    await settle(() => host.workflowHistory().find(run => run.id === third)!.status === 'succeeded');
    const done = host.workflowHistory().find(run => run.id === third)!;
    assert.equal(done.nodes.find(node => node.nodeId === 'parse')!.status, 'cached'); assert.equal(host.history().length, 2); assert.equal(host.remainingCalls, 62);
    const result = host.currentArtifact(done.nodes.find(node => node.nodeId === 'result')!.artifactIds[0]);
    assert.deepEqual(result.payload, { kind: 'inline', value: '{"分数":0,"备注":null,"完成":false}' });
    oldLocate(); ui.render(); assert.equal(host.workflowHistory().find(run => run.id === third)!.status, 'succeeded');

    const fourth = await queue('approved'); const confirmProps = human(fourth).props, confirmForm = formHarness(() => confirmProps);
    assert.match(confirmForm.text(), /不同意.*不等于取消运行/); const oldApprove = confirmForm.button('同意并继续');
    confirmForm.button('不同意并继续')();
    await settle(() => host.workflowHistory().find(run => run.id === fourth)!.status === 'succeeded');
    const rejected = host.workflowHistory().find(run => run.id === fourth)!;
    assert.equal(rejected.nodes.find(node => node.nodeId === 'confirm')!.humanEvidence!.approved, false);
    assert.match(ui.text(), /已接收.*确认选择/);
    assert.equal(rejected.nodes.find(node => node.nodeId === 'approved')!.status, 'skipped'); assert.equal(host.remainingCalls, 62);
    oldApprove(); ui.render(); assert.equal(host.history().length, 2);

    // One cancellation also covers every pending human operation in the SAME run, not just its clicked form.
    ui.button('运行全部步骤').props.onClick(); ui.render(); const allRun = host.workflowHistory().at(-1)!;
    await settle(() => host.waitingHumanInputs().filter(wait => wait.workflowId === allRun.id).length === 3 && host.workflowHistory().at(-1)!.status === 'waiting');
    const allControls = ui.elements().filter(item => item.type === 'human-input' && item.props.wait.workflowId === allRun.id);
    assert.equal(allControls.length, 3); const oldOtherSubmit = allControls[1].props.onSubmit;
    allControls[0].props.onCancel(); await settle(() => host.workflowHistory().find(run => run.id === allRun.id)!.status === 'cancelled');
    assert.equal(host.waitingHumanInputs().length, 0); assert.throws(() => oldOtherSubmit('late answer'), /失效/);
    assert.equal(host.remainingCalls, 62); assert.equal(host.history().length, 2);

    const fifth = await queue('result'), oldFifthLocate = navigation(fifth, 'ask'), fifthCancel = human(fifth).props.onCancel;
    focus('text'); focus('result'); const untouched = ledger(); oldFifthLocate(); ui.render(); assert.equal(ledger(), untouched);
    assert.throws(() => fifthCancel(), /入口已过期/);
    const beforeEdit = JSON.stringify(document()), preEditCancel = human(fifth).props.onCancel, preEditLocate = navigation(fifth, 'ask');
    ui.button('＋参考材料').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); assert.equal(JSON.stringify(document()), beforeEdit);
    const sixth = await queue('result'), sixthBefore = ledger(); preEditLocate(); assert.throws(() => preEditCancel(), /失效|入口已过期/); ui.render(); assert.equal(ledger(), sixthBefore);
    const endLocate = navigation(sixth, 'ask'), endCancel = human(sixth).props.onCancel;
    ui.button('结束试验').props.onClick(); endLocate(); assert.throws(() => endCancel(), /失效|入口已过期/); ui.render();
    assert.equal(host.waitingHumanInputs().length, 0); assert.equal(host.workflowHistory().at(-1)!.status, 'cancelled');
    assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0);
  }
  // Concise wait state plus distinct actual actions separates user input/choice from model consent.
  const registry = s2BuiltinPluginRegistry();
  for (const [pluginId, capabilityId, expected] of [
    ['human-input', 'json', /前往填写/], ['human-input', 'text', /前往填写/],
    ['human-input', 'confirm', /前往确认/], ['model-test', 'generate', /核对本次模型请求/],
  ] as const) {
    const node = { pluginId, pluginVersion: '1.0.0', capabilityId };
    const markup = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView {...({ data: { title: '<练习步骤>', node,
      capability: registry.capability(node), status: 'waiting', artifacts: [], ...(pluginId === 'human-input' ? { onOpenHumanInput() {} } : { onOpenModelRequest() {} }) } } as any)} /></ReactFlowProvider>);
    assert.match(markup, /等待你的操作/); assert.match(markup, expected);
    if (pluginId === 'model-test') { assert.match(markup, /调用模型需确认/); assert.ok(!markup.includes('前往填写')); }
    else assert.ok(!markup.includes('核对本次模型请求'));
    assert.ok(!markup.includes('等待用户输入；')); assert.ok(!markup.includes('<练习步骤>'));
  }
  assert.equal(network, 0); assert.equal(JSON.stringify(definition), originalDefinition);
  console.log('S2 human recovery passed: named run-scoped overview and canvas/history navigation, exact innermost form focus requests without material reads or execution, preserved drafts and invalid JSON, separate user submission/resume with native falsy values and cached upstream, disagreement data vs cancellation, whole-current-run cancellation of three human waits with unrelated runs retained, stale/duplicate/edit-undo/end guards under deferred hooks, distinct human/model wait text, and zero model/resource IO. Browser focus is verified separately.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = oldFetch; }
