// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition } from '../src/types/sceneS2';

const protectedGlobals = ['localStorage', 'window', 'electronAPI'] as const;
const previousGlobals = new Map(protectedGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const previousFetch = globalThis.fetch;
let forbiddenIo = 0;
globalThis.fetch = async () => { forbiddenIo++; throw new Error('S2 model boundary test forbids real IO'); };
// Keep production context budgeting on its pure Node/local ceiling, rather than
// activating real provider/settings hydration with a fake browser Storage.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
for (const key of ['window', 'electronAPI']) Object.defineProperty(globalThis, key, { configurable: true,
  get() { forbiddenIo++; throw new Error('S2 model boundary test forbids settings, Electron, notes and profile access'); } });
const hosts: Array<{ close(): void }> = [];
try {
  const { createS2Scene, designS2Canvas, interactS2Canvas, readS2Definition } = await import('../src/services/scene/sceneS2Canvas');
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const { S2ModelTestSession } = await import('../src/services/scene/sceneS2ModelTest');
  const { S2_PLUGIN_PROTOCOL_RULES } = await import('../src/services/scene/sceneS2PluginProtocol');
  const { S2_WORKFLOW_AGENT_RULES } = await import('../src/services/scene/sceneS2Workflow');
  const { s2DesignFixtureResponse } = await import('./fixtures/s2-design-model');
  const reply = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
  const modelCapability = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
  const ordinary = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成普通文字场景，不装配模型测试', knowledgePoints: [] });
  const modelScene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成受控提示词试验，授权与每次发送分别确认', knowledgePoints: [] });
  const initial = { nodes: [{ id: 'prompt', type: 'text', position: { x: 0, y: 0 }, values: { content: '原样处理合成输入，不读取其他资料。' } }], edges: [],
    execution: { version: 1 as const, nodes: [{ id: 'generate', ...modelCapability, position: { x: 400, y: 0 },
      bindings: { prompt: { kind: 'field' as const, nodeId: 'prompt', fieldId: 'content' }, input: { kind: 'literal' as const, value: '仅合成输入' } } }], links: [] } };
  const modelDefinition: S2CanvasDefinition = readS2Definition({ ...modelScene.canvasWorkspace, plugins: [modelCapability], initial,
    business: { version: 1, purpose: '仅在独立批准固定模型和双预算并逐次确认后测试提示词，不作真实效果验收',
      knowledge: [], workflow: [{ id: 'TestPrompt', goal: '提出可独立确认的模型测试请求', actor: 'tool', capabilities: [modelCapability],
        input: '完整提示词和合成输入', output: '模型文本，不代表业务指标通过' }],
      completion: { mode: 'execution', reference: structuredClone(initial), targetNodeIds: ['generate'],
        coverage: [{ requirementId: 'r1', stepIds: ['TestPrompt'], nodeIds: ['generate'] }] }, criteria: [] } }, { requireBusiness: true });
  modelScene.canvasWorkspace = modelDefinition;

  function assertBoundary(request: LlmCallRequest) {
    const prompt = request.systemPromptOverride!;
    assert.equal(request.workflow, 'agent-scene-setup');
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    const stage = JSON.parse(request.userInput).stage;
    if (['understand', 'assemble', 'review'].includes(stage)) {
      assert.ok(prompt.includes('装配不是授权'));
      assert.ok(prompt.includes('不虚构组件、正文或执行结果'));
      assert.ok(prompt.includes('不输出代码或思考过程'));
      assert.ok(!prompt.includes('请求次数和总预留输出tokens双预算'), 'Construction does not explain host-owned request metering');
      return;
    }
    assert.ok(prompt.includes('没有RAG检索、用户画像、数学验证、通用网络访问或代码执行能力'));
    assert.ok(!prompt.includes('没有RAG、画像、数学验证、网络、代码执行或付费实验工具'), 'Remove the contradictory blanket denial, not the remaining safety limits');
    for (const clause of ['使用宿主模型服务须按当前已安装能力契约进入本局独立授权', '固定服务商/模型与请求和输出双预算',
      '逐次核对完整请求后确认发送', '装配、编辑、排队或已有预算不等于本次发送同意',
      '不按业务ID推断是否可调用', '只能提出待确认的executionRequest', '不通过pluginRequests直接发送', '不代用户批准预算或确认请求',
      '不自动重试或隐藏增加评审调用', '模型测试不授予RAG、画像、数学验证、通用网络或代码权限']) assert.ok(prompt.includes(clause), clause);
  }
  function assertUnderstandIsolation(request: LlmCallRequest) {
    const input = JSON.parse(request.userInput);
    assertBoundary(request); assert.equal(input.pluginCatalog, undefined);
    assert.ok(!request.systemPromptOverride.includes(S2_PLUGIN_PROTOCOL_RULES));
    assert.ok(!request.systemPromptOverride.includes(S2_WORKFLOW_AGENT_RULES));
    if (input.stage === 'turn-understand') {
      assert.equal(input.pluginContext, undefined, 'Semantic understanding gets scene facts/indices, not the action tool catalogue');
      assert.ok(request.systemPromptOverride.includes('先理解用户真正要什么，不选择插件、不匹配工具'));
    }
  }

  // Inspect the REAL two complete-compatibility requests in ordinary and model-equipped cases.
  // This checks protocol assembly, not a model's design/intent understanding.
  for (const scene of [ordinary, modelScene]) {
    const stages: string[] = [];
    const definition = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
      const input = JSON.parse(request.userInput); stages.push(input.stage); assertBoundary(request);
      if (input.stage === 'understand') assertUnderstandIsolation(request);
      else assert.equal(input.pluginCatalog.plugins.some((item: { id: string }) => item.id === 'model-test'), input.stage === 'assemble' || scene === modelScene,
        'Assembly sees installed tools; review only sees the candidate selection, and understand sees neither catalogue');
      return s2DesignFixtureResponse(request, scene.canvasWorkspace!);
    } });
    assert.deepEqual(stages, ['understand', 'assemble']);
    assert.equal(!!definition.plugins?.some(item => item.pluginId === 'model-test'), scene === modelScene);
  }

  let modelDispatches = 0;
  for (const mode of ['ordinary', 'installed-unapproved', 'approved'] as const) {
    const scene = mode === 'ordinary' ? ordinary : modelScene, definition = scene.canvasWorkspace!;
    const host = new S2PluginHost(scene.sceneId, definition.plugins); hosts.push(host); host.setDocument(definition.initial);
    if (mode === 'approved') host.approveModelTestSession(new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId,
      resourceId: 'SyntheticBoundaryModelResource', providerId: 'SyntheticBoundaryProvider', providerLabel: '纯合成固定服务商', model: 'synthetic-boundary-model',
      limits: { maxRequests: 2, maxReservedOutputTokens: 1024, maxOutputTokens: 512 },
      invoke: async () => { modelDispatches++; return { content: '不可自动发送的合成响应', diagnostics: { finishReason: 'stop' } }; } }));
    const context = host.prepare(null, { goal: definition.goal, ...definition.instructions }, '合成边界检查');
    const before = JSON.stringify({ summary: host.modelTestSummary(), history: host.history(), runs: host.workflowHistory(), waits: host.waitingModelTests() });
    const stages: string[] = [];
    const result = await interactS2Canvas(scene, definition.initial, '我希望测试这个提示词；这里只讨论或提出待确认请求，不代我批准或发送。', null, [], { pluginContext: context,
      invoke: async request => {
        const input = JSON.parse(request.userInput); stages.push(input.stage); assertBoundary(request);
        if (input.stage === 'turn-understand') {
          assertUnderstandIsolation(request);
          return reply({ understanding: '合成意图桩，不证明语义理解', desiredOutcome: '普通解释或仅提出待确认请求',
            actions: ['reply', ...(mode === 'ordinary' ? [] : ['execute'])], constraints: ['不代确认、不自动发送'], questions: [], evaluation: 'advice' });
        }
        assert.equal(input.stage, 'turn-act');
        assert.equal(input.pluginCatalog.plugins.some((item: { id: string }) => item.id === 'model-test'), mode !== 'ordinary');
        assert.equal(input.pluginContext.modelTest.approved, mode === 'approved');
        if (mode === 'approved') {
          assert.equal(input.pluginContext.modelTest.model, 'synthetic-boundary-model');
          assert.deepEqual(input.pluginContext.modelTest.limits, { maxRequests: 2, maxReservedOutputTokens: 1024, maxOutputTokens: 512 });
          assert.equal(input.pluginContext.modelTest.usedRequests, 0); assert.equal(input.pluginContext.modelTest.reservedOutputTokens, 0);
        }
        return reply({ understanding: '不扩权或自动调用', plan: '保留明确确认边界', reply: '模型能力需选装、独立批准本局预算并逐次核对完整请求；此处尚未发送。', commands: [],
          ...(mode === 'ordinary' ? {} : { executionRequest: { targetNodeIds: ['generate'], reason: '仅提出待确认的合成模型测试目标' } }) });
      } });
    assert.deepEqual(stages, ['turn-understand', 'turn-act']); assert.deepEqual(result.commands, []); assert.equal(result.pluginRequests, undefined);
    assert.equal(!!result.executionRequest, mode !== 'ordinary');
    assert.equal(JSON.stringify({ summary: host.modelTestSummary(), history: host.history(), runs: host.workflowHistory(), waits: host.waitingModelTests() }), before,
      'A production Agent response must not enqueue tools, spend budget or fabricate per-request confirmation');
    assert.equal(modelDispatches, 0);
    if (mode === 'installed-unapproved') assert.throws(() => host.enqueueWorkflow(['generate']), /模型|授权|model/i);
    if (mode === 'approved') {
      // A separate explicit LOCAL confirmation can enqueue the request, but the
      // real host must still wait with full text rather than infer consent.
      const job = host.enqueueWorkflow(result.executionRequest.targetNodeIds);
      for (let i = 0; i < 150 && !host.waitingModelTests().length; i++) await Promise.resolve();
      assert.equal(host.waitingModelTests().length, 1);
      const wait = host.waitingModelTests()[0];
      assert.equal(wait.prompt, initial.nodes[0].values.content); assert.equal(wait.input, '仅合成输入');
      assert.equal(wait.model, 'synthetic-boundary-model'); assert.equal(wait.maxOutputTokens, 512);
      assert.equal(modelDispatches, 0); assert.equal(host.modelTestSummary().usedRequests, 0);
      host.confirmModelTest(job.id, wait.id, false); await job.completion;
      assert.equal(modelDispatches, 0); assert.equal(host.modelTestSummary().usedRequests, 0); assert.equal(host.modelTestSummary().reservedOutputTokens, 0);
    }
  }
  assert.equal(forbiddenIo, 0);
  console.log('S2 model capability boundary passed: actual production design/interact prompts condition model-test on installed capability, fixed-provider run-local dual budgets and per-request full-text confirmation; no blanket denial, generic IO/RAG/profile/math/code grant, semantic-stage tool catalogue, automatic enqueue/model dispatch or delegated consent. Ordinary, installed-unapproved and approved synthetic contexts covered; explicit host enqueue still waits and refusal costs zero. Offline protocol regression only, not real-model semantic/browser acceptance.');
} finally {
  hosts.forEach(host => host.close()); globalThis.fetch = previousFetch;
  for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
}
