// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2AgentReply } from '../src/types/sceneS2';
import type { S2Table } from '../src/services/scene/sceneS2Structured';

// Deliberately do not create a fake browser Storage: its mere presence activates
// the production settings hydrator. Undefined keeps the existing Node/local
// context ceiling, and any unexpected direct storage access fails immediately.
const previous = new Map(['fetch', 'localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let networkAttempts = 0, electronAttempts = 0;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async () => {
  networkAttempts++; throw new Error('Synthetic browser protocol forbids network/model requests');
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.defineProperty({}, 'electronAPI', {
  get() { electronAttempts++; throw new Error('Synthetic browser protocol forbids Electron/storage/profile access'); },
}) });

try {
  // Install guards BEFORE production imports. Only the explicit fixture invoke
  // handles requests; no provider, settings or real notebook is loaded.
  const { browserRequest, browserDefinition, browserInputText, browserNotesText, browserTemplateRequest, browserTemplateDefinition, browserModelRequest, browserModelDefinition } = await import('./fixtures/s2-browser-definition');
  const { callLLM, browserFixtureState, setBrowserFixtureMode, setBrowserFixtureScenario, releaseBrowserFixtureResponse } = await import('./fixtures/s2-browser-model');
  const { loadManifest, saveScene, loadScene } = await import('./fixtures/s2-browser-store');
  const { createS2Scene, designS2Canvas, interactS2Canvas, readS2Definition, applyS2Commands } = await import('../src/services/scene/sceneS2Canvas');
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const { S2ConversationMemory } = await import('../src/services/scene/sceneS2Memory');
  const { s2TableToRecords } = await import('../src/services/scene/sceneS2Structured');
  const initialCallCount = browserFixtureState.calls.length, originalDefinition = JSON.stringify(browserDefinition);
  assert.equal(browserFixtureState.scenario, 'records', 'Existing fixture API defaults to the unchanged record-table scenario');
  const inputs: Array<Record<string, any>> = [], outputs: Array<{ input: Record<string, any>; value: Record<string, any> }> = [];
  const invoke = async (request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> => {
    const input = JSON.parse(request.userInput); inputs.push(input);
    if (input.stage === 'turn-act') {
      const needsOperations = input.intent.actions.some((action: string) => action === 'edit' || action === 'execute');
      assert.equal(request.systemPromptOverride!.includes('S2插件协议v1'), needsOperations);
      assert.equal(input.pluginCatalog.representation === 'discussion-capability-index', !needsOperations);
    }
    assert.equal(request.workflow, 'agent-scene-setup');
    assert.equal(request.skipProfileInjection, true); assert.equal(request.skipMemoryInjection, true);
    const result = await callLLM(request, options); outputs.push({ input, value: JSON.parse(result.content) }); return result;
  };
  setBrowserFixtureMode('explain');
  readS2Definition(browserDefinition, { requireBusiness: true });
  const scene = createS2Scene(browserRequest);
  scene.canvasWorkspace = await designS2Canvas(scene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.map(input => input.stage), ['understand', 'assemble']);
  assert.equal(scene.canvasWorkspace.plugins.length, 3);
  assert.equal(scene.canvasWorkspace.business.knowledge.length, 2);
  assert.deepEqual(scene.canvasWorkspace.business.criteria.map(item => item.method), ['local', 'semantic', 'advisory']);
  assert.equal(scene.canvasWorkspace.initial.execution.links.length, 1);
  assert.equal(scene.canvasWorkspace.business.completion.reference.execution.links.length, 2);
  assert.equal(JSON.stringify(browserDefinition), originalDefinition, 'Builder must not mutate the shared synthetic definition');
  let document = structuredClone(scene.canvasWorkspace.initial);
  const host = new S2PluginHost(scene.sceneId, scene.canvasWorkspace.plugins);
  host.setDocument(document);
  const memory = new S2ConversationMemory(scene.sceneId, host.runId);
  try {
    // A genuine synthetic user requirement makes host preservation observable;
    // an empty array alone could not prove a retire attempt was harmless.
    const seedQuery = '请保留我的笔记原文，修改与运行分别确认。';
    const seedFrame = memory.begin(scene.sceneId, host.runId, seedQuery, 'user', document);
    const seedReply: S2AgentReply = { understanding: '合成用户记忆种子', plan: '仅建立有出处的测试条件', reply: '合成测试条件', commands: [] };
    memory.stage(seedReply, seedFrame, memory.propose(seedFrame, { set: [{ id: 'PreserveNotes', kind: 'constraint',
      text: '保留笔记原文，修改和运行分别确认', quote: seedQuery, nodeIds: ['notes'] }] }));
    assert.equal(memory.accept(seedReply), true);
    const expectedMemory = memory.snapshot();
    const context = () => host.prepare(null, { goal: scene.canvasWorkspace.goal, ...scene.canvasWorkspace.instructions }, 'Synthetic browser protocol turn');
    const options = () => ({ invoke, pluginContext: context(), memory });
    const assertOriginalFields = () => {
      assert.equal(document.nodes.find(node => node.id === 'notes').values.content, browserNotesText);
      assert.equal(document.nodes.find(node => node.id === 'input').values.content, browserInputText);
    };

    const beforeExplain = JSON.stringify(document);
    const explanation = await interactS2Canvas(scene, document, '解释一下类型区别，不改图也不运行。', null, [], options());
    assert.deepEqual(explanation.commands, []); assert.equal(explanation.executionRequest, undefined);
    assert.equal(explanation.assessment, undefined); assert.equal(JSON.stringify(document), beforeExplain);
    assert.equal(memory.accept(explanation), true); assert.deepEqual(memory.snapshot(), expectedMemory);
    const explainAction = inputs.find(input => input.stage === 'turn-act');
    assert.deepEqual(explainAction.intent.skillIds, ['Types']);
    assert.deepEqual(explainAction.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Types']);
    assert.equal(explainAction.memoryWritable, true);

    setBrowserFixtureMode('edit');
    const beforeEdit = JSON.stringify(document), beforeReviewCalls = inputs.length;
    const edit = await interactS2Canvas(scene, document, '请帮我补齐必要连线，原文保留，只先提出方案。', null, [], options());
    assert.equal(edit.commands.length, 1); assert.equal(edit.executionRequest, undefined);
    assert.equal(JSON.stringify(document), beforeEdit, 'A returned proposal is not an applied edit');
    assert.deepEqual(inputs.slice(beforeReviewCalls).map(input => input.stage), ['turn-understand', 'turn-act', 'turn-proposal-review']);
    const review = inputs.at(-1);
    assert.equal(review.proposalOnly, true); assert.equal(review.sources.find((source: { id: string }) => source.id === 'query').kind, 'user');
    document = applyS2Commands(scene.canvasWorkspace, document, edit.commands);
    assert.equal(document.execution.links.length, 2); assertOriginalFields();
    assert.equal(memory.accept(edit), true); host.setDocument(document);
    assert.equal(host.workflowHistory().length, 0, 'Confirmed edit does not run tools');

    setBrowserFixtureMode('execute');
    const execution = await interactS2Canvas(scene, document, '现在申请运行本地表格展示目标。', null, [], options());
    assert.deepEqual(execution.commands, []); assert.deepEqual(execution.executionRequest.targetNodeIds, ['view']);
    assert.equal(host.workflowHistory().length, 0, 'Execution request still awaits separate user confirmation');
    assert.equal(memory.accept(execution), true);
    // Explicit local test confirmation, not a model-created receipt or UI/browser E2E.
    const job = host.enqueueWorkflow(execution.executionRequest.targetNodeIds);
    const run = await job.completion;
    assert.equal(run.status, 'succeeded'); assert.equal(run.publication, 'current');
    assert.equal(host.workflowHistory().length, 1); assert.equal(host.history().length, 2, 'Renderer must not forge a third plugin call');
    const displayed = run.nodes.find(node => node.nodeId === 'view');
    assert.equal(displayed.status, 'displayed'); assert.equal(displayed.artifactIds.length, 1);
    const table = host.currentArtifact(displayed.artifactIds[0]);
    assert.equal(table.payload.kind, 'inline');
    if (table.payload.kind !== 'inline') assert.fail('Real displayed table must have complete inline data');
    assert.deepEqual(s2TableToRecords(table.payload.value as unknown as S2Table), JSON.parse(browserInputText));
    assertOriginalFields();

    const completed = context();
    completed.frame.event = { id: 'SyntheticBrowserCompleted', kind: 'workflow-completed', workflowRunId: job.id };
    const beforeHostCalls = inputs.length, beforeHostLedger = JSON.stringify(host.history()), beforeHostMemory = memory.snapshot();
    const hostResult = await interactS2Canvas(scene, document, '本地宿主结果通知。', null, [], { invoke, pluginContext: completed, memory, origin: 'host-event' });
    assert.deepEqual(inputs.slice(beforeHostCalls).map(input => input.stage), ['turn-understand', 'turn-act']);
    const hostInputs = inputs.slice(beforeHostCalls), hostOutputs = outputs.filter(item => item.input.origin === 'host-event');
    assert.equal(hostInputs[0].memoryEnabled, true); assert.equal(hostInputs[0].memoryWritable, false);
    assert.equal(hostInputs[0].triggeredExecution.available, true);
    assert.equal(hostInputs[0].triggeredExecution.workflowRunId, job.id);
    assert.equal(hostInputs[0].triggeredExecution.workflow.status, run.status);
    assert.ok(hostOutputs[0].value.memoryUpdate.set.length, 'Fixture genuinely attempts an unauthorized semantic sidecar');
    assert.ok(hostOutputs[1].value.memoryUpdate.retire.length, 'Fixture genuinely attempts an unauthorized action sidecar');
    assert.equal(Object.hasOwn(hostInputs[1].intent, 'memoryUpdate'), false);
    assert.equal(Object.hasOwn(hostResult, 'memoryUpdate'), false);
    assert.deepEqual(hostResult.commands, []); assert.equal(hostResult.executionRequest, undefined);
    assert.equal(hostResult.pluginRequests, undefined); assert.equal(hostResult.assessment, undefined);
    assert.ok(hostResult.reply.includes(run.status)); assert.ok(hostResult.reply.includes(job.id));
    assert.equal(memory.accept(hostResult), true); assert.deepEqual(memory.snapshot(), beforeHostMemory);
    assert.deepEqual(browserFixtureState.readonlyMemoryRecords.map((record: any) => record.id), ['PreserveNotes']);
    assert.equal(JSON.stringify(host.history()), beforeHostLedger); assert.equal(host.workflowHistory().length, 1);
    assert.equal(browserFixtureState.lastOrigin, 'host-event'); assert.equal(browserFixtureState.lastMemoryWritable, false);

    setBrowserFixtureMode('host-failure');
    const beforeFailureCalls = inputs.length, beforeFailureMemory = memory.snapshot();
    await assert.rejects(interactS2Canvas(scene, document, '本地宿主结果通知。', null, [],
      { invoke, pluginContext: completed, memory, origin: 'host-event' }), /Synthetic host interpretation failure/);
    assert.equal(inputs.length, beforeFailureCalls + 1, 'Synthetic transport failure is not a paid format/memory retry');
    assert.equal(browserFixtureState.calls.at(-1).status, 'failed');
    assert.deepEqual(memory.snapshot(), beforeFailureMemory); assert.equal(JSON.stringify(host.history()), beforeHostLedger);

    const beforeSave = await loadManifest({ strict: true }), beforeSavedTemplates = browserFixtureState.savedTemplates.length;
    const saved = await saveScene({ ...scene, canvasWorkspace: { ...scene.canvasWorkspace, initial: document } });
    assert.equal((await loadManifest({ strict: true })).scenes.length, beforeSave.scenes.length + 1);
    assert.equal(browserFixtureState.savedTemplates.length, beforeSavedTemplates + 1);
    assert.deepEqual((await loadScene(saved.sceneId)).canvasWorkspace.initial, document);
    saved.meta.name = 'MutatedCallerCopy'; saved.canvasWorkspace.initial.nodes[0].values.content = 'MutatedCallerInput';
    const loaded = await loadScene(scene.sceneId); loaded.meta.name = 'MutatedLoadedCopy'; loaded.canvasWorkspace.initial.nodes[0].values.content = 'MutatedLoadedInput';
    const loadedAgain = await loadScene(scene.sceneId);
    assert.notEqual(loadedAgain.meta.name, 'MutatedCallerCopy'); assert.notEqual(loadedAgain.meta.name, 'MutatedLoadedCopy');
    assert.equal(loadedAgain.canvasWorkspace.initial.nodes.find(node => node.id === 'input').values.content, browserInputText);
    assert.equal(loadedAgain.canvasWorkspace.initial.nodes.find(node => node.id === 'notes').values.content, browserNotesText);

    setBrowserFixtureMode('delay');
    const controller = new AbortController(), beforeDelayedMemory = memory.snapshot();
    const delayed = interactS2Canvas(scene, document, '合成迟到响应检查，不修改或运行。', null, [], { ...options(), signal: controller.signal });
    for (let attempts = 0; attempts < 50 && !browserFixtureState.pendingResponses; attempts++) await Promise.resolve();
    assert.equal(browserFixtureState.pendingResponses, 1, 'Delay must hold the action response rather than fake a canceled request');
    const delayedRecord = browserFixtureState.calls.at(-1);
    assert.equal(delayedRecord.stage, 'turn-act'); assert.equal(delayedRecord.status, 'pending');
    controller.abort(); assert.equal(releaseBrowserFixtureResponse(), true);
    await assert.rejects(delayed, error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(delayedRecord.status, 'returned', 'Fixture intentionally returned despite abort; production rejected it');
    assert.equal(browserFixtureState.pendingResponses, 0); assert.equal(releaseBrowserFixtureResponse(), false);
    assert.deepEqual(memory.snapshot(), beforeDelayedMemory); assert.equal(JSON.stringify(host.history()), beforeHostLedger); assertOriginalFields();
    const ownCalls = browserFixtureState.calls.slice(initialCallCount);
    assert.equal(ownCalls.some(call => call.memoryRepair || call.responseRepair), false);
    assert.equal(ownCalls.length, 14, '2 builder + 2 explain + 3 edit + 2 execute + 2 host + 1 failure + 2 delayed');
    assert.ok(ownCalls.every(call => call.scenario === 'records'));
    assert.equal(browserFixtureState.realModelCalls, 0); assert.equal(browserFixtureState.networkCalls, 0); assert.equal(browserFixtureState.persistentWrites, 0);
    assert.equal(browserFixtureState.memoryOnly, true); assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 browser protocol passed offline: real builder/controller/host, two-stage design, skill-loaded explanation, edit proposal/review/application with original fields preserved, separately confirmed actual JSON/table/display execution, matching host-event with both unauthorized memory sidecars isolated, synthetic host failure without tool replay, clone-isolated ephemeral templates, and late action response rejected by production abort gate. No network/settings/Electron IO, real-model semantics or browser acceptance.');
  } finally { host.close(); memory.close(); setBrowserFixtureMode('explain'); }

  // A second explicit scenario, not a user-text classifier: real controllers and host, synthetic decisions only.
  setBrowserFixtureScenario('text-template'); setBrowserFixtureMode('explain');
  const templateStart = inputs.length, templateCallStart = browserFixtureState.calls.length;
  const originalTemplateDefinition = JSON.stringify(browserTemplateDefinition);
  readS2Definition(browserTemplateDefinition, { requireBusiness: true });
  const templateScene = createS2Scene(browserTemplateRequest);
  templateScene.canvasWorkspace = await designS2Canvas(templateScene, { disclosure: 'complete', invoke });
  const templateDefinition = templateScene.canvasWorkspace;
  assert.deepEqual(inputs.slice(templateStart).map(input => input.stage), ['understand', 'assemble']);
  assert.deepEqual(templateDefinition.plugins.map(item => `${item.pluginId}/${item.capabilityId}`), ['text-template/bind', 'text-template/render']);
  assert.equal(templateDefinition.initial.nodes.length, 4); assert.equal(templateDefinition.initial.execution.nodes.length, 4);
  assert.equal(templateDefinition.initial.execution.links.length, 2);
  assert.equal(templateDefinition.business.completion.reference.execution.links.length, 3);
  assert.deepEqual(templateDefinition.business.completion.targetNodeIds, ['Privaterender']);
  assert.deepEqual(templateDefinition.business.knowledge.map(item => item.id), ['Types', 'Meaning']);
  assert.ok(templateDefinition.business.criteria.every(item => item.method === 'advisory' && !item.required));
  let templateDocument = structuredClone(templateDefinition.initial);
  const originalTemplateFields = JSON.stringify(templateDocument.nodes);
  const templateHost = new S2PluginHost(templateScene.sceneId, templateDefinition.plugins); templateHost.setDocument(templateDocument);
  const templateMemory = new S2ConversationMemory(templateScene.sceneId, templateHost.runId);
  try {
    const context = () => templateHost.prepare(null, { goal: templateDefinition.goal, ...templateDefinition.instructions }, 'Synthetic text-template protocol turn');
    const options = () => ({ invoke, pluginContext: context(), memory: templateMemory });
    assert.deepEqual(context().approvedCapabilities, templateDefinition.plugins);
    assert.throws(() => templateHost.enqueueWorkflow(['render']), /输入|必需|缺/);
    assert.equal(templateHost.workflowHistory().length, 0, 'An incomplete template graph cannot create a fictitious run');
    const explanationStart = inputs.length;
    const explanation = await interactS2Canvas(templateScene, templateDocument, '解释装配文本和测试LLM效果的区别，先不改图或运行。', null, [], options());
    assert.deepEqual(explanation.commands, []); assert.equal(explanation.executionRequest, undefined); assert.equal(explanation.assessment, undefined);
    assert.ok(explanation.reply.includes('替换一次')); assert.ok(explanation.reply.includes('不调用LLM')); assert.ok(explanation.reply.includes('不验证提示词效果'));
    assert.equal(templateMemory.accept(explanation), true);
    const explanationInput = inputs.slice(explanationStart).find(input => input.stage === 'turn-act');
    assert.deepEqual(explanationInput.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Types']);
    assert.ok(!JSON.stringify(inputs.slice(explanationStart)).includes('PrivatebindRole'), 'Private completion witness stays out of interaction context');
    assert.equal(JSON.stringify(templateDocument.nodes), originalTemplateFields);

    setBrowserFixtureMode('edit'); const editStart = inputs.length;
    const edit = await interactS2Canvas(templateScene, templateDocument, '请只提出最后一条必要连线，保留四段原文，先不运行。', null, [], options());
    assert.deepEqual(edit.commands, [{ op: 'connect-ports', link: { source: { nodeId: 'bindConstraints', portId: 'variables' }, target: { nodeId: 'render', portId: 'variables' } } }]);
    assert.equal(edit.executionRequest, undefined);
    assert.deepEqual(inputs.slice(editStart).map(input => input.stage), ['turn-understand', 'turn-act', 'turn-proposal-review']);
    assert.equal(templateDocument.execution.links.length, 2, 'Template edit proposal waits for independent application');
    templateDocument = applyS2Commands(templateDefinition, templateDocument, edit.commands);
    assert.equal(templateDocument.execution.links.length, 3); assert.equal(templateMemory.accept(edit), true);
    assert.equal(JSON.stringify(templateDocument.nodes), originalTemplateFields); templateHost.setDocument(templateDocument);
    assert.equal(templateHost.workflowHistory().length, 0); assert.equal(templateHost.history().length, 0);

    setBrowserFixtureMode('execute');
    const execution = await interactS2Canvas(templateScene, templateDocument, '申请运行本地装配目标，不能发送LLM请求。', null, [], options());
    assert.deepEqual(execution.commands, []); assert.deepEqual(execution.executionRequest.targetNodeIds, ['render']);
    assert.ok(execution.reply.includes('不调用LLM')); assert.equal(templateHost.workflowHistory().length, 0);
    assert.equal(templateMemory.accept(execution), true);
    const job = templateHost.enqueueWorkflow(execution.executionRequest.targetNodeIds), run = await job.completion;
    assert.equal(run.status, 'succeeded'); assert.equal(run.publication, 'current'); assert.deepEqual(run.targets, ['render']);
    assert.deepEqual(run.nodes.map(node => node.nodeId), ['bindRole', 'bindTask', 'bindConstraints', 'render']);
    assert.equal(templateHost.history().length, 4, 'Exactly three genuine local variable bindings and one render execute');
    assert.equal(templateHost.remainingCalls, 60);
    const render = run.nodes.find(node => node.nodeId === 'render'); assert.equal(render.status, 'succeeded');
    const textArtifact = templateHost.currentArtifact(render.artifactIds[0]);
    assert.equal(textArtifact.type.id, 'core.text'); assert.equal(textArtifact.complete, true); assert.equal(textArtifact.payload.kind, 'inline');
    if (textArtifact.payload.kind !== 'inline') assert.fail('Template output must be a complete genuine local artifact');
    assert.equal(textArtifact.payload.value, '角色：你是一位耐心的提示词工程教练。\n任务：解释检索增强生成，并给出一个学习场景。\n约束：用中文回答，最多三点；原样保留符号 $& 与 {{literal}}，不要把它们当成代码。');
    assert.equal(textArtifact.source.nodeId, 'render'); assert.equal(textArtifact.source.kind, 'plugin');
    assert.equal(textArtifact.source.invocationId, render.invocationId);
    const variables = templateHost.currentArtifact(run.nodes.find(node => node.nodeId === 'bindConstraints').artifactIds[0]);
    assert.equal(variables.payload.kind, 'inline');
    if (variables.payload.kind !== 'inline') assert.fail('Variable dictionary must remain complete');
    assert.deepEqual(Object.keys(variables.payload.value), ['role', 'task', 'constraints']);
    assert.equal(JSON.stringify(templateDocument.nodes), originalTemplateFields, 'Actual assembly preserves all original text blocks');

    const completed = context(); completed.frame.event = { id: 'SyntheticTemplateCompleted', kind: 'workflow-completed', workflowRunId: job.id };
    const beforeHost = inputs.length, ledgerBeforeHost = JSON.stringify(templateHost.history()), memoryBeforeHost = templateMemory.snapshot();
    const hostResult = await interactS2Canvas(templateScene, templateDocument, '本地模板装配完成通知。', null, [], { invoke, pluginContext: completed, memory: templateMemory, origin: 'host-event' });
    assert.deepEqual(inputs.slice(beforeHost).map(input => input.stage), ['turn-understand', 'turn-act']);
    assert.equal(inputs[beforeHost].triggeredExecution.workflowRunId, job.id);
    assert.equal(inputs[beforeHost].triggeredExecution.workflow.status, 'succeeded'); assert.equal(inputs[beforeHost].memoryWritable, false);
    assert.ok(hostResult.reply.includes(job.id)); assert.ok(hostResult.reply.includes('render节点状态为 succeeded'));
    assert.ok(hostResult.reply.includes('没有发送LLM请求')); assert.ok(hostResult.reply.includes('不代表模型回复或提示词效果'));
    assert.deepEqual(hostResult.commands, []); assert.equal(hostResult.executionRequest, undefined); assert.equal(hostResult.pluginRequests, undefined); assert.equal(hostResult.assessment, undefined);
    assert.equal(Object.hasOwn(hostResult, 'memoryUpdate'), false); assert.equal(templateMemory.accept(hostResult), true);
    assert.deepEqual(templateMemory.snapshot(), memoryBeforeHost); assert.equal(JSON.stringify(templateHost.history()), ledgerBeforeHost);
    assert.equal(templateHost.workflowHistory().length, 1); assert.equal(JSON.stringify(templateDocument.nodes), originalTemplateFields);
    assert.equal(JSON.stringify(browserTemplateDefinition), originalTemplateDefinition, 'Builder and interaction do not mutate the shared synthetic template definition');
    const templateCalls = browserFixtureState.calls.slice(templateCallStart);
    assert.equal(templateCalls.length, 11, '2 builder + 2 explain + 3 edit + 2 execute + 2 host, all deterministic fixtures');
    assert.ok(templateCalls.every(call => call.scenario === 'text-template' && !call.memoryRepair && !call.responseRepair));
    assert.equal(browserFixtureState.realModelCalls, 0); assert.equal(browserFixtureState.networkCalls, 0); assert.equal(browserFixtureState.persistentWrites, 0);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 text-template browser protocol passed offline: explicit scenario selection, real staged builder/controller, Types skill loading without private witness, original four-block preservation, separately confirmed single missing-link edit and exact render target, three actual bindings plus single-pass literal output, and readonly host-event with exact run/node status. No real-model/browser/IO acceptance or prompt-effect claim.');
  } finally { templateHost.close(); templateMemory.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  // Third explicit scenario: production staged design/turn/host/session with
  // exact local assembly and ONLY the isolated synthetic model transport.
  setBrowserFixtureScenario('model-test'); setBrowserFixtureMode('explain');
  const { prepareS2ModelTestProvider } = await import('./fixtures/s2-browser-model-transport');
  readS2Definition(browserModelDefinition, { requireBusiness: true });
  const modelScene = createS2Scene(browserModelRequest), modelCallStart = inputs.length;
  modelScene.canvasWorkspace = await designS2Canvas(modelScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(modelCallStart).map(input => input.stage), ['understand', 'assemble']);
  const modelDefinition = modelScene.canvasWorkspace;
  assert.deepEqual(modelDefinition.plugins.map(item => `${item.pluginId}/${item.capabilityId}`), ['text-template/bind', 'text-template/render', 'model-test/generate']);
  assert.deepEqual(modelDefinition.business.completion.targetNodeIds, ['PrivatetestModel']);
  let modelDocument = structuredClone(modelDefinition.initial);
  const originalModelFields = JSON.stringify(modelDocument.nodes);
  const modelHost = new S2PluginHost(modelScene.sceneId, modelDefinition.plugins); modelHost.setDocument(modelDocument);
  const modelMemory = new S2ConversationMemory(modelScene.sceneId, modelHost.runId);
  try {
    const options = () => ({ invoke, pluginContext: modelHost.prepare(null, { goal: modelDefinition.goal, ...modelDefinition.instructions }, 'Synthetic model protocol'), memory: modelMemory });
    const beforeSynthetic = browserFixtureState.syntheticModelRequests.length;
    setBrowserFixtureMode('edit');
    const edit = await interactS2Canvas(modelScene, modelDocument, '保留原文，先只提出必要补线方案，不运行。', null, [], options());
    assert.equal(edit.commands.length, 1); assert.equal(edit.executionRequest, undefined);
    modelDocument = applyS2Commands(modelDefinition, modelDocument, edit.commands); modelHost.setDocument(modelDocument);
    assert.equal(modelMemory.accept(edit), true); assert.equal(JSON.stringify(modelDocument.nodes), originalModelFields);
    assert.throws(() => modelHost.enqueueWorkflow(['testModel']), /授权|模型/);
    const provider = await prepareS2ModelTestProvider();
    assert.equal(browserFixtureState.syntheticModelRequests.length, beforeSynthetic);
    const session = provider.createSession(modelScene.sceneId, modelHost.runId, { maxRequests: 1, maxReservedOutputTokens: 512, maxOutputTokens: 512 });
    modelHost.approveModelTestSession(session);
    assert.throws(() => provider.createSession(modelScene.sceneId, modelHost.runId, { maxRequests: 1, maxReservedOutputTokens: 512, maxOutputTokens: 512 }));
    setBrowserFixtureMode('execute');
    const execution = await interactS2Canvas(modelScene, modelDocument, '申请运行模型测试，实际提示词仍须我确认。', null, [], options());
    assert.deepEqual(execution.commands, []); assert.deepEqual(execution.executionRequest?.targetNodeIds, ['testModel']);
    assert.equal(modelMemory.accept(execution), true); assert.equal(modelHost.workflowHistory().length, 0);
    const waitFor = async (workflowId: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const wait = modelHost.waitingModelTests().find(wait => wait.workflowId === workflowId);
        if (wait) return wait;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.fail('Synthetic model workflow did not wait for explicit confirmation');
    };
    const rejectedJob = modelHost.enqueueWorkflow(['testModel']), rejectedWait = await waitFor(rejectedJob.id);
    assert.equal(browserFixtureState.syntheticModelRequests.length, beforeSynthetic); assert.equal(session.summary().usedRequests, 0);
    modelHost.confirmModelTest(rejectedJob.id, rejectedWait.id, false);
    assert.notEqual((await rejectedJob.completion).status, 'succeeded'); assert.equal(session.summary().usedRequests, 0);
    const job = modelHost.enqueueWorkflow(execution.executionRequest!.targetNodeIds), wait = await waitFor(job.id);
    assert.equal(wait.prompt, '角色：你是一位耐心的提示词工程教练。\n任务：解释检索增强生成，并给出一个学习场景。\n约束：用中文回答，最多三点；原样保留符号 $& 与 {{literal}}，不要把它们当成代码。');
    assert.equal(wait.input, modelDocument.nodes.find(node => node.id === 'testInput')!.values.content);
    modelHost.confirmModelTest(job.id, wait.id, true); assert.throws(() => modelHost.confirmModelTest(job.id, wait.id, true));
    const run = await job.completion; assert.equal(run.status, 'succeeded');
    assert.equal(browserFixtureState.syntheticModelRequests.length, beforeSynthetic + 1);
    assert.deepEqual(browserFixtureState.syntheticModelRequests.at(-1), { prompt: wait.prompt, input: wait.input, maxOutputTokens: 512 });
    assert.equal(session.summary().usedRequests, 1); assert.equal(session.summary().reservedOutputTokens, 512);
    const generated = run.nodes.find(node => node.nodeId === 'testModel')!, result = modelHost.currentArtifact(generated.artifactIds[0]);
    assert.equal(result.type.id, 'core.text'); assert.equal(result.complete, true);
    assert.ok(result.payload.kind === 'inline' && typeof result.payload.value === 'string' && result.payload.value.includes('不是实际LLM回答'));
    const completed = options(); completed.pluginContext.frame.event = { id: 'SyntheticModelCompleted', kind: 'workflow-completed', workflowRunId: job.id };
    const hostResult = await interactS2Canvas(modelScene, modelDocument, '模型测试完成通知', null, [], { ...completed, origin: 'host-event' });
    assert.ok(hostResult.reply.includes(job.id)); assert.ok(hostResult.reply.includes('testModel节点状态为 succeeded'));
    assert.ok(hostResult.reply.includes('不是真实LLM回包')); assert.deepEqual(hostResult.commands, []); assert.equal(hostResult.executionRequest, undefined);
    assert.equal(modelMemory.accept(hostResult), true); assert.equal(JSON.stringify(modelDocument.nodes), originalModelFields);
    const saved = await saveScene({ ...modelScene, canvasWorkspace: { ...modelDefinition, initial: modelDocument } });
    const savedText = JSON.stringify(saved);
    assert.ok(!savedText.includes(provider.resourceId) && !savedText.includes('maxReservedOutputTokens') && !savedText.includes('合成模型回包：'));
    modelHost.revokeModelTests(); assert.equal(modelHost.modelTestSummary()!.active, false);
    assert.throws(() => modelHost.approveModelTestSession(session));
    assert.equal(browserFixtureState.realModelCalls, 0); assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 model-node browser protocol passed offline: real staged builder/turn/host/session, complete original template and input, separate budget and exact per-call wait, reject zero spend, single confirm exactly one synthetic transport call, complete artifact and matching readonly result handoff, saved-template authority exclusion and permanent revoke. No actual model, network, user data, browser or semantic-effect acceptance.');
  } finally { modelHost.close(); modelMemory.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  // Fourth browser fixture: both real scoped resource bridges, with synthetic data only.
  const { browserResourceRequest, browserResourceDefinition, browserResourceSource, browserResourceState, browserResourceText } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('resources');
  readS2Definition(browserResourceDefinition, { requireBusiness: true });
  const resourceScene = createS2Scene(browserResourceRequest), resourceCallStart = inputs.length;
  resourceScene.canvasWorkspace = await designS2Canvas(resourceScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(resourceCallStart).map(input => input.stage), ['understand', 'assemble']);
  const resourceHost = new S2PluginHost(resourceScene.sceneId, resourceScene.canvasWorkspace.plugins);
  try {
    resourceHost.setDocument(resourceScene.canvasWorkspace.initial); resourceHost.bindProjectNotes(browserResourceSource);
    assert.equal(browserResourceState.reads, 0);
    const note = resourceHost.approveProjectNote('synthetic-note'), file = resourceHost.approveTextFile(new File([browserResourceText], '合成资料.json'));
    const resourceDocument = structuredClone(resourceScene.canvasWorkspace.initial);
    resourceDocument.execution!.nodes.find(node => node.id === 'noteRead')!.bindings.resource = { kind: 'literal', value: note.id };
    resourceDocument.execution!.nodes.find(node => node.id === 'fileRead')!.bindings.resource = { kind: 'literal', value: file.id };
    resourceHost.setDocument(resourceDocument); assert.equal(browserResourceState.reads, 0);
    const run = await resourceHost.enqueueWorkflow().completion;
    assert.equal(run.status, 'succeeded'); assert.equal(browserResourceState.reads, 1);
    for (const id of ['fileView', 'noteView']) {
      const output = resourceHost.currentArtifact(run.nodes.find(node => node.nodeId === id)!.artifactIds[0]);
      assert.ok(output.payload.kind === 'inline');
      if (output.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(output.payload.value as unknown as S2Table), JSON.parse(browserResourceText));
    }
    browserResourceState.version = 'v2'; assert.equal(resourceHost.projectNoteSummary()[0].available, false);
    browserResourceState.version = 'v1'; assert.equal(resourceHost.projectNoteSummary()[0].available, false);
    const beforeFailure = resourceHost.remainingCalls;
    const failed = await resourceHost.enqueueWorkflow(['noteView', 'fileView']).completion;
    assert.notEqual(failed.status, 'succeeded'); assert.equal(failed.nodes.find(node => node.nodeId === 'fileView')!.status, 'displayed');
    assert.equal(browserResourceState.reads, 1); assert.equal(resourceHost.remainingCalls, beforeFailure - 1);
    resourceHost.revokeProjectNote(note.id); const fresh = resourceHost.approveProjectNote('synthetic-note');
    resourceDocument.execution!.nodes.find(node => node.id === 'noteRead')!.bindings.resource = { kind: 'literal', value: fresh.id };
    resourceHost.setDocument(resourceDocument); resourceHost.revokeTextFile(file.id);
    assert.equal((await resourceHost.enqueueWorkflow(['noteView']).completion).status, 'succeeded'); assert.equal(browserResourceState.reads, 2);
    const saved = await saveScene({ ...resourceScene, canvasWorkspace: { ...resourceScene.canvasWorkspace, initial: resourceDocument } });
    assert.ok(!JSON.stringify(saved).includes(browserResourceText));
    const freshHost = new S2PluginHost(resourceScene.sceneId, resourceScene.canvasWorkspace.plugins);
    try { freshHost.bindProjectNotes(browserResourceSource); freshHost.setDocument(saved.canvasWorkspace!.initial);
      assert.equal((await freshHost.enqueueWorkflow(['noteView']).completion).status, 'failed'); assert.equal(freshHost.history().length, 0);
    } finally { freshHost.close(); }
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 resource browser fixture passed offline: staged design, exact two native resource bridges, metadata-only approval/binding, full data to tables, sticky invalidation/reapproval, independent file branch, revocation and inert saved handles. Synthetic data only; this script does not claim browser or OS-picker acceptance.');
  } finally { resourceHost.close(); browserResourceState.version = 'v1'; browserResourceState.present = true; setBrowserFixtureScenario('records'); }
  // Fifth fixture reuses the same builder/turn contracts; the form itself grants no capabilities.
  const { browserRecordFormRequest, browserRecordFormDefinition, browserRecordFormValue } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('record-form'); setBrowserFixtureMode('edit');
  readS2Definition(browserRecordFormDefinition, { requireBusiness: true });
  const recordScene = createS2Scene(browserRecordFormRequest), recordStart = inputs.length;
  recordScene.canvasWorkspace = await designS2Canvas(recordScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(recordStart).map(input => input.stage), ['understand', 'assemble']);
  const recordHost = new S2PluginHost(recordScene.sceneId, recordScene.canvasWorkspace.plugins);
  try {
    recordHost.setDocument(recordScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(recordScene, recordScene.canvasWorkspace.initial, '解释填写与运行的区别，不要替我操作', null, [], {
      invoke, pluginContext: recordHost.prepare(null, { goal: recordScene.canvasWorkspace.goal, ...recordScene.canvasWorkspace.instructions }, '合成记录填写说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined);
    assert.equal(recordHost.remainingCalls, 64); assert.equal(recordHost.workflowHistory().length, 0);
    assert.equal((await recordHost.enqueueWorkflow(['recordView']).completion).status, 'succeeded');
    const result = recordHost.workflowHistory().at(-1)!;
    const output = recordHost.currentArtifact(result.nodes.find(node => node.nodeId === 'recordView')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline');
    if (output.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(output.payload.value as unknown as S2Table), browserRecordFormValue);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 record-form browser fixture passed offline: real two-stage builder and turn contracts, inert explain-only synthetic reply even in edit test mode, two authorized native capabilities, explicit local execution with exact independent record data. No model semantics or browser acceptance claim.');
  } finally { recordHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserGroupFormRequest, browserGroupFormDefinition, browserGroupFormValue } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('group-form'); setBrowserFixtureMode('execute');
  readS2Definition(browserGroupFormDefinition, { requireBusiness: true });
  const groupScene = createS2Scene(browserGroupFormRequest), groupStart = inputs.length;
  groupScene.canvasWorkspace = await designS2Canvas(groupScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(groupStart).map(input => input.stage), ['understand', 'assemble']);
  const groupHost = new S2PluginHost(groupScene.sceneId, groupScene.canvasWorkspace.plugins);
  try {
    groupHost.setDocument(groupScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(groupScene, groupScene.canvasWorkspace.initial, '只解释信息分组，先不要运行', null, [], {
      invoke, pluginContext: groupHost.prepare(null, { goal: groupScene.canvasWorkspace.goal, ...groupScene.canvasWorkspace.instructions }, '合成分组填写说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(groupHost.remainingCalls, 64);
    const run = await groupHost.enqueueWorkflow(['groupView']).completion; assert.equal(run.status, 'succeeded');
    const output = groupHost.currentArtifact(run.nodes.find(node => node.nodeId === 'groupSelect')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, browserGroupFormValue.练习设置);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 group-form browser fixture passed offline: real staged builder/turn contracts, explain-only synthetic reply without execution grant, exact native group selection and readonly display with existing two local capabilities. No model semantics or browser acceptance claim.');
  } finally { groupHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserListFormRequest, browserListFormDefinition, browserListFormValue } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('list-form'); setBrowserFixtureMode('execute');
  readS2Definition(browserListFormDefinition, { requireBusiness: true });
  const listScene = createS2Scene(browserListFormRequest), listStart = inputs.length;
  listScene.canvasWorkspace = await designS2Canvas(listScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(listStart).map(input => input.stage), ['understand', 'assemble']);
  const listHost = new S2PluginHost(listScene.sceneId, listScene.canvasWorkspace.plugins);
  try {
    listHost.setDocument(listScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(listScene, listScene.canvasWorkspace.initial, '只解释普通列表，先不要运行', null, [], {
      invoke, pluginContext: listHost.prepare(null, { goal: listScene.canvasWorkspace.goal, ...listScene.canvasWorkspace.instructions }, '合成列表填写说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(listHost.remainingCalls, 64);
    const run = await listHost.enqueueWorkflow(['listView']).completion; assert.equal(run.status, 'succeeded');
    const output = listHost.currentArtifact(run.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, browserListFormValue);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 list-form browser fixture passed offline: staged builder/turn contracts with inert explain-only response even in execute mode; exact mixed-scalar native list through two existing local capabilities. No semantic or actual browser acceptance claim.');
  } finally { listHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserNamedListFormRequest, browserNamedListFormDefinition, browserNamedListFormValue } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('named-list-form'); setBrowserFixtureMode('edit');
  readS2Definition(browserNamedListFormDefinition, { requireBusiness: true });
  const namedListScene = createS2Scene(browserNamedListFormRequest), namedListStart = inputs.length;
  namedListScene.canvasWorkspace = await designS2Canvas(namedListScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(namedListStart).map(input => input.stage), ['understand', 'assemble']);
  const namedListHost = new S2PluginHost(namedListScene.sceneId, namedListScene.canvasWorkspace.plugins);
  try {
    namedListHost.setDocument(namedListScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(namedListScene, namedListScene.canvasWorkspace.initial, '只解释知识点和参考例子怎么填，不要修改或运行', null, [], {
      invoke, pluginContext: namedListHost.prepare(null, { goal: namedListScene.canvasWorkspace.goal, ...namedListScene.canvasWorkspace.instructions }, '合成具名列表填写说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(namedListHost.remainingCalls, 64);
    const run = await namedListHost.enqueueWorkflow(['listView']).completion; assert.equal(run.status, 'succeeded');
    const output = namedListHost.currentArtifact(run.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, browserNamedListFormValue);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 named-list-form browser fixture passed offline: staged builder/turn contracts, inert explain-only response in edit mode, exact independent field/group lists through unchanged real local select/view capabilities. No actual browser or model-semantic claim.');
  } finally { namedListHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserDeclaredFormRequest, browserDeclaredFormDefinition, browserDeclaredFormValue } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('declared-form'); setBrowserFixtureMode('execute');
  readS2Definition(browserDeclaredFormDefinition, { requireBusiness: true });
  const declaredScene = createS2Scene(browserDeclaredFormRequest), declaredStart = inputs.length;
  declaredScene.canvasWorkspace = await designS2Canvas(declaredScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(declaredStart).map(input => input.stage), ['understand', 'assemble']);
  const declaredHost = new S2PluginHost(declaredScene.sceneId, declaredScene.canvasWorkspace.plugins);
  try {
    declaredHost.setDocument(declaredScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(declaredScene, declaredScene.canvasWorkspace.initial, '解释练习要求怎么填写，不要替我操作', null, [], {
      invoke, pluginContext: declaredHost.prepare(null, { goal: declaredScene.canvasWorkspace.goal, ...declaredScene.canvasWorkspace.instructions }, '合成声明表单说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(declaredHost.remainingCalls, 64);
    const run = await declaredHost.enqueueWorkflow(['listView']).completion; assert.equal(run.status, 'succeeded');
    const output = declaredHost.currentArtifact(run.nodes.find(node => node.nodeId === 'listSelect')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.deepEqual(output.payload.value, browserDeclaredFormValue);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 declared-form browser fixture passed offline: staged design and inert reply, exact number/boolean/list/table data through existing real local select/view. Not browser focus or model-semantic acceptance.');
  } finally { declaredHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserFreeTemplateRequest, browserFreeTemplateDefinition, browserFreeTemplateText } = await import('./fixtures/s2-browser-definition');
  const { renderS2TextTemplate } = await import('../src/interaction-packs/prompt-lab/textTemplate');
  setBrowserFixtureScenario('template-layout'); setBrowserFixtureMode('edit');
  readS2Definition(browserFreeTemplateDefinition, { requireBusiness: true });
  const freeScene = createS2Scene(browserFreeTemplateRequest), freeStart = inputs.length;
  freeScene.canvasWorkspace = await designS2Canvas(freeScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(freeStart).map(input => input.stage), ['understand', 'assemble']);
  const freeHost = new S2PluginHost(freeScene.sceneId, freeScene.canvasWorkspace.plugins);
  try {
    const document = freeScene.canvasWorkspace.initial; freeHost.setDocument(document);
    const reply = await interactS2Canvas(freeScene, document, '先解释如何按名称插入材料，不要改图或运行', null, [], {
      invoke, pluginContext: freeHost.prepare(null, { goal: freeScene.canvasWorkspace.goal, ...freeScene.canvasWorkspace.instructions }, '合成自由排版说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(freeHost.remainingCalls, 64);
    const run = await freeHost.enqueueWorkflow(['render']).completion; assert.equal(run.status, 'succeeded');
    const output = freeHost.currentArtifact(run.nodes.find(node => node.nodeId === 'render')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline');
    if (output.payload.kind === 'inline') assert.equal(output.payload.value, renderS2TextTemplate(browserFreeTemplateText,
      Object.fromEntries(['role', 'task', 'constraints'].map(id => [id, document.nodes.find(node => node.id === id)!.values.content]))));
    assert.equal(document.execution!.nodes.find(node => node.id === 'render')!.bindings.template.kind, 'field');
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 free-template browser fixture passed offline: actual staged builder and explain-only turn, linked source template preserved, exact inline/repeated material assembly through four local calls and no model/network. Synthetic protocol only; not browser or model-effect acceptance.');
  } finally { freeHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { reviewTaskDefinition, reviewTaskRequest, reviewTaskSource, reviewTaskState, reviewTaskText } = await import('./fixtures/s2-review-task');
  setBrowserFixtureScenario('review-task'); setBrowserFixtureMode('execute');
  const reviewScene = createS2Scene(reviewTaskRequest), reviewStart = inputs.length;
  reviewScene.canvasWorkspace = await designS2Canvas(reviewScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(reviewStart).map(input => input.stage), ['understand', 'assemble']);
  const reviewHost = new S2PluginHost(reviewScene.sceneId, reviewScene.canvasWorkspace.plugins);
  try {
    const document = structuredClone(reviewScene.canvasWorkspace.initial); reviewHost.bindProjectNotes(reviewTaskSource); reviewHost.setDocument(document);
    const reply = await interactS2Canvas(reviewScene, document, '先解释，别替我选资料或确认', null, [], { invoke,
      pluginContext: reviewHost.prepare(null, { goal: reviewScene.canvasWorkspace.goal, ...reviewScene.canvasWorkspace.instructions }, '合成人工核对说明') });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(reviewHost.remainingCalls, 64);
    const reads = reviewTaskState.reads, note = reviewHost.approveProjectNote('reference-note'); assert.equal(reviewTaskState.reads, reads);
    document.execution!.nodes.find(node => node.id === 'readReference')!.bindings.resource = { kind: 'literal', value: note.id };
    reviewHost.setDocument(document);
    assert.equal((await reviewHost.enqueueWorkflow(['render']).completion).status, 'succeeded');
    const job = reviewHost.enqueueWorkflow(['acceptedText', 'declinedText']);
    for (let i = 0; i < 800 && !reviewHost.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
    const wait = reviewHost.waitingHumanInputs()[0]; assert.ok(wait); assert.equal(reviewTaskState.reads, reads + 2);
    const text = renderS2TextTemplate(document.nodes.find(node => node.id === 'template')!.values.content,
      { ...Object.fromEntries(['role', 'task', 'constraints'].map(id => [id, document.nodes.find(node => node.id === id)!.values.content])), reference: reviewTaskText });
    assert.ok(wait.artifacts[0].payload.kind === 'inline'); if (wait.artifacts[0].payload.kind === 'inline') assert.deepEqual(wait.artifacts[0].payload.value, { review: text });
    const discussionCalls = reviewHost.remainingCalls, discussionStart = inputs.length;
    const discussion = await interactS2Canvas(reviewScene, document, '先解释核对作用，不要代我确认或评价', 'confirmText', [], { invoke,
      memory: new S2ConversationMemory(reviewScene.sceneId, reviewHost.runId), selectedNodeIds: ['confirmText'],
      pluginContext: reviewHost.prepare('confirmText', { goal: reviewScene.canvasWorkspace.goal, ...reviewScene.canvasWorkspace.instructions }, '合成等待期间讨论') });
    assert.deepEqual(inputs.slice(discussionStart).map(input => input.stage), ['turn-understand', 'turn-act']);
    assert.deepEqual(discussion.commands, []); assert.equal(discussion.executionRequest, undefined);
    assert.equal(reviewHost.waitingHumanInputs()[0].id, wait.id); assert.equal(reviewHost.remainingCalls, discussionCalls);
    assert.equal(reviewTaskState.reads, reads + 2);
    reviewHost.submitHumanInput(job.id, wait.id, false); const run = await job.completion;
    assert.equal(run.status, 'succeeded'); assert.equal(run.nodes.find(node => node.nodeId === 'acceptedText')!.status, 'skipped');
    const output = reviewHost.currentArtifact(run.nodes.find(node => node.nodeId === 'declinedText')!.artifactIds[0]);
    assert.ok(output.payload.kind === 'inline'); if (output.payload.kind === 'inline') assert.equal(output.payload.value, '暂不确认，仅保留待修改文本：\n' + text);
    assert.equal(reviewHost.remainingCalls, 55); assert.equal(reviewTaskState.reads, reads + 2);
    const approvedJob = reviewHost.enqueueWorkflow(['acceptedText', 'declinedText']);
    for (let i = 0; i < 800 && !reviewHost.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
    const approvedWait = reviewHost.waitingHumanInputs()[0]; assert.ok(approvedWait);
    reviewHost.submitHumanInput(approvedJob.id, approvedWait.id, true); assert.equal((await approvedJob.completion).status, 'succeeded');
    const afterContext = reviewHost.prepare('confirmText', { goal: reviewScene.canvasWorkspace.goal, ...reviewScene.canvasWorkspace.instructions }, '合成完成后讨论');
    const { s2EvidenceIndex, s2PluginContext, s2RecallContext, readS2ContextRecall } = await import('../src/services/scene/sceneS2Context');
    const beforeProjection = JSON.stringify(afterContext), evidence = s2EvidenceIndex(afterContext)!;
    for (const entries of [evidence.observations, evidence.artifacts, evidence.trials]) assert.ok(JSON.stringify(entries).length <= 4000);
    assert.equal(evidence.artifactIndexOmitted, afterContext.artifactCatalog.length - evidence.artifacts.length);
    assert.equal(evidence.observationIndexOmitted, afterContext.receiptIndex.length - evidence.observations.length);
    const projected = s2PluginContext(afterContext, readS2ContextRecall(undefined))!;
    assert.ok(projected.executionRuns.every(run => 'nodeIndex' in run && !('nodes' in run)));
    assert.ok(projected.cacheReuses.flatMap(item => item.artifacts).every(item => !('preview' in item) && item.previewOmitted));
    const fullRun = afterContext.workflowArchive.find(item => item.id === approvedJob.id)!;
    const recalled = s2RecallContext(readS2ContextRecall({ workflowRunIds: [approvedJob.id] }), [], document, afterContext);
    assert.deepEqual(recalled.items.find(item => item.kind === 'workflow')!.value, fullRun, 'Explicit recall still returns the complete original run');
    assert.equal(JSON.stringify(afterContext), beforeProjection);
    const afterReply = await interactS2Canvas(reviewScene, document, '只解释这次同意的边界，不要改图或重跑。', 'confirmText', [
      { role: 'user', content: '先解释核对作用，不要代我确认或评价' }, { role: 'assistant', content: discussion.reply },
    ], { invoke, memory: new S2ConversationMemory(reviewScene.sceneId, reviewHost.runId), selectedNodeIds: ['confirmText'], pluginContext: afterContext });
    assert.deepEqual(afterReply.commands, []); assert.equal(afterReply.executionRequest, undefined);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0); assert.deepEqual(document.nodes, reviewTaskDefinition.initial.nodes);
    console.log('S2 combined review browser protocol passed offline: real staged builder and explain-only turn, explicit synthetic note approval/selection, complete local assembly to human context, refusal data with exact conditional output, no replay or model/network. Not live semantics or browser acceptance.');
  } finally { reviewHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { browserManualReuseRequest, browserManualReuseDefinition } = await import('./fixtures/s2-browser-definition');
  setBrowserFixtureScenario('manual-reuse'); setBrowserFixtureMode('execute');
  const manualScene = createS2Scene(browserManualReuseRequest), manualStart = inputs.length;
  manualScene.canvasWorkspace = await designS2Canvas(manualScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(manualStart).map(input => input.stage), ['understand', 'assemble']);
  assert.deepEqual(manualScene.canvasWorkspace.initial, browserManualReuseDefinition.initial);
  assert.equal(manualScene.canvasWorkspace.initial.execution.nodes.length, 0);
  const manualHost = new S2PluginHost(manualScene.sceneId, manualScene.canvasWorkspace.plugins);
  try {
    manualHost.setDocument(manualScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(manualScene, manualScene.canvasWorkspace.initial, '只说明保存后如何重新开始，不替我搭图或运行。', null, [], {
      invoke, pluginContext: manualHost.prepare(null, { goal: manualScene.canvasWorkspace.goal, ...manualScene.canvasWorkspace.instructions }, '合成复用说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(reply.pluginRequests?.length ?? 0, 0);
    assert.equal(manualHost.remainingCalls, 64); assert.equal(manualHost.workflowHistory().length, 0); assert.equal(manualHost.projectNoteSummary().length, 0);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 manual reuse browser fixture passed offline: real two-stage design with an empty public graph and retained legacy private reference, explain-only semantic fixture despite execute test mode, no assembly/runtime/resource authority from discussion. Actual manual handlers/save/reopen are tested separately; no live-model/browser/disk or user-comprehension claim.');
  } finally { manualHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
  const { manualPromptRequest, manualPromptDefinition } = await import('./fixtures/s2-review-task');
  setBrowserFixtureScenario('manual-prompt'); setBrowserFixtureMode('execute');
  const promptScene = createS2Scene(manualPromptRequest), promptStart = inputs.length;
  promptScene.canvasWorkspace = await designS2Canvas(promptScene, { disclosure: 'complete', invoke });
  assert.deepEqual(inputs.slice(promptStart).map(input => input.stage), ['understand', 'assemble']);
  assert.deepEqual(promptScene.canvasWorkspace.initial, manualPromptDefinition.initial);
  const promptHost = new S2PluginHost(promptScene.sceneId, promptScene.canvasWorkspace.plugins);
  try {
    promptHost.setDocument(promptScene.canvasWorkspace.initial);
    const reply = await interactS2Canvas(promptScene, promptScene.canvasWorkspace.initial, '先解释怎么按用途搭建，不代替我操作。', null, [], {
      invoke, pluginContext: promptHost.prepare(null, { goal: promptScene.canvasWorkspace.goal, ...promptScene.canvasWorkspace.instructions }, '合成空图说明'),
    });
    assert.deepEqual(reply.commands, []); assert.equal(reply.executionRequest, undefined); assert.equal(reply.pluginRequests?.length ?? 0, 0);
    assert.equal(promptHost.remainingCalls, 64); assert.equal(promptHost.workflowHistory().length, 0);
    assert.equal(networkAttempts, 0); assert.equal(electronAttempts, 0);
    console.log('S2 empty prompt browser fixture passed offline: retained legacy private reference, empty public graph, real two-stage protocol and read-only explanation, no implicit construction/run/consent; not real model semantics.');
  } finally { promptHost.close(); setBrowserFixtureMode('explain'); setBrowserFixtureScenario('records'); }
} finally {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
