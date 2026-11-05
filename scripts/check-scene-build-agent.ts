import assert from 'node:assert/strict';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { generateScene, adaptScene, decideScene, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { prepareSceneTurnAgentContext } from '../src/services/scene/sceneTurnAgent';
import { runSceneSetupStage, SceneSetupError } from '../src/services/scene/sceneSetupStage';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { understandingFixture } from './scene-semantic-fixture';
import type { LlmCallRequest, LlmCallResponse, SceneSpec } from '../src/types';

globalThis.fetch = async () => assert.fail('Scene builder tests use synthetic model output only');
const request = '围绕社会心理学效应逐题测试，只要难的典型单选题；不需要角色、动作、背景或突发事件。';
const history = [{ sourceId: 'prior-user', role: 'user' as const, text: '不要把我的举例当成新的题型授权。' }];
const semantic = understandingFixture('request', request, { intent: 'build-scene', userGoal: '用难的典型单选题测试社会心理学效应',
  expectedExperience: '每回合一道单选题，核对后按表现组织下一轮', requirements: ['只出单选题', '复杂典型案例', '每回合一题'],
  exclusions: ['角色动作', '背景叙事', '突发事件'] });
const assembly = { capabilityPlan: { needs: [{ id: 'practice', goal: '逐题选择', capabilityIds: ['single-choice'] }], missing: [] }, recipeId: 'guided-practice', requestedCapabilities: ['single-choice'],
  requestedPromptModules: ['turn-agent-planning', 'resource-grounding', 'adaptive-progression', 'structured-interaction'],
  interactionPlan: '交叉应用知识点，逐题核对后选择下一题', rationale: '服务用户要求，不引入叙事' };
const first = await runSceneMultiAgent({ userRequest: request, conversation: history, sceneSkillConstraint: 'S1',
  recipeConstraint: 'guided-practice', requestedCapabilities: ['single-choice'], callLlm: async call => {
    const input = JSON.parse(call.userInput);
    assert.equal(input.buildContext.userRequest, request);
    assert.deepEqual(input.buildContext.conversation, history);
    assert.ok(input.specialistTask.objective);
    if (input.phase === 'understand') {
      assert.doesNotMatch(call.systemPromptOverride!, /Recipes:|Capabilities:/);
      return { content: JSON.stringify({ sceneSkill: 'S1', understanding: semantic }) };
    }
    assert.deepEqual(input.buildContext.understanding, semantic);
    return { content: JSON.stringify(assembly) };
  } });
const flow = { answerFeedback:{correctness:'immediate',explanation:'immediate'},flowGuidance: '用户作答后核对答案，再按薄弱点组织另一道典型题。', evaluationRule: '本地核对选项；解释错误依据。',
  progressionRule: '保留用户对难度的要求，基于实际表现选择知识点。', completionRule: '完成设计题量后综合分析。', maxTurns: 15, stages: [] };
const instructions = { aiBehavior: '用复杂典型案例交叉测试知识点，一次一题。', userAction: '选一个答案。',
  understanding: '专项理解标记：区分作答、难度调整与纠正，不扩大题型。', planning: '专项规划标记：按当前知识缺口选择已授权笔记，不为核对答案检索。',
  response: '专项回应标记：自然解释选项依据，题目仍仅限单选，不写角色动作。' };
const rawScene = { meta: { name: '高难社会效应', subject: '社会心理学', goal: semantic.userGoal }, task: '逐题测试', rules: ['保留原始硬约束'],
  behavior: { recipeId: 'guided-practice', kind: '逐题单选', aiBehavior: '旧设计', userAction: '旧行动', evaluationRule: '旧评分', progressionRule: '旧推进',
    interaction: { version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } },
  // Unselected legacy content must be removed BEFORE the semantic reviewer sees the executable draft.
  situation: '旧背景', role: { name: '旧角色', attributes: [] }, events: [{ id: 'e', title: '突发', description: '旧事件', trigger: { type: 'turn', turn: 3 } }],
  runtimeContract: { mode: 'coaching', evaluation: 'each-answer', completion: 'objective', maxUserTasksPerTurn: 1 } };
const opts: any = { subject: '社会心理学', knowledgePoints: ['认知失调', '从众'], sceneSkill: 'S1', recipeId: assembly.recipeId,
  requestedCapabilities: assembly.requestedCapabilities, requestedPromptModules: assembly.requestedPromptModules, buildContext: first.buildContext,
  manifest: { scenes: [] } };
type Mode = 'pass' | 'repair' | 'reject' | 'omitted' | 'forged-path' | 'forged-patch' | 'transport' | 'abort' | 'flow-combination-repair';
function model(mode: Mode = 'pass', controller?: AbortController) {
  const phases: string[] = [], seen: any[] = [];
  let reviews = 0, repairCalls = 0, flowCalls = 0;
  const caller = async (call: LlmCallRequest): Promise<LlmCallResponse> => {
    const input = JSON.parse(call.userInput); phases.push(input.phase); seen.push(input);
    assert.equal(input.buildContext.userRequest, request, 'every stage inherits the complete original goal');
    assert.deepEqual(input.buildContext.conversation, history, 'history is explicit, not assumed model memory');
    assert.deepEqual(input.buildContext.explicitSelections, JSON.parse(JSON.stringify(first.buildContext.explicitSelections)));
    assert.deepEqual(input.buildContext.understanding, semantic);
    assert.ok(input.specialistTask.objective); assert.ok(input.specialistTask.acceptance);
    const response = (value: unknown) => ({ content: JSON.stringify(value) });
    if (input.phase === 'flow') {
      if (mode === 'transport') throw new Error('HTTP 401 provider-secret');
      if (mode === 'abort') controller!.abort();
      if (mode === 'flow-combination-repair') {
        if (++flowCalls === 1) return response({ ...flow, stages: [
          {id: 'start', goal: 'Start', allowedNext: []}, {id: 'unreachable-review', goal: 'Review', allowedNext: []},
        ], initialStageId: 'start' });
        assert.equal(input.outputRepair.code, 'invalid-flow');
        assert.match(input.outputRepair.detail, /unreachable-review/);
        assert.match(input.outputRepair.detail, /allowedNext/);
      }
      return response(flow);
    }
    if (input.phase === 'instructions') {
      assert.deepEqual(input.priorArtifacts.flow, flow);
      assert.ok(call.maxTokensOverride! >= 8192);
      return response(instructions);
    }
    if (input.phase === 'generate') {
      assert.deepEqual(input.priorArtifacts.instructions, instructions);
      return response(input.sourceScene ? { scene: rawScene, adaptedFromExisting: true } : rawScene);
    }
    if (input.phase === 'repair') {
      repairCalls++;
      assert.deepEqual(input.allowedTargets, ['task']);
      return response({ patch: mode === 'forged-patch' ? { sceneId: 'forged' } : { task: '按复杂典型案例逐题测试；仅单选' } });
    }
    assert.equal(input.phase, 'accept'); reviews++;
    const probeSummary = input.priorArtifacts.localProtocolProbes;
    assert.equal(probeSummary.uiEvaluated, false);
    assert.ok(probeSummary.caseCount > 0 && Array.isArray(probeSummary.fixtures));
    assert.ok(!('cases' in probeSummary), 'the model receives compact coverage, not repeated passing descriptions');
    assert.equal(input.scene.situation, ''); assert.deepEqual(input.scene.events, []);
    assert.equal(input.scene.agentInstructions.response, instructions.response);
    const failed = ['repair', 'reject', 'forged-patch'].includes(mode) && (reviews === 1 || mode === 'reject');
    const coverage = input.criteria.map((criterion: any, i: number) => ({ id: criterion.id, satisfied: !(failed && i === 0),
      evidencePaths: [mode === 'forged-path' ? 'behavior.inventedField' : 'task'], detail: '合成验收结论，非真实语义测评' }));
    if (mode === 'omitted') coverage.pop();
    return response({ coverage, issues: failed ? [{ criterionId: 'goal', target: 'task', instruction: '增加复杂典型案例要求' }] : [] });
  };
  return { caller, phases, seen, get repairCalls() { return repairCalls; } };
}
const good = model();
const result = await generateScene({ ...opts, callLlm: good.caller });
assert.deepEqual(good.phases, ['flow', 'instructions', 'generate', 'accept']);
assert.equal(result.behavior?.aiBehavior, instructions.aiBehavior);
assert.equal(result.behavior?.evaluationRule, flow.evaluationRule);
assert.equal(result.runtimeContract?.flowGuidance, flow.flowGuidance);
assert.equal(result.completion.maxTurns, flow.maxTurns);
assert.deepEqual(result.agentInstructions, { understanding: instructions.understanding, planning: instructions.planning, response: instructions.response });
assert.deepEqual(resolveSceneRuntimeContract(result).allowedInteractionTypes, ['single-choice']);
assert.equal(resolveSceneRuntimeContract(result).allowedTools.includes('argument-chain'), false);
assert.equal(good.repairCalls, 0);
const flowRepaired = model('flow-combination-repair');
await generateScene({ ...opts, callLlm: flowRepaired.caller });
assert.deepEqual(flowRepaired.phases, ['flow', 'flow', 'instructions', 'generate', 'accept'], 'the owner design phase repairs its own unreachable graph before acceptance');
const repaired = model('repair');
const fixed = await generateScene({ ...opts, callLlm: repaired.caller });
assert.deepEqual(repaired.phases, ['flow', 'instructions', 'generate', 'accept', 'repair', 'accept']);
assert.equal(fixed.task, '按复杂典型案例逐题测试；仅单选');
assert.deepEqual(fixed.agentInstructions, result.agentInstructions);
assert.equal(repaired.seen[3].scene.sceneId, repaired.seen[5].scene.sceneId, 'targeted repair preserves identity');
assert.deepEqual(repaired.seen[3].scene.behavior, repaired.seen[5].scene.behavior, 'unrelated accepted fields stay unchanged');
for (const [mode, code] of [['reject', 'semantic-rejected'], ['omitted', 'incomplete-acceptance'],
  ['forged-path', 'invalid-acceptance-evidence'], ['forged-patch', 'invalid-repair-target'], ['transport', 'model-http-401']] as const) {
  const broken = model(mode);
  await assert.rejects(() => generateScene({ ...opts, callLlm: broken.caller }),
    error => error instanceof SceneSetupError && error.code === code && !error.message.includes('provider-secret'));
  if (mode === 'reject') assert.equal(broken.repairCalls, 1, 'semantic repair does not loop');
  if (mode === 'transport') assert.deepEqual(broken.phases, ['flow']);
}
const controller = new AbortController(), aborting = model('abort', controller);
await assert.rejects(() => generateScene({ ...opts, signal: controller.signal, callLlm: aborting.caller }), { name: 'AbortError' });
assert.deepEqual(aborting.phases, ['flow']);
const adapted = model();
const source = { ...result, sceneId: 'old-scene' };
const adaptedResult = await adaptScene({ ...opts, sourceSpec: source, callLlm: adapted.caller });
assert.equal(adaptedResult.origin, 'adapted'); assert.equal(adaptedResult.sourceSceneId, 'old-scene');
assert.notEqual(adaptedResult.sceneId, 'old-scene');
assert.equal(source.task, result.task, 'adapt does not mutate the old scene');
assert.deepEqual(adapted.phases, good.phases);
let selectionRead = false;
await decideScene({ ...opts, manifest: { scenes: [{ sceneId: 'old-scene', name: '旧场景', sceneSkill: 'S1' }] }, callLlm: async (call: LlmCallRequest) => {
  const input = JSON.parse(call.userInput); selectionRead = true; assert.equal(input.buildContext.userRequest, request);
  return { content: JSON.stringify({ decision: 'adapt', targetSceneId: 'old-scene' }) };
} });
assert.equal(selectionRead, true);

let truncatedCalls = 0;
await runSceneSetupStage({ stage: 'instructions', maxOutputChars: 1000, request: { providerId: '', model: '', workflow: 'agent-scene-setup', userInput: '{}' },
  invoke: async call => { truncatedCalls++;
    if (truncatedCalls === 1) return { content: '{}', diagnostics: { finishReason: 'length' } };
    assert.equal(call.maxTokensOverride, 16384); assert.equal(JSON.parse(call.userInput).outputRepair.code, 'output-truncated');
    return { content: '{"ok":true}' }; }, validate: raw => raw });
assert.equal(truncatedCalls, 2, 'truncated valid JSON is not accepted as a completed design');

// Actual runtime consumers must receive all three builder-authored instruction sections.
const run: any = { turnCount: 1, messages: [{ id: 'u', speakerType: 'user', content: '用认知失调出题', isStreaming: false }],
  metrics: [], status: 'active', events: [] };
let planned = 0;
await prepareSceneTurnAgentContext(result, run, { callLlm: async call => {
  const input = JSON.parse(call.userInput);
  if (input.phase === 'understand') {
    assert.equal(input.scene.understandingInstructions, instructions.understanding);
    return { content: JSON.stringify({ understanding: understandingFixture('u', run.messages[0].content, {
      informationGaps: [{ id: 'g', description: '需要笔记定义', kind: 'reference-material' }] }), action: 'respond' }) };
  }
  assert.equal(input.scene.planningInstructions, instructions.planning); planned++;
  return { content: '{"action":"respond","toolRequests":[]}' };
} });
assert.equal(planned, 1);
const dialogue: SceneSpec = { ...result, capabilityRecipeId: 'free-dialogue', capabilityIds: ['text'], promptModuleIds: ['turn-agent-planning'],
  runtimeContract: undefined, behavior: { ...result.behavior!, recipeId: 'free-dialogue', interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } } };
