import assert from 'node:assert/strict';
import { harness } from './scene-s2-ui-harness';
import { experimentDefinition } from './fixtures/s2-experiment';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import type { S2InteractionConfig } from '../src/types/sceneS2Interaction';

// Real production component, public interaction engine and local runtime. Only
// provider IO is synthetic; never read settings, files, real notes or models.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Interaction UI fixtures prohibit network');
const live: ReturnType<typeof harness>[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle(ui: ReturnType<typeof harness>, done: () => boolean, label: string) {
  for (let i = 0; i < 180; i++) { ui.render(); if (done()) return; await tick(); }
  assert.fail(`${label}: ${ui.text().slice(0, 1400)}`);
}
function fixture(interaction?: S2InteractionConfig, holdModels = false) {
  const request = { source: 'custom' as const, sceneSkill: 'S2' as const, subject: '合成统一交互场景', knowledgePoints: [], interactionPack: { id: 'prompt-lab', version: '0.1.0' } };
  const definition: S2CanvasDefinition = { ...structuredClone(experimentDefinition),
    instructions: { understanding: '理解当前任务与公开数据', planning: '按本轮范围完成用户要求或事件任务', response: '解释依据；操作结果由本地记录确定' },
    ...(interaction ? { interaction } : {}) };
  const draft = { ...createS2Scene(request), canvasWorkspace: definition };
  let host: S2PluginHost | undefined;
  const modelInputs: Array<{ prompt: string; userInput: string }> = [];
  const releaseModels: Array<() => void> = [];
  const options: Parameters<typeof harness>[0] = { initialDraft: draft, initialRequest: request, onHost(value) { host = value; },
    modelProvider: async () => ({ providerLabel: '合成服务', model: 'synthetic-interaction', resourceId: 'SyntheticInteractionProvider', supportsImages: false,
      createSession(sceneId, runId, limits) { return new S2ModelTestSession({ sceneId, runId, limits, providerId: 'synthetic', providerLabel: '合成服务', model: 'synthetic-interaction', resourceId: 'SyntheticInteractionProvider',
        invoke: async input => { modelInputs.push({ prompt: input.systemPromptOverride!, userInput: input.userInput });
          if (holdModels) await new Promise<void>(resolve => releaseModels.push(resolve));
          return { content: '合成测试结果：完整返回', diagnostics: { finishReason: 'stop' } }; } }); } }),
  };
  const ui = harness(options); live.push(ui);
  return { ui, options, host: () => { assert.ok(host, 'Local scene session'); return host; }, modelInputs, releaseModels };
}
function node(ui: ReturnType<typeof harness>, id: string) { const found = ui.flow().props.nodes.find((value: any) => value.id === id); assert.ok(found, id); return found; }
function send(ui: ReturnType<typeof harness>, value: string) {
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value } }); ui.render();
  const button = ui.button('发送'); assert.equal(button.props.disabled, false); button.props.onClick(); ui.render();
}
function edit(ui: ReturnType<typeof harness>, id: string, value: string) {
  node(ui, id).data.fields[0].startEdit(); ui.render();
  const field = node(ui, id).data.fields[0]; assert.ok(field.editor, 'Inline field editor');
  field.editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: id, fieldId: field.id, previousValue: field.value, value });
  field.editor.props.onDone(); ui.render();
}
function modelInput(ui: ReturnType<typeof harness>) { const request = ui.publicInvocation(); assert.ok(request); return request.input as any; }
function modelPrompt(ui: ReturnType<typeof harness>) { const request = ui.publicInvocation(); assert.ok(request); return request.prompt; }
async function idle(ui: ReturnType<typeof harness>) { await settle(ui, () => !ui.text().includes('助手正在'), 'Interaction settles'); }
async function ready(ui: ReturnType<typeof harness>) { await settle(ui, () => ui.elements().some(item => item.type === 'flow'), 'Loaded public canvas'); }

