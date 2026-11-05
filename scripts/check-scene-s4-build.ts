import assert from 'node:assert/strict';
import { adaptScene, applySceneAssemblyPlan, generateScene, generateS4ComputeConfig, parseSceneSpec, SceneBuildInterruptedError } from '../src/services/scene/sceneGenerator';
import { resolveSceneAssembly, preflightSceneSpec } from '../src/services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { SCENE_COMPUTE_GENERATE_PROMPT, SCENE_COMPUTE_ADAPT_PROMPT } from '../src/workflows/sceneComputePrompt';
import type { SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import type { LlmCallRequest, SceneSpec } from '../src/types';

globalThis.fetch = async () => assert.fail('S4 build regression is offline and synthetic only');
const shell = {
  meta: { name: '合成方程推导', subject: '数学', sceneSkill: 'S4', knowledgePoints: ['一元一次方程'], goal: '由前提完成方程求解' },
  situation: '已知某个量的两倍再加三等于七，使用画布展示合法推导。',
  task: '从已知条件求出未知量，并用前提连线说明每一步的依据。',
  resources: ['已知条件为 2*x+3=7'],
  rules: ['使用公式节点和推导连线，不靠选择题作答'],
  role: { name: '推导助理', attributes: [] },
  metrics: [{ id: 'formula_correctness', name: '推导合法', type: 'boolean', initial: false, target: true, source: 'engine' }],
  completion: { mode: 'metric', successExpression: '存在已验证的完整结论支路', maxTurns: 30 },
};
const parsed = parseSceneSpec(JSON.stringify(shell), 'S4');
assert.equal(parsed.behavior, undefined, 'S4 does not require a dialogue behavior');
const assembled = applySceneAssemblyPlan(parsed, { subject: '数学', knowledgePoints: [], sceneSkill: 'S4', recipeId: 'guided-derivation' });
assert.equal(assembled.situation, shell.situation, 'mathematical problem context is not optional S1 narration');
assert.deepEqual(assembled.resources, shell.resources, 'problem givens must survive module compilation');
assert.equal(assembled.completion.mode, 'metric');
assert.equal(assembled.behavior, undefined);
assert.equal(preflightSceneSpec(assembled, { allowDeferredCompute: true }).valid, true);
assert.equal(preflightSceneSpec(assembled).valid, false, 'preview alone cannot start a canvas');

const assembly = resolveSceneAssembly({ sceneSkill: 'S4', recipeId: 'guided-derivation' });
const context: SceneBuildContext = {
  version: 1, userRequest: '用数理画布学习一元一次方程，通过连线说明每步前提，不显示答案。', conversation: [],
  selectedSurface: 'S4', explicitSelections: {},
  assembly: { recipeId: 'guided-derivation', capabilities: assembly.enabledCapabilities,
    promptModules: assembly.enabledPromptModules, interactionPlan: '用户建节点、连接前提、提交并获得引擎反馈。' },
};
const flow = { flowGuidance: '画布保留数学任务与前提，逐节点提交允许合法多路径。', evaluationRule: '只解释前提链引擎判定，不代判数学对错。',
  progressionRule: '用户自行选择下一步或求助，不生成单选题。', completionRule: '不能用此设计文本替换实际结论支路判定。', maxTurns: 30, stages: [] };
const instructions = { aiBehavior: '推导助手校准反馈', userAction: '创建公式节点并连接前提后提交',
  understanding: '理解当前公式、前提连线和具体求助。', planning: '仅采用本地画布验证与已授权求助。', response: '解释引擎结论，不泄露完整答案。' };
const config = { compute: { type: 'formula', operation: 'solve', expected_formula: '2', expected_steps_count: 2,
  given: [{ name: '已知关系', display: '2*x+3=7', entries: [{ kind: 'relation', display: '2*x+3=7', symbolic: '2*x+3=7' }] }],
  symbols: [{ name: 'x', kind: 'variable', display: '未知量' }],
  expected_steps: [{ display: '两边减去三', symbolic: '2*x=4' }, { display: '两边同除以二', symbolic: 'x=2' }], boundary_conditions: [] },
  help: { base_help_count: 2, difficulty_factor: 1, user_factor: 1, max_help_count: 999, penalty_per_help: .1 } };
const opts = { subject: '数学', knowledgePoints: ['一元一次方程'], sceneSkill: 'S4' as const, recipeId: 'guided-derivation' as const,
  buildContext: context, requestedCapabilities: assembly.enabledCapabilities, requestedPromptModules: assembly.enabledPromptModules,
  manifest: { version: '1.0' as const, updatedAt: '', scenes: [] } };
function model(rawContract?: unknown, interrupted = false, repairEvidence = false) {
  const phases: string[] = [], requests: LlmCallRequest[] = [];
  let didInterrupt = false;
  let acceptanceCalls = 0;
  const caller = async (call: LlmCallRequest) => {
    const input = JSON.parse(call.userInput); phases.push(input.phase); requests.push(call);
    assert.equal(input.buildContext.userRequest, context.userRequest, 'full goal survives every specialist boundary');
    const response = (value: unknown) => ({ content: JSON.stringify(value) });
    if (input.phase === 'flow') { assert.match(call.systemPromptOverride!, /本次运行面是S4数理画布/); return response(flow); }
    if (input.phase === 'instructions') { assert.match(call.systemPromptOverride!, /本次是S4数理画布/); return response(instructions); }
    if (input.phase === 'generate') {
      assert.ok(['scene-compute-generate', 'scene-compute-adapt'].includes(call.workflow!));
      assert.match(input.generationRequirements, /S4 是本地画布数理推导协议/);
      assert.doesNotMatch(input.generationRequirements, /allowedActions 仅 respond|未启用 scenario-framing 则 situation/);
      assert.equal(input.sourceScene?.compute, undefined, 'adapt does not send private source answers to preview generation');
      if (interrupted && !didInterrupt) { didInterrupt = true; throw new Error('HTTP 503 synthetic provider failure'); }
      const scene = { ...shell, runtimeContract: rawContract, ...config };
      return response(input.sourceScene ? { adaptedFromExisting: true, scene } : scene);
    }
    assert.equal(input.phase, 'accept');
    acceptanceCalls++;
    assert.ok(input.availableEvidencePaths.includes('task'));
    assert.ok(input.availableEvidencePaths.includes('agentInstructions.response'));
    assert.ok(!input.availableEvidencePaths.some((path: string) => path.startsWith('behavior')));
    assert.doesNotMatch(call.systemPromptOverride!, /"evidencePaths":\["behavior.aiBehavior"\]/);
    assert.ok(input.criteria.some((item: any) => item.id === 'canvas-protocol'), 'canvas-specific acceptance is explicit');
    assert.equal(input.scene.behavior, undefined); assert.equal(input.scene.compute, undefined); assert.equal(input.scene.help, undefined);
    assert.equal(input.scene.situation, shell.situation);
    if (repairEvidence && acceptanceCalls === 2) {
      assert.equal(input.outputRepair.code, 'invalid-acceptance-evidence');
      assert.match(input.outputRepair.detail, /behavior.aiBehavior/);
    }
    return response({ coverage: input.criteria.map((item: any) => ({ id: item.id, satisfied: true,
      evidencePaths: [repairEvidence && acceptanceCalls === 1 ? 'behavior.aiBehavior' : 'task'] })), issues: [] });
  };
  return { phases, requests, caller };
}
let preview: SceneSpec | undefined;
for (const contract of [undefined, { allowedInteractionTypes: [] }, { allowedInteractionTypes: ['text'] }]) {
  const mocked = model(contract);
  preview = await generateScene({ ...opts, callLlm: mocked.caller });
  assert.deepEqual(mocked.phases, ['flow', 'instructions', 'generate', 'accept']);
  assert.deepEqual(resolveSceneRuntimeContract(preview).allowedInteractionTypes, []);
  assert.deepEqual(resolveSceneRuntimeContract(preview).allowedTools, []);
  assert.equal(preview.compute, undefined); assert.equal(preview.help, undefined);
  assert.equal(preview.completion.successExpression, shell.completion.successExpression, 'design text cannot replace canvas engine completion');
  assert.equal(preflightSceneSpec(preview, { allowDeferredCompute: true }).valid, true);
}
assert.ok(preview);
const evidenceRepaired = model(undefined, false, true);
const repairedPreview = await generateScene({ ...opts, callLlm: evidenceRepaired.caller });
assert.equal(repairedPreview.meta.sceneSkill, 'S4');
assert.deepEqual(evidenceRepaired.phases, ['flow', 'instructions', 'generate', 'accept', 'accept'],
  'invalid S1 evidence in S4 is repaired at acceptance only, without regenerating the scene or private compute');
for (const prompt of [SCENE_COMPUTE_GENERATE_PROMPT, SCENE_COMPUTE_ADAPT_PROMPT]) {
  assert.match(prompt, /S4 是本地画布数理推导协议/);
  assert.match(prompt, /必须是字符串|string/);
}
let configCalls = 0;
const ready = await generateS4ComputeConfig({ spec: preview, callLlm: async call => {
  configCalls++; assert.equal(call.workflow, 'scene-compute-config');
  assert.equal(call.skipMemoryInjection, true); assert.equal(call.skipProfileInjection, true);
  assert.match(call.userInput, /已知条件为 2\*x\+3=7/);
  return { content: JSON.stringify(config) };
} });
assert.equal(configCalls, 1); assert.equal(preflightSceneSpec(ready).valid, true);
assert.equal(ready.sceneId, preview.sceneId); assert.equal(ready.situation, preview.situation);
assert.equal(ready.help!.max_help_count < 999, true, 'host recalculates help budget');
assert.equal(preview.compute, undefined, 'start does not mutate the saved preview');
const run = createRunState(ready);
assert.ok(run.canvas); assert.equal(run.status, 'running');
assert.equal(run.messages.some(message => message.content.includes('x=2')), false, 'private answer is not an opening chat message');
const adapting = model();
const adapted = await adaptScene({ ...opts, sourceSpec: ready, callLlm: adapting.caller });
assert.equal(adapted.origin, 'adapted'); assert.equal(adapted.sourceSceneId, ready.sceneId);
assert.notEqual(adapted.sceneId, ready.sceneId); assert.equal(adapted.compute, undefined);
const interrupted = model(undefined, true);
let checkpoint: import('../src/services/scene/sceneGenerator').SceneBuildCheckpoint | undefined;
await assert.rejects(() => generateScene({ ...opts, callLlm: interrupted.caller }), error => {
  assert.ok(error instanceof SceneBuildInterruptedError); checkpoint = error.checkpoint; return true;
});
assert.ok(checkpoint);
const resumed = await generateScene({ ...opts, resume: checkpoint, callLlm: interrupted.caller });
assert.equal(resumed.meta.sceneSkill, 'S4');
assert.deepEqual(interrupted.phases, ['flow', 'instructions', 'generate', 'generate', 'accept'], 'resume retains accepted S4 design stages');
const controller = new AbortController(); let canceledCalls = 0;
await assert.rejects(() => generateS4ComputeConfig({ spec: preview!, signal: controller.signal, callLlm: async () => {
  canceledCalls++; controller.abort(); return { content: JSON.stringify(config) };
} }), { name: 'AbortError' });
assert.equal(canceledCalls, 1, 'cancellation cannot spend a second repair request');
let invalidConfigCalls = 0;
await assert.rejects(() => generateS4ComputeConfig({ spec: preview!, callLlm: async () => {
  invalidConfigCalls++; return { content: JSON.stringify({ compute: { expected_formula: '' } }) };
} }), /expected_formula/);
assert.equal(invalidConfigCalls, 2, 'invalid start output is bounded and never returns a half-configured scene');
const malformed = model({ allowedInteractionTypes: 'text' });
await assert.rejects(() => generateScene({ ...opts, callLlm: malformed.caller }), error => {
  assert.ok(error instanceof SceneBuildInterruptedError);
  assert.match(error.message, /allowedInteractionTypes/);
  assert.doesNotMatch(error.message, /未包含完整、可执行的行为/); return true;
});
assert.deepEqual(malformed.phases, ['flow', 'instructions', 'generate', 'generate'], 'schema repair is bounded and preserves the exact failing field');
const paid = model({ allowedTools: ['model-experiment'] });
await assert.rejects(() => generateScene({ ...opts, callLlm: paid.caller }), /S4 数理画布不支持 model-experiment/);
assert.equal(paid.phases.includes('accept'), false, 'canvas cannot acquire a paid S1 executor by generated configuration');
console.log('S4 build passed: synthetic new/adapt/empty-or-legacy contract, canvas-specific design/acceptance, deferred private compute, strict start, memory isolation, help budget, resume and cancellation. No network or real user data.');