let responseSeen = false;
await generateGeneralTurn(dialogue, run, { dependencies: { callLlm: async call => {
  if (call.workflow === 'scene-turn-plan') return { content: JSON.stringify({ understanding: understandingFixture('u', run.messages[0].content), action: 'respond' }) };
  assert.ok(call.userInput.includes(instructions.response)); responseSeen = true;
  return { content: '{"content":"合成自然回应","endReason":null}' };
} } });
assert.equal(responseSeen, true);
const longFlow = { ...result, runtimeContract: { ...result.runtimeContract!, flowGuidance: '保持约束'.repeat(500) + '最后的关键要求' } };
assert.ok(resolveSceneRuntimeContract(longFlow).flowGuidance.endsWith('最后的关键要求'), 'flow guidance is not silently truncated');
assert.equal(parseSceneSpec(JSON.stringify(result)).agentInstructions?.response, instructions.response, 'saved instructions survive parsing');
assert.deepEqual(normalizeSceneSpec(JSON.parse(JSON.stringify(result)))?.agentInstructions, result.agentInstructions,
  'library reload retains builder-authored instructions');
console.log('Scene build agent passed: explicit inherited goal/task/artifacts, separate flow/instruction design, actual-draft semantic coverage, bounded targeted repair, stage budgets/truncation, adapt/new parity, abort, and all runtime instruction consumers. Synthetic decisions only.');
