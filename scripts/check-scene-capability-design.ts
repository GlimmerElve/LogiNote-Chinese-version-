import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { applySceneAssemblyPlan, parseSceneSpec, generateScene } from '../src/services/scene/sceneGenerator';
import { resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { SceneCapabilityGapError } from '../src/services/scene/sceneAbilityCatalog';
import { normalizeSceneExperimentPolicy, executeSceneExperiment, sceneExperimentRecords, closeSceneExperimentSession } from '../src/services/scene/sceneExperiment';
import { prepareSceneTurnAgentContext, normalizeSceneTurnPlan } from '../src/services/scene/sceneTurnAgent';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { SceneExperimentLedger } from '../src/components/scene/SceneExperimentLedger';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';
import { understandingFixture } from './scene-semantic-fixture';
import type { LlmCallRequest, LlmCallResponse, SceneExperimentInput, SceneRunState } from '../src/types';
import { SceneSetupError } from '../src/services/scene/sceneSetupStage';
import { designSceneBehavior, applySceneBehaviorDesign } from '../src/services/scene/sceneBuildAgent';
import { SCENE_UNDERSTANDING_PROMPT } from '../src/services/scene/sceneUnderstanding';

globalThis.fetch = async () => assert.fail('Capability design checks are offline; never call a real model');
const userRequest = '我在学习提示词工程，希望提交自己的提示词真实测试，查看输出偏差，改写后对比再试。不要角色、动作或背景。';
const understood = understandingFixture('request', userRequest, { intent: 'build-scene', userGoal: '检验提示词实际效果并迭代',
  expectedExperience: '自然对话，真实试跑，基于输出解释偏差', successCriteria: ['只输出要求的问候语'],
  userActivities: ['提交或确认待测版本', '修改后再试'], agentResponsibilities: ['组织真实实验并解释偏差'], exclusions: ['角色、动作、叙事'] });
const plan = { needs: [{ id: 'submit', goal: '提交提示词与输入', capabilityIds: ['text'] },
  { id: 'test', goal: '真实测试、校验并记录比较', capabilityIds: ['tool:model-experiment', 'check:json-structure', 'state:experiment-history'] }], missing: [] };
const assembly = { recipeId: 'agent-designed', requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning', 'model-experiment'],
  interactionPlan: '按用户要求决定试跑、解释或修改，不固定每轮台词', rationale: '需要执行能力而不是角色或检索', capabilityPlan: plan };
let designCalls = 0;
const design = await runSceneMultiAgent({ userRequest, sceneSkillConstraint: 'S1', callLlm: async call => {
  const input = JSON.parse(call.userInput); designCalls++;
  if (input.phase === 'understand') {
    assert.doesNotMatch(call.systemPromptOverride!, /tool:model-experiment|Executable ability catalogue/);
    return { content: JSON.stringify({ sceneSkill: 'S1', understanding: understood }) };
  }
  assert.deepEqual(input.architecture.understanding.successCriteria, understood.successCriteria);
  assert.match(call.systemPromptOverride!, /tool:model-experiment/);
  return { content: JSON.stringify(assembly) };
} });
assert.equal(designCalls, 2); assert.deepEqual(design.buildContext.capabilityPlan, plan);
assert.equal(design.recommendation.recipeId, 'agent-designed');
assert.equal(design.recommendation.requestedPromptModules.includes('role-context'), false);
let gapCalls = 0;
await assert.rejects(runSceneMultiAgent({ userRequest: '我需要未安装的自由拖拽能力', callLlm: async call => {
  gapCalls++;
  if (JSON.parse(call.userInput).phase === 'understand') return { content: JSON.stringify({ sceneSkill: 'S1',
    understanding: understandingFixture('request', '我需要未安装的自由拖拽能力', { intent: 'build-scene' }) }) };
  return { content: JSON.stringify({ ...assembly, requestedPromptModules: ['turn-agent-planning'],
    capabilityPlan: { needs: [{ id: 'drag', goal: '自由拖拽', capabilityIds: [] }], missing: [{ goal: '自由拖拽', reason: '客户端未实现此交互组件' }] } }) };
} }), error => error instanceof SceneCapabilityGapError && !error.message.includes('缺少用户信息'));
assert.equal(gapCalls, 2, 'an actual capability gap is not repeatedly retried or turned into user clarification');
await assert.rejects(runSceneMultiAgent({ userRequest, callLlm: async call => ({ content: JSON.stringify(JSON.parse(call.userInput).phase === 'understand'
  ? { sceneSkill: 'S1', understanding: understood }
  : { ...assembly, capabilityPlan: { needs: [{ id: 'fake', goal: '执行', capabilityIds: ['tool:run-arbitrary-code'] }], missing: [] } }) }) }),
  error => error instanceof SceneSetupError && error.code === 'unavailable-capability');

const raw = parseSceneSpec(JSON.stringify({ meta: { name: '提示词实验', subject: '提示词工程', goal: understood.userGoal }, task: '按目标检验提示词',
  behavior: { recipeId: 'agent-designed', kind: '自然对话实验', aiBehavior: '理解要求并按需实验', userAction: '提交提示词或追问',
    evaluationRule: '不评分学习表现，分析实际输出', progressionRule: '根据用户下一句话重新决定策略',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } } }));
