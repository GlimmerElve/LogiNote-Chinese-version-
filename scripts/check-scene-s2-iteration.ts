// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse, SceneInitialRequest } from '../src/types';
import type { S2AgentReply, S2Document } from '../src/types/sceneS2';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';

// Install guards BEFORE production imports. Only the explicit synthetic provider
// below may return model-test data; no app config, credentials or user data exist.
const priorFetch = globalThis.fetch, protectedKeys = ['localStorage', 'window', 'electronAPI'];
const descriptors = new Map(protectedKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let forbiddenIo = 0;
const denied = () => { forbiddenIo++; throw new Error('Synthetic S2 iteration forbids real IO'); };
globalThis.fetch = async () => denied();
for (const key of protectedKeys) Object.defineProperty(globalThis, key, key === 'localStorage'
  // The production budget helper probes typeof localStorage before its try.
  // Explicit absence selects its pure local ceiling; never forward to app IO.
  ? { configurable: true, value: undefined } : { configurable: true, get: denied });
let cleanup: (() => void) | undefined;
try {
  const canvas = await import('../src/services/scene/sceneS2Canvas');
  const { S2ModelTestSession } = await import('../src/services/scene/sceneS2ModelTest');
  const { harness } = await import('./scene-s2-ui-harness');
  const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '合成提示词自由迭代交互', knowledgePoints: [] };
  const scene = canvas.createS2Scene(request), capability = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
  const originalPrompt = '请说明检索增强生成的用途，保留这些原始要求。';
  const revisedPrompt = originalPrompt + '\n补充一个形象例子，标记为“形象例子：”。';
  const originalOutput = '合成原始回复：' + 'a'.repeat(4100) + '\n尾部证据：仅说明用途，没有提供例子。';
  const revisedOutput = '合成修订回复：' + 'b'.repeat(4100) + '\n形象例子：像先去图书馆找相关资料，再组织回答。';
  const initial = structuredClone(scene.canvasWorkspace!.initial);
  initial.nodes[0].values.content = originalPrompt;
  initial.execution = { version: 1, nodes: [{ id: 'trial', ...capability, position: { x: 400, y: 0 },
    bindings: { prompt: { kind: 'field', nodeId: 'goal', fieldId: 'content' }, input: { kind: 'literal', value: '只使用合成资料' } } }], links: [] };
  scene.canvasWorkspace = canvas.readS2Definition({ ...scene.canvasWorkspace, initial, plugins: [capability],
    business: { version: 1, purpose: '用户自主决定解释、举例、核对、改图或重测；不按固定教学阶段推进。', knowledge: [],
      workflow: [{ id: 'Trial', actor: 'tool', goal: '单独确认后测试当前完整提示词', capabilities: [capability], input: '原始提示词', output: '完整合成回复，执行成功不代表达标' }],
      completion: { mode: 'execution', reference: structuredClone(initial), targetNodeIds: ['trial'], coverage: [{ requirementId: 'r1', stepIds: ['Trial'], nodeIds: ['trial'] }] },
      criteria: [
        { id: 'Example', label: '输出包含例子标记', expectation: '只核对实际完整输出中是否存在指定标记', method: 'local', required: true,
          target: { nodeId: 'trial', portId: 'text' }, rule: { kind: 'text-includes', value: '形象例子：' } },
        { id: 'Meaning', label: '例子说明先取材再回答', expectation: '只判断当前实际输出的例子是否说明先找资料再回答', method: 'semantic', required: true,
          target: { nodeId: 'trial', portId: 'text' } },
      ] } }, { requireBusiness: true });
  const queries = {
    explain: '先解释本次偏差，不改图也不运行，不正式评价。',
    example: '举一个形象的例子帮助我理解，暂不改图、不测试、不正式评价。',
    pause: '先暂停正式评价，只讨论思路，不改图、不测试。',
    assess: '现在按已声明指标核对当前模型输出，不改图、不测试。',
    compare: '比较这两次提示词试验的输入变化和已记录的指标，不重新运行，也不把历史结论当当前评分。',
    edit: '请仅把当前提示词补充一个形象例子要求，保留其他原文，先给修改建议，不运行。',
    retest: '请重新测试当前提示词，结果回来后按刚才两项指标核对；先给待确认执行申请。' + '合成背景'.repeat(490) + '尾部执行范围：仅核对上述两项，不修改画布，不自动重试。',
    pauseLate: '这次等待结果时，我想补充一个局部调整。' + '合成讨论'.repeat(490) + '尾部最新要求：本次结果回来先暂停正式评价，只讨论，不改图、不自动重试。',
  };
  type Turn = { origin: string; query: string; document: S2Document; stages: string[]; sources: string[]; result?: S2AgentReply };
  const turns: Turn[] = [];
  let host!: S2PluginHost, actualModelCalls = 0, providerPreparations = 0, providerSessions = 0;
  const ui = harness({ initialRequest: request, initialDraft: scene, onHost: value => { host = value; },
    controllers: { design: (scene, options) => canvas.designS2Canvas(scene, { ...options, disclosure: 'complete' }), interact: async (currentScene, document, query, selected, history, options) => {
      const turn: Turn = { origin: options?.origin ?? 'user', query, document: structuredClone(document), stages: [], sources: [] }; turns.push(turn);
      const invoke = async (call: LlmCallRequest): Promise<LlmCallResponse> => {
        assert.equal(call.skipMemoryInjection, true); assert.equal(call.skipProfileInjection, true);
        const input = JSON.parse(call.userInput); turn.stages.push(input.stage);
        assert.equal(input.responseRepair, undefined, 'Deterministic fixtures must satisfy the actual protocol without hidden repair requests');
        if (input.stage === 'turn-proposal-review') return { content: JSON.stringify({ verdict: 'accept', reason: '仅补充用户明确要求的局部，保留原始要求，尚未应用或执行。', evidence: [{ sourceId: 'query', quote: queries.edit }] }) };
        const currentOutput = input.evidenceIndex.currentOutputs?.find((item: any) => item.nodeId === 'trial' && item.portId === 'text');
        assert.ok(currentOutput, 'Current output metadata is discoverable even when no output is available');
        const artifactId = currentOutput.state === 'available' ? currentOutput.artifactIds[0] as string : undefined;
        const hostCompletion = turn.origin === 'host-event';
        if (hostCompletion) {
          assert.equal(input.runRequestContext.initiatingRequest.text, queries.retest, 'Host event preserves the initiating user request including its trailing scope');
          assert.ok(input.runRequestContext.initiatingRequest.text.endsWith('不自动重试。'));
          assert.equal(input.runRequestContext.initiatingRequest.sourceId, options?.originatingUserMessageId);
          assert.ok(!input.recentConversation.some((item: any) => item.sourceId === options?.originatingUserMessageId), 'The long initiating request really was omitted by recent-history packing');
          assert.ok([queries.retest, queries.pauseLate].includes(input.runRequestContext.latestUserRequest.text));
          assert.equal(input.memoryWritable, false, 'Pinned source history is not host-event memory write authority');
        }
        const pausedLater = hostCompletion && input.runRequestContext.latestUserRequest.text === queries.pauseLate;
        const wantsMetrics = query === queries.assess || hostCompletion && !!artifactId && !pausedLater;
        const wantsRead = wantsMetrics || query === queries.explain;
        const comparisonIds = query === queries.compare ? input.evidenceIndex.trials.filter((trial: any) => trial.nodeId === 'trial').map((trial: any) => trial.id) : [];
        if (input.stage === 'turn-understand') {
          assert.equal(input.pluginCatalog, undefined, 'Semantic understanding does not begin with a tool catalogue');
          return { content: JSON.stringify({ understanding: hostCompletion ? '只解读用户已确认的这次结果，不自动继续' : '本轮真实要求：' + query.slice(0, 150),
            desiredOutcome: wantsMetrics ? '比对当前真实全文并标明来源' : '服从本轮表达，不自动推进教学阶段',
            actions: ['reply', ...(query === queries.edit ? ['edit'] : query === queries.retest ? ['execute'] : [])],
            constraints: ['修改、执行图和每次模型发送分别确认'], questions: [], evaluation: wantsMetrics ? 'criteria' : 'advice',
            ...(query === queries.example ? { assistance: 'demonstrate' } : {}),
            ...(comparisonIds.length ? { recall: { trialIds: comparisonIds } } : wantsRead && artifactId ? { recall: { artifactIds: [artifactId] } } : {}) }) };
        }
        assert.equal(input.stage, 'turn-act');
        const source = input.recalledContext.items.find((item: any) => item.kind === 'artifact');
        if (source) {
          turn.sources.push(source.id);
          assert.equal(source.value.artifact.source.runId, host.runId); assert.equal(source.value.artifact.source.nodeId, 'trial');
          assert.equal(source.value.artifact.payload, undefined); assert.ok(source.value.text.length > 4100);
          assert.ok(!JSON.stringify(input.observations ?? []).includes('尾部证据：'));
        }
        const reply: Record<string, unknown> = { understanding: '已区分本轮讨论、评价、修改与执行', plan: '只做本轮选择，不自动串联下一步', reply: '普通讨论已回应，不自动改图或测试。', commands: [] };
        if (query === queries.explain) { assert.equal(source.value.text, originalOutput); reply.reply = '偏差是原输出没有例子；本轮仅解释，不作正式判定。'; }
        else if (query === queries.example) reply.reply = '可以把检索比作先去图书馆找资料，再组织回答；这是教学举例，不冒充测试输出。';
        else if (query === queries.pause) reply.reply = '已暂停本轮正式评价，只讨论思路；没有修改或测试。';
        else if (query === queries.pauseLate) reply.reply = '已保留最新暂停要求，不作正式评价。' + 'p'.repeat(5800);
        else if (query === queries.compare) {
          const trials = input.recalledContext.items.filter((item: any) => item.kind === 'trial');
          assert.equal(trials.length, 2); assert.equal(trials[0].value.inputs.prompt[0].text, originalPrompt);
          assert.equal(trials[0].value.outputs.text[0].text, originalOutput);
          assert.equal(trials[1].value.inputs.prompt[0].text, revisedPrompt); assert.equal(trials[1].value.outputs.text[0].text, revisedOutput);
          assert.ok(trials.every((item: any) => item.value.historicalOnly && item.value.assessments.length));
          reply.reply = '仅对照真实历史，未重新评分或运行。'; reply.comparison = { trialIds: comparisonIds };
        }
        else if (query === queries.edit) {
          reply.reply = '已提出一项局部修改，尚未应用；确认前原文与执行状态不变。';
          reply.commands = [{ op: 'update-node', id: 'goal', values: { content: revisedPrompt } }];
        } else if (query === queries.retest) {
          reply.reply = '仅申请测试当前提示词；仍需确认执行图和本次完整模型请求。' + 'r'.repeat(5800);
          reply.executionRequest = { targetNodeIds: ['trial'], reason: '用户明确要求重测并核对当前输出', force: true };
        } else if (pausedLater) reply.reply = '已收到完整输出；按你等待期间的最新要求，本轮暂停正式评价，只讨论，不自动重试。';
        else if (hostCompletion && !artifactId) reply.reply = '本次尝试未取得完整输出，保留记录，不自动重试；等待你决定下一步。';
        if (wantsMetrics) {
          const hasExample = !!source?.value.text.includes('形象例子：');
          reply.reply = '以下只核对本轮选定的两项指标，不代表整个场景成功。';
          reply.assessment = { criterionIds: ['Example', 'Meaning'], ...(source ? { judgments: [{ criterionId: 'Meaning', verdict: hasExample ? 'met' : 'unmet',
            reason: hasExample ? '原文用找资料再回答说明取材次序。' : '实际原文明确没有例子。', evidence: [{ sourceId: `artifact:${source.id}`,
              quote: hasExample ? '形象例子：像先去图书馆找相关资料，再组织回答。' : '尾部证据：仅说明用途，没有提供例子。' }] }] } : {}) };
        }
        return { content: JSON.stringify(reply) };
      };
      const result = await canvas.interactS2Canvas(currentScene, document, query, selected, history, { ...options, invoke }); turn.result = result; return result;
    } },
    modelProvider: async () => {
      providerPreparations++;
      return { providerLabel: 'Synthetic iteration provider', model: 'synthetic-iteration', resourceId: 'SyntheticIterationResource', supportsImages: false,
        createSession: (sceneId, runId, limits) => { providerSessions++; return new S2ModelTestSession({ sceneId, runId, limits, resourceId: 'SyntheticIterationResource',
          providerId: 'synthetic', providerLabel: 'Synthetic iteration provider', model: 'synthetic-iteration', invoke: async call => {
            actualModelCalls++; assert.equal(call.systemPromptOverride, actualModelCalls === 1 ? originalPrompt : revisedPrompt);
            assert.equal(call.userInput, '只使用合成资料'); assert.equal(call.skipMemoryInjection, true); assert.equal(call.skipProfileInjection, true);
            return { content: actualModelCalls === 1 ? originalOutput : revisedOutput, diagnostics: { finishReason: 'stop' }, usage: { promptTokens: 10, completionTokens: 24 } };
          } }); } };
    } }); cleanup = () => ui.dispose();
  async function settle(done: () => boolean) {
    for (let i = 0; i < 400; i++) { ui.render(); if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`Synthetic iteration did not settle. Turns: ${JSON.stringify(turns.map(turn => ({ query: turn.query.slice(0, 90), stages: turn.stages, complete: !!turn.result })))}; alerts: ${ui.elements().filter(item => item.props.role === 'alert').map(item => ui.text(item)).join('\n')}; UI: ${ui.text().slice(-500)}`);
  }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); ui.render(); };
  const hasButton = (label: string) => ui.elements().some(item => item.type === 'button' && ui.text(item) === label);
  const prompt = () => ui.flow().props.nodes.find((node: any) => node.id === 'goal').data.fields.find((field: any) => field.id === 'content').value;
  const snapshot = () => JSON.stringify(ui.flow().props.nodes.map((node: any) => ({ id: node.id, position: node.position, fields: node.data.fields }))) + JSON.stringify(ui.flow().props.edges);
  const modelLedger = () => JSON.stringify(host.modelTestSummary());
  async function ask(query: string) {
    const before = turns.length;
    ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: query } }); ui.render();
    assert.equal(ui.button('发送').props.disabled, false); ui.button('发送').props.onClick();
    await settle(() => turns.length > before && !!turns.at(-1)!.result && !hasButton('停止助手请求'));
    return turns.at(-1)!;
  }
  ui.button('开始试验').props.onClick(); ui.render();
  ui.button('准备本局模型测试（不发送）').props.onClick(); await settle(() => ui.text().includes('核对并批准本局预算'));
  for (const [label, value] of [['模型请求次数上限', '3'], ['单次输出 tokens 上限', '512'], ['总预留输出 tokens 上限', '1536']]) {
    ui.labelControl(label, 'input').props.onChange({ target: { value } }); ui.render();
  }
  ui.button('批准本局模型测试预算（仍逐次确认）').props.onClick(); ui.render();
  assert.equal(actualModelCalls, 0); assert.equal(providerPreparations, 1); assert.equal(providerSessions, 1);
  ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingModelTests().length === 1);
  assert.equal(actualModelCalls, 0); assert.ok(ui.text().includes(originalPrompt));
  ui.button('确认发送本次模型请求').props.onClick(); await settle(() => host.workflowHistory().at(-1)!.status === 'succeeded');
  assert.equal(actualModelCalls, 1);
  const firstArtifactId = host.workflowHistory().at(-1)!.nodes[0].artifactIds[0];
  const stableCanvas = snapshot(), stableRuns = JSON.stringify(host.workflowHistory()), stableLedger = modelLedger();

  // Deliberately interleave optional actions. These are not stages which users
  // must follow: formal evaluation can resume after a plain explanation/pause.
  const explained = await ask(queries.explain);
  assert.equal(explained.result!.assessment, undefined); assert.deepEqual(explained.sources, [firstArtifactId]);
  const firstMetrics = await ask(queries.assess);
  assert.equal(firstMetrics.result!.assessment!.overall, 'unmet');
  assert.ok(firstMetrics.result!.assessment!.checks.every(check => check.source!.artifactId === firstArtifactId));
  for (const query of [queries.example, queries.pause, queries.example]) {
    const turn = await ask(query); assert.equal(turn.result!.assessment, undefined); assert.deepEqual(turn.sources, []);
  }
  for (const turn of turns) { assert.deepEqual(turn.stages, ['turn-understand', 'turn-act']); assert.deepEqual(turn.result!.commands, []); assert.equal(turn.result!.executionRequest, undefined); }
  assert.equal(snapshot(), stableCanvas); assert.equal(JSON.stringify(host.workflowHistory()), stableRuns); assert.equal(modelLedger(), stableLedger);

  // A rejected edit has no residual authority, including a captured old UI callback.
  await ask(queries.edit); const rejectedEdit = ui.button('确认应用修改').props.onClick;
  assert.equal(prompt(), originalPrompt); assert.equal(actualModelCalls, 1);
  ui.button('放弃建议').props.onClick(); ui.render(); rejectedEdit(); ui.render();
  assert.equal(prompt(), originalPrompt, 'Rejected edit confirmation cannot be replayed');
  const editTurn = await ask(queries.edit); assert.deepEqual(editTurn.stages, ['turn-understand', 'turn-act', 'turn-proposal-review']);
  const applyEdit = ui.button('确认应用修改').props.onClick;
  assert.equal(prompt(), originalPrompt); assert.equal(modelLedger(), stableLedger);
  applyEdit(); ui.render(); assert.equal(prompt(), revisedPrompt); applyEdit(); ui.render(); assert.equal(prompt(), revisedPrompt);
  const afterEditMetrics = await ask(queries.assess);
  assert.equal(afterEditMetrics.result!.assessment!.overall, 'uncertain'); assert.deepEqual(afterEditMetrics.sources, []);
  assert.ok(afterEditMetrics.result!.assessment!.checks.every(check => check.verdict === 'uncertain' && check.evidence.length === 0));
  assert.equal(actualModelCalls, 1, 'Editing/assessing never automatically tests');

  // Asking for a test only offers a proposal; rejecting consumes its old callback.
  const runCount = host.workflowHistory().length;
  await ask(queries.retest); const rejectedRun = ui.button('确认运行并请 Agent 解读').props.onClick;
  assert.equal(host.workflowHistory().length, runCount); assert.equal(actualModelCalls, 1);
  ui.button('暂不运行').props.onClick(); ui.render(); rejectedRun(); await tick();
  assert.equal(host.workflowHistory().length, runCount, 'Rejected execution callback cannot enqueue an old proposal');

  // Graph confirmation does not authorize model sending. Reject the actual
  // full request and prove its old send callback cannot spend model budget.
  await ask(queries.retest); ui.button('确认运行并请 Agent 解读').props.onClick();
  await settle(() => host.waitingModelTests().length === 1);
  const rejectedSend = ui.button('确认发送本次模型请求').props.onClick;
  assert.equal(actualModelCalls, 1); assert.ok(ui.text().includes(revisedPrompt));
  ui.button('拒绝本次模型请求').props.onClick();
  await settle(() => host.workflowHistory().at(-1)!.status === 'failed' && !hasButton('停止助手请求'));
  rejectedSend(); await tick(); assert.equal(actualModelCalls, 1); assert.equal(host.modelTestSummary()!.usedRequests, 1);
  assert.equal(turns.at(-1)!.origin, 'host-event'); assert.equal(turns.at(-1)!.result!.executionRequest, undefined);

  // Cancelling an accepted graph while it waits also consumes the pending send.
  await ask(queries.retest); ui.button('确认运行并请 Agent 解读').props.onClick();
  await settle(() => host.waitingModelTests().length === 1);
  const cancelledSend = ui.button('确认发送本次模型请求').props.onClick;
  const cancelledId = host.workflowHistory().at(-1)!.id;
  ui.button(`取消第 ${host.workflowHistory().findIndex(run => run.id === cancelledId) + 1} 次运行（保留已完成记录）`).props.onClick(); ui.render();
  await settle(() => host.workflowHistory().at(-1)!.status === 'cancelled');
  cancelledSend(); await tick(); assert.equal(actualModelCalls, 1); assert.equal(host.waitingModelTests().length, 0);

  // Fresh natural-language request -> graph confirmation -> exact full prompt
  // confirmation -> one new synthetic model call -> fresh source-bound metrics.
  await ask(queries.retest); const confirmRun = ui.button('确认运行并请 Agent 解读').props.onClick;
  confirmRun(); confirmRun(); ui.render(); await settle(() => host.waitingModelTests().length === 1);
  assert.equal(actualModelCalls, 1); assert.equal(host.modelTestSummary()!.usedRequests, 1);
  const waitId = host.waitingModelTests()[0].id;
  const latePause = await ask(queries.pauseLate);
  assert.equal(latePause.result!.assessment, undefined); assert.equal(host.waitingModelTests()[0].id, waitId);
  assert.equal(actualModelCalls, 1, 'A discussion while waiting cannot send or replace the confirmed graph request');
  const confirmSend = ui.button('确认发送本次模型请求').props.onClick;
  confirmSend(); confirmSend(); ui.render();
  await settle(() => host.workflowHistory().at(-1)!.status === 'succeeded' && turns.at(-1)?.origin === 'host-event' && !!turns.at(-1)?.result && !hasButton('停止助手请求'));
  assert.equal(actualModelCalls, 2); assert.equal(host.modelTestSummary()!.usedRequests, 2); assert.equal(host.modelTestSummary()!.reservedOutputTokens, 1024);
  const secondArtifactId = host.workflowHistory().at(-1)!.nodes[0].artifactIds[0]; assert.notEqual(secondArtifactId, firstArtifactId);
  const pausedCompletion = turns.at(-1)!;
  assert.equal(pausedCompletion.result!.assessment, undefined); assert.deepEqual(pausedCompletion.sources, []);
  const finalTurn = await ask(queries.assess); assert.deepEqual(finalTurn.sources, [secondArtifactId]); assert.equal(finalTurn.result!.assessment!.overall, 'met');
  assert.ok(finalTurn.result!.assessment!.checks.every(check => check.source!.artifactId === secondArtifactId && check.evidence.every(item => item.sourceId !== `artifact:${firstArtifactId}`)));
  const beforeComparison = { calls: actualModelCalls, summary: JSON.stringify(host.modelTestSummary()), history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) };
  const compared = await ask(queries.compare);
  assert.equal(compared.result!.comparison!.scope, 'historical-trials-only'); assert.deepEqual(compared.result!.comparison!.changedInputs, ['prompt']);
  assert.ok(compared.result!.comparison!.metrics.every(metric => metric.comparable && metric.verdicts[0] === 'unmet' && metric.verdicts[1] === 'met'));
  assert.equal(compared.result!.assessment, undefined); assert.deepEqual(compared.result!.commands, []); assert.equal(compared.result!.executionRequest, undefined);
  assert.deepEqual({ calls: actualModelCalls, summary: JSON.stringify(host.modelTestSummary()), history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) }, beforeComparison);
  assert.deepEqual(finalTurn.result!.commands, []); assert.equal(finalTurn.result!.executionRequest, undefined);
  const finalRuns = host.workflowHistory().length; confirmRun(); confirmSend(); rejectedRun(); rejectedSend(); cancelledSend(); await tick();
  assert.equal(host.workflowHistory().length, finalRuns); assert.equal(actualModelCalls, 2); assert.equal(prompt(), revisedPrompt);
  assert.equal(providerPreparations, 1); assert.equal(providerSessions, 1); assert.equal(forbiddenIo, 0);
  console.log('S2 free iteration and historical trial comparison passed: production UI handlers + real understand/act/proposal review + real host; independent explanation/example/pause/criteria/compare turns, full source-bound output metrics, pending/rejected/confirmed local edits, stale-output uncertainty, separate graph/full-request approval, rejection/cancellation/old-handler no replay and exactly one new synthetic retest with new metric provenance. Historical comparison reads two exact trials without a new run or current assessment. Long initiating/latest user scopes survive recent-history omission, so an in-flight later pause governs host completion without memory writes. Zero real IO. Deterministic semantic fixture, NOT live-model semantics, fixed teaching workflow or browser acceptance.');
} finally {
  cleanup?.(); globalThis.fetch = priorFetch;
  for (const key of protectedKeys) { const descriptor = descriptors.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
}