try {
  const ordinary = fixture();
  await ready(ordinary.ui);
  send(ordinary.ui, '解释当前连线的含义，不运行。');
  await settle(ordinary.ui, () => ordinary.ui.publicModelCalls() === 1, 'First public user invocation');
  assert.deepEqual(Object.keys(modelInput(ordinary.ui)).sort(), ['context', 'origin', 'scope', 'task']);
  assert.equal(modelInput(ordinary.ui).origin, 'user');
  assert.equal(modelInput(ordinary.ui).task, '解释当前连线的含义，不运行。');
  assert.deepEqual(modelInput(ordinary.ui).scope.actions, ['reply', 'edit', 'execute']);
  assert.equal(modelInput(ordinary.ui).context.canvas.representation, 'public-index');
  assert.equal(modelInput(ordinary.ui).context.actionGuide, undefined);
  assert(!modelPrompt(ordinary.ui).includes('resultIds:'), 'No result method is taught before any public result exists');
  assert(!modelPrompt(ordinary.ui).includes('eventData'), 'A user message has no custom-event payload');
  assert(!modelPrompt(ordinary.ui).includes('cancel{'), 'No cancellation method is taught before a current active execution exists');
  assert(modelInput(ordinary.ui).context.canvas.nodes.every((item: any) => !Object.hasOwn(item, 'values')));
  assert(!JSON.stringify(modelInput(ordinary.ui)).includes('确认偏误：人们更容易寻找支持已有看法的信息。'), 'Scene material bodies are not sent before reading');
  assert.equal(ordinary.ui.origin(), undefined, 'Public input never uses the legacy S2AgentReply mock');
  ordinary.ui.resolvePublicModel(JSON.stringify({ reply: '连线把内容送入组装块，再由测试块返回结果。' }));
  await settle(ordinary.ui, () => ordinary.ui.text().includes('连线把内容送入组装块'), 'One-call reply renders');
  assert.equal(ordinary.ui.publicModelCalls(), 1); assert.equal(ordinary.host().history().length, 0);
  assert.equal(ordinary.modelInputs.length, 0);

  // Acquisition errors are surfaced before the first host exists, even if a
  // user sends text in the same turn that starts an asynchronous scene save.
  const savingFirst = fixture(); await ready(savingFirst.ui);
  savingFirst.ui.button('保存场景').props.onClick(); savingFirst.ui.render();
  send(savingFirst.ui, '保存过程中解释当前场景。');
  await settle(savingFirst.ui, () => savingFirst.ui.text().includes('场景正在准备或保存'), 'First-session save acquisition error appears');
  assert.equal(savingFirst.ui.publicModelCalls(), 0); assert.equal(savingFirst.modelInputs.length, 0);
  for (let i = 0; i < 3; i++) { await tick(); savingFirst.ui.render(); }
  send(savingFirst.ui, '保存结束后解释当前场景。');
  await settle(savingFirst.ui, () => savingFirst.ui.publicModelCalls() === 1, 'Acquisition recovers after save');
  savingFirst.ui.resolvePublicModel({ reply: '保存后可正常协作。' }); await idle(savingFirst.ui);

  send(ordinary.ui, '把任务改成更具体的要求，然后测试并展示结果。');
  await settle(ordinary.ui, () => ordinary.ui.publicModelCalls() === 2, 'Edit and execute public invocation');
  assert.equal(modelInput(ordinary.ui).context.components, undefined, 'Editing starts from the same index-only public view');
  const contentComponent = modelInput(ordinary.ui).context.canvas.nodes.find((item: any) => item.id === 'task').componentId;
  ordinary.ui.resolvePublicModel({ read: { interfaces: [{ componentId: contentComponent, parameters: ['content'] }] } });
  await settle(ordinary.ui, () => ordinary.ui.publicModelCalls() === 3, 'Only the editable component interface is disclosed');
  assert.equal(modelInput(ordinary.ui).context.components, undefined, 'A parameter edit does not require the whole component');
  const detail = modelInput(ordinary.ui).context.interfaces.find((component: any) => component.componentId === contentComponent);
  assert.equal(detail.representation, 'selected-interface');
  assert.deepEqual(detail.parameters.map((parameter: any) => parameter.id), ['content']);
  assert.equal(detail.inputs, undefined); assert.equal(detail.outputs, undefined);
  assert.ok(detail.parameters.some((parameter: any) => parameter.id === 'content' && parameter.field.maxLength === 6000));
  assert.ok(modelInput(ordinary.ui).context.componentRules);
  assert.ok(modelInput(ordinary.ui).context.actionGuide.includes('setValues{'));
  assert.ok(modelInput(ordinary.ui).context.actionGuide.includes('addNode{'));
  assert.ok(!modelPrompt(ordinary.ui).includes('addNode{'), 'After editing disclosure, creation grammar stays in actionGuide without a duplicate system copy');
  assert.ok(!modelInput(ordinary.ui).context.actionGuide.includes('connect{'));
  assert.ok(!modelInput(ordinary.ui).context.actionGuide.includes('disconnect{'));
  ordinary.ui.resolvePublicModel({ actions: [
    { type: 'setValues', nodeId: 'task', values: { content: '只用一句话解释确认偏误。' } },
    { type: 'run', targetNodeIds: ['testModel', 'showResult'] },
  ], reply: '按要求更新任务并进行一次测试。' });
  await settle(ordinary.ui, () => ordinary.modelInputs.length === 1 && ordinary.host().workflowHistory().at(-1)?.status === 'succeeded', 'Edit then real local model workflow');
  await idle(ordinary.ui);
  assert.equal(node(ordinary.ui, 'task').data.fields[0].value, '只用一句话解释确认偏误。');
  assert.ok(ordinary.modelInputs[0].prompt.includes('只用一句话解释确认偏误。'));
  assert.equal(ordinary.modelInputs[0].userInput, '确认偏误：人们更容易寻找支持已有看法的信息。');
  assert.equal(ordinary.host().history().filter(item => item.request.nodeId === 'testModel').length, 1);
  assert.equal(ordinary.host().waitingModelTests().length, 0, 'No extra request confirmation is introduced');
  assert.ok(node(ordinary.ui, 'showResult').data.artifacts.some((item: any) => item.payload.kind === 'inline' && item.payload.value === '合成测试结果：完整返回'));
  for (let i = 0; i < 5; i++) { await tick(); ordinary.ui.render(); }
  assert.equal(ordinary.ui.publicModelCalls(), 3, 'No configured event means no automatic Agent call');
  for (const label of ['应用助手修改', '确认运行', '确认执行', '开始试验', '开启助手', '关闭助手'])
    assert.ok(!ordinary.ui.elements().some(item => item.type === 'button' && ordinary.ui.text(item) === label), label);

  async function automaticResponse() {
    const automatic = fixture({ version: 1, triggers: [{ id: 'ExplainResult', on: { event: 's2.node.succeeded', nodeId: 'testModel' },
      task: '仅解释这次已完成测试的返回。', scope: { nodeIds: ['testModel'], actions: ['reply'] } }] });
    await ready(automatic.ui);
    const testButton = automatic.ui.inline('testModel').button('测试'); assert.equal(testButton.props.disabled, false); testButton.props.onClick();
    await settle(automatic.ui, () => automatic.ui.publicModelCalls() === 1, 'Configured real workflow completion event');
    assert.equal(automatic.modelInputs.length, 1);
    const eventInput = modelInput(automatic.ui);
    assert.equal(eventInput.origin, 'event'); assert.equal(eventInput.task, '仅解释这次已完成测试的返回。');
    assert.deepEqual(eventInput.scope, { actions: ['reply'], nodeIds: ['testModel'] });
    assert(!modelPrompt(automatic.ui).includes('actions?:'), 'A reply-only configured response has no action output key');
    for (const method of ['addNode', 'removeNode', 'disconnect', 'run', 'cancel']) assert(!modelPrompt(automatic.ui).includes(`${method}{`));
    assert(modelPrompt(automatic.ui).includes('resultIds:'), 'The real event trial makes its public input/output records readable');
    assert(!modelPrompt(automatic.ui).includes('eventData'), 'Built-in execution events use their actual trial records rather than custom payload reads');
    assert.equal(eventInput.context.event.type, 's2.node.succeeded'); assert.equal(eventInput.context.event.nodeId, 'testModel');
    assert.equal(eventInput.context.resultDetails, undefined, 'Automatic completion starts from result indices only');
    assert(!JSON.stringify(eventInput).includes('合成测试结果：完整返回'));
    for (const key of ['id', 'causeId', 'chain', 'revision', 'invocationId']) assert.equal(eventInput.context.event[key], undefined, `No local metadata: ${key}`);
    const resultId = eventInput.context.results.find((item: any) => item.nodeId === 'testModel' && item.portId === 'text' && item.direction === 'output').resultId;
    automatic.ui.resolvePublicModel({ read: { resultIds: [resultId] } });
    await settle(automatic.ui, () => automatic.ui.publicModelCalls() === 2, 'The requested real result is read before explanation');
    assert(modelInput(automatic.ui).context.recalled.resultDetails.some((item: any) => item.resultId === resultId && item.text.includes('合成测试结果：完整返回')));
    assert.equal(modelInput(automatic.ui).context.actionGuide, undefined, 'Result explanation does not receive editing grammar');
    automatic.ui.resolvePublicModel({ reply: '这次返回已完整展示，可以继续修改提示词。' });
    await settle(automatic.ui, () => automatic.ui.text().includes('这次返回已完整展示'), 'Automatic reply appears in normal chat');
    for (let i = 0; i < 5; i++) { await tick(); automatic.ui.render(); }
    assert.equal(automatic.ui.publicModelCalls(), 2, 'One completion delivers one configured response with one necessary body read');
    assert.equal(automatic.modelInputs.length, 1, 'Automatic explanation never reruns the test');
  }

  const stale = fixture(); await ready(stale.ui); send(stale.ui, '替我更新角色。');
  await settle(stale.ui, () => stale.ui.publicModelCalls() === 1, 'Pending user operation');
  const staleComponent = modelInput(stale.ui).context.canvas.nodes.find((item: any) => item.id === 'role').componentId;
  stale.ui.resolvePublicModel({ read: { interfaces: [{ componentId: staleComponent, parameters: ['content'] }] } });
  await settle(stale.ui, () => stale.ui.publicModelCalls() === 2, 'Pending editable response after reading its exact constraints');
  edit(stale.ui, 'role', '用户在等待回复期间写入的新内容。');
  stale.ui.resolvePublicModel({ reply: '已处理。', actions: [{ type: 'setValues', nodeId: 'role', values: { content: '过期模型内容' } }] });
  await idle(stale.ui);
  assert.equal(node(stale.ui, 'role').data.fields[0].value, '用户在等待回复期间写入的新内容。');
  assert.equal(stale.host().history().length, 0); assert.ok(!stale.ui.text().includes('已处理。'));

  const cancelled = fixture(); await ready(cancelled.ui); send(cancelled.ui, '更新角色并运行。');
  await settle(cancelled.ui, () => cancelled.ui.publicModelCalls() === 1, 'Cancellable public request');
  cancelled.ui.button('停止助手请求').props.onClick(); cancelled.ui.render();
  assert.equal(cancelled.ui.publicInvocation()!.signal!.aborted, true);
  cancelled.ui.resolvePublicModel({ reply: '取消后不能显示', actions: [{ type: 'setValues', nodeId: 'role', values: { content: '不能写入' } }, { type: 'run', targetNodeIds: ['assemble'] }] });
  for (let i = 0; i < 5; i++) { await tick(); cancelled.ui.render(); }
  assert.equal(node(cancelled.ui, 'role').data.fields[0].value, experimentDefinition.initial.nodes.find(item => item.id === 'role')!.values.content);
  assert.equal(cancelled.host().history().length, 0); assert.ok(!cancelled.ui.text().includes('取消后不能显示'));

  const switched = fixture(); await ready(switched.ui); send(switched.ui, '替我更新角色并运行。');
  await settle(switched.ui, () => switched.ui.publicModelCalls() === 1, 'Public request before scene switch');
  const oldHost = switched.host(), switchSignal = switched.ui.publicInvocation()!.signal;
  const nextRequest = { ...switched.options.initialRequest!, subject: '切换到另一合成场景' };
  const nextDefinition = structuredClone(experimentDefinition); nextDefinition.initial.nodes.find(item => item.id === 'role')!.values.content = '新场景自己的角色';
  switched.options.initialRequest = nextRequest; switched.options.initialDraft = { ...createS2Scene(nextRequest), canvasWorkspace: nextDefinition };
  switched.ui.render(); await ready(switched.ui); assert.equal(switchSignal!.aborted, true);
  switched.ui.resolvePublicModel({ reply: '旧场景回包', actions: [{ type: 'setValues', nodeId: 'role', values: { content: '不能跨场景写入' } }, { type: 'run', targetNodeIds: ['assemble'] }] });
  for (let i = 0; i < 5; i++) { await tick(); switched.ui.render(); }
  assert.equal(node(switched.ui, 'role').data.fields[0].value, '新场景自己的角色');
  assert.equal(oldHost.history().length, 0); assert.ok(!switched.ui.text().includes('旧场景回包'));

  const closed = fixture(); await ready(closed.ui); send(closed.ui, '更新角色并运行。');
  await settle(closed.ui, () => closed.ui.publicModelCalls() === 1, 'Pending operation before unmount');
  const requestSignal = closed.ui.publicInvocation()!.signal; closed.ui.dispose(); assert.equal(requestSignal!.aborted, true);
  const writes = closed.ui.stateWrites();
  closed.ui.resolvePublicModel({ actions: [{ type: 'setValues', nodeId: 'role', values: { content: '不能写入' } }, { type: 'run', targetNodeIds: ['assemble'] }] });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(closed.ui.stateWrites(), writes, 'A closed session cannot publish a late response');
  assert.equal(closed.modelInputs.length, 0); assert.equal(closed.host().history().length, 0);

  // Two live runs may share a model node. cancel(runId) must only cancel the
  // requested operation, without using the canvas's node-wide stop shortcut.
  const exactCancel = fixture(undefined, true); await ready(exactCancel.ui);
  exactCancel.ui.inline('testModel').button('测试').props.onClick();
  await settle(exactCancel.ui, () => exactCancel.modelInputs.length === 1, 'First overlapping workflow is pending');
  const runOne = exactCancel.host().workflowHistory().at(-1)!;
  const other = exactCancel.host().enqueueWorkflow(['testModel'], undefined, { force: true, modelConfirmation: 'user-action' });
  assert.equal(exactCancel.host().workflowHistory().find(run => run.id === other.id)!.status, 'queued');
  send(exactCancel.ui, '只取消第一项运行，保留另一项运行。');
  await settle(exactCancel.ui, () => exactCancel.ui.publicModelCalls() === 1, 'Exact cancellation public invocation');
  assert(modelInput(exactCancel.ui).context.executions.some((run: any) => run.runId === runOne.id));
  exactCancel.ui.resolvePublicModel({ actions: [{ type: 'cancel', runId: runOne.id }] });
  await settle(exactCancel.ui, () => exactCancel.host().workflowHistory().find(run => run.id === runOne.id)?.status === 'cancelled', 'Requested workflow cancelled');
  await settle(exactCancel.ui, () => exactCancel.modelInputs.length === 2, 'Uncancelled overlapping job proceeds after the first');
  assert.equal(exactCancel.host().workflowHistory().find(run => run.id === other.id)!.status, 'running', 'Sharing a dependency does not widen cancellation to another run');
  exactCancel.releaseModels.forEach(release => release());
  assert.equal((await other.completion).status, 'succeeded'); await idle(exactCancel.ui);
  await automaticResponse();
  console.log('S2 interaction UI passed: public one-call user replies, first-session save acquisition recovery, ordered public edit and real local test/result workflow, exact run cancellation with overlapping dependencies, configured completion event with scoped existing result, no unconfigured automatic call or extra confirmation UI, stale edits and unmount protection. Synthetic providers/hooks only; no network, settings or user data.');
} finally { live.forEach(ui => ui.dispose()); globalThis.fetch = previousFetch; }
