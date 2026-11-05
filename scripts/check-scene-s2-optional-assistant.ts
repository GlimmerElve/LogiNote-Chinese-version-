import assert from 'node:assert/strict';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { readS2ContextArtifact, readS2ContextTrial, readS2ContextEvent, createS2AssessmentArtifactScope, resolveS2AssessmentOutput } from '../src/services/scene/sceneS2ArtifactAccess';
import { snapshotS2AssistantContext } from '../src/services/scene/sceneS2AssistantSnapshot';
import { harness } from './scene-s2-ui-harness';

const request = { source: 'custom' as const, sceneSkill: 'S2' as const, subject: 'Synthetic optional assistant', knowledgePoints: [] };
const draft = createS2Scene(request);
const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
draft.canvasWorkspace!.plugins = [parse, { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' }];
draft.canvasWorkspace!.initial.nodes[0].values.content = '{"原始记录":0}';
draft.canvasWorkspace!.initial.execution = { version: 1, nodes: [{ ...parse, id: 'parse', position: { x: 400, y: 0 },
  bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } }], links: [] };
const answer = { understanding: '只解释已完成实验', plan: '只读建议', reply: '这个结果保留了原来的零值。', commands: [] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let i = 0; i < 200; i++) { ui.render(); if (done()) return; await tick(); }
  assert.fail('Optional-assistant synthetic check did not settle');
}
function run(ui: ReturnType<typeof harness>) { ui.button('运行全部步骤').props.onClick(); ui.render(); }
function ask(ui: ReturnType<typeof harness>, text: string) {
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: text } }); ui.render();
  ui.button('发送').props.onClick(); ui.render();
}
function edit(ui: ReturnType<typeof harness>, text: string) {
  ui.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); ui.render();
  ui.labelControl('内容', 'textarea').props.onChange({ target: { value: text } }); ui.render();
}
let host!: S2PluginHost;
const ui = harness({ initialDraft: draft, onHost: value => { host = value; } });
ui.button('开始试验').props.onClick(); ui.render();
ui.button('关闭助手').props.onClick(); ui.render();
run(ui); await settle(ui, () => host.workflowHistory().at(-1)?.status === 'succeeded');
assert.equal(ui.modelCalls(), 0); assert.equal(host.history().length, 1);
assert.equal(ui.button('运行全部步骤').props.disabled, false);
edit(ui, '{"用户修改":1}'); run(ui); await settle(ui, () => host.workflowHistory().length === 2 && host.workflowHistory().at(-1)?.status === 'succeeded');
assert.equal(ui.modelCalls(), 0, 'Disabled assistant never participates in ordinary experiments');
assert.equal(host.history()[1].artifacts[0].payload.kind, 'inline');
ui.button('开启助手').props.onClick(); ui.render();
assert.ok(!ui.elements().some(item => item.type === 'button' && ['分析本次结果', '解释所选内容', '给我提示'].includes(ui.text(item))),
  'Natural conversation does not require choosing a help mode');