const spec = applySceneAssemblyPlan(raw, { subject: '提示词工程', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed',
  requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning', 'model-experiment'], buildContext: design.buildContext });
const contract = resolveSceneRuntimeContract(spec);
assert.equal(contract.mode, 'dialogue'); assert.equal(contract.evaluation, 'none');
assert.deepEqual(contract.allowedTools, ['model-experiment']); assert.equal(new Set(contract.allowedTools).size, contract.allowedTools.length);
assert.deepEqual(spec.experimentPolicy?.criteria, understood.successCriteria);
assert.deepEqual(spec.metrics, []); assert.deepEqual(spec.events, []); assert.equal(spec.situation, '');
// Scene-level success is not the rubric for the tested model's output.
const behaviorContext = structuredClone(design.buildContext);
behaviorContext.understanding!.successCriteria = ['Show raw results and support iterative prompt revisions'];
const outputPolicy = { criteria: ['Follow the submitted prompt and input without unsupported additions'],
  maxExperiments: 3, maxOutputTokens: 512, temperature: 0.2 };
const flowOutput = { answerFeedback:{correctness:'immediate',explanation:'immediate'},flowGuidance: 'Experiment only when the user requests a run', evaluationRule: 'Assess actual output against the fixed rubric',
  progressionRule: 'Understand the next request before choosing an action', completionRule: 'The user decides when to finish', maxTurns: 12, stages: [] };
const instructionOutput = { aiBehavior: 'Run bounded experiments', userAction: 'Submit or confirm a prompt',
  understanding: 'Distinguish execution from explanation', planning: 'Use only approved capabilities', response: 'Explain with executor receipts' };
const behaviorPhases: string[] = [];
let flowAttempts = 0;
const behaviorDesign = await designSceneBehavior(behaviorContext, { invoke: async call => {
  const input = JSON.parse(call.userInput); behaviorPhases.push(input.phase);
  assert.deepEqual(input.buildContext.understanding.successCriteria, behaviorContext.understanding!.successCriteria);
  assert.equal(input.buildContext.userRequest, userRequest);
  if (input.phase === 'flow') {
    flowAttempts++;
    if (flowAttempts === 1) return { content: JSON.stringify(flowOutput) };
    assert.equal(input.outputRepair.code, 'missing-experiment-policy');
    return { content: JSON.stringify({ ...flowOutput, experimentPolicy: outputPolicy }) };
  }
  assert.equal(input.phase, 'instructions');
  assert.deepEqual(input.priorArtifacts.flow.experimentPolicy, outputPolicy);
  return { content: JSON.stringify(instructionOutput) };
} });
assert.deepEqual(behaviorPhases, ['flow', 'flow', 'instructions']);
assert.deepEqual(behaviorDesign.flow.experimentPolicy, outputPolicy);
assert.notDeepEqual(behaviorDesign.flow.experimentPolicy!.criteria, behaviorContext.understanding!.successCriteria);
const designedSpec = applySceneAssemblyPlan(applySceneBehaviorDesign(spec, behaviorDesign), { subject: spec.meta.subject,
  knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['text'],
  requestedPromptModules: ['turn-agent-planning', 'model-experiment'], buildContext: behaviorContext });
assert.deepEqual(designedSpec.experimentPolicy, outputPolicy, 'compilation preserves the independently designed output rubric');
assert.match(SCENE_UNDERSTANDING_PROMPT, /"kind":"[^"]*execution-result/);
const generatedPhases: string[] = [];
const fullBuildOptions = { subject: spec.meta.subject, knowledgePoints: [], sceneSkill: 'S1' as const, recipeId: 'agent-designed' as const,
  requestedCapabilities: ['text'] as const, requestedPromptModules: ['turn-agent-planning', 'model-experiment'] as const,
  buildContext: behaviorContext, manifest: { version: '1.0', updatedAt: '', scenes: [] } };
const fullExperimentScene = await generateScene({ ...fullBuildOptions, requestedCapabilities: [...fullBuildOptions.requestedCapabilities],
  requestedPromptModules: [...fullBuildOptions.requestedPromptModules], callLlm: async call => {
    const input = JSON.parse(call.userInput); generatedPhases.push(input.phase);
    if (input.phase === 'flow') return { content: JSON.stringify({ ...flowOutput, experimentPolicy: outputPolicy }) };
    if (input.phase === 'instructions') return { content: JSON.stringify(instructionOutput) };
    if (input.phase === 'generate') {
      assert.match(input.generationRequirements, /allowedTools[^；]*model-experiment/);
      assert.deepEqual(input.priorArtifacts.flow.experimentPolicy, outputPolicy);
      return { content: JSON.stringify({ ...raw, runtimeContract: { allowedTools: ['model-experiment'], mode: 'dialogue' } }) };
    }
    assert.equal(input.phase, 'accept');
    assert.ok(input.criteria.some((criterion: { id: string }) => criterion.id === 'experiment-output-rubric'));
    assert.deepEqual(input.scene.runtimeContract.allowedTools, ['model-experiment']);
    assert.deepEqual(input.scene.experimentPolicy, outputPolicy);
    return { content: JSON.stringify({ coverage: input.criteria.map((criterion: { id: string }) => ({
      id: criterion.id, satisfied: true, evidencePaths: ['experimentPolicy.criteria'], detail: 'Synthetic compiled-policy coverage'
    })), issues: [] }) };
  } });
assert.deepEqual(generatedPhases, ['flow', 'instructions', 'generate', 'accept']);
assert.deepEqual(fullExperimentScene.experimentPolicy, outputPolicy);
const revisedOutputPolicy = { ...outputPolicy, criteria: ['Check every explicit output constraint against actual returned text'] };
const repairedPolicyPhases: string[] = [];
const repairedPolicyScene = await generateScene({ ...fullBuildOptions, requestedCapabilities: [...fullBuildOptions.requestedCapabilities],
  requestedPromptModules: [...fullBuildOptions.requestedPromptModules], callLlm: async call => {
    const input = JSON.parse(call.userInput); repairedPolicyPhases.push(input.phase);
    if (input.phase === 'flow') return { content: JSON.stringify({ ...flowOutput, experimentPolicy: outputPolicy }) };
    if (input.phase === 'instructions') return { content: JSON.stringify(instructionOutput) };
    if (input.phase === 'generate') return { content: JSON.stringify(raw) };
    if (input.phase === 'repair') {
      assert.deepEqual(input.allowedTargets, ['experimentPolicy']);
      return { content: JSON.stringify({ patch: { experimentPolicy: revisedOutputPolicy } }) };
    }
    assert.equal(input.phase, 'accept');
    const failure = input.revision === 0;
    return { content: JSON.stringify({ coverage: input.criteria.map((criterion: { id: string }) => ({
      id: criterion.id, satisfied: !(failure && criterion.id === 'experiment-output-rubric'),
      evidencePaths: ['experimentPolicy.criteria'], detail: 'Synthetic output-rubric review'
    })), issues: failure ? [{ criterionId: 'experiment-output-rubric', target: 'experimentPolicy', instruction: 'Refine output-level checks' }] : [] }) };
  } });
assert.deepEqual(repairedPolicyPhases, ['flow', 'instructions', 'generate', 'accept', 'repair', 'accept']);
assert.deepEqual(repairedPolicyScene.experimentPolicy, revisedOutputPolicy, 'semantic repair can correct the output rubric without expanding tool scope');
let invalidPolicyCalls = 0;
await assert.rejects(designSceneBehavior(behaviorContext, { invoke: async () => {
  invalidPolicyCalls++; return { content: JSON.stringify({ ...flowOutput, experimentPolicy: { criteria: [] } }) };
} }), error => error instanceof SceneSetupError && error.stage === 'flow' && error.code === 'missing-experiment-policy');
assert.equal(invalidPolicyCalls, 2, 'invalid experiment policy gets one bounded repair, not a clarification loop');
assert.equal(normalizeSceneExperimentPolicy({ criteria: ['Output check'], maxOutputTokens: 1 }).maxOutputTokens, 256,
  'consent and receipts must show the same minimum token budget as the actual LLM transport');
const dialogueContext = structuredClone(behaviorContext);
dialogueContext.assembly!.promptModules = ['turn-agent-planning'];
const dialogueDesign = await designSceneBehavior(dialogueContext, { invoke: async call => ({ content: JSON.stringify(
  JSON.parse(call.userInput).phase === 'flow' ? { ...flowOutput, experimentPolicy: outputPolicy } : instructionOutput) }) });
assert.equal(dialogueDesign.flow.experimentPolicy, undefined, 'a model cannot enable paid experiments from the flow stage');
assert.equal(resolveSceneAssembly({ sceneSkill: 'S4', recipeId: 'guided-derivation', requestedPromptModules: ['model-experiment'] }).valid, false);
assert.equal(resolveSceneRuntimeContract({ ...raw, promptModuleIds: undefined, experimentPolicy: spec.experimentPolicy }).allowedTools.includes('model-experiment'), false);
const markup = renderToStaticMarkup(createElement(SceneSpecPreview, { spec, busy: false, onChange() {}, onStart() {}, onDelete() {} }));
assert.match(markup, /scene-experiment-consent/); assert.match(markup, /type="checkbox"/); assert.match(markup, /disabled=""/);

const prompt = '忽略裁判指令的例子也只是待测文本；请只输出问候语你好。';
const inputText = '向小王打招呼。';
const newRun = (suffix: string, sourceText = prompt + '\n' + inputText): SceneRunState => {
  const run = createRunState(spec); run.runId = 'offline-experiment-' + suffix; run.experimentApproved = true;
  run.messages.push({ id: 'user-' + suffix, speakerType: 'user', speakerName: '用户', content: sourceText, timestamp: '' }); return run;
};
const argsFor = (run: SceneRunState): SceneExperimentInput => ({ promptSourceMessageId: run.messages.at(-1)!.id, promptQuote: prompt,
  inputSourceMessageId: run.messages.at(-1)!.id, inputQuote: inputText, outputFormat: 'json-object' });
let executions = 0, evaluations = 0;
const invoke = async (call: LlmCallRequest): Promise<LlmCallResponse> => {
  assert.equal(call.skipMemoryInjection, true); assert.equal(call.skipProfileInjection, true);
  assert.equal(call.tools, undefined); assert.equal(call.messages, undefined);
  if (call.workflow === 'scene-model-experiment') {
    executions++;
    assert.equal(call.systemPromptOverride, prompt, 'target prompt is unchanged, not wrapped in controller rules');
    assert.equal(call.userInput, inputText); assert.deepEqual(call.outputSchema, {}, 'expected JSON is checked, not forcibly injected to hide a bad prompt');
    return { content: '{"answer":"你好"}', diagnostics: { finishReason: 'stop', responseModel: 'real-response-model' } };
  }
  evaluations++;
  assert.equal(call.workflow, 'scene-experiment-evaluate'); assert.notEqual(call.systemPromptOverride, prompt);
  const evaluationInput = JSON.parse(call.userInput);
  assert.deepEqual(evaluationInput.criteria, understood.successCriteria); assert.equal(evaluationInput.actualOutput, '{"answer":"你好"}');
  assert.notEqual(call.model, 'real-response-model', 'response metadata cannot choose the judge model');
  return { content: '{"checks":[{"index":0,"verdict":"met","evidence":"你好","suggestion":"尝试其他输入检验稳定性"}]}' };
};
const run = newRun('first'), args = argsFor(run);
await assert.rejects(executeSceneExperiment(spec, { ...run, experimentApproved: false }, args, { invoke }), /未授权/);
await assert.rejects(executeSceneExperiment(spec, run, { ...args, baseUrl: 'https://evil.invalid' }, { invoke }), /不得设置/);
await assert.rejects(executeSceneExperiment(spec, run, { ...args, promptQuote: '并不存在的改写提示词' }, { invoke }), /不是已提交/);
assert.equal(executions, 0);
const [first, duplicate] = await Promise.all([executeSceneExperiment(spec, run, args, { invoke }), executeSceneExperiment(spec, run, args, { invoke })]);
assert.equal(first.id, duplicate.id); assert.equal(executions, 1); assert.equal(evaluations, 1);
assert.equal(first.status, 'complete'); assert.equal(first.formatValid, true); assert.equal(first.evaluation[0].verdict, 'met');
await executeSceneExperiment(spec, run, args, { invoke }); assert.equal(executions, 1, 'same-turn retry does not charge again');
first.output = 'attempted mutation'; assert.equal(sceneExperimentRecords(run)[0].output, '{"answer":"你好"}');
const secondRun = { ...run, messages: [...run.messages, { ...run.messages.at(-1)!, id: 'user-second' }] };
const second = await executeSceneExperiment(spec, secondRun, { ...args, promptSourceMessageId: 'user-second', inputSourceMessageId: 'user-second' }, { invoke });
assert.notEqual(first.id, second.id); assert.equal(executions, 2); assert.equal(second.temperature, first.temperature);
assert.equal(second.maxOutputTokens, first.maxOutputTokens); assert.equal(second.input, first.input);
const explanation = { ...run, messages: [...run.messages, { ...run.messages.at(-1)!, id: 'explain', content: '先不运行，解释刚才失败的原因。' }] };
let explanationCalls = 0;
await prepareSceneTurnAgentContext(spec, explanation, { callLlm: async () => {
  explanationCalls++; return { content: JSON.stringify({ understanding: understandingFixture('explain', explanation.messages.at(-1)!.content), action: 'respond' }) };
}, experimentCallLlm: async () => assert.fail('explanation must not cause a new experiment') });
assert.equal(explanationCalls, 1);
assert.throws(() => normalizeSceneTurnPlan({ understanding: understandingFixture(run.messages.at(-1)!.id, run.messages.at(-1)!.content,
  { informationGaps: [{ id: 'g', description: '查参考资料', kind: 'reference-material' }] }), action: 'respond', toolRequests: [
    { id: 'model-experiment', query: '执行', needId: 'g', reason: '请求错配', experiment: args }] }, spec, run), /有效信息缺口/);

const limitSpec = { ...spec, experimentPolicy: { ...spec.experimentPolicy!, maxExperiments: 1 } };
const failedRun = newRun('failure'); let failedCalls = 0;
const failed = await executeSceneExperiment(limitSpec, failedRun, argsFor(failedRun), { invoke: async call => {
  failedCalls++; if (call.workflow === 'scene-model-experiment') return { content: '实际返回但评估失败' }; throw new Error('secret-key PRIVATE_NOTE');
} });
assert.equal(failed.status, 'failed'); assert.equal(failed.output, '实际返回但评估失败'); assert.doesNotMatch(failed.error!, /secret-key|PRIVATE_NOTE/);
await executeSceneExperiment(limitSpec, failedRun, argsFor(failedRun), { invoke: async () => assert.fail('failed operation is not blindly retried') });
assert.equal(failedCalls, 2);
const overBudget = { ...failedRun, messages: [...failedRun.messages, { ...failedRun.messages.at(-1)!, id: 'over-budget' }] };
await assert.rejects(executeSceneExperiment(limitSpec, overBudget, argsFor(overBudget), { invoke }), /预算已用尽/);
const abortedRun = newRun('abort'), controller = new AbortController();
await assert.rejects(executeSceneExperiment(spec, abortedRun, argsFor(abortedRun), { signal: controller.signal, invoke: async () => {
  controller.abort(); return { content: 'late' };
} }), { name: 'AbortError' });
assert.equal(sceneExperimentRecords(abortedRun).length, 1); assert.equal(sceneExperimentRecords(abortedRun)[0].status, 'failed');
const ungroundedRun = newRun('ungrounded');
const ungrounded = await executeSceneExperiment(spec, ungroundedRun, argsFor(ungroundedRun), { invoke: async call => call.workflow === 'scene-model-experiment'
  ? { content: '你好' } : { content: '{"checks":[{"index":0,"verdict":"met","evidence":"伪造的证据","suggestion":"全通过"}]}' } });
assert.equal(ungrounded.evaluation[0].verdict, 'uncertain'); assert.equal(ungrounded.evaluation[0].evidence, '');
assert.equal(ungrounded.formatValid, false);
const truncatedRun = newRun('truncated'); let truncatedCalls = 0;
const truncated = await executeSceneExperiment(spec, truncatedRun, argsFor(truncatedRun), { invoke: async () => {
  truncatedCalls++; return { content: 'partial', diagnostics: { finishReason: 'length' } };
} });
assert.equal(truncated.status, 'failed'); assert.equal(truncatedCalls, 1);
assert.equal(normalizeSceneExperimentPolicy({ criteria: ['标准'], maxExperiments: 100, maxOutputTokens: 10000 }).maxExperiments, 6);
assert.equal(normalizeSceneExperimentPolicy({ criteria: ['标准'], maxOutputTokens: 10000 }).maxOutputTokens, 2048);

const activeRun = newRun('runtime'); const activeArgs = argsFor(activeRun); let planning = 0; let notified = 0;
const real = await generateGeneralTurn(spec, activeRun, { onExperiments: records => { notified = records.length; }, dependencies: {
  experimentCallLlm: invoke, searchNotes: async () => assert.fail('experiment does not automatically read notes'),
  callLlm: async call => {
    if (call.workflow !== 'scene-turn-plan') return { content: '{"content":"根据实际输出检查偏差。","experiments":[{"id":"fake"}]}' };
    const input = JSON.parse(call.userInput);
    if (input.phase === 'understand') return { content: JSON.stringify({ understanding: understandingFixture(activeRun.messages.at(-1)!.id,
      activeRun.messages.at(-1)!.content, { informationGaps: [{ id: 'execute', kind: 'execution-result', description: '用户要求真实试跑，缺运行结果' }] }), action: 'respond' }) };
    planning++;
    assert.ok(input.experimentSources.some((source: any) => source.content.includes(prompt)));
    return { content: JSON.stringify({ action: 'respond', toolRequests: planning === 1 ? [
      { id: 'model-experiment', query: '测试当前提示词', needId: 'execute', reason: '获取实际模型返回', experiment: activeArgs }] : [] }) };
  },
} });
assert.equal(planning, 2); assert.equal(notified, 1); assert.equal(real.experiments?.length, 1); assert.notEqual(real.experiments?.[0].id, 'fake');
const ledgerMarkup = renderToStaticMarkup(createElement(SceneExperimentLedger, { records: [{ ...real.experiments![0], output: '<script>evil()</script>' }] }));
const closedRun = newRun('closed');
await executeSceneExperiment(spec, closedRun, argsFor(closedRun), { invoke });
const retainedRecords = sceneExperimentRecords(closedRun);
closeSceneExperimentSession({ ...closedRun, status: 'success' });
assert.deepEqual(sceneExperimentRecords(closedRun), []);
assert.equal(retainedRecords.length, 1, 'UI receipt copies remain available after executor cleanup');
await assert.rejects(executeSceneExperiment(spec, { ...closedRun, experimentRecords: [] }, argsFor(closedRun), {
  invoke: async () => assert.fail('closed identities cannot reopen or recharge')
}), { name: 'AbortError' });
const pendingRun = newRun('close-pending');
let finishTarget!: (response: LlmCallResponse) => void, pendingCalls = 0, pendingNotifications = 0;
const pendingExperiment = executeSceneExperiment(spec, pendingRun, argsFor(pendingRun), { invoke: async () => {
  pendingCalls++; return new Promise(resolve => { finishTarget = resolve; });
}, onRecord: () => { pendingNotifications++; } });
const pendingDuplicate = executeSceneExperiment(spec, pendingRun, argsFor(pendingRun), { invoke: async () => assert.fail('duplicate pending trial') });
closeSceneExperimentSession(pendingRun);
finishTarget({ content: 'late target result' });
await assert.rejects(pendingExperiment, { name: 'AbortError' });
await assert.rejects(pendingDuplicate, { name: 'AbortError' });
assert.equal(pendingCalls, 1, 'closing a pending trial prevents a later judge request');
assert.equal(pendingNotifications, 0); assert.deepEqual(sceneExperimentRecords(pendingRun), []);
for (let i = 0; i < 25; i++) {
  const completedRun = newRun('released-' + i);
  await executeSceneExperiment(spec, completedRun, argsFor(completedRun), { invoke });
  closeSceneExperimentSession({ ...completedRun, status: 'success' });
}
assert.equal(sceneExperimentRecords(activeRun).length, 1, 'closing other runs cannot clear an active run budget/receipts');
assert.ok(ledgerMarkup.includes('&lt;script&gt;')); assert.equal(ledgerMarkup.includes('<script>'), false); assert.match(ledgerMarkup, /原始返回结果/);
console.log('Scene capability design passed: goal-led assembly, typed capability gaps, preset independence, explicit execution consent, isolated actual trials/judging, stable parameters, budgets, retry deduplication, grounded receipts, raw-text ledger, and no automatic RAG or S4 permission expansion. Synthetic model decisions only.');
