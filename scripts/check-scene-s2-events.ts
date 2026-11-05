import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition, interactS2Canvas, exportS2Workspace, applyS2Commands } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2InteractionLog, type S2InteractionEvent } from '../src/services/scene/sceneS2Events';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { readS2ContextEvent } from '../src/services/scene/sceneS2ArtifactAccess';
import { readS2ContextRecall, s2RecallContext, s2PluginContext } from '../src/services/scene/sceneS2Context';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import { harness } from './scene-s2-ui-harness';
import type { S2WorkflowNode } from '../src/types/sceneS2';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import { S2ArtifactChart } from '../src/components/scene/S2ArtifactChart';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';

const priorFetch = globalThis.fetch; let network = 0, modelCalls = 0;
globalThis.fetch = async () => { network++; throw new Error('Interaction regression forbids real IO'); };
const hosts: S2PluginHost[] = [];
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const parse = cap('structured-data', 'parse-json'), table = cap('structured-data', 'to-table'), view = cap('structured-view', 'table');
const human = cap('human-input', 'text'), model = cap('model-test', 'generate');
const node = (id: string, capability: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, ...capability, position: { x: 0, y: 0 }, bindings });
const literal = (value: string) => ({ kind: 'literal' as const, value });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function waiting(host: S2PluginHost, id: string) {
  for (let i = 0; i < 100; i++) { if (host.workflowHistory().find(run => run.id === id)?.status === 'waiting') return; await tick(); }
  assert.fail('Synthetic wait deadline exceeded');
}
try {
  const scene = createS2Scene({ source: 'custom', subject: '合成操作记录', sceneSkill: 'S2', knowledgePoints: [] });
  const settings = { id: 'settings', label: '设置', kind: 'form', required: true,
    fields: [{ id: 'count', label: '次数', kind: 'number', required: true, min: 1 }, { id: 'note', label: '备注', kind: 'text' }] };
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, table, view, human, model],
    blockTypes: [{ id: 'settings', label: '设置块', fields: [settings] }, { id: 'data', label: '数据块', fields: [{ id: 'content', label: '记录', kind: 'multiline' }] }],
    initial: { nodes: [
      { id: 'settings', type: 'settings', position: { x: 0, y: 0 }, values: { settings: '{"count":1,"note":""}' } },
      { id: 'data', type: 'data', position: { x: 0, y: 200 }, values: { content: '[{"name":"甲","score":0},{"name":"乙","score":2}]' } },
    ], edges: [], execution: { version: 1, nodes: [
      node('parse', parse, { text: { kind: 'field', nodeId: 'data', fieldId: 'content' } }), node('table', table), node('view', view),
      node('ask', human, { prompt: literal('填写完整 JSON') }), node('afterHuman', parse),
      node('model', model, { prompt: literal('合成模型提示词') }), node('broken', parse, { text: literal('{bad}') }),
    ], links: [
      { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } },
      { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } },
      { source: { nodeId: 'ask', portId: 'text' }, target: { nodeId: 'afterHuman', portId: 'text' } },
    ] } } });
  scene.canvasWorkspace = definition;
  assert.throws(() => applyS2Commands(definition, definition.initial, [{ op: 'record-event', kind: 'model-confirm', approved: true }]), /未授权/);
  const host = new S2PluginHost(scene.sceneId, definition); hosts.push(host); host.setDocument(definition.initial);
  const strategy = { goal: definition.goal, ...definition.instructions };
  const context = () => host.prepare('settings', strategy, '只查看状态');
  const before = host.remainingCalls, raw = definition.initial.nodes[0].values.settings;
  host.recordFieldControl('settings', 'settings', raw, 'editing');
  const firstCount = context().interactions.totalEvents;
  host.recordFieldControl('settings', 'settings', raw, 'editing');
  assert.equal(context().interactions.totalEvents, firstCount, 'Repeated keystrokes coalesce to the same state; no key logging');
  host.recordFieldControl('settings', 'settings', raw, 'invalid');
  host.recordFieldControl('settings', 'settings', 'PRIVATE_UNSUBMITTED_DRAFT', 'editing');
  assert.equal(context().interactions.fieldStates[0].state, 'conflict');
  assert.ok(!JSON.stringify(context()).includes('PRIVATE_UNSUBMITTED_DRAFT'));
  assert.throws(() => host.recordFieldControl('invented', 'settings', raw, 'editing'));
  assert.throws(() => host.recordFieldControl('settings', 'settings', raw, 'execute' as any));
  host.recordFieldControl('settings', 'settings', raw, 'reloaded');
  host.recordFieldControl('settings', 'settings', raw, 'submitted');
  assert.equal(host.remainingCalls, before); assert.equal(host.history().length, 0);

  const seen = new Map<string, S2InteractionEvent>();
  const collect = () => context().interactions.recentEvents.forEach(event => seen.set(event.id, event));
  const complete = await host.enqueueWorkflow(['view'], collect).completion;
  assert.equal(complete.status, 'succeeded');
  assert.ok([...seen.values()].some(event => event.kind === 'plugin-state' && event.status === 'running'));
  assert.ok([...seen.values()].some(event => event.kind === 'node-state' && event.nodeId === 'view' && event.status === 'displayed'));
  const beforeCache = host.remainingCalls;
  const cached = await host.enqueueWorkflow(['view'], collect).completion;
  assert.equal(cached.nodes.find(node => node.nodeId === 'table')!.status, 'cached');
  assert.ok([...seen.values()].some(event => event.kind === 'node-state' && event.status === 'cached'));
  assert.equal(host.remainingCalls, beforeCache);
  const tableArtifact = host.history().find(item => item.request.nodeId === 'table')!.artifacts[0];
  const originalArtifact = JSON.stringify(tableArtifact), calls = host.remainingCalls;
  const elements = (value: any): any[] => Array.isArray(value) ? value.flatMap(elements)
    : value && typeof value === 'object' && value.props ? [value, ...elements(value.props.children)] : [];
  const onViewChange = (id: string, selection: any) => host.recordArtifactView(id, selection);
  const renderedNode = S2WorkflowNodeView({ data: { title: '真实表格展示', capability: s2BuiltinPluginRegistry().capability(view), status: 'displayed', artifacts: [tableArtifact], onViewChange } } as any);
  const artifactView = elements(renderedNode).find(element => element.type === S2ArtifactView)!;
  assert.equal(artifactView.props.onViewChange, onViewChange);
  const chart = elements(S2ArtifactView(artifactView.props)).find(element => element.type === S2ArtifactChart)!;
  assert.ok(chart); chart.props.onViewChange({ kind: 'line', xKey: 'name', yKey: 'score' });
  const viewContext = context(), viewEvent = viewContext.interactions.recentEvents.at(-1)!;
  assert.equal(viewEvent.kind, 'artifact-view');
  host.recordArtifactView(tableArtifact.id, { kind: 'line', xKey: 'name', yKey: 'score' });
  assert.equal(context().interactions.totalEvents, viewContext.interactions.totalEvents);
  for (const invalid of [{ kind: 'html', xKey: 'name', yKey: 'score' }, { kind: 'bar', xKey: 'name', yKey: 'name' },
    { kind: 'bar', xKey: 'missing', yKey: 'score' }, Object.create({ kind: 'bar', xKey: 'name', yKey: 'score' }),
    { kind: 'bar', xKey: 'name', yKey: 'score', execute: true }]) assert.throws(() => host.recordArtifactView(tableArtifact.id, invalid as any));
  assert.equal(JSON.stringify(host.currentArtifact(tableArtifact.id)), originalArtifact);
  assert.equal(host.remainingCalls, calls, 'View changes do not execute, spend or alter data');
  const exactEvent = readS2ContextEvent(viewContext, viewEvent.id); exactEvent.revision = -1;
  assert.notEqual(readS2ContextEvent(viewContext, viewEvent.id).revision, -1);
  assert.throws(() => readS2ContextEvent(structuredClone(viewContext), viewEvent.id), /真实宿主/);
  assert.throws(() => readS2ContextEvent(viewContext, 'interaction-forged'));
  assert.throws(() => readS2ContextRecall({ eventIds: Array.from({ length: 5 }, (_, i) => `interaction-${i}`) }));
  assert.equal(Object.hasOwn(s2PluginContext(viewContext, readS2ContextRecall(undefined))!, 'interactions'), false, 'No unbounded duplicate journal in plugin projection');
  let turns = 0, squeezed = false;
  await interactS2Canvas(scene, definition.initial, '我选择了什么视图？只解释，不运行', 'settings', [], {
    pluginContext: viewContext, invoke: async request => {
      turns++; const input = JSON.parse(request.userInput);
      if (input.stage === 'turn-understand') {
        const indexBlock = input.optionalContextBlocks.find((block: any) => block.id === input.interactionContext.optionalContextId);
        assert.ok(JSON.parse(indexBlock.text).eventIndex.some((event: any) => event.id === viewEvent.id));
        assert.equal(input.interactionContext.recentEvents, undefined, 'Full event bodies are optional, not duplicated protected context');
        assert.ok(input.optionalContextBlocks.some((block: any) => block.sourceIds.includes(viewEvent.id)));
        const { optionalContextBlocks, ...protectedInput } = input;
        const candidate = { ...request, userInput: JSON.stringify(protectedInput), sceneOptionalContext: optionalContextBlocks };
        const baseline = fitSceneContextBudget({ ...candidate, sceneOptionalContext: [] }).diagnostics!;
        // Reserve room for explicit omission IDs as well as protected sources.
        const pressure = Math.ceil((baseline.estimatedInputTokens + baseline.outputReserveTokens + 1024) / .9);
        const fitted = fitSceneContextBudget(candidate, { provider: { contextWindowTokens: pressure } });
        squeezed = fitted.diagnostics!.omittedContextIds.some(id => id.startsWith('s2-interaction-'));
        assert.deepEqual(JSON.parse(fitted.request.userInput).interactionContext, input.interactionContext);
        return { content: JSON.stringify({ understanding: '用户询问刚选的视图', desiredOutcome: '只解释操作', actions: ['reply'], constraints: ['不运行'], questions: [], recall: { eventIds: [viewEvent.id] } }) };
      }
      assert.equal(input.interactionContext, undefined, 'Action receives only semantically selected exact event records');
      assert.equal(input.recalledContext.items.find((item: any) => item.kind === 'interaction-event').value.view.kind, 'line');
      return { content: JSON.stringify({ understanding: '视图为折线图', plan: '只解释', reply: '你刚为这份表格选择了折线图，横轴name、纵轴score；数据未修改，也没有重新运行。', commands: [] }) };
    },
  });
  assert.equal(turns, 2); assert.equal(squeezed, true); assert.equal(host.remainingCalls, calls);

  const ask = host.enqueueWorkflow(['afterHuman'], collect); await waiting(host, ask.id); collect();
  const wait = host.waitingHumanInputs()[0];
  assert.ok([...seen.values()].some(event => event.kind === 'node-state' && event.status === 'waiting' && event.waitId === wait.id));
  host.submitHumanInput(ask.id, wait.id, '{"human":true}'); collect();
  assert.equal((await ask.completion).status, 'succeeded');
  assert.ok([...seen.values()].some(event => event.kind === 'human-submit' && event.waitId === wait.id));
  const bad = await host.enqueueWorkflow(['broken'], collect).completion;
  assert.equal(bad.status, 'failed');
  assert.ok([...seen.values()].some(event => event.kind === 'node-state' && event.nodeId === 'broken' && event.status === 'failed'));
  const cancel = host.enqueueWorkflow(['ask'], collect); await waiting(host, cancel.id); host.cancelWorkflow(cancel.id);
  assert.equal((await cancel.completion).status, 'cancelled');
  host.approveModelTestSession(new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticResource',
    providerId: 'SyntheticProvider', providerLabel: '合成服务', model: 'synthetic-model',
    limits: { maxRequests: 1, maxReservedOutputTokens: 256, maxOutputTokens: 256 },
    invoke: async () => { modelCalls++; return { content: 'synthetic result', diagnostics: { finishReason: 'stop' } }; } }));
  const modelJob = host.enqueueWorkflow(['model'], collect); await waiting(host, modelJob.id);
  const modelWait = host.waitingModelTests()[0]; collect();
  host.confirmModelTest(modelJob.id, modelWait.id, false); collect(); await modelJob.completion;
  assert.ok([...seen.values()].some(event => event.kind === 'model-confirm' && !event.approved));
  assert.equal(host.modelTestSummary()!.usedRequests, 0); assert.equal(modelCalls, 0);
  const old = context(), oldId = old.interactions.eventIndex.at(-1)!.id;
  const changed = structuredClone(definition.initial); changed.nodes[1].values.content = '[]'; host.setDocument(changed);
  assert.throws(() => readS2ContextEvent(old, oldId), /失效/);
  assert.throws(() => host.recordArtifactView(tableArtifact.id, { kind: 'bar', xKey: 'name', yKey: 'score' }));
  const recalled = s2RecallContext(readS2ContextRecall({ eventIds: [oldId] }), [], changed, context());
  assert.equal((recalled.items[0].value as S2InteractionEvent).publication, 'stale');
  assert.ok(!exportS2Workspace(definition, definition.initial).includes('interaction-'), 'Templates never contain the run journal');

  const log = new S2InteractionLog('SyntheticScene', 'SyntheticRun');
  for (let i = 0; i < 300; i++) log.append({ kind: 'canvas-revised' }, i + 1, 'host');
  const bounded = log.snapshot(300, true, []);
  assert.equal(bounded.totalEvents, 300); assert.equal(bounded.retainedEvents, 256); assert.equal(bounded.retiredEvents, 44);
  assert.equal(bounded.eventIndex.length, 12); assert.equal(bounded.recentEvents.length, 8);
  bounded.recentEvents[0].revision = -1; assert.notEqual(log.snapshot(300, true, []).recentEvents[0].revision, -1);

  // Production callbacks report state and preserve the separate explicit user-message trigger.
  let uiHost: S2PluginHost | undefined;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, onHost: host => { uiHost = host; hosts.push(host); } });
  try {
    await ui.openConversationSession();
    ui.flow().props.onNodeClick({}, { id: 'settings' }); ui.render();
    const contentField = () => ui.flow().props.nodes.find((node: any) => node.id === 'settings').data.fields.find((field: any) => field.id === 'settings');
    if (contentField().startEdit) { contentField().startEdit(); ui.render(); }
    const editor = () => [...ui.elements(contentField().editor), ...ui.elements()].find(element => element.type === 'field-editor')!;
    editor().props.onStateChange('editing', raw); editor().props.onStateChange('invalid', raw);
    assert.equal(ui.modelCalls(), 1); assert.equal(uiHost!.remainingCalls, 64);
    ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '刚刚提交失败了吗，只解释' } }); ui.render();
    ui.button('发送').props.onClick(); ui.render();
    assert.equal(ui.pluginContext().interactions.fieldStates[0]?.state, 'invalid', ui.text().slice(-1400));
    ui.resolve({ understanding: '提交尚未成功', plan: '只解释', reply: '字段仍有未通过验证的草稿，已提交内容没有被替换。', commands: [] }); await tick(); ui.render();
    const late = editor().props.onStateChange;
    ui.dispose(); late('editing', raw);
    assert.equal(ui.modelCalls(), 2); assert.equal(uiHost!.remainingCalls, 64);
  } finally { ui.dispose(); }
  assert.equal(network, 0); assert.equal(modelCalls, 0);
  console.log('S2 interaction events passed: bounded source/revision journal, draft-state privacy/deduplication, validated real view selection, exact event recall with clone/scope/stale protection, optional event bodies under budget, two-stage semantic/action handoff, real host/plugin/wait/submit/reject/failure/cancel/cache lifecycle and production controls without automatic Agent/tool execution. Offline synthetic only.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = priorFetch; }