assert.equal(ui.modelCalls(), 0);
ask(ui, '这块内容有什么作用？先给我解释，不要修改或运行。');
assert.equal(ui.pluginContext()?.frame.event.kind, 'user-message', 'Ordinary conversation is the actual user request, not a synthetic shortcut event');
ui.resolve({ ...answer, reply: '只解释选中的块，不替换实验结果。' }); await tick(); ui.render();
ask(ui, '看一下第二次实验的结果，告诉我有哪些偏差，不要修改或重跑。');
assert.equal(ui.origin(), 'user'); assert.equal(ui.modelCalls(), 2);
assert.ok(ui.pluginContext()?.executionRuns.some(run => run.id === host.workflowHistory()[1].id), 'The semantic agent can recall the real completed experiment');
assert.equal(ui.button('运行全部步骤').props.disabled, false, 'Hanging analysis cannot disable manual execution');
assert.equal(ui.labelControl('选择并允许本局读取文本资料', 'input').props.disabled, false, 'Resource controls are not controlled by assistant state');
edit(ui, '{"分析期间修改":2}');
run(ui); await settle(ui, () => host.workflowHistory().length === 3 && host.workflowHistory().at(-1)?.status === 'succeeded');
assert.equal(ui.modelCalls(), 2, 'A new experiment does not force or queue analysis behind the hanging request');
ui.resolve(answer); await tick(); ui.render();
assert.ok(ui.text().includes('回应期间画布已变化'), 'A stale ordinary conversation cannot publish advice as if it were about the new configuration');
assert.equal(host.workflowHistory().at(-1)?.status, 'succeeded');
ask(ui, '分析当前实验结果，只给建议。');
ui.reject(new Error('Synthetic assistant unavailable')); await tick(); ui.render();
assert.ok(ui.text().includes('Synthetic assistant unavailable'));
assert.equal(host.history().length, 3); assert.equal(ui.button('运行全部步骤').props.disabled, false);
run(ui); await settle(ui, () => host.workflowHistory().length === 4 && host.workflowHistory().at(-1)?.status === 'succeeded');
ask(ui, '请帮我解释这次结果。');
const closingSignal = ui.signal()!;
ui.button('关闭助手').props.onClick(); ui.render(); assert.equal(closingSignal.aborted, true);
ui.resolve({ ...answer, reply: '关闭后迟到的分析不得发布' }); await tick(); ui.render();
assert.ok(!ui.text().includes('关闭后迟到的分析不得发布'));
assert.equal(host.history().length, 3, 'Cache reuse remains a real queue record, not an extra tool call');
run(ui); await settle(ui, () => host.workflowHistory().length === 5 && host.workflowHistory().at(-1)?.status === 'succeeded');
assert.equal(ui.modelCalls(), 4, 'Closing the assistant does not close its local plugin host');
ui.button('开启助手').props.onClick(); ui.render();
ask(ui, '帮我补一个内容块，先展示填写建议，不要直接应用或运行。');
ui.resolve({ ...answer, commands: [{ op: 'add-node', node: { id: 'proposed-content', type: 'text', position: { x: 0, y: 0 }, values: { content: '待确认的填写建议' } } }] }); await tick(); ui.render();
assert.ok(ui.elements().some(element => element.type === 'button' && ui.text(element) === '确认应用修改'));
assert.ok(!ui.flow().props.nodes.some((node: any) => node.id === 'proposed-content'), 'Natural collaboration only proposes a change, never applies it silently');
ui.button('关闭助手').props.onClick(); ui.render();
assert.ok(!ui.elements().some(element => element.type === 'button' && ui.text(element) === '确认应用修改'));
ui.dispose();

// The model request is independently confirmed and survives a hanging or closed
// assistant. This is injected synthetic transport, not a live model call.
const modelDraft = createS2Scene(request);
const model = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
modelDraft.canvasWorkspace!.plugins = [model];
modelDraft.canvasWorkspace!.initial.execution = { version: 1, nodes: [{ ...model, id: 'generate', position: { x: 400, y: 0 },
  bindings: { prompt: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } }], links: [] };
let modelHost!: S2PluginHost, releaseModel!: () => void, networkSignal: AbortSignal | undefined, calls = 0;
const modelUi = harness({ initialDraft: modelDraft, onHost: value => { modelHost = value; } });
modelUi.button('开始试验').props.onClick(); modelUi.render();
modelHost.approveModelTestSession(new S2ModelTestSession({ sceneId: modelDraft.sceneId, runId: modelHost.runId,
  resourceId: 'SyntheticOptionalAssistantResource', providerId: 'synthetic', providerLabel: '合成模型', model: 'synthetic-model',
  limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 }, invoke: async (_request, options) => {
    calls++; networkSignal = options.signal; await new Promise<void>(resolve => { releaseModel = resolve; });
    return { content: ' 完整模型返回\n', diagnostics: { finishReason: 'stop' } };
  } }));
