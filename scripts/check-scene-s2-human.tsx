import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createS2Scene, readS2Definition, applyS2Commands, exportS2Workspace, importS2Workspace, interactS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, executeS2JsonCheck, type S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { executeS2Structured } from '../src/services/scene/sceneS2Structured';
import { s2ComposableCapabilities, s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { readS2PluginRequest } from '../src/services/scene/sceneS2PluginProtocol';
import { S2HumanInput } from '../src/components/scene/S2HumanInput';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';

globalThis.fetch = async () => assert.fail('Human-input checks are local, synthetic and never call real models or external tools');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic human input', sceneSkill: 'S2', knowledgePoints: [] });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId) && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const literal = (value: any) => ({ kind: 'literal' as const, value });
const node = (id: string, pluginId: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, pluginId, pluginVersion: '1.0.0', capabilityId, position: { x: 100, y: 100 }, bindings });
const document: S2Document = { nodes: [{ ...scene.canvasWorkspace!.initial.nodes[0], values: { content: '{"tag":"keep"}' } }], edges: [], execution: { version: 1, nodes: [
  node('parse', 'structured-data', 'parse-json', { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } }),
  node('ask', 'human-input', 'json', { prompt: literal('补充完整 JSON，保留上游结果') }),
  node('view', 'structured-view', 'json-tree'), node('independent', 'json-check', 'validate', { text: literal('{}') }),
], links: [
  { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'ask', portId: 'context' } },
  { source: { nodeId: 'ask', portId: 'value' }, target: { nodeId: 'view', portId: 'value' } },
] } };
const definition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial: document });
const strategy = { goal: definition.goal, ...definition.instructions }, allHosts: S2PluginHost[] = [];
function hostFor(doc = document) { const host = new S2PluginHost(scene.sceneId, plugins); host.setDocument(doc); allHosts.push(host); return host; }
async function status(host: S2PluginHost, id: string, expected = 'waiting') {
  for (let i = 0; i < 500; i++) { const run = host.workflowHistory().find(run => run.id === id)!; if (run.status === expected) return run; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail(`Run did not reach ${expected}`);
}
async function completed(job: { completion: Promise<S2WorkflowRun> }) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([job.completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic workflow deadline')), 2500); })]); }
  finally { clearTimeout(timer!); }
}
const state = (run: S2WorkflowRun, id: string) => run.nodes.find(node => node.nodeId === id)!;
const host = hostFor(), first = host.enqueueWorkflow(['view', 'independent']);
const waiting = await status(host, first.id); assert.equal(state(waiting, 'parse').status, 'succeeded'); assert.equal(state(waiting, 'independent').status, 'succeeded'); assert.equal(state(waiting, 'view').status, 'pending');
assert.equal(host.remainingCalls, 62); assert.equal(host.history().length, 2);
const wait = host.waitingHumanInputs()[0]; assert.equal(wait.artifacts[0].payload.kind === 'inline' && (wait.artifacts[0].payload.value as any).tag, 'keep');
assert.throws(() => host.submitHumanInput('other-workflow', wait.id, {}), /失效/); assert.throws(() => host.submitHumanInput(first.id, 'forged-wait', {}), /失效/);
assert.equal((await completed(host.enqueueWorkflow(['parse']))).status, 'succeeded', 'Other queue work must not be held behind a user wait');
assert.equal(host.remainingCalls, 62);
for (const value of [undefined, JSON.parse('{"__proto__":true}'), 'x'.repeat(25000)]) assert.throws(() => host.submitHumanInput(first.id, wait.id, value));
assert.equal(host.waitingHumanInputs().length, 1); assert.equal(host.history().length, 2);
const markup = renderToStaticMarkup(<S2HumanInput wait={{ ...wait, prompt: '<img onerror=x>' }} nodeLabel="补充练习要求" disabled={false} onSubmit={() => {}} onCancel={() => {}} />);
assert.ok(markup.includes('补充数据（JSON 格式）')); assert.ok(markup.includes('&lt;img')); assert.ok(!markup.includes('<img'));
assert.ok(markup.includes('<h4>补充练习要求 · 等待你补充材料</h4>'));
assert.ok(markup.includes('aria-label="需要你补充材料：补充练习要求"'));
assert.ok(markup.includes('<details><summary>技术详情</summary>'), 'Technical identities stay inside a collapsed disclosure');
assert.ok(!markup.slice(0, markup.indexOf('<details>')).includes(`步骤编号：${wait.nodeId}`));
assert.ok(markup.includes('聊天不会代替这里的提交') && markup.includes('参考材料'));
host.submitHumanInput(first.id, wait.id, { new: true });
assert.throws(() => host.submitHumanInput(first.id, wait.id, { duplicate: true }), /失效|已提交/);
const done = await completed(first); assert.equal(done.status, 'succeeded'); assert.equal(state(done, 'view').status, 'displayed');
assert.equal(host.history().length, 2); assert.equal(host.remainingCalls, 62, 'Resume reuses this run outputs without replaying upstream');
const input = host.currentArtifact(state(done, 'ask').artifactIds[0]); assert.equal(input.source.kind, 'user'); assert.equal(input.source.invocationId, undefined);
assert.deepEqual(input.payload.kind === 'inline' && input.payload.value, { new: true }); assert.equal(state(done, 'ask').invocationId, undefined);
const context = host.prepare('ask', strategy, 'explain'); assert.ok(context.humanInputs.some(item => item.artifactId === input.id)); assert.ok(context.frame.availableArtifactIds.includes(input.id));
const second = host.enqueueWorkflow(['view']); await status(host, second.id); const secondWait = host.waitingHumanInputs()[0]; assert.notEqual(secondWait.id, wait.id);
host.submitHumanInput(second.id, secondWait.id, null); assert.equal((await completed(second)).status, 'succeeded'); assert.equal(host.remainingCalls, 62, 'User answers are never cached, pure upstream still can be cached');
// Execute the real form handlers with deterministic hooks, including same-frame double-submit protection.
function formHarness(wait: ReturnType<S2PluginHost['waitingHumanInputs']>[number], submit: (value: unknown) => void,
  options: Partial<React.ComponentProps<typeof S2HumanInput>> = {}) {
  const slots: any[] = []; let cursor = 0, tree: any;
  const ReactStub = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState: (value: any) => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef: (value: any) => { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; } };
  const output = ts.transpileModule(readFileSync('src/components/scene/S2HumanInput.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const exports: any = {}; vm.runInNewContext(output, { exports, JSON, Error, require: (name: string) => name === 'react' ? ReactStub : { S2ArtifactView: 'artifact' } });
  const render = () => { cursor = 0; tree = exports.S2HumanInput({ wait, disabled: false, onSubmit: submit, onCancel: () => {}, ...options }); };
  const elements = (node: any = tree): any[] => Array.isArray(node) ? node.flatMap(child => elements(child ?? null)) : node && typeof node === 'object' ? [node, ...elements(node.children ?? [])] : [];
  const text = (node: any = tree): string => Array.isArray(node) ? node.map(child => text(child ?? null)).join('') : node && typeof node === 'object' ? text(node.children ?? []) : String(node ?? '');
  render(); return { render, elements, text, draft(value: string) { elements().find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); },
    button(label: string) { const button = elements().find(node => node.type === 'button' && text(node) === label); assert.ok(button, `Button missing: ${label}`); return button; },
    submit() { elements().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); } };
}
const formJob = host.enqueueWorkflow(['view']); await status(host, formJob.id); const formWait = host.waitingHumanInputs()[0]; let formCalls = 0;
const form = formHarness(formWait, value => { formCalls++; host.submitHumanInput(formJob.id, formWait.id, value); });
form.draft('{bad'); form.submit(); assert.equal(formCalls, 0); assert.ok(form.text().includes('JSON 格式无效')); assert.equal(form.elements().find(node => node.type === 'textarea').props.value, '{bad');
assert.ok(form.elements().find(node => node.type === 'textarea').props['aria-describedby'].includes(form.elements().find(node => node.props.role === 'alert').props.id));
form.draft('{"__proto__":true}'); form.submit(); assert.equal(formCalls, 1); assert.equal(host.waitingHumanInputs().length, 1); assert.equal(form.elements().find(node => node.type === 'textarea').props.value, '{"__proto__":true}');
form.draft('[{"name":"B"}]'); const originalFormHandler = form.elements().find(node => node.type === 'form').props.onSubmit;
originalFormHandler({ preventDefault() {} }); originalFormHandler({ preventDefault() {} }); assert.equal(formCalls, 2, 'Only one valid same-frame submit'); await completed(formJob);
form.render(); assert.ok(form.text().includes('已提交，流程将继续处理。')); assert.equal(form.elements().find(node => node.type === 'textarea').props.disabled, true);
const exported = exportS2Workspace(definition, document); assert.deepEqual(importS2Workspace(exported), definition); assert.ok(!exported.includes(wait.id)); assert.ok(!exported.includes('humanEvidence'));

// Naming and cancel feedback are presentation-only: keep draft/error/host guards intact.
const draftStore = new Map(), displayWait = { ...formWait, artifacts: [] }; let cancellations = 0;
const cancelledForm = formHarness(displayWait, () => assert.fail('Cancellation must not submit a value'), {
  nodeLabel: '填写背景材料', drafts: draftStore, onCancel: () => { cancellations++; },
});
cancelledForm.draft('{"unfinished":');
const cancelButton = cancelledForm.button('取消本次运行（保留已完成记录）'); cancelButton.props.onClick(); cancelButton.props.onClick(); cancelledForm.render();
assert.equal(cancellations, 1); assert.ok(cancelledForm.text().includes('已请求取消本次运行，已完成的记录仍保留；最终状态请查看运行记录。'));
assert.ok(cancelledForm.elements().find(node => node.type === 'details' && !node.props.open));
assert.ok(!cancelledForm.elements().some(node => node.props['aria-label'] === '供你参考的材料'), 'Empty contexts add no empty reference panel');
const staleCancel = formHarness(displayWait, () => assert.fail('Stale cancellation must not submit'), {
  onCancel: () => { throw new Error('等待已变化，未取消其他运行'); },
});
staleCancel.draft('{"keep":'); staleCancel.button('取消本次运行（保留已完成记录）').props.onClick(); staleCancel.render();
assert.equal(staleCancel.elements().find(node => node.type === 'textarea').props.value, '{"keep":'); assert.ok(staleCancel.text().includes('未取消其他运行'));
assert.equal(staleCancel.text(staleCancel.elements().find(node => node.type === 'h4')), '本步骤 · 等待你补充材料');

// Boolean confirmation is typed user data and controls explicit approved/rejected branches.
const confirmDoc = structuredClone(document); confirmDoc.execution = { version: 1, nodes: [node('approve', 'human-input', 'confirm', { prompt: literal('同意继续吗？'), context: literal({ message: 'synthetic' }) }),
  { ...node('yes', 'json-check', 'validate', { text: literal('{}') }), when: { nodeId: 'approve', portId: 'decision', pointer: '/approved', equals: true, match: true } },
  { ...node('no', 'json-check', 'validate', { text: literal('{}') }), when: { nodeId: 'approve', portId: 'decision', pointer: '/approved', equals: true, match: false } },
], links: [] };
readS2Definition({ ...definition, initial: confirmDoc }); const confirmHost = hostFor(confirmDoc), rejected = confirmHost.enqueueWorkflow(['yes', 'no']); await status(confirmHost, rejected.id);
const rejectWait = confirmHost.waitingHumanInputs()[0]; assert.throws(() => confirmHost.submitHumanInput(rejected.id, rejectWait.id, 'yes'), /明确/);
let rejectCalls = 0;
const rejectForm = formHarness(rejectWait, value => { rejectCalls++; confirmHost.submitHumanInput(rejected.id, rejectWait.id, value); }, {
  nodeLabel: '确认练习要求', onCancel: () => assert.fail('Disagreement is data, not workflow cancellation'),
});
assert.equal(rejectForm.text(rejectForm.elements().find(node => node.type === 'h4')), '确认练习要求 · 等待你确认');
assert.ok(rejectForm.text().includes('“不同意”不等于取消运行'));
const rejectButton = rejectForm.button('不同意并继续'); assert.ok(rejectButton.props['aria-describedby']);
rejectButton.props.onClick(); rejectButton.props.onClick(); assert.equal(rejectCalls, 1);
const rejectedRun = await completed(rejected);
assert.equal(rejectedRun.status, 'succeeded'); assert.equal(state(rejectedRun, 'yes').status, 'skipped'); assert.equal(state(rejectedRun, 'no').status, 'succeeded'); assert.equal(state(rejectedRun, 'approve').humanEvidence!.approved, false); assert.equal(confirmHost.remainingCalls, 63);
const approved = confirmHost.enqueueWorkflow(['yes', 'no']); await status(confirmHost, approved.id); confirmHost.submitHumanInput(approved.id, confirmHost.waitingHumanInputs()[0].id, true);
assert.equal(state(await completed(approved), 'yes').status, 'succeeded'); assert.equal(state(await completed(approved), 'no').status, 'skipped');

// Text is preserved exactly; layout does not invalidate a wait, but any semantic edit does.
const textDoc = structuredClone(document); textDoc.execution = { version: 1, nodes: [node('text', 'human-input', 'text', { prompt: literal('填写原文') }), node('check', 'json-check', 'validate')], links: [{ source: { nodeId: 'text', portId: 'text' }, target: { nodeId: 'check', portId: 'text' } }] };
const textHost = hostFor(textDoc), textJob = textHost.enqueueWorkflow(['check']); await status(textHost, textJob.id); const textWait = textHost.waitingHumanInputs()[0];
assert.throws(() => textHost.submitHumanInput(textJob.id, textWait.id, '   '), /非空/); assert.throws(() => textHost.submitHumanInput(textJob.id, textWait.id, 'x'.repeat(6001)));
const layout = structuredClone(textDoc); layout.execution!.nodes[0].position.x += 50; textHost.setDocument(layout);
const exact = '  {"raw":true}\n'; textHost.submitHumanInput(textJob.id, textWait.id, exact); const textDone = await completed(textJob);
assert.equal(textHost.currentArtifact(state(textDone, 'text').artifactIds[0]).payload.kind === 'inline' && (textHost.currentArtifact(state(textDone, 'text').artifactIds[0]).payload as any).value, exact);
assert.equal(textHost.remainingCalls, 63);
const editJob = textHost.enqueueWorkflow(['check']); await status(textHost, editJob.id); const editWait = textHost.waitingHumanInputs()[0];
const edit = structuredClone(layout); edit.nodes[0].values.content = 'changed'; textHost.setDocument(edit);
assert.equal((await completed(editJob)).status, 'cancelled'); assert.equal((await completed(editJob)).publication, 'stale'); assert.equal(textHost.waitingHumanInputs().length, 0);
assert.throws(() => textHost.submitHumanInput(editJob.id, editWait.id, '{}'), /失效/);
textHost.setDocument(layout); assert.throws(() => textHost.submitHumanInput(editJob.id, editWait.id, '{}'), /失效/);

// Multiple simultaneous waits, independent branch progress, and explicit cancellation/end.
const multiple = structuredClone(textDoc); multiple.execution = { version: 1, nodes: [node('a', 'human-input', 'text', { prompt: literal('A') }), node('b', 'human-input', 'text', { prompt: literal('B') })], links: [] };
const multiHost = hostFor(multiple), multiJob = multiHost.enqueueWorkflow(); await status(multiHost, multiJob.id);
const multiWait = multiHost.waitingHumanInputs(); assert.equal(multiWait.length, 2); multiHost.submitHumanInput(multiJob.id, multiWait[0].id, 'a'); multiHost.submitHumanInput(multiJob.id, multiWait[1].id, 'b');
assert.equal((await completed(multiJob)).status, 'succeeded'); assert.equal(multiHost.remainingCalls, 64);
// A response can arrive while an independent branch is awaiting its adapter. A previously passed dependent
// must get a new segment, not be reported complete or cause the independent upstream to replay.
const concurrent = structuredClone(document); concurrent.execution = { version: 1, nodes: [
  node('a_human', 'human-input', 'text', { prompt: literal('并行输入') }), node('b_start', 'structured-data', 'parse-json', { text: literal('{}') }),
  node('a_next', 'json-check', 'validate'), node('b_slow', 'structured-data', 'stringify'),
], links: [{ source: { nodeId: 'a_human', portId: 'text' }, target: { nodeId: 'a_next', portId: 'text' } }, { source: { nodeId: 'b_start', portId: 'value' }, target: { nodeId: 'b_slow', portId: 'value' } }] };
let release!: () => void, slowStarted = false;
const gate = new Promise<void>(resolve => { release = resolve; });
const concurrentHost = new S2PluginHost(scene.sceneId, plugins, async (call, values, signal) => {
  if (call.nodeId === 'b_slow') { slowStarted = true; await gate; }
  return call.pluginId === 'json-check' ? executeS2JsonCheck(call, values, signal) : executeS2Structured(call, values);
}); allHosts.push(concurrentHost); concurrentHost.setDocument(concurrent); const concurrentJob = concurrentHost.enqueueWorkflow();
for (let i = 0; !slowStarted && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(slowStarted, true); assert.equal(state(concurrentHost.workflowHistory()[0], 'a_next').status, 'pending');
concurrentHost.submitHumanInput(concurrentJob.id, concurrentHost.waitingHumanInputs()[0].id, '{}'); release();
assert.equal((await completed(concurrentJob)).status, 'succeeded'); assert.equal(concurrentHost.history().length, 3); assert.equal(concurrentHost.remainingCalls, 61);
for (const action of ['cancel', 'end']) {
  const h = hostFor(), job = h.enqueueWorkflow(['view']); await status(h, job.id); const w = h.waitingHumanInputs()[0];
  if (action === 'cancel') h.cancelWorkflow(job.id); else h.close();
  assert.equal((await completed(job)).status, 'cancelled'); assert.equal(h.waitingHumanInputs().length, 0); assert.throws(() => h.submitHumanInput(job.id, w.id, {})); assert.equal(h.history().length, 1);
}
const failing = structuredClone(document); failing.nodes[0].values.content = '{bad'; const failHost = hostFor(failing), failJob = failHost.enqueueWorkflow(['view']);
assert.equal((await completed(failJob)).status, 'failed'); assert.equal(failHost.waitingHumanInputs().length, 0);

// No fake input by plugin APIs or Agent commands. A plain explanation does not answer a wait.
const beforeBudget = confirmHost.remainingCalls, prepared = confirmHost.prepare('approve', strategy, 'discuss');
const request = { nodeId: 'approve', pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'confirm', inputs: { prompt: [prepared.bindings[0].artifactId] }, reason: 'fake user' };
assert.throws(() => readS2PluginRequest(s2BuiltinPluginRegistry(), prepared.frame, request), /人工|工具/);
await assert.rejects(() => confirmHost.execute(request, prepared.frame, 'cannot-bypass'), /人工|工具/); assert.equal(confirmHost.remainingCalls, beforeBudget);
assert.throws(() => applyS2Commands(definition, document, [{ op: 'submit-human-input', value: 'fake' }]), /未授权/);
const discussJob = confirmHost.enqueueWorkflow(['yes']); await status(confirmHost, discussJob.id);
const reply = (value: unknown) => ({ content: JSON.stringify(value) } as any); let modelCalls = 0;
await interactS2Canvas({ ...scene, canvasWorkspace: { ...definition, initial: confirmDoc } }, confirmDoc, '解释一下，暂时不要回答确认', null, [], { pluginContext: confirmHost.prepare(null, strategy, 'explain'), invoke: async input => {
  modelCalls++; const data = JSON.parse(input.userInput);
  if (data.stage === 'turn-understand') { assert.ok(data.evidenceIndex.humanWaits.length); return reply({ understanding: '只解释', desiredOutcome: '理解确认边界', actions: ['reply'], constraints: [], questions: [] }); }
  assert.ok(input.systemPromptOverride!.includes('不能由Agent填写')); return reply({ understanding: '只解释', plan: '不作答', reply: '等待你的明确选择', commands: [] });
} });
assert.equal(modelCalls, 2); assert.equal(confirmHost.waitingHumanInputs().length, 1); confirmHost.cancelWorkflow(discussJob.id); await completed(discussJob);
for (const h of allHosts) h.close();
console.log('S2 human waits passed: text/JSON/explicit confirmation, exact raw user artifacts without fake plugin receipts/debit/cache, independent branches/queues, preserved upstream and multiple waits, rejection/approval branches, invalid/duplicate/foreign/stale/undo/end/failed-source protection, saved-design-only roundtrip, escaped accessible SSR, Agent cannot fill or execute a human answer. Synthetic local host/models only; not real-model semantic accuracy or restart recovery.');
