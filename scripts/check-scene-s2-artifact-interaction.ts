import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';

const priorFetch = globalThis.fetch; let io = 0;
globalThis.fetch = async () => { io++; throw new Error('Synthetic artifact interaction forbids network'); };
try {
  const { createS2Scene, readS2Definition, interactS2Canvas } = await import('../src/services/scene/sceneS2Canvas');
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const { S2ModelTestSession } = await import('../src/services/scene/sceneS2ModelTest');
  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成提示词测试完整产物比对', knowledgePoints: [] });
  const capability = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
  const text = '完整合成回复：' + 'a'.repeat(4200) + '\n尾部例子：通过笔记检索找到相关概念再回答。';
  const initial = structuredClone(scene.canvasWorkspace!.initial);
  initial.execution = { version: 1, nodes: [{ id: 'generate', ...capability, position: { x: 400, y: 0 }, bindings: { prompt: { kind: 'field', nodeId: initial.nodes[0].id, fieldId: 'content' } } }], links: [] };
  scene.canvasWorkspace = readS2Definition({ ...scene.canvasWorkspace, plugins: [capability], initial,
    business: { version: 1, purpose: '根据明确指标按需比对实际完整回复，不自动改图或重测', knowledge: [],
      workflow: [{ id: 'Trial', actor: 'tool', goal: '用户逐次确认后取得模型原文', capabilities: [capability], input: '完整提示词', output: '原始模型文本，不代表满足指标' }],
      completion: { mode: 'execution', reference: structuredClone(initial), targetNodeIds: ['generate'], coverage: [{ requirementId: 'r1', stepIds: ['Trial'], nodeIds: ['generate'] }] },
      criteria: [
        { id: 'Tail', label: '完整回复包含例子', expectation: '实际输出包含尾部例子标记，只核对此文本条件', method: 'local', required: true, target: { nodeId: 'generate', portId: 'text' }, rule: { kind: 'text-includes', value: '尾部例子：' } },
        { id: 'Meaning', label: '例子说明检索用途', expectation: '例子能够说明先检索再回答', method: 'semantic', required: true, target: { nodeId: 'generate', portId: 'text' } },
      ] } }, { requireBusiness: true });
  const definition = scene.canvasWorkspace, host = new S2PluginHost(scene.sceneId, definition.plugins); host.setDocument(initial);
  let modelCalls = 0;
  const session = new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticFullResponse', providerId: 'synthetic', providerLabel: 'Synthetic complete response', model: 'synthetic',
    limits: { maxRequests: 2, maxReservedOutputTokens: 1024, maxOutputTokens: 512 }, invoke: async () => { modelCalls++; return { content: text, diagnostics: { finishReason: 'stop' } }; } });
  host.approveModelTestSession(session);
  try {
    const run = host.enqueueWorkflow(['generate']);
    for (let i = 0; i < 300 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 1));
    host.confirmModelTest(run.id, host.waitingModelTests()[0].id, true);
    const completed = await run.completion; assert.equal(completed.status, 'succeeded');
    const artifactId = completed.nodes[0].artifactIds[0];
    const context = () => host.prepare(null, { goal: definition.goal, ...definition.instructions }, '合成全文核对');
    const before = { calls: host.remainingCalls, ledger: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()), model: JSON.stringify(session.summary()) };
    const requests: LlmCallRequest[] = [];
    const invoke = async (request: LlmCallRequest): Promise<LlmCallResponse> => {
      requests.push(request); const input = JSON.parse(request.userInput);
      assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
      if (input.stage === 'turn-understand') {
        assert.ok(input.evidenceIndex.artifacts.some((item: any) => item.id === artifactId));
        assert.ok(!JSON.stringify(input.observations).includes('尾部例子：'), 'Preview cannot contain the decisive evidence at the end');
        return { content: JSON.stringify({ understanding: '只按声明指标比对实际全文', desiredOutcome: '带来源解释差距，不修改或重测', actions: ['reply'], constraints: ['不修改、不执行'], questions: [], evaluation: 'criteria', recall: { artifactIds: [artifactId] } }) };
      }
      assert.equal(input.stage, 'turn-act');
      const recalled = input.recalledContext.items.find((item: any) => item.kind === 'artifact' && item.id === artifactId);
      assert.equal(recalled.value.text, text); assert.equal(recalled.value.artifact.source.runId, host.runId); assert.equal(recalled.value.artifact.payload, undefined);
      return { content: JSON.stringify({ understanding: '全文包含可核对的尾部例子', plan: '仅评价，不改图或执行', reply: '本轮仅比对两项明确指标，例子不是整体能力证明。', commands: [],
        assessment: { criterionIds: ['Tail', 'Meaning'], judgments: [{ criterionId: 'Meaning', verdict: 'met', reason: '例子说明先检索再回答的用途。', evidence: [{ sourceId: `artifact:${artifactId}`, quote: '尾部例子：通过笔记检索找到相关概念再回答。' }] }] } }) };
    };
    const result = await interactS2Canvas(scene, initial, '根据这次模型的实际全文按指标解释，不改图也不重新测试。', null, [], { pluginContext: context(), invoke });
    assert.deepEqual(requests.map(request => JSON.parse(request.userInput).stage), ['turn-understand', 'turn-act']);
    assert.equal(result.assessment!.overall, 'met'); assert.equal(result.assessment!.checks.length, 2);
    assert.ok(result.assessment!.checks.every(check => check.evidence.some(item => item.sourceId === `artifact:${artifactId}`)));
    assert.deepEqual(result.commands, []); assert.equal(result.executionRequest, undefined); assert.equal(result.pluginRequests, undefined);
    assert.deepEqual({ calls: host.remainingCalls, ledger: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()), model: JSON.stringify(session.summary()) }, before);

    // Without full recall, even visible previews do not authorize a formal pass.
    const noRecall = await interactS2Canvas(scene, initial, '按指标核对，但没有提供全文。', null, [], { pluginContext: context(), invoke: async request => {
      const input = JSON.parse(request.userInput);
      return { content: JSON.stringify(input.stage === 'turn-understand'
        ? { understanding: '只提供预览，不能判断全文', desiredOutcome: '明确待确认', actions: ['reply'], constraints: [], questions: [], evaluation: 'criteria' }
        : { understanding: '未取全文', plan: '不猜测达标', reply: '当前未读取完整来源，不能判定达标。', commands: [], assessment: { criterionIds: ['Tail', 'Meaning'] } }) };
    } });
    assert.equal(noRecall.assessment!.overall, 'uncertain'); assert.ok(noRecall.assessment!.checks.every(check => check.verdict === 'uncertain'));

    // Latest attempt changes while the Agent prepares its response: the old
    // full text remains a valid historical read, never a current-target pass.
    const changed = await interactS2Canvas(scene, initial, '核对当前输出。', null, [], { pluginContext: context(), invoke: async request => {
      const input = JSON.parse(request.userInput);
      if (input.stage === 'turn-understand') return { content: JSON.stringify({ understanding: '核对当前输出', desiredOutcome: '当前目标指标', actions: ['reply'], constraints: [], questions: [], evaluation: 'criteria', recall: { artifactIds: [artifactId] } }) };
      const newer = host.enqueueWorkflow(['generate']); host.cancelWorkflow(newer.id); await newer.completion;
      return { content: JSON.stringify({ understanding: '本轮输入对应旧尝试', plan: '由宿主重验最新目标', reply: '实际目标以宿主当前来源为准。', commands: [], assessment: { criterionIds: ['Tail'] } }) };
    } });
    assert.equal(changed.assessment!.overall, 'uncertain'); assert.equal(modelCalls, 1); assert.equal(io, 0);
    console.log('S2 artifact interaction passed: explicit synthetic model approval and one genuine host output, real understand→full recall→action→host assessment with evidence beyond previews, exact provenance, field-copy-free local/semantic checks, no-recall uncertainty and in-flight new-attempt invalidation; explain/assess never modifies or re-executes. Injected synthetic model only; NOT live-model semantics or browser acceptance.');
  } finally { host.close(); }
} finally { globalThis.fetch = priorFetch; }