modelUi.render(); ask(modelUi, '给我一点思路，不要替我运行。');
run(modelUi); await settle(modelUi, () => modelHost.waitingModelTests().length === 1);
assert.equal(modelUi.button('确认发送本次模型请求').props.disabled, false);
modelUi.button('确认发送本次模型请求').props.onClick(); await settle(modelUi, () => calls === 1);
modelUi.button('关闭助手').props.onClick(); modelUi.render();
assert.equal(modelUi.signal()!.aborted, true); assert.equal(networkSignal?.aborted, false, 'Closing analysis never aborts the independently confirmed request');
modelUi.resolve(answer); releaseModel(); await settle(modelUi, () => modelHost.workflowHistory().at(-1)?.status === 'succeeded');
assert.equal(modelHost.history()[0].artifacts[0].payload.kind, 'inline');
assert.equal((modelHost.history()[0].artifacts[0].payload as any).value, ' 完整模型返回\n');
assert.ok(!modelUi.text().includes(answer.reply)); assert.equal(calls, 1);
modelUi.dispose();

// Four real assembly predecessors and three input fields must not consume the
// bounded evidence pools before the actual model output and exact model trial.
const rich = createS2Scene(request), render = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' };
const display = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
const image = { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' };
rich.canvasWorkspace!.plugins = [render, model, display, image];
rich.canvasWorkspace!.blockTypes.push({ id: 'form', label: '提示词部分', fields: ['role', 'task', 'format'].map(id => ({ id, label: id, kind: 'text' })) });
rich.canvasWorkspace!.initial.nodes.push({ id: 'form', type: 'form', position: { x: 0, y: 300 }, values: { role: '角色原文', task: '任务原文', format: '格式原文' } });
rich.canvasWorkspace!.initial.execution = { version: 1, nodes: [
  ...[1, 2, 3].map(index => ({ ...render, id: `unrelated${index}`, position: { x: 0, y: 500 + index * 200 }, bindings: {
    template: { kind: 'literal' as const, value: `无关目标 ${index}` }, variables: { kind: 'literal' as const, value: {} } } })),
  ...[1, 2, 3, 4].map(index => ({ ...render, id: `assemble${index}`, position: { x: 300 * index, y: 0 }, bindings: {
    ...(index === 1 ? { template: { kind: 'literal' as const, value: ' 完整提示词\n{{literal}}不自动解释' } } : {}), variables: { kind: 'literal' as const, value: {} } } })),
  { ...model, id: 'actual-model', position: { x: 1600, y: 0 }, bindings: { input: { kind: 'literal', value: '完整待处理材料' } } },
  { ...display, id: 'actual-display', position: { x: 2000, y: 0 }, bindings: {} },
  { ...image, id: 'image', position: { x: 1600, y: 300 }, bindings: {} },
], links: [
  ...[1, 2, 3].map(index => ({ source: { nodeId: `assemble${index}`, portId: 'text' }, target: { nodeId: `assemble${index + 1}`, portId: 'template' } })),
  { source: { nodeId: 'assemble4', portId: 'text' }, target: { nodeId: 'actual-model', portId: 'prompt' } },
  { source: { nodeId: 'actual-model', portId: 'text' }, target: { nodeId: 'actual-display', portId: 'text' } },
  { source: { nodeId: 'image', portId: 'image' }, target: { nodeId: 'actual-model', portId: 'image' } },
] };
// A template with no references is copied exactly; no test performs semantic prompt rewriting.
rich.canvasWorkspace!.initial.execution.nodes.find(node => node.id === 'assemble1')!.bindings.template = { kind: 'literal', value: ' 完整提示词\n保留原文' };
const richHost = new S2PluginHost(rich.sceneId, rich.canvasWorkspace!); richHost.setDocument(rich.canvasWorkspace!.initial);
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
const imageInfo = await richHost.approveImageFile(new File([Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0))], '合成图片.png', { type: 'image/png' }));
rich.canvasWorkspace!.initial.execution.nodes.find(node => node.id === 'image')!.bindings.resource = { kind: 'literal', value: imageInfo.id };
richHost.setDocument(rich.canvasWorkspace!.initial);
richHost.approveModelTestSession(new S2ModelTestSession({ sceneId: rich.sceneId, runId: richHost.runId,
  resourceId: 'SyntheticRichResource', providerId: 'synthetic', providerLabel: '合成模型', model: 'synthetic-model', supportsImages: true,
  limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 }, invoke: async request => {
    assert.equal(request.images?.length, 1); return { content: '模型真正返回', diagnostics: { finishReason: 'stop' } };
  } }));
