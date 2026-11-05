import assert from 'node:assert/strict';
import type { S2BusinessCriterion } from '../src/types/sceneS2Business';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { readS2AssessmentRequest, formatS2Assessment, S2_ASSESSMENT_RULES } from '../src/services/scene/sceneS2Assessment';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { createS2AssessmentArtifactScope, readS2AssessmentArtifact, readS2ContextArtifact } from '../src/services/scene/sceneS2ArtifactAccess';
import { readS2ContextRecall, s2RecallContext } from '../src/services/scene/sceneS2Context';

const previousFetch = globalThis.fetch; let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Artifact assessment is synthetic-only; no real model/network/notes/profile'); };
const hosts: S2PluginHost[] = [];
try {
  const capability = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const plugins = [capability('model-test', 'generate'), capability('structured-data', 'parse-json'), capability('workflow-simulation', 'step')];
  const scene = createS2Scene({ source: 'custom', subject: '合成产物评价：原始模型文本与JSON输出，不复制到字段', knowledgePoints: [], sceneSkill: 'S2' });
  const initial = { nodes: [{ id: 'prompt', type: 'text', position: { x: 0, y: 0 }, values: { content: '合成指令：返回一个JSON对象，只使用合成数据。' } }], edges: [],
    execution: { version: 1 as const, nodes: [
      { id: 'generate', ...plugins[0], position: { x: 350, y: 0 }, bindings: { prompt: { kind: 'field' as const, nodeId: 'prompt', fieldId: 'content' } } },
      { id: 'parsed', ...plugins[1], position: { x: 700, y: 0 }, bindings: {} },
      { id: 'simulated', ...plugins[2], position: { x: 350, y: 300 }, bindings: { purpose: { kind: 'literal' as const, value: '仅模拟一份预设输出' },
        assumptions: { kind: 'literal' as const, value: '不是模型或真实业务返回' }, sample: { kind: 'literal' as const, value: { score: 80 } } } },
    ], links: [{ source: { nodeId: 'generate', portId: 'text' }, target: { nodeId: 'parsed', portId: 'text' } }] } };
  const criteria: S2BusinessCriterion[] = [
    { id: 'FieldLegacy', label: '原字段指标兼容', expectation: '提示词包含合成指令', method: 'local', required: false,
      target: { nodeId: 'prompt', fieldId: 'content' }, rule: { kind: 'text-includes', value: '合成指令' } },
    { id: 'OutputTail', label: '模型返回尾部', expectation: '完整模型文本含尾部标记，仅比对该条件', method: 'local', required: true,
      target: { nodeId: 'generate', portId: 'text' }, rule: { kind: 'text-includes', value: 'FirstOutputTailMarker' } },
    { id: 'OutputJson', label: 'JSON输出数值', expectation: '已解析JSON的score等于80，不外推业务通过', method: 'local', required: true,
      target: { nodeId: 'parsed', portId: 'value' }, rule: { kind: 'json-pointer-equals', pointer: '/score', value: 80 } },
    { id: 'OutputSemantic', label: '模型文本依据', expectation: '引用真实最新模型返回进行解释', method: 'semantic', required: true, target: { nodeId: 'generate', portId: 'text' } },
    { id: 'SimulationLocal', label: '显式模拟轨迹格式', expectation: '仅核对模拟轨迹mode，不代表真实模型或业务成功', method: 'local', required: false,
      target: { nodeId: 'simulated', portId: 'result' }, rule: { kind: 'json-pointer-equals', pointer: '/mode', value: 'simulation-only' } },
    { id: 'Advice', label: '开放建议', expectation: '可对提示词提出建议，不作为必过标准', method: 'advisory', required: false },
  ];
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins, initial,
    business: { version: 1, purpose: '核对真实完整产物的指定范围；本测试调用器为合成桩', knowledge: [],
      workflow: [{ id: 'OutputPath', goal: '取回原始模型文本并显式解析；模拟另有标记', actor: 'tool', capabilities: plugins, input: '完整合成提示词', output: '模型文本、结构化JSON和独立模拟轨迹' }],
      completion: { mode: 'execution', reference: structuredClone(initial), targetNodeIds: ['parsed', 'simulated'],
        coverage: [{ requirementId: 'r1', stepIds: ['OutputPath'], nodeIds: ['generate', 'parsed', 'simulated'] }] }, criteria,
    } }, { requireBusiness: true });
  scene.canvasWorkspace = definition;
  const current = definition.initial, business = definition.business;
  const invalidTarget = (target: unknown) => ({ ...definition, business: { ...business, criteria: [{ ...criteria[1], target }] } });
  for (const target of [{ nodeId: 'generate' }, { nodeId: 'generate', fieldId: 'content', portId: 'text' },
    { nodeId: 'generate', portId: 'missing' }, { nodeId: 'generate', portId: 'prompt' }, { nodeId: 'prompt', portId: 'text' },
    { nodeId: 'missing', portId: 'text' }, { nodeId: 'generate', fieldId: 'content' }]) assert.throws(() => readS2Definition(invalidTarget(target), { requireBusiness: true }));
  assert.deepEqual(definition.business.criteria[1].target, { nodeId: 'generate', portId: 'text' });
  const host = new S2PluginHost(scene.sceneId, plugins); hosts.push(host); host.setDocument(current);
  const strategy = { goal: definition.goal, ...definition.instructions }, context = () => host.prepare(null, strategy, '合成全文读取与评价');
  const request = (criterionIds: string[], judgments?: unknown[]) => ({ criterionIds, ...(judgments ? { judgments } : {}) });
  const judge = (criterionId: string, sourceId: string, quote: string, verdict: 'met' | 'unmet' | 'uncertain' = 'met') => ({ criterionId, verdict, reason: '仅为合成判断桩，引用实际原文，不证明语义准确', evidence: [{ sourceId, quote }] });
  const scoped = (ctx: ReturnType<typeof context>, ids: string[]) => {
    const recalled = s2RecallContext(readS2ContextRecall({ artifactIds: ids }), [], current, ctx);
    const delivered = recalled.items.filter(item => item.kind === 'artifact').map(item => item.id);
    return { recalled, scope: createS2AssessmentArtifactScope(ctx, delivered) };
  };
  const empty = scoped(context(), []);
  assert.equal(readS2AssessmentRequest(request(['FieldLegacy']), business, current).overall, 'met');
  for (const id of ['OutputTail', 'OutputJson', 'OutputSemantic']) assert.equal(readS2AssessmentRequest(request([id]), business, current, undefined, empty.scope).overall, 'uncertain');
  const unsupported = request(['OutputTail'], [{ criterionId: 'OutputTail', verdict: 'met', reason: '伪造宿主已核对', evidence: [] }]);
  assert.equal(readS2AssessmentRequest(unsupported, business, current, undefined, empty.scope).overall, 'uncertain', 'A confident local verdict cannot replace an absent output');

  let modelCalls = 0;
  const firstText = JSON.stringify({ summary: '完整正文'.repeat(180) + 'FirstOutputTailMarker', score: 80 });
  const secondText = JSON.stringify({ summary: '第二次完整返回，没有原尾部标记', score: 81 });
  const session = new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticArtifactAssessmentResource',
    providerId: 'SyntheticArtifactAssessmentProvider', providerLabel: '合成固定模型', model: 'synthetic-assessment-model',
    limits: { maxRequests: 3, maxReservedOutputTokens: 1536, maxOutputTokens: 512 }, invoke: async () => {
      modelCalls++; return { content: modelCalls === 1 ? firstText : modelCalls === 2 ? secondText : 'partial ThirdOutput', diagnostics: { finishReason: modelCalls === 3 ? 'length' : 'stop' } };
    } });
  host.approveModelTestSession(session);
  async function waitForModel() {
    for (let tries = 0; tries < 200 && !host.waitingModelTests().length; tries++) await Promise.resolve();
    assert.equal(host.waitingModelTests().length, 1); return host.waitingModelTests()[0];
  }
  const firstJob = host.enqueueWorkflow(['parsed', 'simulated']);
  const firstWait = await waitForModel(); assert.equal(modelCalls, 0);
  host.confirmModelTest(firstJob.id, firstWait.id, true);
  const first = await firstJob.completion; assert.equal(first.status, 'succeeded'); assert.equal(modelCalls, 1);
  const firstModel = first.nodes.find(node => node.nodeId === 'generate').artifactIds[0];
  const firstJson = first.nodes.find(node => node.nodeId === 'parsed').artifactIds[0];
  const simulation = first.nodes.find(node => node.nodeId === 'simulated').artifactIds[0];
  const actualContext = context(), full = scoped(actualContext, [firstModel, firstJson, simulation]);
  assert.equal(full.recalled.unavailable.length, 0);
  assert.equal(readS2AssessmentArtifact(full.scope, firstModel).text, firstText);
  assert.ok(firstText.indexOf('FirstOutputTailMarker') > 500, 'Local rule must inspect beyond the generic tool preview');
  const evaluation = readS2AssessmentRequest(request(['OutputTail', 'OutputJson', 'OutputSemantic'], [judge('OutputSemantic', `artifact:${firstModel}`, 'FirstOutputTailMarker')]), business, current, undefined, full.scope);
  assert.equal(evaluation.overall, 'met'); assert.ok(evaluation.checks.every(check => check.verdict === 'met'));
  assert.equal(evaluation.checks[0].source.artifactId, firstModel); assert.equal(evaluation.checks[1].source.artifactId, firstJson);
  assert.deepEqual(evaluation.checks[2].evidence, [{ sourceId: `artifact:${firstModel}`, quote: 'FirstOutputTailMarker' }]);
  assert.equal(evaluation.checks[2].source.simulationOnly, false); assert.equal(evaluation.checks[2].source.source.sceneId, scene.sceneId);
  assert.equal(evaluation.checks[2].source.source.runId, host.runId); assert.equal(evaluation.checks[2].source.source.nodeId, 'generate');
  assert.ok(evaluation.checks[2].source.source.invocationId);
  const localAgainstModel = readS2AssessmentRequest(request(['OutputJson'], [{ criterionId: 'OutputJson', verdict: 'unmet', reason: '模型说错了', evidence: [] }]), business, current, undefined, full.scope);
  assert.equal(localAgainstModel.overall, 'met', 'Local rules use the host full JSON, not a model judgment');
  const simReport = readS2AssessmentRequest(request(['SimulationLocal']), business, current, undefined, full.scope);
  assert.equal(simReport.overall, 'met'); assert.equal(simReport.checks[0].source.simulationOnly, true);
  assert.match(formatS2Assessment(simReport), /仅核对模拟轨迹，不代表真实模型或业务效果/);
  assert.equal(simReport.checks[0].source.artifactId, simulation);
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${simulation}`, 'simulation-only')]), business, current, undefined, full.scope), /匹配artifact|其他产物|目标端口/);
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${firstJson}`, 'FirstOutputTailMarker')]), business, current, undefined, full.scope), /匹配artifact|其他产物|目标端口/);
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', 'field:prompt:content', '合成指令')]), business, current, undefined, full.scope), /field|目标端口/);
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', 'query', '合成要求')]), business, current, '合成要求', full.scope), /query|目标端口/);
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${firstModel}`, '并不存在的拼接引用')]), business, current, undefined, full.scope), /连续原文/);
  assert.throws(() => createS2AssessmentArtifactScope(structuredClone(actualContext), [firstModel]), /真实宿主|上下文|读取权限/);
  assert.throws(() => readS2AssessmentArtifact(structuredClone(full.scope), firstModel), /宿主签发|证据范围/);
  const previewOnly = scoped(actualContext, []);
  assert.equal(readS2AssessmentRequest(request(['OutputTail']), business, current, undefined, previewOnly.scope).overall, 'uncertain');
  assert.equal(readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${firstModel}`, 'FirstOutputTailMarker')]), business, current, undefined, previewOnly.scope).overall, 'uncertain',
    'Knowing a valid ID/preview is not full delivery to this turn');

  // Two individually complete outputs can exceed the shared recall budget.
  // Only successfully delivered items may enter the opaque assessment scope.
  const budgetHost = new S2PluginHost('SyntheticArtifactBudgetScene', plugins); hosts.push(budgetHost); budgetHost.setDocument(current);
  let budgetModelCalls = 0;
  budgetHost.approveModelTestSession(new S2ModelTestSession({ sceneId: 'SyntheticArtifactBudgetScene', runId: budgetHost.runId, resourceId: 'SyntheticBudgetResource',
    providerId: 'SyntheticBudgetProvider', providerLabel: '合成预算模型', model: 'synthetic-budget-model',
    limits: { maxRequests: 1, maxReservedOutputTokens: 512, maxOutputTokens: 512 }, invoke: async () => {
      budgetModelCalls++; return { content: JSON.stringify({ summary: 'x'.repeat(5600), score: 80 }), diagnostics: { finishReason: 'stop' } };
    } }));
  const budgetJob = budgetHost.enqueueWorkflow(['parsed']);
  for (let tries = 0; tries < 200 && !budgetHost.waitingModelTests().length; tries++) await Promise.resolve();
  assert.equal(budgetHost.waitingModelTests().length, 1);
  budgetHost.confirmModelTest(budgetJob.id, budgetHost.waitingModelTests()[0].id, true);
  const budgetRun = await budgetJob.completion; assert.equal(budgetRun.status, 'succeeded'); assert.equal(budgetModelCalls, 1);
  const budgetModel = budgetRun.nodes.find(node => node.nodeId === 'generate').artifactIds[0], budgetJson = budgetRun.nodes.find(node => node.nodeId === 'parsed').artifactIds[0];
  const budgetRead = scoped(budgetHost.prepare(null, strategy, '预算内完整读取'), [budgetModel, budgetJson]);
  assert.equal(budgetRead.recalled.items.filter(item => item.kind === 'artifact').length, 1);
  assert.equal(budgetRead.recalled.unavailable.some(item => item.id === budgetJson && item.reason.includes('预算')), true);
  assert.equal(readS2AssessmentRequest(request(['OutputJson']), business, current, undefined, budgetRead.scope).overall, 'uncertain',
    'A different complete text artifact cannot stand in for the declared JSON port whose full result did not fit');

  // A newer attempt invalidates the old target mapping immediately, even while
  // the old artifact remains a real readable source for ordinary discussion.
  const newerJob = host.enqueueWorkflow(['parsed']);
  const newerWait = await waitForModel();
  assert.equal(readS2ContextArtifact(actualContext, firstModel).text, firstText);
  assert.equal(readS2AssessmentRequest(request(['OutputTail', 'OutputJson']), business, current, undefined, full.scope).overall, 'uncertain');
  assert.equal(readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${firstModel}`, 'FirstOutputTailMarker')]), business, current, undefined, full.scope).overall, 'uncertain');
  host.confirmModelTest(newerJob.id, newerWait.id, true); const newer = await newerJob.completion; assert.equal(newer.status, 'succeeded');
  const secondModel = newer.nodes.find(node => node.nodeId === 'generate').artifactIds[0], secondJson = newer.nodes.find(node => node.nodeId === 'parsed').artifactIds[0];
  const secondScope = scoped(context(), [firstModel, secondModel, secondJson]);
  assert.equal(readS2AssessmentRequest(request(['OutputTail', 'OutputJson']), business, current, undefined, secondScope.scope).overall, 'unmet');
  assert.throws(() => readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${firstModel}`, 'FirstOutputTailMarker')]), business, current, undefined, secondScope.scope), /匹配artifact|旧尝试|目标端口/);
  assert.equal(readS2AssessmentRequest(request(['OutputSemantic'], [judge('OutputSemantic', `artifact:${secondModel}`, '第二次完整返回')]), business, current, undefined, secondScope.scope).overall, 'met');
  const failedJob = host.enqueueWorkflow(['parsed']), failedWait = await waitForModel();
  host.confirmModelTest(failedJob.id, failedWait.id, true); const failed = await failedJob.completion;
  assert.equal(failed.status, 'failed'); assert.equal(failed.nodes.find(node => node.nodeId === 'generate').artifactIds.length, 0);
  assert.equal(readS2AssessmentRequest(request(['OutputTail', 'OutputJson', 'OutputSemantic']), business, current, undefined, secondScope.scope).overall, 'uncertain',
    'Truncated latest response cannot reuse a previously successful target');

  const beforeMove = readS2ContextArtifact(actualContext, firstModel).text;
  const moved = structuredClone(current); moved.nodes[0].position.x += 100; host.setDocument(moved);
  assert.equal(readS2ContextArtifact(actualContext, firstModel).text, beforeMove, 'Layout changes do not revoke unchanged source data');
  const changed = structuredClone(current); changed.nodes[0].values.content += ' 实际语义修改'; host.setDocument(changed);
  assert.throws(() => readS2ContextArtifact(actualContext, firstModel), /失效|修订/);
  assert.equal(readS2AssessmentRequest(request(['OutputTail']), business, changed, undefined, full.scope).overall, 'uncertain');
  const deleted = { ...current, execution: { ...current.execution, nodes: current.execution.nodes.filter(node => node.id !== 'generate'), links: [] } };
  assert.equal(readS2AssessmentRequest(request(['OutputSemantic']), business, deleted, undefined, full.scope).overall, 'uncertain');
  assert.equal(modelCalls, 3); assert.equal(networkAttempts, 0);
  assert.match(S2_ASSESSMENT_RULES, /artifact:真实产物ID/); assert.match(S2_ASSESSMENT_RULES, /当前最新完整artifact/);
  assert.match(S2_ASSESSMENT_RULES, /无需复制到内容块/); assert.match(S2_ASSESSMENT_RULES, /simulationOnly=true/);
  console.log('S2 artifact assessment passed: legacy field compatibility plus exclusive real single-output targets, real host/full-recall opaque scopes, full text/JSON local recomputation, exact latest-target semantic artifact quotes and provenance, explicit simulation-only metadata without model impersonation, no preview/query/field/other-node substitution, and uncertain missing/unprovided/new-attempt/truncated/stale/deleted outputs. Synthetic provider only; no real-model semantic or browser acceptance.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = previousFetch; }