const richJob = richHost.enqueueWorkflow(['unrelated1', 'unrelated2', 'unrelated3', 'actual-display']);
for (let i = 0; i < 200 && !richHost.waitingModelTests().length; i++) await tick();
const richWait = richHost.waitingModelTests()[0]; assert.ok(richWait);
richHost.confirmModelTest(richJob.id, richWait.id, true); const richRun = await richJob.completion;
assert.equal(richRun.status, 'succeeded'); assert.equal(richHost.history().length, 9);
const prepared = richHost.prepare('form', { goal: rich.canvasWorkspace!.goal, ...rich.canvasWorkspace!.instructions }, '只分析本轮');
prepared.frame.event = { id: 'SyntheticCompletedEvent', kind: 'workflow-completed', workflowRunId: richRun.id };
const evidenceLifetime = new AbortController(), pinned = snapshotS2AssistantContext(prepared, evidenceLifetime.signal);
assert.equal(pinned.assistantEvidence.imageInputCount, 1); assert.equal(pinned.assistantEvidence.imageContentsProvided, false);
assert.ok(pinned.assistantEvidence.note.includes('不表示助手看过图片'));
assert.ok(!JSON.stringify(pinned).includes(pngBase64), 'Analysis contains handles and explicit limits, never another unauthorized image dispatch');
const actual = richHost.history().find(item => item.request.nodeId === 'actual-model')!;
const resultId = actual.artifacts[0].id;
assert.equal(richRun.targets.slice(0, 3).join(','), 'unrelated1,unrelated2,unrelated3', 'Three earlier unrelated targets compete for the bounded artifact pool');
assert.equal(readS2ContextArtifact(pinned, resultId).text, '模型真正返回');
const trial = readS2ContextTrial(pinned, actual.receipt.invocationId);
assert.equal(trial.inputs.prompt[0].text, ' 完整提示词\n保留原文');
assert.equal(trial.inputs.input[0].text, '完整待处理材料'); assert.equal(trial.outputs.text[0].text, '模型真正返回');
const assessmentScope = createS2AssessmentArtifactScope(pinned, [resultId]);
const returnedIndex = pinned.outputIndex.find(item => item.nodeId === 'actual-model' && item.portId === 'text')!;
returnedIndex.nodeId = 'forged-node'; returnedIndex.portId = 'forged-port';
assert.equal(resolveS2AssessmentOutput(assessmentScope, 'actual-model', 'text')?.text, '模型真正返回');
assert.equal(resolveS2AssessmentOutput(assessmentScope, 'forged-node', 'forged-port'), undefined, 'Mutable presentation indices never become output authority');
let readableArtifacts = 0, copiedArtifactChars = 0, readableTrials = 0, copiedTrialChars = 0;
for (const id of pinned.frame.availableArtifactIds) try { const body = readS2ContextArtifact(pinned, id); readableArtifacts++; copiedArtifactChars += body.text.length; } catch { /* Expected bounded omissions. */ }
for (const item of pinned.trialIndex) try { const body = readS2ContextTrial(pinned, item.id); readableTrials++; copiedTrialChars += JSON.stringify(body).length; } catch { /* Expected bounded omissions. */ }
assert.ok(readableArtifacts <= 3 && copiedArtifactChars <= 10000); assert.ok(readableTrials <= 2 && copiedTrialChars <= 20000);
const originalOutput = actual.artifacts[0].payload as any; originalOutput.value = '外部更改不能污染快照';
assert.equal(readS2ContextArtifact(pinned, resultId).text, '模型真正返回');
const changed = structuredClone(rich.canvasWorkspace!.initial); changed.nodes[0].values.content = '下一轮新内容'; richHost.setDocument(changed);
assert.throws(() => readS2ContextArtifact(prepared, resultId), /失效/);
assert.equal(readS2ContextArtifact(pinned, resultId).text, '模型真正返回', 'Bounded read-only evidence survives later user edits without gaining new data');
assert.throws(() => readS2ContextArtifact(structuredClone(pinned), resultId), /真实宿主上下文/);
assert.throws(() => readS2ContextArtifact(pinned, 'ForeignArtifact'), /未提供/);
const forged = snapshotS2AssistantContext(structuredClone(prepared), new AbortController().signal);
assert.throws(() => readS2ContextArtifact(forged, resultId), /未提供/);
assert.throws(() => readS2ContextTrial(pinned, richHost.history()[0].receipt.invocationId), /未提供/, 'Unselected assembly archives cannot evict or impersonate the model trial');
evidenceLifetime.abort();
assert.throws(() => readS2ContextArtifact(pinned, resultId), /关闭或结束/);
assert.throws(() => readS2ContextTrial(pinned, actual.receipt.invocationId), /关闭或结束/);
richHost.close();

// Interaction bodies share the existing 10k artifact/evidence pool. They must
// not become a second unbounded body store merely because four IDs fit.
const budgetScene = createS2Scene(request);
budgetScene.canvasWorkspace!.plugins = [render];
budgetScene.canvasWorkspace!.initial.execution = { version: 1, nodes: [1, 2].map(index => ({ ...render, id: `long-result${index}`, position: { x: 400, y: index * 200 },
  bindings: { template: { kind: 'literal' as const, value: '保留原文'.repeat(1225) }, variables: { kind: 'literal' as const, value: {} } } })), links: [] };
const budgetHost = new S2PluginHost(budgetScene.sceneId, budgetScene.canvasWorkspace!);
budgetHost.setDocument(budgetScene.canvasWorkspace!.initial);
const budgetRun = await budgetHost.enqueueWorkflow(['long-result1', 'long-result2']).completion;
assert.equal(budgetRun.status, 'succeeded');
for (const ids of [['goal'], ['long-result1'], [], ['goal', 'long-result2']]) budgetHost.recordCanvasSelection(ids);
const budgetSource = budgetHost.prepare('goal', { goal: budgetScene.canvasWorkspace!.goal, ...budgetScene.canvasWorkspace!.instructions }, '读取本轮');
budgetSource.frame.event = { id: 'SyntheticBudgetEvent', kind: 'workflow-completed', workflowRunId: budgetRun.id };
const budgetLifetime = new AbortController(), budgetEvidence = snapshotS2AssistantContext(budgetSource, budgetLifetime.signal);
let totalBodies = budgetHost.history().reduce((chars, item) => chars + readS2ContextArtifact(budgetEvidence, item.artifacts[0].id).text.length, 0), readableEvents = 0;
for (const binding of budgetEvidence.bindings) try { totalBodies += readS2ContextArtifact(budgetEvidence, binding.artifactId).text.length; } catch { /* Bounded omission. */ }
const budgetEventIds = budgetSource.interactions.recentEvents.slice(-4).map(event => event.id);
assert.equal(budgetEventIds.length, 4);
for (const id of budgetEventIds) try { totalBodies += JSON.stringify(readS2ContextEvent(budgetEvidence, id)).length; readableEvents++; } catch { /* Over-budget bodies stay unavailable, not truncated. */ }
assert.ok(totalBodies <= 10000); assert.ok(readableEvents < 4, 'Event bodies cannot bypass the shared complete-body budget');
budgetLifetime.abort();
assert.throws(() => readS2ContextEvent(budgetEvidence, budgetEventIds[0]), /关闭或结束/);
budgetHost.close();
console.log('S2 optional assistant passed: ordinary user-message chat without help-mode controls; disabled/hanging/failed/closed assistance leaves editing, reruns, separate model confirmation and raw results usable; stale reply/late-close isolation and pending collaboration without silent edits; bounded readonly model-first evidence survives edits but not close, clone or foreign IDs. Synthetic hooks/transport only, not browser/live acceptance.');
